import { BUILDINGS } from './instructions.js';

/**
 * 1通話ぶんの受付状態。プロセス内メモリにのみ保持する。
 *
 * Realtime API にセッション再開機構は無く、ソケットが切れた時点で会話履歴は
 * 失われる。したがって業務状態を会話から読み戻す設計は取らない。
 * DB への書き込みは Stage 5 で行う。
 *
 * **ツール引数がこの受付内容の唯一の正。** OpenAI は入力の文字起こしについて
 * 「モデルが実際に聞いた内容そのものではない」と明記しているため、
 * 文字起こしを業務データとして使ってはいけない。
 */

export type SlotName = 'name_kana' | 'phone' | 'building' | 'room';

/** CLAUDE.md の会話フロー順。次に聞くべき項目はこの順で決まる。 */
export const SLOT_ORDER: SlotName[] = ['name_kana', 'phone', 'building', 'room'];

const SLOT_LABEL: Record<SlotName, string> = {
  name_kana: 'お名前の読み',
  phone: '電話番号',
  building: 'マンション名',
  room: '部屋番号',
};

export interface RecordResult {
  ok: boolean;
  /** 今回受理された項目 */
  recorded: SlotName[];
  /** 検証に失敗した項目とその理由 */
  rejected: Array<{ slot: SlotName; reason: string }>;
  /** 次に聞くべき項目（すべて揃っていれば null） */
  next_missing: SlotName | null;
  /** モデルへの短い指示 */
  hint: string;
}

/** 全角数字を半角へ。電話番号・部屋番号の前処理。 */
function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 数字以外を落とす（ハイフン・括弧・空白を許容するため）。 */
function digitsOnly(value: string): string {
  return toHalfWidthDigits(value).replace(/[^0-9]/g, '');
}

/** ひらがな・カタカナ・長音・中黒・空白のみか。 */
function isKana(value: string): boolean {
  return /^[ぁ-ゖァ-ヺー・　\s ー・]+$/.test(value.trim());
}

export class ReceptionState {
  private readonly slots: Partial<Record<SlotName, string>> = {};
  /** 同じ call_id の重複呼び出しを無視するため。 */
  private readonly handledCallIds = new Set<string>();
  /** 項目ごとの失敗回数。3回でスキップ判断（CLAUDE.md のエラー処理要件）。 */
  private readonly failures: Partial<Record<SlotName, number>> = {};

  get values(): Partial<Record<SlotName, string>> {
    return { ...this.slots };
  }

  get isComplete(): boolean {
    return SLOT_ORDER.every((s) => this.slots[s] !== undefined);
  }

  get nextMissing(): SlotName | null {
    return SLOT_ORDER.find((s) => this.slots[s] === undefined) ?? null;
  }

  failureCount(slot: SlotName): number {
    return this.failures[slot] ?? 0;
  }

  alreadyHandled(callId: string): boolean {
    return this.handledCallIds.has(callId);
  }

  markHandled(callId: string): void {
    this.handledCallIds.add(callId);
  }

  /**
   * ツール引数を検証して記録する。
   * 引数はすべて任意。モデルは項目を確定するたびに部分的に呼んでよい
   * （CLAUDE.md「都度復唱して確定させてから次に進む」に沿う）。
   */
  record(args: Partial<Record<SlotName, unknown>>): RecordResult {
    const recorded: SlotName[] = [];
    const rejected: Array<{ slot: SlotName; reason: string }> = [];

    for (const slot of SLOT_ORDER) {
      const raw = args[slot];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = String(raw).trim();
      const result = this.validate(slot, value);
      if (result.ok) {
        this.slots[slot] = result.value;
        recorded.push(slot);
      } else {
        this.failures[slot] = (this.failures[slot] ?? 0) + 1;
        rejected.push({ slot, reason: result.reason });
      }
    }

    const next = this.nextMissing;
    return {
      ok: rejected.length === 0,
      recorded,
      rejected,
      next_missing: next,
      hint: this.buildHint(next, rejected),
    };
  }

  private buildHint(
    next: SlotName | null,
    rejected: Array<{ slot: SlotName; reason: string }>,
  ): string {
    if (rejected.length > 0) {
      const r = rejected[0];
      if (!r) return '';
      // 3回失敗したら固執せず先へ進ませる。
      if (this.failureCount(r.slot) >= 3) {
        return `${SLOT_LABEL[r.slot]}は3回聞き取れませんでした。これ以上聞き返さず、次の項目へ進んでください。`;
      }
      return `${SLOT_LABEL[r.slot]}が正しくありません（${r.reason}）。丁寧に聞き返してください。`;
    }
    if (next === null) {
      return '4項目すべて揃いました。仮予約日をご案内してください。';
    }
    return `次は${SLOT_LABEL[next]}を伺ってください。`;
  }

  private validate(slot: SlotName, value: string): { ok: true; value: string } | { ok: false; reason: string } {
    switch (slot) {
      case 'name_kana': {
        if (value.length < 2) return { ok: false, reason: '短すぎます' };
        // 漢字の確定は行わない設計。かな以外が混ざっていたら聞き直させる。
        if (!isKana(value)) return { ok: false, reason: 'かな以外の文字が含まれています' };
        return { ok: true, value };
      }
      case 'phone': {
        const digits = digitsOnly(value);
        // CLAUDE.md: 桁数検証（10〜11桁）
        if (digits.length < 10 || digits.length > 11) {
          return { ok: false, reason: `桁数が${digits.length}桁です（10〜11桁である必要があります）` };
        }
        return { ok: true, value: digits };
      }
      case 'building': {
        const normalized = value.replace(/[\s　]/g, '');
        const match = BUILDINGS.find((b) => b === normalized);
        if (!match) {
          return { ok: false, reason: `候補（${BUILDINGS.join('・')}）のいずれにも一致しません` };
        }
        return { ok: true, value: match };
      }
      case 'room': {
        const digits = digitsOnly(value);
        // CLAUDE.md: 数字のみ。英字混じりは想定しない。
        if (digits.length === 0) return { ok: false, reason: '数字が含まれていません' };
        if (digits.length > 5) return { ok: false, reason: '桁数が多すぎます' };
        return { ok: true, value: digits };
      }
    }
  }
}

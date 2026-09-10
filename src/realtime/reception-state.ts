import { BUILDINGS } from './instructions.js';
import { checkPreferredDate, jstToday, speakJa, toIso, type CalendarDate } from './dates.js';

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
export type ResponseType = 'confirm' | 'change' | 'decline';

/** CLAUDE.md の会話フロー順。 */
export const SLOT_ORDER: SlotName[] = ['name_kana', 'phone', 'building', 'room'];

const SLOT_LABEL: Record<SlotName, string> = {
  name_kana: 'お名前の読み',
  phone: '電話番号',
  building: 'マンション名',
  room: '部屋番号',
};

const RESPONSE_LABEL: Record<ResponseType, string> = {
  confirm: '確定',
  change: '変更希望',
  decline: '辞退',
};

/** 会話全体として次に何をすべきか。 */
export type NextStep =
  | { kind: 'slot'; slot: SlotName }
  | { kind: 'announce_tentative' }
  | { kind: 'response_type' }
  | { kind: 'preferred_date'; index: 1 | 2 | 3 }
  | { kind: 'complete' };

export interface ToolResult {
  ok: boolean;
  recorded: string[];
  rejected: Array<{ field: string; reason: string }>;
  /** サーバーが計算した復唱用文字列。モデルはこれをそのまま読み上げる。 */
  readback?: Record<string, string>;
  next: string;
  hint: string;
}

function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function digitsOnly(value: string): string {
  return toHalfWidthDigits(value).replace(/[^0-9]/g, '');
}

function isKana(value: string): boolean {
  return /^[ぁ-ゖァ-ヺー・　\s]+$/.test(value.trim());
}

export class ReceptionState {
  private readonly slots: Partial<Record<SlotName, string>> = {};
  private responseType: ResponseType | null = null;
  /** 第一〜第三希望日（ISO 文字列）。index 0 が第一希望。 */
  private readonly preferred: Array<string | undefined> = [undefined, undefined, undefined];
  private completed = false;
  /** review_reception を通ったか。CLAUDE.md の「通話終了前に復唱して確認」を構造的に担保する。 */
  private reviewed = false;

  private readonly handledCallIds = new Set<string>();
  private readonly failures: Record<string, number> = {};

  constructor(
    private readonly today: CalendarDate = jstToday(),
    /** 仮予約日。これと同じ日を希望日にするのは矛盾なので拒否する。 */
    private readonly tentative: CalendarDate | null = null,
  ) {}

  // ---- 参照 ----

  get values(): Record<string, unknown> {
    return {
      ...this.slots,
      response_type: this.responseType,
      preferred_date_1: this.preferred[0],
      preferred_date_2: this.preferred[1],
      preferred_date_3: this.preferred[2],
      completed: this.completed,
    };
  }

  get isComplete(): boolean {
    return this.completed;
  }

  get slotsFilled(): boolean {
    return SLOT_ORDER.every((s) => this.slots[s] !== undefined);
  }

  /** 変更希望のときだけ希望日が必要。第一希望は必須、第二・第三は任意扱いにする。 */
  get datesSatisfied(): boolean {
    if (this.responseType !== 'change') return true;
    return this.preferred[0] !== undefined;
  }

  get nextStep(): NextStep {
    const missingSlot = SLOT_ORDER.find((s) => this.slots[s] === undefined);
    if (missingSlot) return { kind: 'slot', slot: missingSlot };
    if (this.responseType === null) return { kind: 'response_type' };
    if (this.responseType === 'change') {
      for (let i = 0; i < 3; i += 1) {
        if (this.preferred[i] === undefined) return { kind: 'preferred_date', index: (i + 1) as 1 | 2 | 3 };
      }
    }
    return { kind: 'complete' };
  }

  private describeNext(): { next: string; hint: string } {
    const step = this.nextStep;
    switch (step.kind) {
      case 'slot':
        return { next: step.slot, hint: `次は${SLOT_LABEL[step.slot]}を伺ってください。` };
      case 'announce_tentative':
        return { next: 'announce_tentative', hint: '仮予約日をご案内してください。' };
      case 'response_type':
        return {
          next: 'response_type',
          hint: '仮予約日をご案内し、確定・変更希望・辞退のどれかを伺ってください。',
        };
      case 'preferred_date':
        return {
          next: `preferred_date_${step.index}`,
          hint:
            step.index === 1
              ? '第一希望日を伺ってください。1つずつ確定させ、まとめて聞かないでください。'
              : `第${step.index === 2 ? '二' : '三'}希望日を伺ってください。不要と言われた場合は complete_reception を呼んでください。`,
        };
      case 'complete':
        return { next: 'complete', hint: '内容を復唱し、complete_reception を呼んでください。' };
    }
  }

  markReviewed(): void {
    this.reviewed = true;
  }

  alreadyHandled(callId: string): boolean {
    return this.handledCallIds.has(callId);
  }

  markHandled(callId: string): void {
    this.handledCallIds.add(callId);
  }

  failureCount(field: string): number {
    return this.failures[field] ?? 0;
  }

  // ---- 記録 ----

  /** 4項目。項目ごとに部分的に呼んでよい。 */
  recordResidentInfo(args: Record<string, unknown>): ToolResult {
    const recorded: string[] = [];
    const rejected: Array<{ field: string; reason: string }> = [];

    for (const slot of SLOT_ORDER) {
      const raw = args[slot];
      if (raw === undefined || raw === null || raw === '') continue;
      const result = this.validateSlot(slot, String(raw).trim());
      if (result.ok) {
        this.slots[slot] = result.value;
        recorded.push(slot);
        // 聞き直して取れたら失敗回数はリセットする。
        // 累積のままだと、住人が言い直している最中に3回に達し、
        // AI が「おかけ直しください」と通話を切り上げてしまう。
        delete this.failures[slot];
      } else {
        this.failures[slot] = (this.failures[slot] ?? 0) + 1;
        rejected.push({ field: slot, reason: result.reason });
      }
    }
    return this.result(recorded, rejected);
  }

  recordResponse(type: unknown): ToolResult {
    const value = String(type ?? '').trim();
    if (value !== 'confirm' && value !== 'change' && value !== 'decline') {
      this.failures.response_type = (this.failures.response_type ?? 0) + 1;
      return this.result([], [
        { field: 'response_type', reason: 'confirm / change / decline のいずれかである必要があります' },
      ]);
    }
    if (!this.slotsFilled) {
      return this.result([], [
        { field: 'response_type', reason: '先に4項目（お名前・電話番号・マンション名・部屋番号）を確定してください' },
      ]);
    }
    this.responseType = value;
    return this.result(['response_type'], []);
  }

  /**
   * 希望日。1つずつ確定させる運用のため、date1/date2/date3 はすべて任意。
   * **曜日はここで計算した値を返し、モデルにはそれを読み上げさせる。**
   */
  recordPreferredDates(args: Record<string, unknown>): ToolResult {
    if (this.responseType !== 'change') {
      return this.result([], [
        { field: 'preferred_dates', reason: '変更希望（change）のときだけ指定できます' },
      ]);
    }

    const recorded: string[] = [];
    const rejected: Array<{ field: string; reason: string }> = [];
    const readback: Record<string, string> = {};

    ([1, 2, 3] as const).forEach((n) => {
      const raw = args[`date${n}`];
      if (raw === undefined || raw === null || raw === '') return;
      const field = `preferred_date_${n}`;
      const check = checkPreferredDate(String(raw), this.today);
      if (!check.ok) {
        this.failures[field] = (this.failures[field] ?? 0) + 1;
        rejected.push({ field, reason: check.reason });
        return;
      }
      // 変更を希望しているのに仮予約日と同じ日を挙げるのは矛盾している
      if (this.tentative && check.iso === toIso(this.tentative)) {
        rejected.push({
          field,
          reason: '仮予約日と同じ日付です。変更をご希望とのことなので、別の日をご確認ください',
        });
        return;
      }
      // 同じ日を重複して希望として登録させない
      const dup = this.preferred.findIndex((p, i) => p === check.iso && i !== n - 1);
      if (dup >= 0) {
        rejected.push({ field, reason: `第${dup + 1}希望と同じ日付です。別の日をご確認ください` });
        return;
      }
      this.preferred[n - 1] = check.iso;
      recorded.push(field);
      delete this.failures[field];
      readback[field] = check.readback;
    });

    const res = this.result(recorded, rejected);
    if (Object.keys(readback).length > 0) res.readback = readback;
    return res;
  }

  /** 受付完了。これ以降は変更を受け付けない。 */
  complete(): ToolResult {
    if (!this.slotsFilled) {
      return this.result([], [{ field: 'complete', reason: '4項目が揃っていません' }]);
    }
    if (this.responseType === null) {
      return this.result([], [{ field: 'complete', reason: '確定・変更希望・辞退の回答がありません' }]);
    }
    if (!this.datesSatisfied) {
      return this.result([], [{ field: 'complete', reason: '変更希望の場合は第一希望日が必要です' }]);
    }
    if (!this.reviewed) {
      // result() を通さない。あれは全ての差し戻しに「丁寧に聞き返してください」を
      // 付けるため、住人に聞き返せという誤った指示になる。
      return {
        ok: false,
        recorded: [],
        rejected: [{ field: 'complete', reason: 'まだ復唱していません' }],
        next: 'review',
        hint: 'review_reception を呼び、戻り値をそのまま読み上げて確認を取ってから complete_reception を呼んでください。',
      };
    }
    this.completed = true;
    return {
      ok: true,
      recorded: ['completed'],
      rejected: [],
      next: 'end_call',
      hint: '受付完了です。お礼を述べて通話を終えてください。',
    };
  }

  /** DB 保存用の素の値。日付は ISO、回答区分は日本語（管理画面にそのまま出す）。 */
  snapshot(): {
    name_kana: string | null;
    phone: string | null;
    building: string | null;
    room: string | null;
    response_type: string | null;
    preferred_date_1: string | null;
    preferred_date_2: string | null;
    preferred_date_3: string | null;
  } {
    return {
      name_kana: this.slots.name_kana ?? null,
      phone: this.slots.phone ?? null,
      building: this.slots.building ?? null,
      room: this.slots.room ?? null,
      response_type: this.responseType ? RESPONSE_LABEL[this.responseType] : null,
      preferred_date_1: this.preferred[0] ?? null,
      preferred_date_2: this.preferred[1] ?? null,
      preferred_date_3: this.preferred[2] ?? null,
    };
  }

  /** 何か1つでも聞き取れているか。何も無い通話は保存しない。 */
  get hasAnything(): boolean {
    return SLOT_ORDER.some((s) => this.slots[s] !== undefined) || this.responseType !== null;
  }

  /** 復唱用のまとめ。Stage 5 の CONFIRM_SUMMARY で使う。 */
  summaryForReadback(tentative: CalendarDate): Record<string, string> {
    const out: Record<string, string> = {
      name_kana: this.slots.name_kana ?? '',
      phone: this.slots.phone ?? '',
      building: this.slots.building ?? '',
      room: this.slots.room ?? '',
      tentative_date: speakJa(tentative),
      response_type: this.responseType ? RESPONSE_LABEL[this.responseType] : '',
    };
    ([1, 2, 3] as const).forEach((n) => {
      const iso = this.preferred[n - 1];
      if (!iso) return;
      const check = checkPreferredDate(iso, this.today);
      if (check.ok) out[`preferred_date_${n}`] = check.readback;
    });
    return out;
  }

  private result(recorded: string[], rejected: Array<{ field: string; reason: string }>): ToolResult {
    const { next, hint } = this.describeNext();
    let finalHint = hint;
    if (rejected.length > 0) {
      const r = rejected[0];
      if (r) {
        finalHint =
          this.failureCount(r.field) >= 3
            ? `${r.field} は3回聞き取れませんでした。これ以上聞き返さず、次へ進んでください。`
            : `${r.reason} 丁寧に聞き返してください。`;
      }
    }
    return { ok: rejected.length === 0, recorded, rejected, next, hint: finalHint };
  }

  private validateSlot(
    slot: SlotName,
    value: string,
  ): { ok: true; value: string } | { ok: false; reason: string } {
    switch (slot) {
      case 'name_kana': {
        if (value.length < 2) return { ok: false, reason: 'お名前が短すぎます。' };
        if (!isKana(value)) return { ok: false, reason: 'お名前はかなのみで記録します。' };
        return { ok: true, value };
      }
      case 'phone': {
        const digits = digitsOnly(value);
        if (digits.length < 10 || digits.length > 11) {
          return { ok: false, reason: `電話番号が${digits.length}桁です（10〜11桁が必要です）。` };
        }
        return { ok: true, value: digits };
      }
      case 'building': {
        const normalized = value.replace(/[\s　]/g, '');
        const match = BUILDINGS.find((b) => b === normalized);
        if (!match) {
          return { ok: false, reason: `マンション名が候補（${BUILDINGS.join('・')}）に一致しません。` };
        }
        return { ok: true, value: match };
      }
      case 'room': {
        const digits = digitsOnly(value);
        if (digits.length === 0) return { ok: false, reason: '部屋番号に数字が含まれていません。' };
        if (digits.length > 5) return { ok: false, reason: '部屋番号の桁数が多すぎます。' };
        return { ok: true, value: digits };
      }
    }
  }
}

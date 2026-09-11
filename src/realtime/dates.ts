/**
 * 日付ユーティリティ。
 *
 * 本デモの精度要件の中核。要件定義:
 *   「復唱時は必ず曜日を添える。曜日が冗長な検証になる。
 *     住人が『15日』と言ったのに AI が『5日』と聞き取った場合、
 *     曜日の不一致で即座に誤りが表面化する」
 *
 * したがって**曜日はサーバー側で計算した値を正とする**。モデルに曜日を
 * 計算させると、日付は正しいのに曜日だけ間違えるという最悪の形が起こりうる
 * （検証装置そのものが壊れるため、誤りが表面化しなくなる）。
 *
 * タイムゾーンはサーバーのロケール設定に依存させない。エポックを +9 時間ずらして
 * UTC として読むことで、どこで動かしても JST の暦日が得られる。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** サーバーのタイムゾーンに関係なく、日本時間での「今日」を返す。 */
export function jstToday(now: Date = new Date()): CalendarDate {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** YYYY-MM-DD を解釈する。存在しない日付（2月30日など）は null。 */
export function parseIsoDate(value: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 正規化して元に戻るかで実在判定する（4月31日 → 5月1日 になるのを弾く）
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function toIso(d: CalendarDate): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** 曜日（「木」など）。正午アンカーの UTC で計算するため DST・TZ の影響を受けない。 */
export function weekdayOf(d: CalendarDate): string {
  const probe = new Date(Date.UTC(d.year, d.month - 1, d.day, 12));
  return WEEKDAYS[probe.getUTCDay()] ?? '';
}

/** 復唱用の文字列。曜日を必ず含める。 */
export function formatJa(d: CalendarDate): string {
  return `${d.month}月${d.day}日（${weekdayOf(d)}曜日）`;
}

/** 音声で読み上げる用（括弧を使わない）。 */
export function speakJa(d: CalendarDate): string {
  return `${d.month}月${d.day}日、${weekdayOf(d)}曜日`;
}

/** today から見て何日後か。過去なら負。 */
export function daysFromToday(d: CalendarDate, today: CalendarDate = jstToday()): number {
  const a = Date.UTC(d.year, d.month - 1, d.day);
  const b = Date.UTC(today.year, today.month - 1, today.day);
  return Math.round((a - b) / 86400000);
}

export function addDays(d: CalendarDate, days: number): CalendarDate {
  const probe = new Date(Date.UTC(d.year, d.month - 1, d.day + days, 12));
  return {
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: probe.getUTCDate(),
  };
}

/** 希望日として受け付けられる範囲。デモなので広めに取る。 */
export const MIN_DAYS_AHEAD = 1;
export const MAX_DAYS_AHEAD = 180;

export type DateCheck =
  | { ok: true; date: CalendarDate; iso: string; readback: string }
  | { ok: false; reason: string };

/**
 * 希望日を検証する。
 * モデルには「来週の火曜日」などの相対表現を YYYY-MM-DD へ変換させたうえで渡させる。
 * ここでは実在性と妥当な範囲だけを見る。
 */
export function checkPreferredDate(value: string, today: CalendarDate = jstToday()): DateCheck {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return { ok: false, reason: '日付として解釈できません（YYYY-MM-DD 形式で指定してください）' };
  }
  const diff = daysFromToday(parsed, today);
  if (diff < MIN_DAYS_AHEAD) {
    return { ok: false, reason: diff === 0 ? '本日は指定できません' : '過去の日付です' };
  }
  if (diff > MAX_DAYS_AHEAD) {
    return { ok: false, reason: `先すぎます（${MAX_DAYS_AHEAD}日以内で指定してください）` };
  }
  return { ok: true, date: parsed, iso: toIso(parsed), readback: speakJa(parsed) };
}

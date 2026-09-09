/**
 * Twilio Media Streams の WebSocket プロトコル定義。
 *
 * ここに書かれた綴りはすべて公式ドキュメント（websocket-messages）で確認済み。
 * 特に注意すべき点:
 *
 *  1. media イベントの track は "inbound" / "outbound"。TwiML 属性値の
 *     "inbound_track" とは綴りが違う。"inbound_track" で比較すると
 *     エラーも出ずに一件もマッチせず、完全な無音になる。
 *  2. dtmf イベントの track だけは "inbound_track" 表記。同じ概念に3つの語彙がある。
 *  3. sequenceNumber / chunk / timestamp はいずれも「数字の文字列」。
 *     Stage 2 の音声トリム計算で数値として使うため、境界で Number() 正規化する。
 *  4. Twilio は "close" / "closed" イベントを送らない。公式サンプルの一部が
 *     それを待っているが誤りで、終端は stop イベントとWSのクローズのみ。
 */

/** Twilio → 自サーバー。この6種類しか来ない。 */
export type InboundEvent = 'connected' | 'start' | 'media' | 'dtmf' | 'stop' | 'mark';

export interface ConnectedMessage {
  event: 'connected';
  protocol: string;
  version: string;
  // 注意: streamSid も sequenceNumber も持たない。最初に届くのがこれ。
}

export interface MediaFormat {
  /** 常に "audio/x-mulaw"。選択の余地はない。 */
  encoding: string;
  /** 常に 8000。 */
  sampleRate: number;
  /** 常に 1。 */
  channels: number;
}

export interface StartMessage {
  event: 'start';
  sequenceNumber: string;
  streamSid: string;
  start: {
    accountSid: string;
    streamSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: MediaFormat;
    /** TwiML の <Parameter> がそのまま届く。クエリ文字列が使えないため、通話ごとの値を渡す唯一の手段。 */
    customParameters?: Record<string, string>;
  };
}

export interface MediaMessage {
  event: 'media';
  sequenceNumber: string;
  streamSid: string;
  media: {
    /** "inbound" = 発信者の声。"inbound_track" ではない。 */
    track: string;
    chunk: string;
    /** ストリーム開始からのミリ秒。文字列で届く。 */
    timestamp: string;
    /** base64 エンコードされた μ-law バイト列。ヘッダ無しの生データ。 */
    payload: string;
  };
}

export interface DtmfMessage {
  event: 'dtmf';
  sequenceNumber: string;
  streamSid: string;
  /** ここだけ "inbound_track" 表記。 */
  dtmf: { track: string; digit: string };
}

export interface StopMessage {
  event: 'stop';
  sequenceNumber: string;
  streamSid: string;
  stop: { accountSid: string; callSid: string };
}

export interface MarkMessage {
  event: 'mark';
  sequenceNumber: string;
  streamSid: string;
  mark: { name: string };
}

export type InboundMessage =
  | ConnectedMessage
  | StartMessage
  | MediaMessage
  | DtmfMessage
  | StopMessage
  | MarkMessage;

/** media.track の値。TwiML 属性の inbound_track / outbound_track / both_tracks とは別物。 */
export const TRACK_INBOUND = 'inbound';
export const TRACK_OUTBOUND = 'outbound';

/** μ-law のデジタル無音は 0xFF。0x00 で埋めるとノイズになる。 */
export const MULAW_SILENCE_BYTE = 0xff;

export function parseInbound(raw: string): InboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== 'string') return null;
  return parsed as InboundMessage;
}

/** 数字文字列を数値へ。壊れた値では NaN を撒かず 0 を返す。 */
export function num(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** base64 の μ-law ペイロードの実バイト長。フレーム長の実測に使う。 */
export function payloadByteLength(payloadBase64: string): number {
  return Buffer.from(payloadBase64, 'base64').length;
}

/**
 * 複数フレームを1メッセージにまとめる。
 * base64 文字列を単純連結してはいけない（4文字単位のパディングで壊れる）。
 * 必ずバイト列に戻して連結し、最後に1回だけエンコードする。
 */
export function concatPayloads(payloadsBase64: string[]): string {
  if (payloadsBase64.length === 1) return payloadsBase64[0] as string;
  const buffers = payloadsBase64.map((p) => Buffer.from(p, 'base64'));
  return Buffer.concat(buffers).toString('base64');
}

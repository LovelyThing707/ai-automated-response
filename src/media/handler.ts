/**
 * Stage 2 以降でトランスポート層を書き換えないための唯一の境界。
 *
 * media-stream.ts が Twilio プロトコルの面倒（イベント種別・文字列数値・
 * track の綴り・streamSid ガード）をすべて吸収し、ハンドラには正規化済みの
 * イベントだけを渡す。Stage 2 は echo-handler を realtime-handler に
 * 差し替えるだけで済む。
 */

export interface StreamSendApi {
  media(payloadBase64: string): void;
  mark(name: string): void;
  clear(): void;
  close(reason?: string): void;
}

export interface StreamContext {
  streamSid: string;
  callSid: string;
  accountSid: string;
  /** TwiML の <Parameter> から届く値。Stage 3 以降で仮予約日などを受け取る。 */
  customParameters: Record<string, string>;
  /** start.mediaFormat の実測値。常に audio/x-mulaw 8000Hz mono のはず。 */
  mediaFormat: { encoding: string; sampleRate: number; channels: number };
  send: StreamSendApi;
}

export interface MediaHandler {
  /** start イベント受信直後。非同期処理をしてもメッセージは取りこぼされない（内部でキューされる）。 */
  onStart(ctx: StreamContext): void | Promise<void>;
  /** 発信者の音声フレーム。timestampMs は Number() 正規化済み。 */
  onMedia(payloadBase64: string, timestampMs: number): void;
  /** 送った mark が再生完了して返ってきた。 */
  onMark(name: string): void;
  onDtmf(digit: string): void;
  /** Twilio が stop を送ってきた（通話終了）。 */
  onStop(): void;
  /** WebSocket が閉じた。stop が来ないまま切れる場合もあるため、後片付けはここで行う。 */
  onClose(code: number, reason: string): void;
}

export type MediaHandlerFactory = () => MediaHandler;

import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Twilio へ送るメッセージのビルダ兼ガード。
 *
 * 送ってよいのは media / mark / clear の3種のみ。それ以外はプロトコル違反として
 * Warning 31951 または Error 31924 になる。
 *
 * 絶対に守るべき点:
 *  1. streamSid は全メッセージ必須。start 到着前は取得できない。
 *     欠落してもエラーも音も出ず、ソケットは健全なまま無音になる。
 *  2. media メッセージのフィールドは event / streamSid / media.payload の3つだけ。
 *     受信した media オブジェクトをそのまま返すと track・chunk・timestamp が
 *     余計なフィールドとして混入し、Warning 31951 で黙って破棄される。
 *  3. WebSocket の TEXT フレームで送る。ws.send(Buffer) はバイナリフレームになり
 *     Warning 31950 で音声が捨てられる。必ず JSON.stringify した文字列を渡す。
 *  4. payload に WAV/RIFF ヘッダを付けない。生の μ-law バイト列のみ。
 *
 *  なお 31950 / 31951 / 31931 は Stream あたり1回しか通知されない。
 *  プロトコルバグがあっても Console には1行しか出ないため、
 *  「警告が少ない = 軽微」と誤読しないこと。
 */
export class StreamSender {
  private streamSid: string | null = null;
  private droppedBeforeStart = 0;
  private sentMedia = 0;
  private sentMarks = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** start イベント受信時に一度だけ呼ぶ。 */
  bind(streamSid: string): void {
    this.streamSid = streamSid;
  }

  get isReady(): boolean {
    return this.streamSid !== null && this.socket.readyState === this.socket.OPEN;
  }

  get stats(): { sentMedia: number; sentMarks: number; droppedBeforeStart: number } {
    return {
      sentMedia: this.sentMedia,
      sentMarks: this.sentMarks,
      droppedBeforeStart: this.droppedBeforeStart,
    };
  }

  private send(message: object): boolean {
    if (this.streamSid === null) {
      this.droppedBeforeStart += 1;
      return false;
    }
    if (this.socket.readyState !== this.socket.OPEN) return false;
    // 必ず文字列で送る。Buffer を渡すとバイナリフレームになり Twilio に破棄される。
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** base64 の μ-law ペイロードを再生キューへ送る。 */
  sendMedia(payloadBase64: string): boolean {
    const ok = this.send({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: payloadBase64 },
    });
    if (ok) this.sentMedia += 1;
    return ok;
  }

  /**
   * マーカーを送る。Twilio は該当位置の再生完了時に同名の mark を返す。
   * Stage 1 では再生バッファ深度の計測に、Stage 2 では barge-in のゲートに使う。
   */
  sendMark(name: string): boolean {
    const ok = this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
    if (ok) this.sentMarks += 1;
    return ok;
  }

  /** Twilio 側にバッファ済みの未再生音声を破棄する。Stage 2 の barge-in で使用。 */
  sendClear(): boolean {
    return this.send({ event: 'clear', streamSid: this.streamSid });
  }

  /**
   * ストリームを終了する。
   * 「通話を切る」のではなくソケットを閉じるのが正しい終了手順で、
   * これにより </Connect> 以降の TwiML（終わりの挨拶など）が再生される。
   * この直後に Console へ 31921 が赤く記録されるが、これは正常な動作。
   */
  closeStream(reason = 'normal'): void {
    this.log.info({ reason, ...this.stats }, 'ストリームを終了します（31921 は正常）');
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.close(1000, reason);
    }
  }
}

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { concatPayloads, payloadByteLength } from '../twilio/protocol.js';
import type { MediaHandler, StreamContext } from './handler.js';

/**
 * Stage 1: 受信した発信者の音声をそのまま返す。
 *
 * 実装方針（ECHO_BATCH_FRAMES=1 が既定）:
 *   Twilio 公式サンプルは 50 フレーム（約1秒）貯めてから返すが、これは
 *   意図的に遅い実装で、そのまま写すと「1秒のブツ切り遅延」を自作した上に
 *   パイプライン本来の遅延が測れなくなる。Stage 1 の目的はパイプラインの
 *   遅延を正直に可視化することなので、既定は1フレームずつの即時転送とする。
 *   比較実験のため ECHO_BATCH_FRAMES で束ね数を変えられる。
 *
 *   ペーシング用の setTimeout は入れない。Twilio 側がバッファして順に再生するため、
 *   自前タイマーは音の途切れとドリフトの典型的な原因になる。
 *
 * もう一つの役割は「Twilio が文書化していない値を自分の環境で実測すること」。
 * フレーム長・ケイデンス・無音時の挙動・再生バッファ深度は公式ドキュメントに
 * 記載が無く、Stage 2 の barge-in のタイミング計算がこれらに依存する。
 */
export class EchoHandler implements MediaHandler {
  private ctx: StreamContext | null = null;
  private log: FastifyBaseLogger;

  // --- エコー用のバッファ ---
  private pending: string[] = [];

  // --- 計測 ---
  private startedAtMs = 0;
  private frameCount = 0;
  private lastTimestampMs: number | null = null;
  private readonly frameSizes = new Map<number, number>();
  private readonly timestampDeltas = new Map<number, number>();
  private markSeq = 0;
  private readonly markSentAt = new Map<string, number>();
  private markRttSamples: number[] = [];
  private firstMediaAtMs: number | null = null;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }

  onStart(ctx: StreamContext): void {
    this.ctx = ctx;
    this.startedAtMs = Date.now();
    this.log = this.log.child({ streamSid: ctx.streamSid, callSid: ctx.callSid });

    this.log.info(
      {
        mediaFormat: ctx.mediaFormat,
        customParameters: ctx.customParameters,
        batchFrames: config.echo.batchFrames,
        markEvery: config.echo.markEvery,
      },
      'エコー開始',
    );

    // 想定外のフォーマットは Stage 2 の前提を崩すので明示的に警告する。
    if (ctx.mediaFormat.encoding !== 'audio/x-mulaw' || ctx.mediaFormat.sampleRate !== 8000) {
      this.log.warn({ mediaFormat: ctx.mediaFormat }, '想定外の音声フォーマットです（audio/x-mulaw 8000 を想定）');
    }
    if (Object.keys(ctx.customParameters).length === 0) {
      this.log.warn('customParameters が空です。TwiML の <Parameter> が届いていません（Stage 3 以降で必須）');
    }
  }

  onMedia(payloadBase64: string, timestampMs: number): void {
    if (!this.ctx) return;
    this.frameCount += 1;
    if (this.firstMediaAtMs === null) this.firstMediaAtMs = Date.now();

    // --- 実測: フレーム長と timestamp のケイデンス ---
    // 160バイト / 20ms / 50fps は広く信じられているが Twilio の公式文書には
    // 一切記載が無いため、定数として埋め込まず毎回実測する。
    if (this.frameCount <= config.logMediaFrames) {
      const bytes = payloadByteLength(payloadBase64);
      const delta = this.lastTimestampMs === null ? null : timestampMs - this.lastTimestampMs;
      this.frameSizes.set(bytes, (this.frameSizes.get(bytes) ?? 0) + 1);
      if (delta !== null) this.timestampDeltas.set(delta, (this.timestampDeltas.get(delta) ?? 0) + 1);
      this.log.info(
        { frame: this.frameCount, bytes, base64Length: payloadBase64.length, timestampMs, deltaMs: delta },
        '媒体フレーム実測',
      );
    } else {
      const bytes = payloadByteLength(payloadBase64);
      this.frameSizes.set(bytes, (this.frameSizes.get(bytes) ?? 0) + 1);
      if (this.lastTimestampMs !== null) {
        const delta = timestampMs - this.lastTimestampMs;
        this.timestampDeltas.set(delta, (this.timestampDeltas.get(delta) ?? 0) + 1);
      }
    }
    this.lastTimestampMs = timestampMs;

    // --- エコー本体 ---
    // payload は base64 文字列のまま素通しする。decode/encode の往復は
    // 不要な上に遅延の純増になる。
    this.pending.push(payloadBase64);
    if (this.pending.length >= config.echo.batchFrames) {
      // base64 文字列の単純連結は 4 文字パディングで壊れるため、
      // concatPayloads がバイト列に戻してから1回だけ再エンコードする。
      const payload = concatPayloads(this.pending);
      this.pending = [];
      this.ctx.send.media(payload);
    }

    // --- 実測: 再生バッファ深度 ---
    if (config.echo.markEvery > 0 && this.frameCount % config.echo.markEvery === 0) {
      this.markSeq += 1;
      const name = `probe-${this.markSeq}`;
      this.markSentAt.set(name, Date.now());
      this.ctx.send.mark(name);
    }
  }

  onMark(name: string): void {
    const sentAt = this.markSentAt.get(name);
    if (sentAt === undefined) {
      this.log.debug({ name }, '未知の mark を受信');
      return;
    }
    this.markSentAt.delete(name);
    const rtt = Date.now() - sentAt;
    this.markRttSamples.push(rtt);
    this.log.info({ name, rttMs: rtt }, 'mark 往復（再生バッファ深度の目安）');
  }

  onDtmf(digit: string): void {
    this.log.info({ digit }, 'DTMF を受信');
  }

  onStop(): void {
    // stop 自体のログは transport 層（media-stream.ts）が文脈付きで出すため、
    // ここでは端数フレームの吐き出しだけを行う。
    this.flush();
  }

  onClose(code: number, reason: string): void {
    this.flush();
    this.logSummary(code, reason);
  }

  /** 端数フレームを取りこぼさない（batchFrames > 1 のとき意味がある）。 */
  private flush(): void {
    if (this.pending.length > 0 && this.ctx) {
      this.ctx.send.media(concatPayloads(this.pending));
      this.pending = [];
    }
  }

  /**
   * 通話終了時のサマリ。ここで出る値がそのまま
   * 納品物5（テスト結果および既知の制約事項）の素材になる。
   */
  private logSummary(code: number, reason: string): void {
    const wallMs = this.startedAtMs === 0 ? 0 : Date.now() - this.startedAtMs;
    const streamMs = this.lastTimestampMs ?? 0;
    const sizes = [...this.frameSizes.entries()].sort((a, b) => b[1] - a[1]);
    const deltas = [...this.timestampDeltas.entries()].sort((a, b) => b[1] - a[1]);
    const rtt = this.markRttSamples;
    const avgRtt = rtt.length === 0 ? null : Math.round(rtt.reduce((a, b) => a + b, 0) / rtt.length);

    this.log.info(
      {
        closeCode: code,
        closeReason: reason || '(empty)',
        frames: this.frameCount,
        wallClockMs: wallMs,
        streamTimestampMs: streamMs,
        // 実測 fps。20ms/50fps 前提が自分の環境で成立するかはここで判定する。
        framesPerSecondWallClock: wallMs > 0 ? Number(((this.frameCount / wallMs) * 1000).toFixed(2)) : null,
        framesPerSecondByTimestamp: streamMs > 0 ? Number(((this.frameCount / streamMs) * 1000).toFixed(2)) : null,
        frameSizeHistogram: Object.fromEntries(sizes.map(([k, v]) => [`${k}bytes`, v])),
        timestampDeltaHistogram: Object.fromEntries(deltas.slice(0, 5).map(([k, v]) => [`${k}ms`, v])),
        markRtt: { samples: rtt.length, avgMs: avgRtt, minMs: rtt.length ? Math.min(...rtt) : null, maxMs: rtt.length ? Math.max(...rtt) : null },
        marksUnreturned: this.markSentAt.size,
      },
      'エコー終了サマリ（納品物5の素材）',
    );
  }
}

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { buildInstructions, resolveTentativeDate } from '../realtime/instructions.js';
import { formatJa, jstToday } from '../realtime/dates.js';
import { OpenAiSession } from '../realtime/openai-session.js';
import { ReceptionState } from '../realtime/reception-state.js';
import { payloadByteLength } from '../twilio/protocol.js';
import type { MediaHandler, StreamContext } from './handler.js';

/** μ-law 8kHz mono は 8000 バイト/秒 = 1ミリ秒あたり 8 バイト。 */
const MULAW_BYTES_PER_MS = 8;

/**
 * 生成音声 何ミリ秒ごとに mark を1つ打つか。
 * 公式サンプルはデルタごとに1つ打つが、Twilio への送信メッセージ数が倍になる。
 * 「まだ再生中か」の判定粒度としては 200ms で十分。ただし下げすぎると
 * barge-in ゲートが早く空になるため 200ms を下限とする。
 */
const MARK_INTERVAL_MS = 200;

/**
 * Stage 2: Twilio Media Streams と OpenAI Realtime API を中継する。
 *
 * このファイルが所有するのは「Twilio と OpenAI の間の音声中継」と
 * 「barge-in のタイムスタンプ演算・markQueue」だけ。
 * OpenAI のワイヤ形式は OpenAiSession が、Twilio のワイヤ形式は StreamSender が持つ。
 */
export class RealtimeHandler implements MediaHandler {
  private ctx: StreamContext | null = null;
  private session: OpenAiSession | null = null;
  private log: FastifyBaseLogger;
  private finished = false;

  // --- barge-in のための状態（§5-1）---
  /** Twilio の inbound プレゼンテーションクロック。壁時計より正確で GC ポーズに汚染されない。 */
  private latestMediaTimestampMs = 0;
  /** 再生中のアシスタント item。 */
  private currentItemId: string | null = null;
  /** その item の初デルタを Twilio へ流した瞬間の inbound クロック値。 */
  private itemStartTimestampMs: number | null = null;
  /** その item について OpenAI から受け取った音声の総ミリ秒。audio_end_ms の安全弁。 */
  private itemGeneratedMs = 0;
  /** 送出済みで未返却の mark 名。「まだ再生中の音声があるか」の唯一の判定材料。 */
  private markQueue: string[] = [];
  /** 直近に mark を打った itemGeneratedMs。 */
  private markedUpToMs = 0;

  // --- 計測（納品物5の素材）---
  private inboundFrames = 0;
  private droppedInbound = 0;
  private audioDeltas = 0;
  private bargeInCount = 0;
  private truncateSkipped = 0;
  /**
   * 発信者が話し終わった時刻。発信者が体感する待ち時間の起点はここであって
   * speech_started ではない（そちらだと発話そのものの長さと VAD の無音待ちが
   * まるごと計上され、体感より大幅に長い値になる）。
   */
  private speechStoppedAtMs: number | null = null;
  private responseLatencies: number[] = [];
  private transcripts: string[] = [];
  private startedAtMs = 0;

  /** 受付内容。ツール引数が唯一の正で、文字起こしは業務データとして使わない。 */
  private readonly state = new ReceptionState();
  private toolCalls = 0;
  private toolRejections = 0;

  // --- 終話（complete_reception）---
  /** 受付完了。締めの挨拶を再生し終えたらソケットを閉じる。 */
  private hangupArmed = false;
  /** 締めの挨拶の音声が届き始めたか。 */
  private hangupAudioSeen = false;
  /** 締めの挨拶の生成が終わったか。 */
  private hangupResponseDone = false;
  /** mark が返らないまま止まった場合の保険。 */
  private hangupTimer: NodeJS.Timeout | null = null;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }

  async onStart(ctx: StreamContext): Promise<void> {
    this.ctx = ctx;
    this.startedAtMs = Date.now();
    this.log = this.log.child({ streamSid: ctx.streamSid, callSid: ctx.callSid });

    const today = jstToday();
    const tentativeDate = resolveTentativeDate(today);
    const instructions = buildInstructions({ today, tentativeDate });

    this.log.info(
      {
        model: config.openai.model,
        voice: config.openai.voice,
        vadSilenceMs: config.openai.vadSilenceMs,
        tentativeDate: formatJa(tentativeDate),
      },
      'Realtime ハンドラ開始',
    );

    const session = new OpenAiSession(this.log, {
      onReady: () => this.handleReady(),
      onAudioDelta: (payload, itemId) => this.handleAudioDelta(payload, itemId),
      onSpeechStarted: () => this.handleSpeechStarted(),
      onSpeechStopped: () => {
        this.speechStoppedAtMs = Date.now();
      },
      onIdleTimeout: () => this.log.info('無音タイムアウト（idle_timeout_ms）'),
      onTranscript: (text) => this.handleTranscript(text),
      onToolCall: (call) => this.handleToolCall(call),
      onResponseDone: (info) => this.handleResponseDone(info),
      onFatal: (reason) => this.handleFatal(reason),
    });
    this.session = session;

    try {
      // 接続完了までに届いた Twilio のフレームは media-stream.ts がキューしている。
      await session.connect(instructions);
    } catch (err) {
      this.log.error({ err }, 'OpenAI への接続に失敗しました。通話を終了します');
      this.ctx.send.close('openai-connect-failed');
      return;
    }
  }

  /**
   * session.updated の検証を通過した時点で挨拶の口火を切る。
   *
   * server_vad ではモデルは発信者の発話を待つため、これを送らないと
   * 着信直後は完全な無音になる。streamSid は onStart 時点で確定済みなので、
   * 公式サンプルにあるレース（streamSid 未確定で音声が捨てられる）は起きない。
   */
  private handleReady(): void {
    if (!this.session) return;
    this.session.createUserText('通話が接続されました。冒頭の挨拶を行ってください。');
    this.session.createResponse();
    this.log.info('挨拶の生成を要求しました');
  }

  onMedia(payloadBase64: string, timestampMs: number): void {
    this.latestMediaTimestampMs = timestampMs;
    this.inboundFrames += 1;
    if (!this.session || !this.session.isOpen) {
      this.droppedInbound += 1;
      return;
    }
    // トランスコードしない。Twilio の media.payload は既に base64 μ-law 8kHz で、
    // OpenAI の audio/pcmu と同一物（名前だけ audio/x-mulaw と audio/pcmu で違う）。
    this.session.appendAudio(payloadBase64);
  }

  /** AI の音声を Twilio へ流し、再生位置を追跡するための mark を打つ。 */
  private handleAudioDelta(payloadBase64: string, itemId: string): void {
    if (!this.ctx) return;
    this.audioDeltas += 1;

    if (itemId !== this.currentItemId) {
      // 新しいアシスタント item の開始
      this.currentItemId = itemId;
      this.itemStartTimestampMs = this.latestMediaTimestampMs;
      this.itemGeneratedMs = 0;
      this.markedUpToMs = 0;

      if (this.speechStoppedAtMs !== null) {
        this.responseLatencies.push(Date.now() - this.speechStoppedAtMs);
        this.speechStoppedAtMs = null;
      }
    }

    if (this.hangupArmed) this.hangupAudioSeen = true;

    this.itemGeneratedMs += payloadByteLength(payloadBase64) / MULAW_BYTES_PER_MS;
    this.ctx.send.media(payloadBase64);

    while (this.itemGeneratedMs - this.markedUpToMs >= MARK_INTERVAL_MS) {
      this.markedUpToMs += MARK_INTERVAL_MS;
      const name = `p-${itemId}-${this.markedUpToMs}`;
      this.markQueue.push(name);
      this.ctx.send.mark(name);
    }
  }

  /**
   * barge-in の唯一の起点。response.done は待たない
   * （response.cancelled というイベントは存在しない）。
   *
   * clear / truncate / リセットは必ず同じ同期ブロックで行う。途中で await すると
   * clear に誘発された Twilio の mark エコーが先に配送されて markQueue が壊れる。
   */
  private handleSpeechStarted(): void {
    // ゲート1: まだ再生されていない音声があるか。
    // これが無いと、再生が終わったあとの相槌（「はい」）のたびに
    // 過大な audio_end_ms で truncate を送りサーバーエラーになる。
    if (this.markQueue.length === 0) {
      this.truncateSkipped += 1;
      return;
    }
    // ゲート2: 計測の起点が有効か。0 は正当な起点なので truthy 判定にしない。
    if (this.itemStartTimestampMs === null || this.currentItemId === null || !this.ctx || !this.session) {
      this.truncateSkipped += 1;
      return;
    }

    const elapsedMs = this.latestMediaTimestampMs - this.itemStartTimestampMs;
    // itemGeneratedMs で頭打ちにすることで「audio_end_ms が実音声長を超える」
    // サーバーエラーを構造的に起こしえなくする。公式サンプルにはこの上限が無い。
    const audioEndMs = Math.max(0, Math.min(Math.round(elapsedMs), Math.floor(this.itemGeneratedMs)));

    // --- ここから同期ブロック。await しない ---
    this.ctx.send.clear(); // (1) 発信者に聞こえている音を止める
    this.session.truncate(this.currentItemId, audioEndMs); // (2) モデルの履歴を実際に聞こえた位置で切る
    this.resetPlaybackTracking(); // (3) 局所状態のリセット
    this.bargeInCount += 1;

    this.log.info({ audioEndMs, elapsedMs: Math.round(elapsedMs) }, 'barge-in');
  }

  onMark(name: string): void {
    // 通常は先頭だが、clear 後のエコーで順序が乱れうるので indexOf を使う。
    const idx = this.markQueue.indexOf(name);
    if (idx >= 0) this.markQueue.splice(idx, 1);
    if (this.markQueue.length === 0) {
      this.resetPlaybackTracking();
      this.maybeHangup();
    }
  }

  /**
   * 送出済み音声がすべて鳴り終わった時点でリセットする。
   *
   * 公式サンプルは通常終了時にこれをリセットしないため、2ターン目以降の barge-in で
   * 常にターン1の起点からの経過時間を送ることになり audio_end_ms が実音声長を
   * 大幅に超える。本フローは最低7ターンあるので、踏襲すると事実上すべての
   * barge-in が失敗する。
   */
  private resetPlaybackTracking(): void {
    this.currentItemId = null;
    this.itemStartTimestampMs = null;
    this.itemGeneratedMs = 0;
    this.markedUpToMs = 0;
    this.markQueue = [];
  }

  /**
   * ツール呼び出しを処理して結果を返す。
   *
   * 結果を返しただけではモデルは話し出さない。**必ず response.create を送る**。
   * これを忘れるとツール呼び出しのたびに AI が黙り込む（よくあるバグ）。
   */
  private handleToolCall(call: { callId: string; name: string; rawArgs: string }): void {
    if (!this.session) return;
    // 中断時にも同じ call が再送されうるため冪等化する。
    if (this.state.alreadyHandled(call.callId)) return;
    this.state.markHandled(call.callId);
    this.toolCalls += 1;

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.rawArgs) as Record<string, unknown>;
    } catch {
      this.log.warn({ rawArgs: call.rawArgs }, 'ツール引数を JSON として解釈できませんでした');
    }

    let output: unknown;
    switch (call.name) {
      case 'record_resident_info':
        output = this.state.recordResidentInfo(args);
        break;
      case 'record_response':
        output = this.state.recordResponse(args.type);
        break;
      case 'record_preferred_dates':
        output = this.state.recordPreferredDates(args);
        break;
      case 'complete_reception': {
        const result = this.state.complete();
        output = result;
        if (result.ok) this.armHangup();
        break;
      }
      default:
        output = { ok: false, error: 'unknown tool: ' + call.name };
        this.log.warn({ name: call.name }, '未知のツールが呼ばれました');
    }

    const res = output as { rejected?: unknown[] } | undefined;
    if (res && Array.isArray(res.rejected) && res.rejected.length > 0) this.toolRejections += 1;
    this.log.info({ tool: call.name, args, output }, 'ツール呼び出し');

    this.session.sendToolOutput(call.callId, output);
    // ツール結果を返しただけではモデルは話し出さない。必ず response.create を送る。
    this.session.createResponse();
  }

  /**
   * 受付完了。ここで即座に閉じてはいけない。
   * 締めの挨拶が Twilio の再生バッファに残ったままソケットを閉じると、
   * 未再生分が破棄されて発信者は途中で切られる。
   * 「生成が終わり、かつ送出済み音声がすべて鳴り終わった」時点で閉じる。
   */
  private armHangup(): void {
    this.hangupArmed = true;
    this.hangupAudioSeen = false;
    this.hangupResponseDone = false;
    this.log.info('受付完了。締めの挨拶の再生完了を待って終話します');
    // mark が返らないまま止まった場合でも通話を残さない。
    this.hangupTimer = setTimeout(() => {
      this.log.warn('締めの挨拶の再生完了を待てませんでした。強制的に終話します');
      this.finishCall();
    }, 20000);
  }

  private maybeHangup(): void {
    if (!this.hangupArmed || !this.hangupAudioSeen || !this.hangupResponseDone) return;
    if (this.markQueue.length > 0) return;
    this.finishCall();
  }

  /** ソケットを閉じる。通話を切るのではなく </Connect> 以降の TwiML へ進ませる。 */
  private finishCall(): void {
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    if (this.ctx) this.ctx.send.close('reception-completed');
  }

  private handleTranscript(text: string): void {
    this.transcripts.push(text);
    this.log.info({ text }, 'AI 発話');
  }

  private handleResponseDone(info: { responseId: string; status: string; reason?: string; usage?: unknown }): void {
    this.log.info({ status: info.status, reason: info.reason, usage: info.usage }, 'response.done');
    if (info.status === 'incomplete') {
      this.log.warn({ reason: info.reason }, '応答が途中で打ち切られました（max_output_tokens 超過の可能性）');
    }
    // 保険: 再生済みならここでもリセットしておく。
    if (this.markQueue.length === 0) this.resetPlaybackTracking();
    if (this.hangupArmed && info.status === 'completed') {
      this.hangupResponseDone = true;
      this.maybeHangup();
    }
  }

  private handleFatal(reason: string): void {
    this.log.error({ reason }, 'OpenAI 側で復帰不能な問題が発生しました。通話を終了します');
    if (this.ctx) this.ctx.send.close(reason);
  }

  onDtmf(digit: string): void {
    // OpenAI 側の DTMF イベントは SIP 専用で本ブリッジでは発火しない。ログのみ。
    this.log.info({ digit }, 'DTMF を受信');
  }

  onStop(): void {
    this.finish('twilio-stop');
  }

  onClose(code: number, reason: string): void {
    this.finish('ws-close');
    this.logSummary(code, reason);
  }

  private finish(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    if (this.session) this.session.close(reason);
  }

  private logSummary(code: number, reason: string): void {
    const wallMs = this.startedAtMs === 0 ? 0 : Date.now() - this.startedAtMs;
    const lat = this.responseLatencies;
    const avgLat = lat.length === 0 ? null : Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);

    this.log.info(
      {
        closeCode: code,
        closeReason: reason || '(empty)',
        wallClockMs: wallMs,
        inboundFrames: this.inboundFrames,
        droppedInbound: this.droppedInbound,
        audioDeltas: this.audioDeltas,
        bargeInCount: this.bargeInCount,
        truncateSkipped: this.truncateSkipped,
        marksOutstanding: this.markQueue.length,
        // 発話終了（speech_stopped）から AI の最初の音声が届くまで。
        // これが発信者の体感する待ち時間そのもの。
        responseLatencyMs: {
          samples: lat.length,
          avgMs: avgLat,
          minMs: lat.length ? Math.min(...lat) : null,
          maxMs: lat.length ? Math.max(...lat) : null,
        },
        aiUtterances: this.transcripts.length,
        toolCalls: this.toolCalls,
        toolRejections: this.toolRejections,
        collected: this.state.values,
        completed: this.state.isComplete,
        nextStep: this.state.nextStep,
      },
      'Realtime 通話サマリ（納品物5の素材）',
    );
    for (const t of this.transcripts) this.log.info({ text: t }, '会話ログ（AI発話）');
  }
}

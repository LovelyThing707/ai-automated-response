import WebSocket from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';

/**
 * OpenAI Realtime API (GA) への WebSocket クライアント。
 *
 * このファイルは OpenAI のワイヤ形式だけを知っている。Twilio のプロトコル、
 * markQueue、タイムスタンプ演算、業務状態は一切持たない。
 *
 * GA スキーマの要点（beta と混ぜると「エラー無しで無音」になる）:
 *  - session.type = 'realtime' は必須
 *  - 音声形式は session.audio.{input,output}.format = { type: 'audio/pcmu' }
 *    オブジェクトであって文字列ではない。'g711_ulaw' は beta の値。rate キーは無い
 *  - ノイズ抑制は session.audio.input.noise_reduction（既定 null = オフ）
 *  - modalities ではなく output_modalities
 *  - OpenAI-Beta ヘッダは付けない（付けると beta スキーマが選択される）
 *  - temperature は GA の session から削除された
 *
 * EventEmitter ではなくコールバック方式にしているのは、未処理の error イベントで
 * プロセスが落ちるのを避けるため（CLAUDE.md「通話中の例外でプロセスが落ちないこと」）。
 */

export interface OpenAiSessionEvents {
  /** session.updated の検証を通過した。ここまで来て初めて音声を流してよい。 */
  onReady(): void;
  /** AI の音声チャンク（base64 μ-law）。 */
  onAudioDelta(payloadBase64: string, itemId: string): void;
  /** 発信者が話し始めた。barge-in の唯一の起点。 */
  onSpeechStarted(): void;
  /** 発信者が話し終わった。ここからが発信者の体感待ち時間の起点。 */
  onSpeechStopped(): void;
  /** 無音が続いた（server_vad の idle_timeout_ms）。 */
  onIdleTimeout(): void;
  /** AI の発話内容（ログ用）。 */
  onTranscript(text: string, itemId: string): void;
  /** 応答が終わった。status は completed / cancelled / failed / incomplete。 */
  onResponseDone(info: { responseId: string; status: string; reason?: string; usage?: unknown }): void;
  /** 復帰不能。通話を終わらせる。 */
  onFatal(reason: string): void;
}

export class OpenAiSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private eventSeq = 0;

  /** 実際に届いた音声デルタのイベント名（GA/legacy のどちらか）。初回のみログする。 */
  private observedAudioEventName: string | null = null;

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly events: OpenAiSessionEvents,
  ) {}

  get isOpen(): boolean {
    return this.ready && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private nextEventId(prefix: string): string {
    this.eventSeq += 1;
    return `${prefix}_${this.eventSeq}`;
  }

  /**
   * 接続し、session.created を待って session.update を送り、
   * session.updated の検証まで通ったら resolve する。
   */
  async connect(instructions: string): Promise<void> {
    // model は URL のクエリ文字列だけで指定する。session.model と食い違うと
    // エラーにならないまま挙動が変わるため、単一の定数から組む。
    const url = 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(config.openai.model);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('OpenAI への接続が ' + config.openai.connectTimeoutMs + 'ms でタイムアウトしました'));
        }
      }, config.openai.connectTimeoutMs);

      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, {
          // Authorization のみ。OpenAI-Beta は付けない。
          headers: { Authorization: 'Bearer ' + config.openai.apiKey },
        });
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      ws.on('open', () => this.log.info({ model: config.openai.model }, 'OpenAI Realtime へ接続'));

      ws.on('message', (raw: Buffer) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          this.log.warn('OpenAI からのメッセージを JSON として解釈できませんでした');
          return;
        }
        try {
          this.dispatch(event, instructions, settle);
        } catch (err) {
          // 1つのイベント処理の失敗で通話全体を落とさない。
          this.log.error({ err, type: event.type }, 'OpenAI イベント処理中に例外');
        }
      });

      ws.on('error', (err: Error) => {
        this.log.error({ err }, 'OpenAI WebSocket エラー');
        const wasReady = this.ready;
        settle(new Error('OpenAI WebSocket エラー: ' + err.message));
        if (wasReady) this.events.onFatal('websocket-error: ' + err.message);
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        const reason = reasonBuf ? reasonBuf.toString('utf8') : '';
        this.log.info({ code, reason: reason || '(empty)' }, 'OpenAI WebSocket クローズ');
        const wasReady = this.ready;
        this.ready = false;
        settle(new Error('OpenAI が接続を閉じました (code=' + code + ')'));
        if (wasReady && !this.closed) this.events.onFatal('openai-closed-' + code);
      });
    });
  }

  private dispatch(
    event: Record<string, unknown>,
    instructions: string,
    settle: (err?: Error) => void,
  ): void {
    const type = typeof event.type === 'string' ? event.type : '';

    switch (type) {
      case 'session.created':
        // 100ms タイマーではなくこのイベントを契機に送る。
        this.send(this.buildSessionUpdate(instructions));
        return;

      case 'session.updated': {
        this.verifySession(event);
        this.ready = true;
        settle();
        this.events.onReady();
        return;
      }

      // 音声デルタ。GA は response.output_audio.delta、beta は response.audio.delta。
      // 名前を外すと「エラー無しの完全な無音」になり原因の切り分けが極めて困難なため、
      // 両方を受け、実際に届いた名前を初回だけログして経験的に確定させる。
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (this.observedAudioEventName === null) {
          this.observedAudioEventName = type;
          this.log.info({ audioEventName: type }, '音声デルタのイベント名を確定');
        }
        const delta = typeof event.delta === 'string' ? event.delta : '';
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        if (delta) this.events.onAudioDelta(delta, itemId);
        return;
      }

      case 'input_audio_buffer.speech_started':
        this.events.onSpeechStarted();
        return;

      case 'input_audio_buffer.speech_stopped':
        this.events.onSpeechStopped();
        return;

      case 'input_audio_buffer.timeout_triggered':
        this.events.onIdleTimeout();
        return;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = typeof event.transcript === 'string' ? event.transcript : '';
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        if (text) this.events.onTranscript(text, itemId);
        return;
      }

      case 'response.done': {
        const response = (event.response ?? {}) as Record<string, unknown>;
        const details = (response.status_details ?? {}) as Record<string, unknown>;
        this.events.onResponseDone({
          responseId: typeof response.id === 'string' ? response.id : '',
          status: typeof response.status === 'string' ? response.status : 'unknown',
          reason: typeof details.reason === 'string' ? details.reason : undefined,
          usage: response.usage,
        });
        return;
      }

      case 'conversation.item.truncated':
        this.log.debug('truncate が受理されました');
        return;

      case 'rate_limits.updated':
        this.log.debug({ rateLimits: event.rate_limits }, 'rate_limits.updated');
        return;

      case 'error': {
        const err = (event.error ?? {}) as Record<string, unknown>;
        // error.param が違反しているフィールドパス、error.event_id が自分が送った event_id。
        this.log.error(
          {
            code: err.code,
            message: err.message,
            param: err.param,
            forEventId: err.event_id,
          },
          'OpenAI error イベント',
        );
        const message = String(err.message ?? '');
        const code = String(err.code ?? '');
        // 認証・課金上限は復帰不能。通話を終わらせる。
        if (/insufficient_quota|invalid_api_key|billing|exceeded/i.test(code + ' ' + message)) {
          this.events.onFatal('openai-fatal: ' + (code || message));
        }
        return;
      }

      default:
        return;
    }
  }

  /** session.updated の実測値を検証する。設定が効いていないことに気付く唯一の手段。 */
  private verifySession(event: Record<string, unknown>): void {
    const session = (event.session ?? {}) as Record<string, unknown>;
    const audio = (session.audio ?? {}) as Record<string, unknown>;
    const input = (audio.input ?? {}) as Record<string, unknown>;
    const output = (audio.output ?? {}) as Record<string, unknown>;
    const inFormat = (input.format ?? {}) as Record<string, unknown>;
    const outFormat = (output.format ?? {}) as Record<string, unknown>;
    const noise = input.noise_reduction as Record<string, unknown> | null | undefined;
    const turn = (input.turn_detection ?? {}) as Record<string, unknown>;

    const actual = {
      inputFormat: inFormat.type,
      outputFormat: outFormat.type,
      noiseReduction: noise ? noise.type : null,
      turnDetection: turn.type,
      silenceMs: turn.silence_duration_ms,
      voice: output.voice,
      outputModalities: session.output_modalities,
    };
    this.log.info({ actual }, 'session.updated（実際に反映された設定）');

    if (inFormat.type !== 'audio/pcmu' || outFormat.type !== 'audio/pcmu') {
      this.log.error(
        { actual },
        '音声フォーマットが audio/pcmu になっていません。24kHz PCM として解釈され無音または高速ノイズになります',
      );
    }
    if (actual.noiseReduction !== 'near_field') {
      // 既定は null（オフ）。古いパスで送ると「エラー無しで無効のまま」になる最悪の失敗モード。
      this.log.error({ actual }, 'noise_reduction が near_field になっていません（設定が効いていません）');
    }
  }

  private buildSessionUpdate(instructions: string): Record<string, unknown> {
    const o = config.openai;
    return {
      type: 'session.update',
      event_id: this.nextEventId('sess'),
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            noise_reduction: { type: 'near_field' },
            turn_detection: {
              type: 'server_vad',
              threshold: o.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: o.vadSilenceMs,
              create_response: true,
              interrupt_response: true,
              idle_timeout_ms: o.vadIdleTimeoutMs,
            },
            ...(o.transcription
              ? { transcription: { model: o.transcriptionModel, language: 'ja' } }
              : {}),
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: o.voice,
            speed: o.outputSpeed,
          },
        },
        instructions,
        max_output_tokens: o.maxOutputTokens,
      },
    };
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  /** 発信者の音声を送る。base64 μ-law のまま素通しする（トランスコード不要）。 */
  appendAudio(payloadBase64: string): boolean {
    // フィールド名は audio。delta ではない。server_vad が自動確定するため commit は送らない。
    return this.send({ type: 'input_audio_buffer.append', audio: payloadBase64 });
  }

  /** barge-in: モデルの会話履歴を「実際に発信者へ聞こえた位置」で切る。 */
  truncate(itemId: string, audioEndMs: number): boolean {
    return this.send({
      type: 'conversation.item.truncate',
      event_id: this.nextEventId('trunc'),
      item_id: itemId,
      content_index: 0,
      audio_end_ms: audioEndMs,
    });
  }

  /** 会話に項目を追加する（挨拶の口火を切るときなど）。 */
  createUserText(text: string): boolean {
    return this.send({
      type: 'conversation.item.create',
      event_id: this.nextEventId('item'),
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  }

  /** 応答生成を明示的に要求する。 */
  createResponse(): boolean {
    return this.send({ type: 'response.create', event_id: this.nextEventId('resp') });
  }

  close(reason = 'normal'): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.log.info({ reason }, 'OpenAI セッションを閉じます');
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, reason);
    this.ws = null;
  }
}

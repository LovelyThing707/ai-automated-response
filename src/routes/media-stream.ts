import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { EchoHandler } from '../media/echo-handler.js';
import type { MediaHandler, StreamContext } from '../media/handler.js';
import {
  TRACK_INBOUND,
  num,
  parseInbound,
  type InboundMessage,
  type MediaMessage,
  type StartMessage,
} from '../twilio/protocol.js';
import { StreamSender } from '../twilio/sender.js';

function createHandler(log: FastifyInstance['log']): MediaHandler {
  switch (config.handler) {
    case 'echo':
      return new EchoHandler(log);
    case 'realtime':
      // config.ts の validateConfig で起動時に弾いているため、ここには来ない。
      throw new Error('MEDIA_HANDLER=realtime は Stage 2 で実装します');
  }
}

export function registerMediaStreamRoute(app: FastifyInstance): void {
  // { websocket: true } を付け忘れると通常の GET ルートとして 200 を返し、
  // Twilio 側は 101 が返らないため Error 31920 で失敗する。
  app.get('/media-stream', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const log = app.log.child({ component: 'media-stream', remote: request.ip });
    const sender = new StreamSender(socket, log);
    const handler = createHandler(log);

    let streamSid: string | null = null;
    let callSid: string | null = null;
    let closed = false;

    // onStart が非同期の場合（Stage 2 で OpenAI へ接続する等）、その間に届いた
    // メッセージを取りこぼすと通話冒頭の音声が欠ける。電話越しではマイク不良と
    // 区別がつかないため、明示的にキューする。
    let ready = false;
    const queue: InboundMessage[] = [];

    // sequenceNumber の欠落検出（音のブツ切りの原因切り分け用）
    let lastSeq = 0;
    let seqGaps = 0;
    // outbound トラックは <Connect><Stream> では届かない想定。届いたら前提が崩れている。
    let unexpectedTrackFrames = 0;

    const dispatch = (msg: InboundMessage): void => {
      switch (msg.event) {
        case 'media': {
          const m = msg as MediaMessage;
          // ここが Stage 1 最大の落とし穴。media イベントの track は "inbound"。
          // TwiML 属性値の "inbound_track" と比較すると一件もマッチせず、
          // エラーも出ないまま発信者には完全な無音になる。
          if (m.media.track !== TRACK_INBOUND) {
            unexpectedTrackFrames += 1;
            if (unexpectedTrackFrames === 1) {
              log.warn({ track: m.media.track }, 'inbound 以外のトラックを受信（想定外）');
            }
            return;
          }
          handler.onMedia(m.media.payload, num(m.media.timestamp));
          return;
        }
        case 'mark':
          handler.onMark(msg.mark.name);
          return;
        case 'dtmf':
          handler.onDtmf(msg.dtmf.digit);
          return;
        case 'stop':
          log.info({ seqGaps, unexpectedTrackFrames }, 'stop を受信');
          handler.onStop();
          return;
        default:
          return;
      }
    };

    const drain = (): void => {
      ready = true;
      while (queue.length > 0) {
        const msg = queue.shift();
        if (msg) dispatch(msg);
      }
    };

    // ---- リスナーは同期的に張る ----
    // @fastify/websocket の README が明記している通り、ハンドラ内で await した後に
    // on('message') を張ると、その間に届いたメッセージは黙って捨てられる。
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw as Buffer).toString('utf8');
        const msg = parseInbound(text);
        if (!msg) {
          log.warn({ preview: text.slice(0, 120) }, 'JSON として解釈できないメッセージ');
          return;
        }

        // sequenceNumber の欠落チェック（connected は持たない）
        if ('sequenceNumber' in msg && typeof msg.sequenceNumber === 'string') {
          const seq = num(msg.sequenceNumber);
          if (lastSeq !== 0 && seq !== lastSeq + 1) {
            seqGaps += 1;
            log.warn({ expected: lastSeq + 1, received: seq }, 'sequenceNumber が不連続');
          }
          lastSeq = seq;
        }

        switch (msg.event) {
          case 'connected': {
            // 必ず最初に届く。streamSid も sequenceNumber も持たないため、
            // ここで streamSid を読もうとすると undefined になる。
            log.info({ protocol: msg.protocol, version: msg.version }, 'connected');
            return;
          }
          case 'start': {
            const s = msg as StartMessage;
            streamSid = s.start.streamSid ?? s.streamSid;
            callSid = s.start.callSid;
            sender.bind(streamSid);

            const ctx: StreamContext = {
              streamSid,
              callSid,
              accountSid: s.start.accountSid,
              customParameters: s.start.customParameters ?? {},
              mediaFormat: s.start.mediaFormat,
              send: {
                media: (payload: string) => void sender.sendMedia(payload),
                mark: (name: string) => void sender.sendMark(name),
                clear: () => void sender.sendClear(),
                close: (reason?: string) => sender.closeStream(reason),
              },
            };

            log.info({ streamSid, callSid, tracks: s.start.tracks }, 'start を受信');

            // onStart が Promise を返す場合のみキューを使う。同期実装では即座に drain。
            const result = handler.onStart(ctx);
            if (result && typeof (result as Promise<void>).then === 'function') {
              (result as Promise<void>).then(drain).catch((err: unknown) => {
                log.error({ err }, 'onStart で例外。ストリームを終了します');
                sender.closeStream('onStart-error');
              });
            } else {
              drain();
            }
            return;
          }
          default: {
            if (!ready) {
              queue.push(msg);
              return;
            }
            dispatch(msg);
          }
        }
      } catch (err) {
        // メッセージ処理中の例外でプロセスを落とさない。通話1本を失うだけに留める。
        log.error({ err }, 'メッセージ処理中に例外');
      }
    });

    socket.on('error', (err: Error) => {
      log.error({ err }, 'WebSocket エラー');
    });

    // Twilio は "close" / "closed" という JSON イベントを送らない。
    // 公式サンプルの一部がそれを待っているが誤りで、終端は stop と
    // トランスポート層のクローズだけ。後片付けは必ずここで行う。
    socket.on('close', (code: number, reasonBuf: Buffer) => {
      if (closed) return;
      closed = true;
      const reason = reasonBuf?.toString('utf8') ?? '';
      log.info({ code, reason, streamSid, callSid, seqGaps, ...sender.stats }, 'WebSocket クローズ');
      try {
        handler.onClose(code, reason);
      } catch (err) {
        log.error({ err }, 'onClose で例外');
      }
    });

    // Twilio が ping を送るかは未文書化。実測してログに残す。
    socket.on('ping', () => log.debug('ping を受信'));
  });
}

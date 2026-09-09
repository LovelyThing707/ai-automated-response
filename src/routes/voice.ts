import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { verifyTwilioSignature } from '../twilio/signature.js';
import { buildVoiceTwiML, resolveHostname } from '../twilio/twiml.js';

/**
 * 着信 webhook。Twilio が「A CALL COMES IN」で呼ぶ。
 *
 * GET/POST 両対応にしている理由: ブラウザで開いて TwiML を目視確認できるようにするため。
 * Twilio 公式の古いサンプルは POST 限定で、ブラウザで開くと空が返るため
 * 「サーバーが壊れている」と毎回誤診される。
 * ただし署名検証は GET と POST でハッシュ計算方法が異なる点に注意
 * （POST はフォームパラメータを連結、GET はクエリ文字列を含むURLのみ）。
 */
export function registerVoiceRoute(app: FastifyInstance): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = (request.method === 'POST'
      ? (request.body as Record<string, unknown> | undefined)
      : (request.query as Record<string, unknown> | undefined)) ?? {};

    const sig = verifyTwilioSignature(request, request.method === 'POST' ? params : {});
    if (sig.checked && !sig.valid) {
      request.log.warn({ url: sig.url, reason: sig.reason, mode: config.twilio.signatureMode }, '署名検証に失敗');
      if (config.twilio.signatureMode === 'enforce') {
        return reply.code(403).type('text/plain').send('invalid signature');
      }
    } else if (sig.checked) {
      request.log.info({ url: sig.url }, '署名検証 OK');
    }

    const hostname = resolveHostname(request.headers.host);
    const callSid = typeof params.CallSid === 'string' ? params.CallSid : undefined;
    const from = typeof params.From === 'string' ? params.From : undefined;
    const to = typeof params.To === 'string' ? params.To : undefined;

    // Stage 3 以降はここで仮予約日などを <Parameter> に載せる。
    // クエリ文字列は Error 31920 になるため、これが通話ごとの値を渡す唯一の手段。
    const twiml = buildVoiceTwiML({ hostname, parameters: { stage: '1' } });

    request.log.info({ callSid, from, to, hostname, method: request.method }, '着信 → TwiML を返却');
    return reply.code(200).type('text/xml; charset=utf-8').send(twiml);
  };

  app.get('/voice', handler);
  app.post('/voice', handler);
}

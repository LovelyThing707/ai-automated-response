import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * <Stream statusCallback> の受け口。
 *
 * Stage 1 でストリームが張れないとき、原因が見える数少ない場所のひとつ。
 * 31920 / 31921 / 31924 / 31930 / 31931 / 31941 / 31950 / 31951 は
 * いずれも WebSocket 上には現れず、Twilio Console Debugger か
 * ここに届く StreamError にしか出ない。
 *
 * 注意: statusCallback のパラメータは PascalCase（StreamSid）。
 * WebSocket JSON の camelCase（streamSid）と混同しないこと。
 */
export function registerStreamStatusRoute(app: FastifyInstance): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as Record<string, unknown> | undefined) ?? {};
    const event = body.StreamEvent;
    const error = body.StreamError;

    const fields = {
      streamEvent: event,
      streamSid: body.StreamSid,
      streamName: body.StreamName,
      callSid: body.CallSid,
      accountSid: body.AccountSid,
      timestamp: body.Timestamp,
      streamError: error,
    };

    if (error) {
      request.log.error(fields, 'StreamError（ストリームが張れない場合はここに原因が出る）');
    } else {
      request.log.info(fields, 'StreamEvent');
    }
    return reply.code(204).send();
  };

  app.post('/stream-status', handler);
}

/** 任意。通話全体のステータス。Stage 5 で受付レコードの確定に使える。 */
export function registerCallStatusRoute(app: FastifyInstance): void {
  app.post('/call-status', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | undefined) ?? {};
    request.log.info(
      {
        callSid: body.CallSid,
        callStatus: body.CallStatus,
        from: body.From,
        to: body.To,
        duration: body.CallDuration,
      },
      'CallStatus',
    );
    return reply.code(204).send();
  });
}

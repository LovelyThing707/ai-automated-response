import type { FastifyBaseLogger } from 'fastify';

export interface CallLogContext {
  callSid?: string;
  streamSid?: string;
}

/**
 * 通話単位の子ロガー。callSid / streamSid を常に付けることで、
 * 複数通話が並行しても Console のログと突き合わせられるようにする。
 */
export function callLogger(base: FastifyBaseLogger, ctx: CallLogContext): FastifyBaseLogger {
  return base.child(ctx);
}

/** 認証情報をログに出さないための短縮表示。 */
export function redactSid(sid: string | undefined): string {
  if (!sid) return '(none)';
  return sid.length <= 10 ? sid : `${sid.slice(0, 6)}…${sid.slice(-4)}`;
}

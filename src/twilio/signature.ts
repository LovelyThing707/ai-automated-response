import twilio from 'twilio';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export interface SignatureResult {
  checked: boolean;
  valid: boolean;
  /** 検証に使用したURL（不一致時の切り分けに使う） */
  url: string;
  reason?: string;
}

/**
 * Twilio が公開URLとして呼んだであろう絶対URLを復元する。
 * トンネル配下では x-forwarded-proto / x-forwarded-host を見ないと
 * http://localhost:3000/... になってしまい、署名が必ず不一致になる。
 */
export function reconstructUrl(request: FastifyRequest): string {
  const headers = request.headers;
  const forwardedProto = (headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const host = config.publicHostname || forwardedHost || (headers.host as string | undefined) || '';
  const proto = forwardedProto ?? (config.publicHostname || forwardedHost ? 'https' : request.protocol);
  return `${proto}://${host}${request.url}`;
}

/**
 * X-Twilio-Signature を検証する。
 *
 * 本プロジェクトは Twilio REST API を一切呼ばないため、Auth Token の用途は
 * この検証ただ一つ。トークン未入手の間も開発を止めないよう、
 * off / log / enforce の3モードにしてある。
 */
export function verifyTwilioSignature(
  request: FastifyRequest,
  params: Record<string, unknown>,
): SignatureResult {
  const url = reconstructUrl(request);

  if (config.twilio.signatureMode === 'off') {
    return { checked: false, valid: true, url, reason: 'TWILIO_SIGNATURE_MODE=off' };
  }
  if (!config.twilio.authToken) {
    return { checked: false, valid: true, url, reason: 'TWILIO_AUTH_TOKEN が未設定' };
  }

  const signature = request.headers['x-twilio-signature'];
  if (typeof signature !== 'string') {
    return { checked: true, valid: false, url, reason: 'X-Twilio-Signature ヘッダが無い' };
  }

  const valid = twilio.validateRequest(
    config.twilio.authToken,
    signature,
    url,
    (params ?? {}) as Record<string, string>,
  );
  return { checked: true, valid, url, reason: valid ? undefined : '署名が一致しない' };
}

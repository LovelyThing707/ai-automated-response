import 'dotenv/config';

export type SignatureMode = 'off' | 'log' | 'enforce';
export type HandlerKind = 'echo' | 'realtime';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`環境変数 ${name} は数値である必要があります (現在値: "${raw}")`);
  }
  return Math.trunc(n);
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = str(name, fallback);
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`環境変数 ${name} は ${allowed.join(' | ')} のいずれかである必要があります (現在値: "${raw}")`);
  }
  return raw as T;
}

export const config = {
  port: int('PORT', 3000),
  /** Fastify の既定は 127.0.0.1。0.0.0.0 でないとトンネル経由で届かない。 */
  host: str('HOST', '0.0.0.0'),
  /** 空の場合はリクエストの Host ヘッダから wss URL を組む（ngrok の URL 変更に自己追従）。 */
  publicHostname: str('PUBLIC_HOSTNAME'),

  twilio: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    authToken: str('TWILIO_AUTH_TOKEN'),
    phoneNumber: str('TWILIO_PHONE_NUMBER'),
    signatureMode: oneOf('TWILIO_SIGNATURE_MODE', ['off', 'log', 'enforce'] as const, 'log'),
  },

  handler: oneOf('MEDIA_HANDLER', ['echo', 'realtime'] as const, 'echo'),
  echo: {
    batchFrames: Math.max(1, int('ECHO_BATCH_FRAMES', 1)),
    markEvery: Math.max(0, int('ECHO_MARK_EVERY', 25)),
  },

  logLevel: str('LOG_LEVEL', 'info'),
  logMediaFrames: Math.max(0, int('LOG_MEDIA_FRAMES', 20)),
} as const;

/**
 * 起動時に設定の不整合を検出する。
 * Stage 1 は Twilio 認証情報が無くても動く（署名検証を off/log にすればよい）ため、
 * 「本当に動かないもの」だけを致命的エラーにし、それ以外は警告として返す。
 */
export function validateConfig(): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (config.twilio.signatureMode === 'enforce' && !config.twilio.authToken) {
    fatal.push(
      'TWILIO_SIGNATURE_MODE=enforce ですが TWILIO_AUTH_TOKEN が未設定です。' +
        'すべての着信が 403 で拒否されます。トークンを設定するか log/off にしてください。',
    );
  }
  if (config.handler === 'realtime') {
    fatal.push('MEDIA_HANDLER=realtime は Stage 2 で実装します。現時点では echo のみ利用可能です。');
  }
  if (!config.twilio.authToken && config.twilio.signatureMode === 'log') {
    warnings.push(
      'TWILIO_AUTH_TOKEN が未設定のため署名検証をスキップします（Stage 1 では想定内）。' +
        'トークン入手後に .env へ設定し、動作確認後 TWILIO_SIGNATURE_MODE=enforce にしてください。',
    );
  }
  if (config.echo.batchFrames > 1) {
    warnings.push(
      `ECHO_BATCH_FRAMES=${config.echo.batchFrames} です。1 より大きい値は意図的に遅延を増やします（比較実験用）。`,
    );
  }
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    warnings.push('HOST が localhost です。トンネル経由の着信が届かない可能性があります。');
  }
  return { fatal, warnings };
}

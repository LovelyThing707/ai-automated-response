import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { config, validateConfig } from './config.js';
import { registerMediaStreamRoute } from './routes/media-stream.js';
import { registerCallStatusRoute, registerStreamStatusRoute } from './routes/stream-status.js';
import { registerVoiceRoute } from './routes/voice.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // 認証情報が誤ってログに出るのを防ぐ
      redact: ['req.headers.authorization', 'req.headers["x-twilio-signature"]'],
    },
    // Twilio は X-Forwarded-* を付けて来ないが、ngrok / リバースプロキシが付ける。
    // 署名検証で正しい公開URLを復元するために必要。
    trustProxy: true,
  });

  // Twilio の webhook は application/x-www-form-urlencoded
  await app.register(formbody);
  await app.register(websocket);

  app.get('/health', async () => ({
    status: 'ok',
    stage: 1,
    handler: config.handler,
    signatureMode: config.twilio.signatureMode,
  }));

  registerVoiceRoute(app);
  registerStreamStatusRoute(app);
  registerCallStatusRoute(app);
  registerMediaStreamRoute(app);

  return app;
}

async function main(): Promise<void> {
  const { fatal, warnings } = validateConfig();
  if (fatal.length > 0) {
    for (const message of fatal) console.error(`[設定エラー] ${message}`);
    process.exit(1);
  }

  const app = await buildServer();
  for (const message of warnings) app.log.warn(`[設定警告] ${message}`);

  // 通話中の例外でプロセスが落ちないこと（CLAUDE.md のエラー処理要件）。
  process.on('uncaughtException', (err) => app.log.error({ err }, 'uncaughtException'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandledRejection'));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'シャットダウンします');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });

  const hostHint = config.publicHostname || '<ngrokのホスト名>';
  app.log.info(
    {
      voiceWebhook: `https://${hostHint}/voice`,
      mediaStream: `wss://${hostHint}/media-stream`,
      streamStatus: `https://${hostHint}/stream-status`,
      handler: config.handler,
      echoBatchFrames: config.echo.batchFrames,
    },
    'Stage 1 サーバー起動完了',
  );
}

// このファイルが直接実行されたときだけ起動する（テストから import できるように）。
// Windows のパス区切りを正しく file:// URL へ変換するため pathToFileURL を使う。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly || process.env.START_SERVER === '1') {
  main().catch((err) => {
    console.error('起動に失敗しました:', err);
    process.exit(1);
  });
}

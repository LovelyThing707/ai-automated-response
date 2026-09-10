/**
 * OpenAI Realtime API への接続と session 設定を、実機通話なしで検証する。
 *
 * 音声を1バイトも流さないため課金はほぼ発生しない。
 * Stage 2 で最も危険なのは「GA スキーマの綴りを間違えてもエラーが出ず、
 * 設定が無効なまま通話が成立してしまう」ことなので、通話前にここで潰す。
 *
 *   npx tsx test/realtime-check.ts
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../src/config.js';
import { buildInstructions, resolveTentativeDate, formatJapaneseDate } from '../src/realtime/instructions.js';
import { OpenAiSession } from '../src/realtime/openai-session.js';

const lines: string[] = [];
const record = (obj: unknown, msg?: string): void => {
  const text = typeof obj === 'string' ? obj : msg ?? '';
  const data = typeof obj === 'string' ? undefined : obj;
  lines.push(`${text}${data ? ' ' + JSON.stringify(data) : ''}`);
  console.log(`  ${text}${data ? ' ' + JSON.stringify(data) : ''}`);
};

const logger = {
  info: record,
  warn: record,
  error: record,
  debug: () => {},
  fatal: record,
  trace: () => {},
  silent: () => {},
  level: 'info',
  child: () => logger,
} as unknown as FastifyBaseLogger;

async function main(): Promise<void> {
  if (!config.openai.apiKey) {
    console.error('OPENAI_API_KEY が未設定です (.env を確認してください)');
    process.exit(1);
  }

  const today = new Date();
  const tentativeDate = resolveTentativeDate(today);
  console.log(`model:          ${config.openai.model}`);
  console.log(`voice:          ${config.openai.voice}`);
  console.log(`tentative date: ${formatJapaneseDate(tentativeDate)}`);
  console.log('--- connecting ---');

  let ready = false;
  const session = new OpenAiSession(logger, {
    onReady: () => {
      ready = true;
    },
    onAudioDelta: () => {},
    onSpeechStarted: () => {},
    onIdleTimeout: () => {},
    onTranscript: () => {},
    onResponseDone: () => {},
    onFatal: (reason) => record(`FATAL: ${reason}`),
  });

  try {
    await session.connect(buildInstructions({ today, tentativeDate }));
  } catch (err) {
    console.error('\n接続に失敗しました:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const joined = lines.join('\n');
  const checks: Array<[string, boolean]> = [
    ['接続と session.updated の受信', ready],
    ['input format = audio/pcmu', /"inputFormat":"audio\/pcmu"/.test(joined)],
    ['output format = audio/pcmu', /"outputFormat":"audio\/pcmu"/.test(joined)],
    ['noise_reduction = near_field', /"noiseReduction":"near_field"/.test(joined)],
    ['turn_detection = server_vad', /"turnDetection":"server_vad"/.test(joined)],
    [`silence_duration_ms = ${config.openai.vadSilenceMs}`, joined.includes(`"silenceMs":${config.openai.vadSilenceMs}`)],
    ['output_modalities = ["audio"]', /"outputModalities":\["audio"\]/.test(joined)],
    ['tools が5つ登録されている', /"toolCount":5/.test(joined)],
    ['5ツールすべて登録されている', ['record_resident_info','record_response','record_preferred_dates','review_reception','complete_reception'].every(function (n) { return joined.indexOf(n) >= 0; })],
    ['スキーマ違反エラーが無い', !/OpenAI error/.test(joined)],
  ];

  console.log('\n--- results ---');
  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);

  session.close('check-done');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

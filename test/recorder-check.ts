/**
 * 録音（WAV 書き出し）を通話なしで検証する。
 *
 *   npm run test:recorder
 *
 * 音声の不具合は「再生してみるまで分からない」形で出るため、
 * ヘッダの各フィールドと左右チャンネルの分離をここで確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CallRecorder } from '../src/media/recorder.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const OUT_DIR = './data/_test-recordings';
fs.rmSync(OUT_DIR, { recursive: true, force: true });

/** n バイトぶんの μ-law ペイロード（すべて同じ値）を base64 で作る。 */
const payload = (byte: number, length: number): string =>
  Buffer.alloc(length, byte).toString('base64');

// μ-law の 0xFF はデジタル無音、0x00 は振幅最大（負側）
const SILENCE = 0xff;
const LOUD = 0x00;

console.log('--- μ-law の展開 ---');
{
  const r = new CallRecorder();
  r.writeCaller(payload(SILENCE, 160), 0);
  r.startAiItem(0);
  r.writeAi(payload(LOUD, 160));
  const file = r.save(OUT_DIR, 'decode.wav');
  const buf = fs.readFileSync(file);

  check('0xFF はデジタル無音（0）に展開される', buf.readInt16LE(44) === 0, String(buf.readInt16LE(44)));
  const aiSample = buf.readInt16LE(46);
  check('0x00 は大きな負の振幅に展開される', aiSample < -30000, String(aiSample));
}

console.log('\n--- WAV ヘッダ ---');
{
  const r = new CallRecorder();
  r.writeCaller(payload(SILENCE, 160), 0);
  const file = r.save(OUT_DIR, 'header.wav');
  const b = fs.readFileSync(file);

  check('RIFF ヘッダ', b.toString('ascii', 0, 4) === 'RIFF');
  check('WAVE 形式', b.toString('ascii', 8, 12) === 'WAVE');
  check('PCM（非圧縮）', b.readUInt16LE(20) === 1, String(b.readUInt16LE(20)));
  check('ステレオ 2ch', b.readUInt16LE(22) === 2, String(b.readUInt16LE(22)));
  check('サンプリング 8000Hz', b.readUInt32LE(24) === 8000, String(b.readUInt32LE(24)));
  check('16bit', b.readUInt16LE(34) === 16, String(b.readUInt16LE(34)));
  check('data チャンク', b.toString('ascii', 36, 40) === 'data');
  check(
    'data サイズがファイル長と整合',
    b.readUInt32LE(40) === b.length - 44,
    `${b.readUInt32LE(40)} vs ${b.length - 44}`,
  );
  check('RIFF サイズが整合', b.readUInt32LE(4) === b.length - 8);
}

console.log('\n--- 左右チャンネルの分離 ---');
{
  const r = new CallRecorder();
  // 発信者だけが 0.02 秒喋る
  r.writeCaller(payload(LOUD, 160), 0);
  // AI は別の時刻に喋る（1秒後）
  r.startAiItem(1000);
  r.writeAi(payload(LOUD, 160));
  const b = fs.readFileSync(r.save(OUT_DIR, 'stereo.wav'));

  const at = (ms: number): { left: number; right: number } => {
    const frame = 44 + ms * 8 * 4;
    return { left: b.readInt16LE(frame), right: b.readInt16LE(frame + 2) };
  };

  const t0 = at(0);
  check('0ms: 左（発信者）に音がある', t0.left < -30000, String(t0.left));
  check('0ms: 右（AI）は無音', t0.right === 0, String(t0.right));

  const t1000 = at(1000);
  check('1000ms: 左（発信者）は無音', t1000.left === 0, String(t1000.left));
  check('1000ms: 右（AI）に音がある', t1000.right < -30000, String(t1000.right));
}

console.log('\n--- barge-in で聞こえなかった分を残さない ---');
{
  const r = new CallRecorder();
  r.writeCaller(payload(SILENCE, 160), 0);
  r.startAiItem(0);
  // AI が 1 秒ぶん（8000サンプル = 8000バイト）生成した
  r.writeAi(payload(LOUD, 8000));
  // しかし実際に聞こえたのは最初の 200ms だけだった
  r.truncateAiTo(200);
  const b = fs.readFileSync(r.save(OUT_DIR, 'truncate.wav'));

  const rightAt = (ms: number): number => b.readInt16LE(44 + ms * 8 * 4 + 2);
  check('聞こえた範囲（100ms）は残る', rightAt(100) < -30000, String(rightAt(100)));

  // 200ms 以降は切り詰められているため、そもそもファイルに含まれないか無音
  const framesInFile = (b.length - 44) / 4;
  const sampleAt300ms = 300 * 8;
  const after = sampleAt300ms < framesInFile ? rightAt(300) : 0;
  check('聞こえなかった範囲（300ms）は残らない', after === 0, String(after));
}

console.log('\n--- 空の通話は保存対象にしない ---');
{
  const r = new CallRecorder();
  check('何も書いていなければ isEmpty', r.isEmpty === true);
  r.writeCaller(payload(SILENCE, 160), 0);
  check('書き込めば isEmpty ではない', r.isEmpty === false);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'すべて通過' : failed + ' 件失敗'}`);
process.exit(failed === 0 ? 0 : 1);

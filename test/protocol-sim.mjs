// Twilio Media Streams のメッセージ列をローカルで再現し、
// 実機通話の前にプロトコル処理を検証する。
import { WebSocket } from 'ws';

// SIM_BASE でトンネル越しの公開URLも検証できる（Twilio が実際に通る経路）
// 既定は .env の PORT 既定値と揃える（README は『サーバー起動中に別ターミナルで』と案内するため）
const PORT = process.env.SIM_PORT || process.env.PORT || '3000';
const BASE = process.env.SIM_BASE || `http://127.0.0.1:${PORT}`;
const WS_BASE = BASE.replace(/^http/, 'ws');
const results = [];
const ok = (n, c, d = '') => results.push({ n, c, d });

const STREAM_SID = 'MZ00000000000000000000000000000001';
const CALL_SID = 'CA00000000000000000000000000000001';
const ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// 160バイトの μ-law フレーム（無音は 0xFF）にダミーの波形を混ぜる
function frame(seed) {
  const b = Buffer.alloc(160, 0xff);
  for (let i = 0; i < 160; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b.toString('base64');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- HTTP エンドポイント ----
  const health = await fetch(`${BASE}/health`);
  ok('GET /health が 200', health.status === 200, `status=${health.status}`);

  // エコー固有の検証は MEDIA_HANDLER=echo のときだけ意味がある。
  // realtime モードでは AI が応答するため、音声は返ってくるが「入力と同一」にはならない。
  const handler = health.ok ? (await health.clone().json()).handler : 'unknown';
  const isEcho = handler === 'echo';
  if (!isEcho) {
    console.log('');
    console.log(`  [注記] サーバーは MEDIA_HANDLER=${handler} で動作中です。`);
    console.log('         音声のエコー検証はスキップします（プロトコルの検証のみ実施）。');
    console.log('         エコーも検証するには .env で MEDIA_HANDLER=echo にして再起動してください。');
    console.log('');
  }

  const voice = await fetch(`${BASE}/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: CALL_SID, From: '+819012345678', To: '+815017225690' }),
  });
  const twiml = await voice.text();
  ok('POST /voice が 200', voice.status === 200, `status=${voice.status}`);
  ok('Content-Type が text/xml', (voice.headers.get('content-type') || '').includes('text/xml'));
  ok('<Connect><Stream> を使用', /<Connect>\s*<Stream/.test(twiml));
  ok('<Start><Stream> を使っていない', !/<Start>/.test(twiml));
  ok('url が絶対 wss://', /url="wss:\/\/[^"]+"/.test(twiml));
  ok('url にクエリ文字列が無い (31920回避)', !/url="wss:\/\/[^"]*\?/.test(twiml));
  ok('track 属性を書いていない (31941回避)', !/<Stream[^>]*\strack=/.test(twiml));
  if (isEcho) {
    ok('<Say> が <Connect> より前', twiml.indexOf('<Say') < twiml.indexOf('<Connect>'));
  } else {
    // realtime では冒頭の <Say> を出さない。挨拶は AI が行うため、
    // ここで喋ると挨拶が二重になる（<Say> は outbound トラックで AI には聞こえない）。
    ok('realtime では冒頭に <Say> を置かない', twiml.indexOf('<Connect>') < twiml.indexOf('<Say'));
  }
  ok('</Connect> の後にも <Say> がある', twiml.lastIndexOf('<Say') > twiml.indexOf('</Connect>'));
  ok('Stream に name が付いている', /<Stream[^>]*\sname="[^"]+"/.test(twiml));
  ok('statusCallback が絶対URL', /statusCallback="https:\/\//.test(twiml));

  // ---- WebSocket ----
  let seq = 0;
  const ws = new WebSocket(`${WS_BASE}/media-stream`);
  const received = [];
  let binaryFrames = 0;

  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('WS接続タイムアウト')), 5000);
  });
  ok('wss ハンドシェイクが成立 (101)', true);

  ws.on('message', (data, isBinary) => {
    if (isBinary) binaryFrames++;
    const msg = JSON.parse(data.toString('utf8'));
    received.push(msg);
    // Twilio は mark を再生完了時に返す。それを模擬する。
    if (msg.event === 'mark') {
      ws.send(JSON.stringify({
        event: 'mark', sequenceNumber: String(++seq), streamSid: STREAM_SID, mark: { name: msg.mark.name },
      }));
    }
  });

  const send = (o) => ws.send(JSON.stringify({ ...o, sequenceNumber: String(++seq) }));

  // 1) connected — streamSid も sequenceNumber も持たない
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));

  // start より前に届いた media は送り返してはいけない（streamSid 未取得）
  await sleep(50);
  const beforeStart = received.length;

  // 2) start
  send({
    event: 'start',
    streamSid: STREAM_SID,
    start: {
      accountSid: ACCOUNT_SID, streamSid: STREAM_SID, callSid: CALL_SID,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: {},
    },
  });
  await sleep(50);

  // 3) media — track は "inbound"（"inbound_track" ではない）
  const sentPayloads = [];
  for (let i = 0; i < 30; i++) {
    const p = frame(i);
    sentPayloads.push(p);
    send({ event: 'media', streamSid: STREAM_SID,
      media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload: p } });
    await sleep(5);
  }

  // 4) outbound トラックのフレーム — エコーしてはいけない
  const outboundPayload = frame(999);
  send({ event: 'media', streamSid: STREAM_SID,
    media: { track: 'outbound', chunk: '31', timestamp: '600', payload: outboundPayload } });

  // 5) DTMF — dtmf だけ track が "inbound_track" 表記
  send({ event: 'dtmf', streamSid: STREAM_SID, dtmf: { track: 'inbound_track', digit: '5' } });
  await sleep(200);

  // 6) stop
  send({ event: 'stop', streamSid: STREAM_SID, stop: { accountSid: ACCOUNT_SID, callSid: CALL_SID } });
  await sleep(150);

  const media = received.filter((m) => m.event === 'media');
  const marks = received.filter((m) => m.event === 'mark');

  ok('start より前に送信しない', beforeStart === 0, `${beforeStart}件`);
  if (isEcho) ok('media を送り返した', media.length > 0, `${media.length}件`);
  ok('バイナリフレームを送っていない (31950回避)', binaryFrames === 0, `${binaryFrames}件`);

  const fieldsOk = media.every((m) => {
    const top = Object.keys(m).sort().join(',');
    const inner = Object.keys(m.media).sort().join(',');
    return top === 'event,media,streamSid' && inner === 'payload';
  });
  ok('media のフィールドが event/streamSid/media.payload の3つだけ (31951回避)', fieldsOk,
    fieldsOk ? '' : JSON.stringify(Object.keys(media[0] || {})) + ' / ' + JSON.stringify(Object.keys((media[0] || {}).media || {})));

  ok('全 media に streamSid が入っている', media.every((m) => m.streamSid === STREAM_SID));

  const echoed = Buffer.concat(media.map((m) => Buffer.from(m.media.payload, 'base64')));
  const expected = Buffer.concat(sentPayloads.map((p) => Buffer.from(p, 'base64')));
  if (isEcho) {
    ok('エコーされた音声バイト列が入力と完全一致', echoed.equals(expected),
      `echo=${echoed.length}B expected=${expected.length}B`);
  }

  const outBuf = Buffer.from(outboundPayload, 'base64');
  ok('outbound トラックをエコーしていない', !echoed.includes(outBuf));

  if (isEcho) ok('mark を送っている（バッファ深度計測）', marks.length > 0, `${marks.length}件`);
  const markFieldsOk = marks.every((m) => Object.keys(m).sort().join(',') === 'event,mark,streamSid'
    && Object.keys(m.mark).join(',') === 'name');
  ok('mark のフィールドが event/streamSid/mark.name のみ', markFieldsOk);

  ws.close();
  await sleep(150);

  // ---- 結果 ----
  let failed = 0;
  for (const r of results) {
    if (!r.c) failed++;
    console.log(`${r.c ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? `  (${r.d})` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SIM ERROR:', e); process.exit(1); });

/**
 * DB 層を通話なしで検証する。
 *
 *   npm run test:db
 *
 * **必ず専用のテストDBを使う。** config は import 時に DATABASE_PATH を読み切るため、
 * 環境変数を差し替えてから db モジュールを動的 import する。
 *
 * （以前ここを「config が _test を含まなければ環境変数を書き換える」実装にしたところ、
 *   config は既に確定済みで書き換えが効かず、最後の clearAllReceptions() が
 *   本番のデモDBを消した。同じ失敗を繰り返さないこと。）
 */
import fs from 'node:fs';

const TEST_DB = './data/_test.sqlite';
process.env.DATABASE_PATH = TEST_DB;

// 残骸を消してから始める（環境変数を設定した後、import より前に行う）
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(TEST_DB + suffix);
  } catch {
    /* 無ければよい */
  }
}

// ここで初めて読み込む。この時点の DATABASE_PATH が使われる。
const { clearAllReceptions, distinctBuildings, getReception, listReceptions, saveReception } =
  await import('../src/db/index.js');
const { config } = await import('../src/config.js');

type NewReception = Parameters<typeof saveReception>[0];

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// 保険: 万が一テストDB以外を掴んでいたら、何もせず止まる。
if (!config.databasePath.includes('_test')) {
  console.error(`安全のため中止します。テストDB以外を開いています: ${config.databasePath}`);
  process.exit(1);
}

const base: NewReception = {
  received_at: '2026-09-11T01:00:00.000Z',
  name_kana: 'やまだ たろう',
  phone: '09012345678',
  building: 'ライオンズマンション',
  room: '305',
  tentative_date: '2026-09-24',
  response_type: '変更希望',
  preferred_date_1: '2026-10-01',
  preferred_date_2: '2026-10-05',
  preferred_date_3: '2026-10-10',
  status: '受付完了',
  call_sid: 'CAtest0000000000000000000000000001',
};

console.log('--- 保存と読み出し ---');
saveReception(base);
check('1件保存された', listReceptions().length === 1);

const first = listReceptions()[0];
check('氏名が保存されている', first?.name_kana === 'やまだ たろう', String(first?.name_kana));
check('第三希望まで保存されている', first?.preferred_date_3 === '2026-10-10', String(first?.preferred_date_3));
check('受付状況が保存されている', first?.status === '受付完了', String(first?.status));

console.log('\n--- 同じ通話の再保存（上書き） ---');
saveReception({ ...base, room: '999', status: '受付完了' });
check('行が増えない（call_sid で一意）', listReceptions().length === 1, `${listReceptions().length}件`);
check('内容が上書きされる', listReceptions()[0]?.room === '999', String(listReceptions()[0]?.room));

console.log('\n--- 未完了の通話 ---');
saveReception({
  ...base,
  call_sid: 'CAtest0000000000000000000000000002',
  received_at: '2026-09-11T02:00:00.000Z',
  name_kana: 'すずき はなこ',
  phone: '08011112222',
  building: 'ネスペマンション',
  response_type: null,
  preferred_date_1: null,
  preferred_date_2: null,
  preferred_date_3: null,
  status: '受付未完了',
});
check('2件になった', listReceptions().length === 2);
check('新しい順に並ぶ', listReceptions()[0]?.name_kana === 'すずき はなこ', String(listReceptions()[0]?.name_kana));

console.log('\n--- 絞り込み ---');
check('マンション名で絞り込める', listReceptions({ building: 'ネスペマンション' }).length === 1);
check('受付状況で絞り込める', listReceptions({ status: '受付完了' }).length === 1);
check('氏名の部分一致で絞り込める', listReceptions({ q: 'すずき' }).length === 1);
check('電話番号の部分一致で絞り込める', listReceptions({ q: '0901234' }).length === 1);
check('部屋番号の部分一致で絞り込める', listReceptions({ q: '999' }).length === 1);
check('該当なしは0件', listReceptions({ building: 'テストマンション' }).length === 0);
check(
  '登録済みのマンション名だけ返す',
  JSON.stringify(distinctBuildings()) === JSON.stringify(['ネスペマンション', 'ライオンズマンション']),
  distinctBuildings().join(','),
);

console.log('\n--- 詳細取得 ---');
const id = listReceptions()[0]?.id ?? 0;
check('IDで取得できる', getReception(id)?.id === id);
check('存在しないIDは null', getReception(999999) === null);

console.log('\n--- 一括クリア ---');
const removed = clearAllReceptions();
check('2件削除された', removed === 2, `${removed}件`);
check('空になった', listReceptions().length === 0);

for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(config.databasePath + suffix);
  } catch {
    /* 無ければよい */
  }
}

console.log(`\n${failed === 0 ? 'すべて通過' : failed + ' 件失敗'}`);
process.exit(failed === 0 ? 0 : 1);

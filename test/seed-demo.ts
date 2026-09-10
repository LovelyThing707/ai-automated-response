/**
 * 管理画面の確認用に架空の受付データを投入する。
 *
 *   npx tsx test/seed-demo.ts
 *
 * CLAUDE.md の要件どおり、実在する個人情報は一切使わない。
 */
import { listReceptions, saveReception } from '../src/db/index.js';

const rows = [
  {
    received_at: '2026-09-11T00:12:00.000Z',
    name_kana: 'やまだ たろう', phone: '09012345678',
    building: 'ライオンズマンション', room: '305',
    tentative_date: '2026-09-24', response_type: '確定',
    preferred_date_1: null, preferred_date_2: null, preferred_date_3: null,
    status: '受付完了' as const, call_sid: 'CAdemo000000000000000000000000001',
  },
  {
    received_at: '2026-09-11T01:03:00.000Z',
    name_kana: 'すずき はなこ', phone: '08011112222',
    building: 'ネスペマンション', room: '1203',
    tentative_date: '2026-09-24', response_type: '変更希望',
    preferred_date_1: '2026-10-01', preferred_date_2: '2026-10-05', preferred_date_3: '2026-10-10',
    status: '受付完了' as const, call_sid: 'CAdemo000000000000000000000000002',
  },
  {
    received_at: '2026-09-11T02:41:00.000Z',
    name_kana: 'たなか いちろう', phone: '0455556666',
    building: 'テストマンション', room: '101',
    tentative_date: '2026-09-24', response_type: '辞退',
    preferred_date_1: null, preferred_date_2: null, preferred_date_3: null,
    status: '受付完了' as const, call_sid: 'CAdemo000000000000000000000000003',
  },
  {
    received_at: '2026-09-11T03:15:00.000Z',
    name_kana: 'さとう', phone: null,
    building: null, room: null,
    tentative_date: '2026-09-24', response_type: null,
    preferred_date_1: null, preferred_date_2: null, preferred_date_3: null,
    status: '受付未完了' as const, call_sid: 'CAdemo000000000000000000000000004',
  },
];

for (const r of rows) saveReception(r);
console.log(`投入しました。現在 ${listReceptions().length} 件`);

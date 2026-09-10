/**
 * 日付ユーティリティと受付状態機械を、通話なしで検証する。
 *
 * 日付の誤りは「AIが自信を持って間違った曜日を読み上げる」形で表面化するため、
 * 実機通話では気付きにくい。ここで潰しておく。
 *
 *   npx tsx test/flow-check.ts
 */
import {
  checkPreferredDate,
  formatJa,
  parseIsoDate,
  speakJa,
  weekdayOf,
  type CalendarDate,
} from '../src/realtime/dates.js';
import { ReceptionState } from '../src/realtime/reception-state.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const d = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });

console.log('--- 日付 ---');
// 2026-09-24 が木曜であることは Stage 2 の実機通話で確認済み。ここを基準に据える。
check('2026-09-24 は木曜日', weekdayOf(d(2026, 9, 24)) === '木', weekdayOf(d(2026, 9, 24)));
check('2026-09-10 は木曜日（2週間前）', weekdayOf(d(2026, 9, 10)) === '木', weekdayOf(d(2026, 9, 10)));
check('2026-09-25 は金曜日', weekdayOf(d(2026, 9, 25)) === '金', weekdayOf(d(2026, 9, 25)));
check('2026-01-01 は木曜日', weekdayOf(d(2026, 1, 1)) === '木', weekdayOf(d(2026, 1, 1)));
check('2028-02-29 は火曜日（閏日）', weekdayOf(d(2028, 2, 29)) === '火', weekdayOf(d(2028, 2, 29)));

check('復唱形式に曜日が入る', formatJa(d(2026, 9, 24)) === '9月24日（木曜日）', formatJa(d(2026, 9, 24)));
check('読み上げ形式に曜日が入る', speakJa(d(2026, 9, 24)) === '9月24日、木曜日', speakJa(d(2026, 9, 24)));

check('2026-02-30 は存在しない', parseIsoDate('2026-02-30') === null);
check('2026-04-31 は存在しない', parseIsoDate('2026-04-31') === null);
check('2027-02-29 は存在しない（平年）', parseIsoDate('2027-02-29') === null);
check('2028-02-29 は存在する（閏年）', parseIsoDate('2028-02-29') !== null);
check('形式違いを弾く', parseIsoDate('2026/9/24') === null);

const today = d(2026, 9, 10);
check('過去日を拒否', checkPreferredDate('2026-09-05', today).ok === false);
check('当日を拒否', checkPreferredDate('2026-09-10', today).ok === false);
check('翌日を受理', checkPreferredDate('2026-09-11', today).ok === true);
check('遠すぎる日付を拒否', checkPreferredDate('2027-09-11', today).ok === false);
const okDate = checkPreferredDate('2026-10-01', today);
check(
  '受理時に曜日つき readback を返す',
  okDate.ok && okDate.readback === '10月1日、木曜日',
  okDate.ok ? okDate.readback : 'rejected',
);

console.log('\n--- 状態機械: 確定パターン ---');
{
  const s = new ReceptionState(today);
  check('最初は name_kana を求める', s.nextStep.kind === 'slot' && s.nextStep.slot === 'name_kana');

  const r1 = s.recordResidentInfo({ name_kana: 'やまだ たろう' });
  check('かなの氏名を受理', r1.ok && r1.next === 'phone', r1.next);

  check('漢字混じりを拒否', s.recordResidentInfo({ name_kana: '山田太郎' }).ok === false);
  check('9桁の電話番号を拒否', s.recordResidentInfo({ phone: '090123456' }).ok === false);
  check('12桁の電話番号を拒否', s.recordResidentInfo({ phone: '090123456789' }).ok === false);
  check('10桁を受理（固定電話）', s.recordResidentInfo({ phone: '0312345678' }).ok === true);

  s.recordResidentInfo({ phone: '090-1234-5678' });
  check('ハイフンを除去して保持', s.values.phone === '09012345678', String(s.values.phone));

  check('候補外のマンション名を拒否', s.recordResidentInfo({ building: 'サンプルマンション' }).ok === false);
  s.recordResidentInfo({ building: 'ライオンズマンション' });
  s.recordResidentInfo({ room: '305' });
  check('4項目が揃うと回答区分を求める', s.nextStep.kind === 'response_type');

  check('不正な回答区分を拒否', s.recordResponse('maybe').ok === false);
  const rc = s.recordResponse('confirm');
  check('confirm を受理し完了へ進む', rc.ok && s.nextStep.kind === 'complete', rc.next);
  check('confirm では希望日を拒否', s.recordPreferredDates({ date1: '2026-10-01' }).ok === false);
  check('complete_reception が成功', s.complete().ok === true);
  check('完了フラグが立つ', s.isComplete === true);
}

console.log('\n--- 状態機械: 変更希望パターン ---');
{
  const s = new ReceptionState(today);
  check('4項目前に回答区分を拒否', s.recordResponse('change').ok === false);

  s.recordResidentInfo({ name_kana: 'すずき はなこ' });
  s.recordResidentInfo({ phone: '08011112222' });
  s.recordResidentInfo({ building: 'ネスペマンション' });
  s.recordResidentInfo({ room: '1203' });
  s.recordResponse('change');
  check('change なら第一希望を求める', s.nextStep.kind === 'preferred_date' && s.nextStep.index === 1);

  check('希望日が揃う前の完了を拒否', s.complete().ok === false);

  const p1 = s.recordPreferredDates({ date1: '2026-10-01' });
  check('第一希望を受理', p1.ok && p1.next === 'preferred_date_2', p1.next);
  check('readback に曜日が入る', p1.readback?.preferred_date_1 === '10月1日、木曜日', JSON.stringify(p1.readback));

  check('第一希望と同じ日を第二希望に拒否', s.recordPreferredDates({ date2: '2026-10-01' }).ok === false);
  s.recordPreferredDates({ date2: '2026-10-05' });
  check('第二希望のあと第三希望を求める', s.nextStep.kind === 'preferred_date' && s.nextStep.index === 3);

  check('第一希望だけで完了できる（第二・第三は任意）', s.complete().ok === true);
}

console.log('\n--- 状態機械: 辞退パターン ---');
{
  const s = new ReceptionState(today);
  s.recordResidentInfo({ name_kana: 'たなか いちろう' });
  s.recordResidentInfo({ phone: '0455556666' });
  s.recordResidentInfo({ building: 'テストマンション' });
  s.recordResidentInfo({ room: '101' });
  s.recordResponse('decline');
  check('decline なら希望日なしで完了へ', s.nextStep.kind === 'complete');
  check('decline で完了できる', s.complete().ok === true);

  const sum = s.summaryForReadback(d(2026, 9, 24));
  check('復唱まとめに仮予約日の曜日が入る', sum.tentative_date === '9月24日、木曜日', sum.tentative_date ?? '');
  check('復唱まとめの回答区分が日本語', sum.response_type === '辞退', sum.response_type ?? '');
}

console.log(`\n${failed === 0 ? 'すべて通過' : failed + ' 件失敗'}`);
process.exit(failed === 0 ? 0 : 1);

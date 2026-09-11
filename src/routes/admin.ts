import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  clearAllReceptions,
  distinctBuildings,
  getReception,
  listReceptions,
  type ReceptionRow,
} from '../db/index.js';
import { BUILDINGS } from '../realtime/instructions.js';
import { formatJa, parseIsoDate } from '../realtime/dates.js';

/**
 * 受付内容の確認用画面。
 *
 * 要件定義の指定どおり認証は無く、デザインにも凝らない。
 * スコープは「一覧・詳細・簡易検索/絞り込み・デモデータ一括クリア」の4つだけで、
 * 受付内容の編集や個別削除、工事日程の確定機能は**契約で対象外**。
 */

const STATUSES = ['受付完了', '受付未完了'] as const;

function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ISO(UTC) を日本時間の表示用文字列にする。 */
function formatReceivedAt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const jst = new Date(t + 9 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}/${p(jst.getUTCMonth() + 1)}/${p(jst.getUTCDate())} ` +
    `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
  );
}

/** YYYY-MM-DD を「9月24日（木曜日）」にする。空なら「—」。 */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = parseIsoDate(iso);
  return d ? formatJa(d) : iso;
}

function statusBadge(status: string): string {
  const done = status === '受付完了';
  const bg = done ? '#e7f4ec' : '#fdf1de';
  const fg = done ? '#1c6b3f' : '#8a5216';
  return `<span class="badge" style="background:${bg};color:${fg}">${esc(status)}</span>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}｜工事日程 受付管理</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f4f6f8; color: #16202e;
    font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
    font-size: 14px; line-height: 1.7;
  }
  header {
    background: #fff; border-bottom: 1px solid #dde3ea; padding: 14px 20px;
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; }
  header a { color: #1d4ed8; text-decoration: none; font-size: 13px; }
  header a:hover { text-decoration: underline; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px; }
  .card { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; }
  form.filters {
    display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;
    padding: 14px; margin-bottom: 16px;
  }
  form.filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6675; }
  select, input[type=text] {
    font: inherit; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff;
    min-width: 150px;
  }
  button {
    font: inherit; padding: 7px 14px; border-radius: 5px; border: 1px solid #1d4ed8;
    background: #1d4ed8; color: #fff; cursor: pointer;
  }
  button.secondary { background: #fff; color: #1d4ed8; }
  button.danger { background: #fff; color: #b42318; border-color: #f0b4ae; }
  button:hover { opacity: .9; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eef2f6; vertical-align: top; }
  th { background: #f8fafc; font-size: 12px; color: #5a6675; font-weight: 600; white-space: nowrap; }
  tbody tr:hover { background: #f8fbff; }
  td a { color: #1d4ed8; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .empty { padding: 40px 20px; text-align: center; color: #5a6675; }
  .count { color: #5a6675; font-size: 13px; }
  dl.detail { margin: 0; }
  dl.detail div { display: grid; grid-template-columns: 180px 1fr; gap: 12px; padding: 11px 16px; border-bottom: 1px solid #eef2f6; }
  dl.detail div:last-child { border-bottom: 0; }
  dl.detail dt { color: #5a6675; font-size: 13px; margin: 0; }
  dl.detail dd { margin: 0; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .table-wrap { overflow-x: auto; }
  @media (max-width: 640px) { dl.detail div { grid-template-columns: 1fr; gap: 2px; } }
</style>
</head>
<body>
<header>
  <h1>工事日程 受付管理</h1>
  <a href="/admin">一覧</a>
  <span class="count">社内確認用デモ</span>
</header>
<main>${body}</main>
</body>
</html>`;
}

function renderList(rows: ReceptionRow[], filter: { building: string; status: string; q: string }): string {
  // 絞り込み候補は、登録済みの値と 要件定義の3件を合わせて重複を除く
  const buildings = Array.from(new Set([...distinctBuildings(), ...BUILDINGS])).sort();

  const options = (values: readonly string[], selected: string): string =>
    ['<option value="">すべて</option>']
      .concat(
        values.map(
          (v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`,
        ),
      )
      .join('');

  const body = rows.length
    ? `<div class="card table-wrap"><table>
  <thead><tr>
    <th>受付日時</th><th>お名前</th><th>マンション名</th><th>部屋番号</th>
    <th>回答内容</th><th>受付状況</th><th></th>
  </tr></thead>
  <tbody>
  ${rows
    .map(
      (r) => `<tr>
    <td class="num">${esc(formatReceivedAt(r.received_at))}</td>
    <td>${esc(r.name_kana) || '—'}</td>
    <td>${esc(r.building) || '—'}</td>
    <td class="num">${esc(r.room) || '—'}</td>
    <td>${esc(r.response_type) || '—'}</td>
    <td>${statusBadge(r.status)}</td>
    <td><a href="/admin/receptions/${r.id}">詳細</a></td>
  </tr>`,
    )
    .join('\n')}
  </tbody></table></div>`
    : `<div class="card empty">該当する受付はありません。</div>`;

  return `
<form class="filters card" method="get" action="/admin">
  <label>マンション名
    <select name="building">${options(buildings, filter.building)}</select>
  </label>
  <label>受付状況
    <select name="status">${options(STATUSES, filter.status)}</select>
  </label>
  <label>キーワード（お名前・電話番号・部屋番号）
    <input type="text" name="q" value="${esc(filter.q)}" placeholder="例: やまだ">
  </label>
  <button type="submit">絞り込む</button>
  <button type="submit" class="secondary" name="reset" value="1" formnovalidate>条件をクリア</button>
</form>

<div class="toolbar">
  <span class="count">${rows.length} 件</span>
  <form method="post" action="/admin/clear" onsubmit="return confirm('デモデータをすべて削除します。この操作は取り消せません。よろしいですか？');">
    <button type="submit" class="danger">デモデータを一括クリア</button>
  </form>
</div>

${body}`;
}

function renderDetail(row: ReceptionRow): string {
  const item = (label: string, value: string): string =>
    `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  return `
<p><a href="/admin">← 一覧に戻る</a></p>
<div class="card"><dl class="detail">
  ${item('受付日時', esc(formatReceivedAt(row.received_at)))}
  ${item('お名前（かな）', esc(row.name_kana) || '—')}
  ${item('電話番号', `<span class="num">${esc(row.phone) || '—'}</span>`)}
  ${item('マンション名', esc(row.building) || '—')}
  ${item('部屋番号', `<span class="num">${esc(row.room) || '—'}</span>`)}
  ${item('仮予約日', esc(formatDate(row.tentative_date)))}
  ${item('回答内容', esc(row.response_type) || '—')}
  ${item('第一希望日', esc(formatDate(row.preferred_date_1)))}
  ${item('第二希望日', esc(formatDate(row.preferred_date_2)))}
  ${item('第三希望日', esc(formatDate(row.preferred_date_3)))}
  ${item('受付状況', statusBadge(row.status))}
  ${item('Call SID', `<span class="num">${esc(row.call_sid) || '—'}</span>`)}
</dl></div>`;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/admin', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const filter = q.reset
      ? { building: '', status: '', q: '' }
      : { building: q.building ?? '', status: q.status ?? '', q: q.q ?? '' };
    const rows = listReceptions({
      building: filter.building || undefined,
      status: filter.status || undefined,
      q: filter.q || undefined,
    });
    return reply.type('text/html; charset=utf-8').send(layout('受付一覧', renderList(rows, filter)));
  });

  app.get('/admin/receptions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getReception(Number(id));
    if (!row) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(layout('見つかりません', '<div class="card empty">該当する受付が見つかりません。<br><a href="/admin">一覧に戻る</a></div>'));
    }
    return reply.type('text/html; charset=utf-8').send(layout('受付詳細', renderDetail(row)));
  });

  app.post('/admin/clear', async (request: FastifyRequest, reply: FastifyReply) => {
    const removed = clearAllReceptions();
    request.log.warn({ removed }, 'デモデータを一括クリアしました');
    return reply.redirect('/admin', 303);
  });
}

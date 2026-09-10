import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * デモ用の受付データ保存。
 *
 * スキーマは CLAUDE.md の「データモデル」節をそのまま写したもの。
 * 日付は YYYY-MM-DD の文字列で保持する（SQLite に日付型は無く、
 * この形式なら文字列比較がそのまま日付順になる）。
 */

export type ReceptionStatus = '受付完了' | '受付未完了';

export interface ReceptionRow {
  id: number;
  received_at: string;
  name_kana: string | null;
  phone: string | null;
  building: string | null;
  room: string | null;
  tentative_date: string | null;
  response_type: string | null;
  preferred_date_1: string | null;
  preferred_date_2: string | null;
  preferred_date_3: string | null;
  status: ReceptionStatus;
  call_sid: string | null;
}

export type NewReception = Omit<ReceptionRow, 'id'>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receptions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at      TEXT NOT NULL,
  name_kana        TEXT,
  phone            TEXT,
  building         TEXT,
  room             TEXT,
  tentative_date   TEXT,
  response_type    TEXT,
  preferred_date_1 TEXT,
  preferred_date_2 TEXT,
  preferred_date_3 TEXT,
  status           TEXT NOT NULL,
  call_sid         TEXT
);
-- 同じ通話を二重に保存しないための保険。通話中の例外で保存経路が
-- 二度走る可能性があるため、call_sid で一意にしておく。
-- 部分インデックス（WHERE call_sid IS NOT NULL）にはしない。
-- SQLite の ON CONFLICT は部分インデックスを競合対象として指定できないため。
-- 通常の UNIQUE インデックスでも SQLite は NULL 同士を別物として扱うので、
-- call_sid が無い行は何件でも入る。
CREATE UNIQUE INDEX IF NOT EXISTS idx_receptions_call_sid ON receptions(call_sid);
CREATE INDEX IF NOT EXISTS idx_receptions_received_at ON receptions(received_at DESC);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const file = config.databasePath;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new Database(file);
  // 通話中の書き込みが読み取り（管理画面）でブロックされないように。
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

/**
 * 受付内容を保存する。同じ call_sid が既にあれば上書きする。
 *
 * 上書きにしている理由: 通話終了時（onStop / onClose）と受付完了時の
 * 両方から呼ばれうるため。完了時の内容で最終的に上書きされるのが正しい。
 */
export function saveReception(row: NewReception): number {
  const stmt = getDb().prepare(`
    INSERT INTO receptions (
      received_at, name_kana, phone, building, room,
      tentative_date, response_type,
      preferred_date_1, preferred_date_2, preferred_date_3,
      status, call_sid
    ) VALUES (
      @received_at, @name_kana, @phone, @building, @room,
      @tentative_date, @response_type,
      @preferred_date_1, @preferred_date_2, @preferred_date_3,
      @status, @call_sid
    )
    ON CONFLICT(call_sid) DO UPDATE SET
      received_at      = excluded.received_at,
      name_kana        = excluded.name_kana,
      phone            = excluded.phone,
      building         = excluded.building,
      room             = excluded.room,
      tentative_date   = excluded.tentative_date,
      response_type    = excluded.response_type,
      preferred_date_1 = excluded.preferred_date_1,
      preferred_date_2 = excluded.preferred_date_2,
      preferred_date_3 = excluded.preferred_date_3,
      status           = excluded.status
  `);
  const info = stmt.run(row);
  return Number(info.lastInsertRowid);
}

export interface ListFilter {
  building?: string;
  status?: string;
  /** 氏名・電話番号・部屋番号の部分一致 */
  q?: string;
}

export function listReceptions(filter: ListFilter = {}): ReceptionRow[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filter.building) {
    where.push('building = @building');
    params.building = filter.building;
  }
  if (filter.status) {
    where.push('status = @status');
    params.status = filter.status;
  }
  if (filter.q) {
    where.push('(name_kana LIKE @q OR phone LIKE @q OR room LIKE @q)');
    params.q = `%${filter.q}%`;
  }
  const sql =
    'SELECT * FROM receptions' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY received_at DESC, id DESC';
  return getDb().prepare(sql).all(params) as ReceptionRow[];
}

export function getReception(id: number): ReceptionRow | null {
  const row = getDb().prepare('SELECT * FROM receptions WHERE id = ?').get(id);
  return (row as ReceptionRow | undefined) ?? null;
}

/** デモデータ一括クリア。管理画面から確認ダイアログ付きで呼ぶ。 */
export function clearAllReceptions(): number {
  const info = getDb().prepare('DELETE FROM receptions').run();
  return info.changes;
}

/** 一覧の絞り込み用に、実際に登録されている値だけを返す。 */
export function distinctBuildings(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT building FROM receptions WHERE building IS NOT NULL ORDER BY building')
    .all() as Array<{ building: string }>;
  return rows.map((r) => r.building);
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * デモ用の受付データ保存。
 *
 * Node 組み込みの `node:sqlite` を使う。better-sqlite3 でも機能は足りるが、
 * あちらは binding.gyp を持つためインストール時に npm が node-gyp rebuild を
 * 自動実行し、Visual Studio が入っていない環境では **npm install 自体が失敗する**
 * （実際に納品ZIPからのクリーンインストールで node_modules が空になることを確認）。
 * 「クライアント環境で動かせること」が納品要件なので、ネイティブ依存を持たない
 * 組み込みモジュールを選ぶ。
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

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.databasePath;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  // 通話中の書き込みが読み取り（管理画面）でブロックされないように。
  db.exec('PRAGMA journal_mode = WAL');
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
  // node:sqlite の lastInsertRowid は bigint
  const info = stmt.run(row as unknown as Record<string, string | null>);
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
  const stmt = getDb().prepare(sql);
  const rows = Object.keys(params).length > 0 ? stmt.all(params) : stmt.all();
  return rows as unknown as ReceptionRow[];
}

export function getReception(id: number): ReceptionRow | null {
  const row = getDb().prepare('SELECT * FROM receptions WHERE id = ?').get(id);
  return (row as unknown as ReceptionRow | undefined) ?? null;
}

/** デモデータ一括クリア。管理画面から確認ダイアログ付きで呼ぶ。 */
export function clearAllReceptions(): number {
  const info = getDb().prepare('DELETE FROM receptions').run();
  return Number(info.changes);
}

/**
 * DB を閉じる。終了時に必ず呼ぶこと。
 *
 * WAL モードでは書き込みが -wal ファイルに残る。checkpoint せずに
 * .sqlite 単体をコピーすると、直近の受付が入っていない（空に見える）状態になる。
 * 納品ZIPやバックアップで実害が出るため、終了時に確実に畳む。
 */
export function closeDb(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } finally {
    db = null;
  }
}

/** 一覧の絞り込み用に、実際に登録されている値だけを返す。 */
export function distinctBuildings(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT building FROM receptions WHERE building IS NOT NULL ORDER BY building')
    .all() as unknown as Array<{ building: string }>;
  return rows.map((r) => r.building);
}

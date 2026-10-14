import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Abre o banco com os PRAGMAs do DATA_MODEL. Use ':memory:' nos testes. */
export function openDb(file: string, options: { readonly?: boolean } = {}): Db {
  if (file !== ':memory:' && !options.readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
  });
  if (!options.readonly && file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

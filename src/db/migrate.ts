import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index.ts';
import { nowUtcIso } from '../time.ts';

export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

type Migration = { version: number; name: string; sql: string };

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: Number(f.slice(0, 3)),
      name: f,
      sql: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
}

/** Aplica, em ordem e cada uma numa transação, as migrations ainda não registradas. */
export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
  const done: string[] = [];
  for (const m of loadMigrations(dir)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        nowUtcIso(),
      );
    })();
    done.push(m.name);
  }
  return done;
}

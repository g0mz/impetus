import type { Db } from '../index.ts';
import { nowUtcIso } from '../../time.ts';

export function getSetting<T>(db: Db, key: string): T | undefined {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  return v === undefined ? undefined : (JSON.parse(v) as T);
}

/** Grava (ou apaga, com `undefined`) e devolve o valor anterior. */
export function setSetting(db: Db, key: string, value: unknown): unknown {
  const before = getSetting<unknown>(db, key);
  if (value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), nowUtcIso());
  return before;
}

export function getSettingsByPrefix(db: Db, prefix: string): Record<string, unknown> {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'")
    .all(`${prefix.replace(/[%_\\]/g, '\\$&')}%`) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key.slice(prefix.length), JSON.parse(r.value) as unknown]));
}

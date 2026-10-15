import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execa } from 'execa';
import Database from 'better-sqlite3';
import type { Db } from '../db/index.ts';

export type BackupResult = { file: string; bytes: number; pruned: number; uploaded: boolean };

/**
 * Backup diário (DEPLOY.md §7): cópia consistente do SQLite (API de backup, funciona com WAL) →
 * gzip → retenção local de `keepDays` → envio opcional via rclone para `remote` (ex.: gcrypt:impetus).
 * `data/wa-auth` (credencial) nunca entra.
 */
export async function runBackup(o: {
  db: Db;
  backupsDir: string;
  localDate: string;
  keepDays?: number;
  remote?: string | undefined;
  mediaDir?: string;
  syncMedia?: boolean;
}): Promise<BackupResult> {
  fs.mkdirSync(o.backupsDir, { recursive: true });
  const raw = path.join(o.backupsDir, `impetus-${o.localDate}.db`);
  await o.db.backup(raw);
  const file = `${raw}.gz`;
  fs.writeFileSync(file, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }));
  fs.rmSync(raw);

  const keep = o.keepDays ?? 14;
  const cutoff = Date.now() - keep * 86400_000;
  let pruned = 0;
  for (const f of fs.readdirSync(o.backupsDir)) {
    const full = path.join(o.backupsDir, f);
    if (
      /^impetus-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f) &&
      full !== file &&
      fs.statSync(full).mtimeMs < cutoff
    ) {
      fs.rmSync(full);
      pruned++;
    }
  }

  let uploaded = false;
  if (o.remote) {
    await execa('rclone', ['copy', o.backupsDir, `${o.remote}/db/`, '--max-age', '48h'], {
      timeout: 20 * 60_000,
    });
    if (o.syncMedia && o.mediaDir && fs.existsSync(o.mediaDir))
      await execa('rclone', ['sync', o.mediaDir, `${o.remote}/media/`], { timeout: 60 * 60_000 });
    uploaded = true;
  }
  return { file, bytes: fs.statSync(file).size, pruned, uploaded };
}

/**
 * Restore (DEPLOY.md §7): descompacta um backup para `dest` e confere integridade e tabelas
 * essenciais. Não sobrescreve um banco existente.
 */
export function restoreBackup(gzFile: string, dest: string): { tables: number; meals: number; sets: number } {
  if (fs.existsSync(dest)) throw new Error(`${dest} já existe; mova-o antes de restaurar`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zlib.gunzipSync(fs.readFileSync(gzFile)));
  const db = new Database(dest);
  try {
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity_check: ${String(check)}`);
    const tables = db
      .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .get() as number;
    const count = (t: string) => db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number;
    return { tables, meals: count('meals'), sets: count('sets') };
  } finally {
    db.close();
  }
}

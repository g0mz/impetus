import fs from 'node:fs';
import path from 'node:path';

export type AuthDirState = 'none' | 'registered' | 'incomplete';

/** Estado da sessão do Baileys em disco: sem sessão, vinculada, ou incompleta/corrompida (gera 401). */
export function inspectAuthDir(dir: string): AuthDirState {
  const file = path.join(dir, 'creds.json');
  if (!fs.existsSync(file)) return 'none';
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { registered?: boolean; me?: unknown };
    return c.registered && c.me ? 'registered' : 'incomplete';
  } catch {
    return 'incomplete';
  }
}

/** Tira uma sessão incompleta do caminho sem apagar (renomeia para `<dir>.bak-<timestamp>`). */
export function setAsideAuthDir(dir: string, now = new Date()): string {
  const dest = `${dir}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(dir, dest);
  return dest;
}

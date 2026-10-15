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

const validCreds = (file: string) => {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { registered?: boolean; me?: unknown };
    return Boolean(c.registered && c.me);
  } catch {
    return false;
  }
};

/** Guarda uma cópia do creds.json quando ele está válido (escrita atômica: tmp + rename). */
export function backupCreds(dir: string): boolean {
  const file = path.join(dir, 'creds.json');
  if (!validCreds(file)) return false;
  const tmp = path.join(dir, 'creds.json.bak.tmp');
  fs.copyFileSync(file, tmp);
  fs.renameSync(tmp, path.join(dir, 'creds.json.bak'));
  return true;
}

/**
 * creds.json vazio/corrompido (queda de energia, processo morto no meio da escrita) mas com cópia válida:
 * restaura a cópia e evita ter de parear de novo. Devolve true se restaurou.
 */
export function recoverCreds(dir: string): boolean {
  const file = path.join(dir, 'creds.json');
  const bak = path.join(dir, 'creds.json.bak');
  if (!fs.existsSync(file) || validCreds(file) || !validCreds(bak)) return false;
  fs.copyFileSync(bak, file);
  return true;
}

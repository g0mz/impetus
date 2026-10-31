import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Grava só se o conteúdo mudou (não mexe no mtime nem acorda o Syncthing à toa), de forma atômica:
 * arquivo temporário no mesmo diretório + rename. O `.stignore` do cofre deve excluir `*.tmp`.
 */
export function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return true;
}

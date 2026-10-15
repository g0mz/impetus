import fs from 'node:fs';
import path from 'node:path';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Uma instância por DATA_DIR: duas cópias com a mesma sessão do WhatsApp derrubam o vínculo e
 * disputam as portas. Devolve a função que libera a trava.
 */
export function acquireInstanceLock(dataDir: string, pid = process.pid): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'impetus.lock');
  const other = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : NaN;
  if (Number.isInteger(other) && other !== pid && alive(other))
    throw new Error(
      `já existe um Impetus rodando com este DATA_DIR (pid ${other}). Pare-o antes de iniciar outro.`,
    );
  fs.writeFileSync(file, String(pid));
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file);
    } catch {
      /* já removido */
    }
  };
}

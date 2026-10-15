import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Salva o áudio recebido como veio (WhatsApp/Telegram: OGG/Opus) em data/media/AAAA/MM. */
export function saveAudio(input: Buffer, mediaDir: string, ext = 'ogg', now = new Date()): string {
  const dir = path.join(
    mediaDir,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(file, input);
  return file;
}

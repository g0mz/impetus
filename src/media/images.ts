import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const MAX_SIDE = 1568;

/**
 * Normaliza e salva uma imagem (ARCHITECTURE.md §4.1): aplica a rotação do EXIF, limita o lado
 * maior a 1568 px, converte para JPEG q85 e descarta metadados (EXIF/GPS). Devolve o caminho absoluto.
 */
export async function saveNormalizedImage(
  input: Buffer,
  mediaDir: string,
  now = new Date(),
): Promise<string> {
  const dir = path.join(
    mediaDir,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.jpg`);
  await sharp(input)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(file);
  return file;
}

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ManifestEntry = { sha256: string; source: string; license: string };
export type Manifest = { files: Record<string, ManifestEntry> };

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Confere os arquivos de seeds/ contra seeds/vendor/manifest.json. Arquivo ausente ou com hash
 * diferente interrompe o seed: dado alterado sem revisão não entra no banco.
 */
export function verifyVendor(seedsDir: string): Manifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(seedsDir, 'vendor', 'manifest.json'), 'utf8')) as Manifest;
  const problems: string[] = [];
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const file = path.join(seedsDir, rel);
    if (!fs.existsSync(file)) problems.push(`${rel}: ausente`);
    else if (sha256File(file) !== entry.sha256) problems.push(`${rel}: sha256 diferente do manifest`);
  }
  if (problems.length) throw new Error(`Dados de seed não conferem:\n  - ${problems.join('\n  - ')}`);
  return manifest;
}

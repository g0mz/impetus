// Copia arquivos que o tsc não emite (migrations SQL) para dist/.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
fs.cpSync(path.join(root, 'src/db/migrations'), path.join(root, 'dist/db/migrations'), { recursive: true });

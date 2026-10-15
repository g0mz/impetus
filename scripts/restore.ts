// Restaura um backup: `npm run restore -- data/backups/impetus-2026-10-14.db.gz [destino]`.
// Padrão do destino: data/impetus.db (precisa não existir; pare o serviço e mova o banco atual antes).
import path from 'node:path';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { restoreBackup } from '../src/ops/backup.ts';

await runCli(async () => {
  const [file, dest] = process.argv.slice(2);
  if (!file) {
    console.error('Uso: npm run restore -- <backup.db.gz> [destino]');
    process.exitCode = 1;
    return;
  }
  const target = path.resolve(dest ?? loadConfig().dbPath);
  const r = restoreBackup(path.resolve(file), target);
  console.log(
    `✅ Restaurado em ${target}: ${r.tables} tabelas, ${r.meals} refeições, ${r.sets} séries (integrity ok).`,
  );
  console.log('Depois: refaça o vínculo do WhatsApp (npm run wa:link) se a pasta wa-auth não veio junto.');
});

// Gera os diários de todos os dias que já estão no banco (idempotente: só grava o que mudou).
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { messageDays, writeDiary } from '../src/vault/diary.ts';

const config = loadConfig();
if (!config.VAULT_DIR) {
  console.error('Defina VAULT_DIR (caminho absoluto do cofre) no ambiente.');
  process.exit(1);
}
const db = openDb(config.dbPath, { readonly: true });
const o = { cutoffHour: config.DAY_CUTOFF_HOUR, timeZone: config.TZ };
let written = 0;
for (const day of messageDays(db, o)) if (writeDiary(db, config.VAULT_DIR, day, o)) written++;
console.log(`${written} diário(s) gravado(s) em ${config.VAULT_DIR}/impetus/diario`);

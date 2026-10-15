import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTurn, finishTurn } from '../../src/db/repos/turns.ts';
import { createLogger } from '../../src/logger.ts';
import { restoreBackup, runBackup } from '../../src/ops/backup.ts';
import { buildJobs, runJob } from '../../src/scheduler/jobs.ts';
import { seedReportWeek } from '../fixtures/report-week.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

const logger = createLogger('silent');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
const NOW = '2026-10-18T23:00:00Z';

describe('backup e restore', () => {
  it('backup gzip consistente, restore com integridade e os mesmos dados', async () => {
    const dir = tmp();
    const file = path.join(dir, 'live.db');
    const { db: mem, ex } = makeDb();
    // banco em arquivo (o backup do better-sqlite3 exige arquivo ou memória; usamos arquivo como em produção)
    await mem.backup(file);
    mem.close();
    const { openDb } = await import('../../src/db/index.ts');
    const db = openDb(file);
    seedReportWeek(db, { now: NOW, remada: ex.remada!, supino: ex.supInc! });

    const backupsDir = path.join(dir, 'backups');
    const old = path.join(backupsDir, 'impetus-2026-01-01.db.gz');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(old, 'x');
    fs.utimesSync(old, new Date('2026-01-02'), new Date('2026-01-02'));

    const r = await runBackup({ db, backupsDir, localDate: '2026-10-18', keepDays: 14 });
    expect(path.basename(r.file)).toBe('impetus-2026-10-18.db.gz');
    expect(r).toMatchObject({ pruned: 1, uploaded: false });
    expect(fs.existsSync(old)).toBe(false);

    const dest = path.join(dir, 'restored', 'impetus.db');
    expect(restoreBackup(r.file, dest)).toMatchObject({ meals: 12, sets: 18 });
    expect(() => restoreBackup(r.file, dest)).toThrow(/já existe/);
    db.close();
  });
});

describe('alerta de turnos falhando', () => {
  it('avisa com ≥ 3 falhas em 2 h, no máximo a cada 6 h', async () => {
    const { db } = makeDb();
    for (let k = 0; k < 3; k++) {
      const id = createTurn(db, 'chat', '2026-10-18T22:00:00Z');
      finishTurn(db, id, { status: 'failed' }, '2026-10-18T22:30:00Z');
    }
    const sent: string[] = [];
    const jobs = buildJobs({
      db,
      logger,
      timeZone: SETTINGS.timeZone,
      cutoffHour: 4,
      notify: async (t) => void sent.push(t),
      report: async () => ({ text: 'x', reportId: 1 }),
      retryTurn: async () => false,
      config: {
        REPORT_DAILY: false,
        REPORT_DAILY_TIME: '21:30',
        REPORT_WEEKLY_CRON: '0 20 * * 0',
        REPORT_MONTHLY_CRON: '0 9 1 * *',
        HC_STALE_HOURS: 48,
        DATA_DIR: '.',
      },
    });
    const job = jobs.find((j) => j.name === 'alert.turns_failing')!;
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    await runJob(deps, job, NOW);
    await runJob(deps, job, '2026-10-18T23:30:00Z');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('3 mensagens falharam');
  });
});

describe('trava de instância única', () => {
  it('recusa segunda instância viva; aceita trava órfã; libera ao parar', async () => {
    const { acquireInstanceLock } = await import('../../src/ops/lock.ts');
    const dir = tmp();
    const release = acquireInstanceLock(dir);
    expect(() => acquireInstanceLock(dir, process.pid + 1)).toThrow(/já existe um Impetus rodando/);
    release();
    fs.writeFileSync(path.join(dir, 'impetus.lock'), '999999'); // pid morto
    const r2 = acquireInstanceLock(dir);
    r2();
    expect(fs.existsSync(path.join(dir, 'impetus.lock'))).toBe(false);
  });
});

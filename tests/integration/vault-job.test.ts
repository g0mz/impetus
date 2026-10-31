import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { insertMessage } from '../../src/db/repos/messages.ts';
import { createLogger } from '../../src/logger.ts';
import { buildJobs, runJob } from '../../src/scheduler/jobs.ts';
import { makeDb } from '../helpers.ts';

const logger = createLogger('silent');
const baseConfig = {
  REPORT_DAILY: false,
  REPORT_DAILY_TIME: '21:30',
  REPORT_WEEKLY_CRON: '0 20 * * 0',
  REPORT_MONTHLY_CRON: '0 9 1 * *',
  HC_STALE_HOURS: 48,
  DATA_DIR: os.tmpdir(),
};

function jobsFor(db: ReturnType<typeof makeDb>['db'], vaultDir?: string) {
  return buildJobs({
    db,
    logger,
    timeZone: 'America/Sao_Paulo',
    cutoffHour: 4,
    notify: async () => undefined,
    report: async () => ({ text: '', reportId: 0 }),
    retryTurn: async () => false,
    config: { ...baseConfig, ...(vaultDir ? { VAULT_DIR: vaultDir } : {}) },
  });
}

describe('job vault.diary', () => {
  it('só existe com VAULT_DIR', () => {
    const { db } = makeDb();
    expect(jobsFor(db).some((j) => j.name === 'vault.diary')).toBe(false);
    expect(jobsFor(db, os.tmpdir()).some((j) => j.name === 'vault.diary')).toBe(true);
  });

  it('roda pelo runJob e grava o diário', async () => {
    const { db } = makeDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-job-'));
    insertMessage(db, {
      channel: 'telegram',
      direction: 'in',
      external_id: 'x1',
      kind: 'text',
      text: 'treinei peito',
      created_at: '2026-10-30T15:00:00Z',
    });
    const job = jobsFor(db, dir).find((j) => j.name === 'vault.diary')!;
    expect(
      await runJob({ db, logger, timeZone: 'America/Sao_Paulo', cutoffHour: 4 }, job, '2026-10-30T20:00:00Z'),
    ).toBe('ran');
    expect(fs.readFileSync(path.join(dir, 'impetus', 'diario', '2026-10-30.md'), 'utf8')).toContain(
      'treinei peito',
    );
  });
});

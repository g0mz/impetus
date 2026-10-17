import { describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../../src/db/repos/settings.ts';
import type { RunTurn } from '../../src/gateway/turn-runner.ts';
import { createLogger } from '../../src/logger.ts';
import { addDays } from '../../src/time.ts';
import { buildReportBrief, reportPeriod } from '../../src/reports/build.ts';
import { generateReport } from '../../src/reports/service.ts';
import { buildJobs, runJob, type JobDef } from '../../src/scheduler/jobs.ts';
import { seedReportWeek } from '../fixtures/report-week.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

const logger = createLogger('silent');
// Domingo 18/10/2026, 20:00 em São Paulo → semana seg 12/10 – dom 18/10.
const NOW = '2026-10-18T23:00:00Z';

describe('relatório semanal', () => {
  it('período seg–dom e mês anterior', () => {
    expect(reportPeriod('weekly', '2026-10-18')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    expect(reportPeriod('weekly', '2026-10-12')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    expect(reportPeriod('monthly', '2026-01-01')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
  });

  it('brief com números conhecidos e fallback sem cérebro (snapshot)', async () => {
    const { db, ex } = makeDb();
    seedReportWeek(db, { now: NOW, remada: ex.remada!, supino: ex.supInc! });
    const r = await generateReport({
      db,
      kind: 'weekly',
      now: NOW,
      cutoffHour: 4,
      timeZone: SETTINGS.timeZone,
      logger,
    });
    expect(r.usedLlm).toBe(false);
    const b = r.brief;
    expect(b.period).toEqual({ start: '2026-10-12', end: '2026-10-18', label: '12–18/out' });
    expect(b.training).toMatchObject({ sessions: 3, training_days: 3, work_sets: 18 });
    expect(b.training.tonnage_kg).toBe(3 * 8 * (60 + 62.5 + 65) + 9 * 48 * 10);
    expect(b.nutrition).toMatchObject({
      complete_days: 4,
      kcal_avg: 2400,
      protein_avg: 135,
      protein_days_hit: 2,
      protein_adherence_pct: 50,
    });
    expect(b.body).toMatchObject({ weight_trend_end: 80.1, weigh_ins: 2 });
    expect(b.insights.map((i) => i.id)).toContain('pr_celebration');
    // números do texto saem do brief
    expect(r.text).toContain('3 sessões (meta 3) · 18 séries');
    expect(r.text).toContain('4/7 dias completos · 2.400 kcal/dia · proteína 135 g/dia');
    expect(r.text).toMatchSnapshot();
    const row = db.prepare('SELECT used_llm, text FROM reports WHERE id = ?').get(r.reportId) as {
      used_llm: number;
      text: string;
    };
    expect(row).toEqual({ used_llm: 0, text: r.text });
  });

  it('cérebro falhou → fallback; cérebro ok → texto do LLM', async () => {
    const { db, ex } = makeDb();
    seedReportWeek(db, { now: NOW, remada: ex.remada!, supino: ex.supInc! });
    const failing = (async () => ({ status: 'failed', text: '' })) as unknown as RunTurn;
    const a = await generateReport({
      db,
      kind: 'weekly',
      now: NOW,
      cutoffHour: 4,
      timeZone: SETTINGS.timeZone,
      runTurn: failing,
      logger,
    });
    expect(a.usedLlm).toBe(false);
    expect(a.text).toContain('📊 Semana');
    const okTurn = (async () => ({ status: 'done', text: 'Relatório do coach' })) as unknown as RunTurn;
    const b = await generateReport({
      db,
      kind: 'weekly',
      now: NOW,
      cutoffHour: 4,
      timeZone: SETTINGS.timeZone,
      runTurn: okTurn,
      logger,
    });
    expect(b).toMatchObject({ usedLlm: true, text: 'Relatório do coach' });
  });
});

describe('scheduler', () => {
  it('job com periodKey não roda duas vezes no mesmo período (reinício)', async () => {
    const { db } = makeDb();
    let runs = 0;
    const job: JobDef = {
      name: 'x',
      cron: '* * * * *',
      periodKey: () => '2026-10-12',
      run: async () => void runs++,
    };
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    expect(await runJob(deps, job, NOW)).toBe('ran');
    expect(await runJob(deps, job, NOW)).toBe('skipped');
    expect(runs).toBe(1);
  });

  it('falha registra ok=0 e permite nova tentativa', async () => {
    const { db } = makeDb();
    let fail = true;
    const job: JobDef = {
      name: 'y',
      cron: '* * * * *',
      periodKey: () => 'p',
      run: async () => {
        if (fail) throw new Error('boom');
      },
    };
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    expect(await runJob(deps, job, NOW)).toBe('failed');
    fail = false;
    expect(await runJob(deps, job, NOW)).toBe('ran');
  });

  it('relatório semanal agendado: envia uma vez; pausado não envia', async () => {
    const { db } = makeDb();
    const sent: string[] = [];
    const jobs = buildJobs({
      db,
      logger,
      timeZone: SETTINGS.timeZone,
      cutoffHour: 4,
      notify: async (t) => void sent.push(t),
      report: async () => ({ text: 'semana!', reportId: 1 }),
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
    const weekly = jobs.find((j) => j.name === 'report.weekly')!;
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    await runJob(deps, weekly, NOW);
    await runJob(deps, weekly, NOW);
    expect(sent).toEqual(['semana!']);

    setSetting(db, 'proactive.paused', true);
    await runJob(deps, weekly, '2026-10-25T23:00:00Z');
    expect(sent).toHaveLength(1);
  });
});

describe('relatório com canal fora do ar', () => {
  it('não gera o relatório (não gasta cota) e o job fica como falho para nova tentativa', async () => {
    const { db } = makeDb();
    let generated = 0;
    const jobs = buildJobs({
      db,
      logger,
      timeZone: SETTINGS.timeZone,
      cutoffHour: 4,
      notify: async () => {},
      report: async () => ({ text: 'x', reportId: ++generated }),
      retryTurn: async () => false,
      waitChannel: async () => false,
      config: {
        REPORT_DAILY: false,
        REPORT_DAILY_TIME: '21:30',
        REPORT_WEEKLY_CRON: '0 20 * * 0',
        REPORT_MONTHLY_CRON: '0 9 1 * *',
        HC_STALE_HOURS: 48,
        DATA_DIR: '.',
      },
    });
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    expect(
      await runJob(
        deps,
        jobs.find((j) => j.name === 'report.weekly')!,
        NOW,
      ),
    ).toBe('failed');
    expect(generated).toBe(0);
  });
});

describe('report.catchup', () => {
  it('reenvia o semanal que falhou quando o canal volta', async () => {
    const { db } = makeDb();
    let up = false;
    const sent: string[] = [];
    const jobs = buildJobs({
      db,
      logger,
      timeZone: SETTINGS.timeZone,
      cutoffHour: 4,
      notify: async (t) => void sent.push(t),
      report: async () => ({ text: 'semana!', reportId: 1 }),
      retryTurn: async () => false,
      waitChannel: async () => up,
      config: {
        REPORT_DAILY: false,
        REPORT_DAILY_TIME: '21:30',
        REPORT_WEEKLY_CRON: '0 20 * * 0',
        REPORT_MONTHLY_CRON: '0 9 1 * *',
        HC_STALE_HOURS: 48,
        DATA_DIR: '.',
      },
    });
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    const catchup = jobs.find((j) => j.name === 'report.catchup')!;
    await runJob(
      deps,
      jobs.find((j) => j.name === 'report.weekly')!,
      NOW,
    );
    up = true;
    await runJob(deps, catchup, '2026-10-19T00:15:00Z');
    await runJob(deps, catchup, '2026-10-19T01:15:00Z');
    expect(sent).toEqual(['semana!']);
  });
});

describe('/pausar e /retomar', () => {
  it('ao retomar, oferece os relatórios pulados durante a pausa', async () => {
    const { runCommand } = await import('../../src/gateway/commands.ts');
    const { buildRegistry } = await import('../../src/tools/index.ts');
    const { db } = makeDb();
    const ctx = { db, registry: buildRegistry(), settings: SETTINGS, now: NOW };
    expect(runCommand(ctx, 'pausar', '').text).toMatch(/pausadas/);
    const jobs = buildJobs({
      db,
      logger,
      timeZone: SETTINGS.timeZone,
      cutoffHour: 4,
      notify: async () => {},
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
    await runJob(
      { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 },
      jobs.find((j) => j.name === 'report.weekly')!,
      NOW,
    );
    expect(runCommand(ctx, 'retomar', '').text).toContain('/relatorio semana');
    expect(runCommand({ ...ctx, now: '2026-11-01T12:00:00Z' }, 'retomar', '').text).not.toContain(
      '/relatorio',
    );
  });
});

describe('lembrete de recarga do chip', () => {
  it('/recarga anota; avisa a partir de 25 dias, mesmo pausado', async () => {
    const { runCommand } = await import('../../src/gateway/commands.ts');
    const { buildRegistry } = await import('../../src/tools/index.ts');
    const { db } = makeDb();
    const ctx = { db, registry: buildRegistry(), settings: SETTINGS, now: NOW };
    expect(runCommand(ctx, 'recarga', '').text).toContain('18/10');
    const sent: { t: string; critical?: boolean }[] = [];
    const jobs = buildJobs({
      db,
      logger,
      timeZone: SETTINGS.timeZone,
      cutoffHour: 4,
      notify: async (t, o) => void sent.push({ t, ...(o?.critical ? { critical: true } : {}) }),
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
    const job = jobs.find((j) => j.name === 'alert.sim_recharge')!;
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: 4 };
    await runJob(deps, job, '2026-11-11T14:00:00Z'); // 24 dias
    expect(sent).toEqual([]);
    await runJob(deps, job, '2026-11-12T14:00:00Z'); // 25 dias
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ critical: true });
    expect(sent[0]!.t).toContain('25 dias');
  });
});

describe('verificação de números do relatório', () => {
  it('fallback só usa números do brief; número inventado é apontado', async () => {
    const { numbersNotInBrief } = await import('../../src/reports/verify.ts');
    const { db, ex } = makeDb();
    seedReportWeek(db, { now: NOW, remada: ex.remada!, supino: ex.supInc! });
    const r = await generateReport({
      db,
      kind: 'weekly',
      now: NOW,
      cutoffHour: 4,
      timeZone: SETTINGS.timeZone,
      logger,
    });
    expect(numbersNotInBrief(r.text, r.brief)).toEqual([]);
    expect(numbersNotInBrief(`${r.text}\nVocê comeu 2.650 kcal`, r.brief)).toEqual(['2650']);
  });
});

describe('brief somente leitura', () => {
  /**
   * A estimativa de manutenção usa uma janela fixa de 28 dias antes do fim do período e exige
   * 80% de dias completos e 8+ pesagens dentro dela: 28 dias densos terminando em 18/10.
   */
  function seedDenseMonth(db: ReturnType<typeof makeDb>['db']) {
    setSetting(db, 'goal.kcal', 2400);
    const meal = db.prepare(
      `INSERT INTO meals (eaten_at, local_date, confidence, kcal, protein_g, carbs_g, fat_g, fiber_g, created_at, updated_at)
       VALUES (?, ?, 'high', 800, 50, 0, 0, 0, ?, ?)`,
    );
    const weigh = db.prepare(
      "INSERT INTO body_metrics (measured_at, local_date, weight_kg, source, created_at) VALUES (?, ?, ?, 'chat', ?)",
    );
    for (let i = 0; i < 28; i++) {
      const d = addDays('2026-09-21', i);
      for (let k = 0; k < 3; k++) meal.run(`${d}T15:00:00Z`, d, NOW, NOW);
      if (i % 3 === 0) weigh.run(`${d}T10:00:00Z`, d, 80 + i * 0.02, NOW);
    }
  }
  const PERIOD = { start: '2026-09-21', end: '2026-10-18' };

  it('por padrão grava a estimativa de manutenção', () => {
    const { db } = makeDb();
    seedDenseMonth(db);
    expect(getSetting<number>(db, 'metrics.maintenance_estimate')).toBeUndefined();
    buildReportBrief(db, 'monthly', PERIOD, NOW);
    expect(getSetting<number>(db, 'metrics.maintenance_estimate')).toEqual(expect.any(Number));
  });

  it('persist:false não grava nada', () => {
    const { db } = makeDb();
    seedDenseMonth(db);
    const brief = buildReportBrief(db, 'adhoc', PERIOD, NOW, { persist: false });
    expect(brief.nutrition.kcal_avg).toBe(2400); // o brief continua completo
    expect(getSetting<number>(db, 'metrics.maintenance_estimate')).toBeUndefined();
  });
});

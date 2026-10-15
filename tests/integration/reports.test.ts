import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/index.ts';
import { setSetting } from '../../src/db/repos/settings.ts';
import type { RunTurn } from '../../src/gateway/turn-runner.ts';
import { createLogger } from '../../src/logger.ts';
import { reportPeriod } from '../../src/reports/build.ts';
import { generateReport } from '../../src/reports/service.ts';
import { buildJobs, runJob, type JobDef } from '../../src/scheduler/jobs.ts';
import { SETTINGS, data, makeCaller, makeDb } from '../helpers.ts';

const logger = createLogger('silent');
// Domingo 18/10/2026, 20:00 em São Paulo → semana seg 12/10 – dom 18/10.
const NOW = '2026-10-18T23:00:00Z';
const sets = (n: number, weight_kg: number, reps: number) =>
  Array.from({ length: n }, () => ({ weight_kg, reps }));

/** Semana sintética com números conhecidos. */
function seedWeek(db: Db, ex: Record<string, number>) {
  const { call, newTurn } = makeCaller(db, { now: NOW });
  for (const [key, value] of [
    ['kcal', 2400],
    ['protein_g', 140],
    ['training_days', 3],
  ] as const)
    data(call('set_goal', { key, value }));
  const workouts: [string, number][] = [
    ['2026-10-12', 60],
    ['2026-10-14', 62.5],
    ['2026-10-16', 65],
  ];
  for (const [d, w] of workouts) {
    newTurn(NOW);
    data(
      call('log_workout', {
        new_session: true,
        performed_at: `${d}T21:00:00Z`,
        entries: [
          { exercise_id: ex.remada!, sets: sets(3, w, 8) },
          { exercise_id: ex.supInc!, sets: sets(3, 24, 10) },
        ],
      }),
    );
  }
  const meal = db.prepare(
    `INSERT INTO meals (eaten_at, local_date, confidence, kcal, protein_g, carbs_g, fat_g, fiber_g, created_at, updated_at)
     VALUES (?, ?, 'high', ?, ?, 0, 0, 0, ?, ?)`,
  );
  // 4 dias completos (3 refeições): 2400 kcal e 150 g ou 120 g de proteína.
  for (const [d, p] of [
    ['2026-10-12', 50],
    ['2026-10-13', 50],
    ['2026-10-14', 40],
    ['2026-10-15', 40],
  ] as const)
    for (let k = 0; k < 3; k++) meal.run(`${d}T15:00:00Z`, d, 800, p, NOW, NOW);
  const w = db.prepare(
    "INSERT INTO body_metrics (measured_at, local_date, weight_kg, source, created_at) VALUES (?, ?, ?, 'chat', ?)",
  );
  w.run('2026-10-12T10:00:00Z', '2026-10-12', 80, NOW);
  w.run('2026-10-15T10:00:00Z', '2026-10-15', 81, NOW);
}

describe('relatório semanal', () => {
  it('período seg–dom e mês anterior', () => {
    expect(reportPeriod('weekly', '2026-10-18')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    expect(reportPeriod('weekly', '2026-10-12')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    expect(reportPeriod('monthly', '2026-01-01')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
  });

  it('brief com números conhecidos e fallback sem cérebro (snapshot)', async () => {
    const { db, ex } = makeDb();
    seedWeek(db, ex);
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
    seedWeek(db, ex);
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

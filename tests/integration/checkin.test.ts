import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../../src/brain/context-builder.ts';
import { setSetting } from '../../src/db/repos/settings.ts';
import { createTurn, finishTurn } from '../../src/db/repos/turns.ts';
import { insertMessage } from '../../src/db/repos/messages.ts';
import type { RunTurn } from '../../src/gateway/turn-runner.ts';
import { createLogger } from '../../src/logger.ts';
import { buildCheckinBrief, generateCheckin, renderCheckinFallback } from '../../src/reports/checkin.ts';
import { buildJobs, runJob } from '../../src/scheduler/jobs.ts';
import { SETTINGS, data, makeCaller, makeDb } from '../helpers.ts';

const logger = createLogger('silent');
// quarta 2026-10-21, 07:30 local
const WED = '2026-10-21T10:30:00Z';
const THU = '2026-10-22T10:30:00Z';

function setup() {
  const { db, ex } = makeDb();
  const { call, state } = makeCaller(db, { now: '2026-10-14T21:00:00Z' });
  data(
    call('define_routine', {
      name: 'Upper A',
      exercises: [{ exercise_id: ex.supInc, target_sets: 3, rep_min: 8, rep_max: 12 }],
    }),
  );
  data(call('set_weekly_schedule', { days: [{ weekday: 'qua', routine_name: 'upper a' }] }));
  data(
    call('log_workout', {
      routine_name: 'upper a',
      entries: [
        { exercise_id: ex.supInc, sets: Array.from({ length: 3 }, () => ({ weight_kg: 30, reps: 12 })) },
      ],
    }),
  );
  state.now = WED;
  return { db, call };
}

const sleep = (db: ReturnType<typeof makeDb>['db'], localDate: string, minutes: number) =>
  db
    .prepare(
      "INSERT INTO health_daily (local_date, sleep_minutes, updated_at) VALUES (?, ?, '2026-10-21T10:00:00Z')",
    )
    .run(localDate, minutes);

describe('check-in diário (Fase 8d)', () => {
  it('dia de treino: envia com a rotina e os alvos da progressão', () => {
    const { db } = setup();
    const r = buildCheckinBrief(db, WED, SETTINGS);
    expect(r.send).toBe(true);
    expect(r.reason).toBe('sessão planejada');
    expect(r.brief.planned?.routine).toBe('Upper A');
    expect(r.brief.targets[0]).toMatchObject({ exercise: 'Supino inclinado com halteres', rule: 'increase' });
  });

  it('descanso sem noite curta nem evento: não envia; noite curta ou evento vencendo: envia', () => {
    const { db, call } = setup();
    expect(buildCheckinBrief(db, THU, SETTINGS)).toMatchObject({ send: false, reason: 'nada a dizer' });
    sleep(db, '2026-10-22', 300);
    expect(buildCheckinBrief(db, THU, SETTINGS)).toMatchObject({ send: true, reason: 'noite curta' });

    const { db: db2, call: call2 } = setup();
    void call;
    data(call2('remember_note', { kind: 'life_event', text: 'joelho doendo', due_date: '2026-10-22' }));
    const r = buildCheckinBrief(db2, THU, SETTINGS);
    expect(r).toMatchObject({ send: true, reason: 'evento de vida' });
    expect(r.brief.life_events_due).toEqual([{ note_id: 1, text: 'joelho doendo' }]);
  });

  it('ajuste temporário vale no check-in; dado faltando de ontem só entra no brief', () => {
    const { db, call } = setup();
    data(
      call('set_plan_override', {
        until_date: '2026-10-21',
        text: 'feriado',
        changes: [{ weekday: 'qua', routine_name: null }],
      }),
    );
    expect(buildCheckinBrief(db, WED, SETTINGS).send).toBe(false);
    expect(buildCheckinBrief(db, WED, SETTINGS).brief.missing_yesterday).toEqual(['refeições']);
  });

  it('fallback determinístico', () => {
    const { db } = setup();
    sleep(db, '2026-10-21', 320);
    expect(renderCheckinFallback(buildCheckinBrief(db, WED, SETTINGS).brief)).toMatchSnapshot();
  });

  it('generateCheckin: cérebro redige em modo checkin; se falhar, fallback; sem nada a dizer, null', async () => {
    const { db } = setup();
    const calls: Parameters<RunTurn>[0][] = [];
    const ok: RunTurn = async (req) => {
      calls.push(req);
      return { turnId: 7, status: 'done', text: 'Bom dia! Upper A hoje.', entities: [] };
    };
    const r = await generateCheckin({ db, now: WED, settings: SETTINGS, runTurn: ok, logger });
    expect(r).toMatchObject({ text: 'Bom dia! Upper A hoje.', usedLlm: true, turnId: 7 });
    expect(calls[0]).toMatchObject({ mode: 'checkin', inboundMessageIds: [] });
    expect(calls[0]!.extraInstructions).toContain('<checkin_brief>');

    const fail: RunTurn = async () => ({ turnId: 8, status: 'failed', text: 'x', entities: [] });
    expect(await generateCheckin({ db, now: WED, settings: SETTINGS, runTurn: fail, logger })).toMatchObject({
      usedLlm: false,
      text: expect.stringContaining('Upper A'),
    });
    expect(await generateCheckin({ db, now: THU, settings: SETTINGS, runTurn: ok, logger })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('o check-in enviado aparece no <recent_turns> do turno seguinte', () => {
    const { db } = setup();
    const turnId = createTurn(db, 'checkin', WED);
    finishTurn(db, turnId, { status: 'done', durationMs: 1 }, WED);
    insertMessage(db, {
      channel: 'terminal',
      direction: 'out',
      external_id: 'c1',
      kind: 'text',
      text: 'Bom dia! Upper A hoje.',
      turn_id: turnId,
    });
    const p = buildTurnPrompt(db, {
      now: WED,
      settings: SETTINGS,
      userText: 'beleza',
      images: [],
      recentTurns: 8,
    });
    expect(p).toContain('- [qua 21/10 07:30] check-in da manhã (enviado por você): "Bom dia! Upper A hoje."');
  });

  it('job: respeita /pausar e CHECKIN_ENABLED; um por dia', async () => {
    const { db } = setup();
    const sent: string[] = [];
    const jobs = (enabled: boolean) =>
      buildJobs({
        db,
        logger,
        timeZone: SETTINGS.timeZone,
        cutoffHour: SETTINGS.cutoffHour,
        notify: async () => {},
        report: async () => ({ text: '', reportId: 0 }),
        retryTurn: async () => true,
        checkin: async () => {
          sent.push('x');
          return 'enviado';
        },
        config: {
          REPORT_DAILY: false,
          REPORT_DAILY_TIME: '21:30',
          REPORT_WEEKLY_CRON: '0 20 * * 0',
          REPORT_MONTHLY_CRON: '0 9 1 * *',
          HC_STALE_HOURS: 36,
          DATA_DIR: '.',
          CHECKIN_ENABLED: enabled,
        },
      }).find((j) => j.name === 'checkin')!;
    const deps = { db, logger, timeZone: SETTINGS.timeZone, cutoffHour: SETTINGS.cutoffHour };
    expect(await runJob(deps, jobs(false), WED)).toBe('ran');
    expect(sent).toHaveLength(0);

    setSetting(db, 'proactive.paused', true);
    await runJob(deps, jobs(true), THU);
    expect(sent).toHaveLength(0);
    setSetting(db, 'proactive.paused', false);

    await runJob(deps, jobs(true), '2026-10-23T10:30:00Z');
    expect(await runJob(deps, jobs(true), '2026-10-23T11:30:00Z')).toBe('skipped');
    expect(sent).toHaveLength(1);
  });
});

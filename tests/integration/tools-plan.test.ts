import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../../src/brain/context-builder.ts';
import { scheduleRows } from '../../src/db/repos/plan.ts';
import { undoTurn } from '../../src/db/undo.ts';
import { runCommand } from '../../src/gateway/commands.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { SETTINGS, data, makeCaller, makeDb } from '../helpers.ts';

// 2026-10-21 é quarta; 13:00Z = 10:00 local
const WED = '2026-10-21T13:00:00Z';
type Day = {
  local_date: string;
  weekday: string;
  routine: string | null;
  source: string;
  overrides?: unknown[];
};

function setup() {
  const { db, ex } = makeDb();
  const caller = makeCaller(db, { now: WED });
  data(
    caller.call('define_routine', {
      name: 'Upper A',
      exercises: [{ exercise_id: ex.supInc, target_sets: 3, rep_min: 8, rep_max: 12 }],
    }),
  );
  data(
    caller.call('define_routine', {
      name: 'Lower A',
      exercises: [{ exercise_id: ex.remada, target_sets: 3, rep_min: 6, rep_max: 10 }],
    }),
  );
  return { db, ex, ...caller };
}

describe('agenda semanal e ajustes temporários (Fase 8c)', () => {
  it('set_weekly_schedule valida rotina e dia repetido; substitui a agenda; desfazer restaura', () => {
    const { db, call, newTurn } = setup();
    expect(call('set_weekly_schedule', { days: [{ weekday: 'seg', routine_name: 'push' }] })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      call('set_weekly_schedule', {
        days: [
          { weekday: 'seg', routine_name: 'upper a' },
          { weekday: 'seg', routine_name: 'lower a' },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const r = data(
      call<{ schedule: { weekday: string; routine: string }[] }>('set_weekly_schedule', {
        days: [
          { weekday: 'qua', routine_name: 'upper a' },
          { weekday: 'seg', routine_name: 'lower a' },
        ],
      }),
    );
    expect(r.schedule).toEqual([
      { weekday: 'seg', routine: 'Lower A' },
      { weekday: 'qua', routine: 'Upper A' },
    ]);
    const turn = newTurn();
    call('set_weekly_schedule', { days: [{ weekday: 'sex', routine_name: 'upper a' }] });
    expect(scheduleRows(db)).toHaveLength(1);
    undoTurn(db, turn, WED);
    expect(scheduleRows(db).map((x) => x.weekday)).toEqual([1, 3]);
  });

  it('get_next_targets sem rotina usa a planejada de hoje; get_day_summary traz o plano', () => {
    const { call } = setup();
    expect(call('get_next_targets', {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    call('set_weekly_schedule', { days: [{ weekday: 'qua', routine_name: 'upper a' }] });
    const t = data(call<{ routine: string; planned_today: Day }>('get_next_targets', {}));
    expect(t.routine).toBe('Upper A');
    expect(t.planned_today).toMatchObject({ weekday: 'quarta', routine: 'Upper A', source: 'schedule' });
    expect(data(call<{ planned: Day }>('get_day_summary', {})).planned.routine).toBe('Upper A');
  });

  it('set_plan_override move a sessão no período e vence sozinho; end_plan_override cancela', () => {
    const { db, call, state } = setup();
    call('set_weekly_schedule', {
      days: [
        { weekday: 'qua', routine_name: 'upper a' },
        { weekday: 'qui', routine_name: 'lower a' },
      ],
    });
    expect(call('set_plan_override', { until_date: '2026-10-20', text: 'x de novo' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(call('set_plan_override', { until_date: '2027-01-30', text: 'longo demais' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    const o = data(
      call<{ override_id: number; week: Day[] }>('set_plan_override', {
        until_date: '2026-10-25',
        text: 'semana corrida, upper A na sexta',
        changes: [
          { weekday: 'qua', routine_name: null },
          { weekday: 'sex', routine_name: 'upper a' },
        ],
      }),
    );
    expect(o.week.slice(0, 3).map((d) => d.routine)).toEqual([null, 'Lower A', 'Upper A']);
    expect(data(call<{ days: Day[] }>('get_week_plan', { days: 8 })).days.at(-1)).toMatchObject({
      local_date: '2026-10-28',
      routine: 'Upper A',
      source: 'schedule',
    });

    const prompt = (now: string) =>
      buildTurnPrompt(db, { now, settings: SETTINGS, userText: 'oi', images: [], recentTurns: 0 });
    expect(prompt(WED)).toContain(`- [${o.override_id}] 21/10–25/10: semana corrida, upper A na sexta`);
    expect(prompt(WED)).toContain('plano de hoje: descanso · amanhã (quinta 22/10): Lower A');
    // amanhã já tem treino: a linha "próximo treino" não repete a informação
    expect(prompt(WED)).not.toContain('próximo treino');
    // quinta: amanhã é sexta com upper A (ajuste)
    expect(prompt('2026-10-22T13:00:00Z')).toContain('amanhã (sexta 23/10): Upper A');
    expect(prompt('2026-10-28T13:00:00Z')).not.toContain('<plan_overrides>');

    data(call('end_plan_override', { override_id: o.override_id }));
    state.now = WED;
    expect(data(call<{ planned: Day }>('get_day_summary', {})).planned.routine).toBe('Upper A');
    expect(call('end_plan_override', { override_id: o.override_id })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('/treino sem rotina mostra a planejada; em dia de descanso avisa', () => {
    const { db, call } = setup();
    const ctx = { db, registry: buildRegistry(), settings: SETTINGS, now: WED };
    expect(runCommand(ctx, 'treino', '').text).toMatch(/Uso/);
    call('set_weekly_schedule', { days: [{ weekday: 'qua', routine_name: 'upper a' }] });
    expect(runCommand(ctx, 'treino', '').text).toContain('Upper A');
    expect(runCommand({ ...ctx, now: '2026-10-22T13:00:00Z' }, 'treino', '').text).toMatch(/descanso/);
  });
});

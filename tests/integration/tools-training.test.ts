import { describe, expect, it } from 'vitest';
import { undoTurn } from '../../src/db/undo.ts';
import { data, makeCaller, makeDb } from '../helpers.ts';

type LogOut = {
  session_id: number;
  local_date: string;
  routine?: string;
  appended_to_open_session: boolean;
  summary: { exercise: string; sets_compact: string; vs_last?: string; prs: string[] }[];
  session_totals: { work_sets: number; exercises: number };
};

const sets = (n: number, weight_kg: number, reps: number) =>
  Array.from({ length: n }, () => ({ weight_kg, reps }));

function auditCount(db: ReturnType<typeof makeDb>['db'], turnId: number, entity?: string) {
  return db
    .prepare('SELECT count(*) FROM audit_log WHERE turn_id = ? AND (? IS NULL OR entity = ?)')
    .pluck()
    .get(turnId, entity ?? null, entity ?? null) as number;
}

describe('envelope e escopo', () => {
  it('tool desconhecida → NOT_FOUND; entrada inválida → VALIDATION com o campo', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db);
    expect(call('nao_existe', {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const r = call('log_workout', { entries: [{ exercise_id: 1, sets: [{ reps: -1 }] }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(!r.ok && r.error.message).toMatch(/entries\.0\.sets\.0\.reps/);
  });

  it('turno de relatório (somente leitura) recebe FORBIDDEN em tools de escrita', () => {
    const { db, ex } = makeDb();
    const { call } = makeCaller(db, { toolScope: 'read' });
    expect(
      call('log_workout', { entries: [{ exercise_id: ex.remada, sets: sets(1, 60, 8) }] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(call('get_goals', {}).ok).toBe(true);
  });
});

describe('search_exercises', () => {
  it('consulta única e em lote (D-019)', () => {
    const { db, ex } = makeDb();
    const { call } = makeCaller(db);
    const one = data(
      call<{ matches: { id: number; score: number }[] }>('search_exercises', { query: 'sup inc' }),
    );
    expect(one.matches[0]).toMatchObject({ id: ex.supIncBarra, score: 1 });
    const many = data(
      call<{ results: { query: string; matches: { id: number }[] }[] }>('search_exercises', {
        queries: ['supino inclinado halter', 'remada curvada'],
      }),
    );
    expect(many.results.map((r) => r.matches[0]?.id)).toEqual([ex.supInc, ex.remada]);
    expect(call('search_exercises', {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});

describe('define_routine', () => {
  it('cria, substitui (upsert por nome) e audita', () => {
    const { db, ex } = makeDb();
    const { call, state } = makeCaller(db);
    const r = data(
      call<{ routine_id: number; exercises: { name_pt: string; rep_min: number }[] }>('define_routine', {
        name: 'Upper B',
        exercises: [
          { exercise_id: ex.supInc, target_sets: 3, rep_min: 8, rep_max: 12 },
          { exercise_id: ex.remada, target_sets: 4, rep_min: 6, rep_max: 10 },
        ],
      }),
    );
    expect(r.exercises.map((e) => e.name_pt)).toEqual([
      'Supino inclinado com halteres',
      'Remada curvada com barra',
    ]);
    expect(auditCount(db, state.turnId, 'routine')).toBe(1);

    const again = data(
      call<{ routine_id: number; exercises: unknown[] }>('define_routine', {
        name: 'upper b',
        exercises: [{ exercise_id: ex.lateral }],
      }),
    );
    expect(again.routine_id).toBe(r.routine_id);
    expect(again.exercises).toHaveLength(1);
  });

  it('NOT_FOUND para exercício inexistente e VALIDATION para faixa invertida', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db);
    expect(call('define_routine', { name: 'A', exercises: [{ exercise_id: 999 }] })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      call('define_routine', { name: 'A', exercises: [{ exercise_id: 1, rep_min: 12, rep_max: 8 }] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });
});

describe('log_workout', () => {
  it('registra o treino completo do SPEC (10 séries) com rotina e auditoria', () => {
    const { db, ex } = makeDb();
    const { call, state } = makeCaller(db);
    data(
      call('define_routine', {
        name: 'Upper B',
        exercises: [{ exercise_id: ex.supInc }, { exercise_id: ex.remada }, { exercise_id: ex.lateral }],
      }),
    );
    const out = data(
      call<LogOut>('log_workout', {
        routine_name: 'upper B',
        entries: [
          { exercise_id: ex.supInc, sets: sets(3, 30, 10) },
          { exercise_id: ex.remada, sets: sets(4, 60, 8) },
          { exercise_id: ex.lateral, sets: sets(3, 10, 15) },
        ],
      }),
    );
    expect(out).toMatchObject({
      routine: 'Upper B',
      local_date: '2026-10-13',
      appended_to_open_session: false,
    });
    expect(out.session_totals).toEqual({ work_sets: 10, exercises: 3 });
    expect(out.summary.map((s) => s.sets_compact)).toEqual(['30kg 3×10', '60kg 4×8', '10kg 3×15']);
    expect(auditCount(db, state.turnId, 'set')).toBe(10);
    expect(auditCount(db, state.turnId, 'workout_session')).toBe(1);
  });

  it('anexa à sessão aberta (< 3 h) e cria nova depois disso', () => {
    const { db, ex } = makeDb();
    const { call, newTurn } = makeCaller(db, { now: '2026-10-13T21:10:00Z' });
    const first = data(
      call<LogOut>('log_workout', { entries: [{ exercise_id: ex.supIncBarra, sets: sets(2, 30, 10) }] }),
    );

    newTurn('2026-10-13T21:40:00Z');
    const second = data(
      call<LogOut>('log_workout', {
        entries: [
          {
            exercise_id: ex.supIncBarra,
            sets: [
              { weight_kg: 32, reps: 10 },
              { weight_kg: 32, reps: 9 },
              { weight_kg: 32, reps: 8 },
            ],
          },
        ],
      }),
    );
    expect(second.session_id).toBe(first.session_id);
    expect(second.appended_to_open_session).toBe(true);
    expect(second.summary[0]?.sets_compact).toBe('30kg 2×10, 32kg 10/9/8');
    expect(second.session_totals.work_sets).toBe(5);

    newTurn('2026-10-14T01:00:00Z');
    const third = data(
      call<LogOut>('log_workout', { entries: [{ exercise_id: ex.remada, sets: sets(1, 60, 8) }] }),
    );
    expect(third.session_id).not.toBe(first.session_id);
    expect(third.local_date).toBe('2026-10-13'); // 22:00 local, antes da virada das 04:00
  });

  it('new_session força sessão nova mesmo com uma aberta', () => {
    const { db, ex } = makeDb();
    const { call } = makeCaller(db);
    const a = data(
      call<LogOut>('log_workout', { entries: [{ exercise_id: ex.remada, sets: sets(1, 60, 8) }] }),
    );
    const b = data(
      call<LogOut>('log_workout', {
        new_session: true,
        entries: [{ exercise_id: ex.remada, sets: sets(1, 60, 8) }],
      }),
    );
    expect(b.session_id).not.toBe(a.session_id);
  });

  it('vs_last e PRs contra a sessão anterior', () => {
    const { db, ex } = makeDb();
    const { call, newTurn } = makeCaller(db, { now: '2026-10-08T21:00:00Z' });
    data(
      call('log_workout', {
        entries: [
          {
            exercise_id: ex.supInc,
            sets: [
              { weight_kg: 28, reps: 10 },
              { weight_kg: 28, reps: 10 },
              { weight_kg: 28, reps: 9 },
            ],
          },
        ],
      }),
    );
    newTurn('2026-10-13T21:00:00Z');
    const out = data(
      call<LogOut>('log_workout', { entries: [{ exercise_id: ex.supInc, sets: sets(3, 30, 10) }] }),
    );
    expect(out.summary[0]).toMatchObject({ vs_last: '+2kg', prs: ['weight', 'e1rm'] });
  });

  it('rotina inexistente não bloqueia: registra sem vínculo e avisa', () => {
    const { db, ex } = makeDb();
    const { call } = makeCaller(db);
    const r = call<LogOut>('log_workout', {
      routine_name: 'lower Z',
      entries: [{ exercise_id: ex.remada, sets: sets(1, 60, 8) }],
    });
    expect(r.ok && r.hints?.[0]).toMatch(/não existe/);
    expect(r.ok && r.data.routine).toBeUndefined();
  });

  it('exercício inexistente → NOT_FOUND e nada é gravado (rollback)', () => {
    const { db, ex } = makeDb();
    const { call, state } = makeCaller(db);
    expect(
      call('log_workout', {
        entries: [
          { exercise_id: ex.remada, sets: sets(1, 60, 8) },
          { exercise_id: 999, sets: sets(1, 1, 1) },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(db.prepare('SELECT count(*) FROM sets').pluck().get()).toBe(0);
    expect(auditCount(db, state.turnId)).toBe(0);
  });
});

describe('consultas de treino', () => {
  function seedTwoSessions() {
    const ctx = makeDb();
    const c = makeCaller(ctx.db, { now: '2026-10-08T21:00:00Z' });
    data(
      c.call('define_routine', {
        name: 'Upper B',
        exercises: [
          { exercise_id: ctx.ex.supInc, target_sets: 3, rep_min: 8, rep_max: 12 },
          { exercise_id: ctx.ex.remada, target_sets: 4, rep_min: 6, rep_max: 8 },
          { exercise_id: ctx.ex.lateral, target_sets: 3, rep_min: 12, rep_max: 15 },
        ],
      }),
    );
    data(
      c.call('log_workout', {
        routine_name: 'Upper B',
        entries: [
          {
            exercise_id: ctx.ex.supInc,
            sets: [
              { weight_kg: 28, reps: 10 },
              { weight_kg: 28, reps: 10 },
              { weight_kg: 28, reps: 9 },
            ],
          },
          { exercise_id: ctx.ex.remada, sets: sets(4, 60, 8) },
          {
            exercise_id: ctx.ex.lateral,
            sets: [
              { weight_kg: 10, reps: 15 },
              { weight_kg: 10, reps: 15 },
              { weight_kg: 10, reps: 13 },
            ],
          },
        ],
      }),
    );
    return { ...ctx, ...c };
  }

  it('get_next_targets reproduz o exemplo do SPEC', () => {
    const { call } = seedTwoSessions();
    const t = data(
      call<{
        last_date: string;
        targets: { exercise: string; last: string; target: string; rule: string }[];
      }>('get_next_targets', { routine_name: 'upper b' }),
    );
    expect(t.last_date).toBe('2026-10-08');
    expect(t.targets.map((x) => [x.last, x.target, x.rule])).toEqual([
      ['28kg 10/10/9', '28kg 3×10', 'hold'],
      ['60kg 4×8', '62,5kg 4×6', 'increase'],
      ['10kg 15/15/13', '10kg 15/15/14', 'hold'],
    ]);
  });

  it('get_next_targets com rotina inexistente → NOT_FOUND com candidatas', () => {
    const { call } = seedTwoSessions();
    expect(call('get_next_targets', { routine_name: 'lower A' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', candidates: ['Upper B'] },
    });
  });

  it('get_last_sessions por rotina e por exercício', () => {
    const { call, ex } = seedTwoSessions();
    const byRoutine = data(
      call<{ sessions: { exercises: { name: string; sets_compact: string; best_e1rm: number }[] }[] }>(
        'get_last_sessions',
        { routine_name: 'Upper B' },
      ),
    );
    expect(byRoutine.sessions[0]?.exercises[1]).toMatchObject({
      name: 'Remada curvada com barra',
      sets_compact: '60kg 4×8',
      best_e1rm: 76,
    });
    const byEx = data(
      call<{ sessions: { date: string }[] }>('get_last_sessions', { exercise_id: ex.lateral, limit: 3 }),
    );
    expect(byEx.sessions).toHaveLength(1);
    expect(byEx.sessions[0]?.date).toBe('08/10');
  });
});

describe('cardio, metas e resumo do dia', () => {
  it('log_cardio converte unidades e exige duração ou distância', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db);
    const id = data(
      call<{ id: number }>('log_cardio', { activity: 'Corrida', distance_km: 5, duration_min: 28 }),
    ).id;
    expect(
      db.prepare('SELECT activity, duration_s, distance_m FROM cardio_sessions WHERE id = ?').get(id),
    ).toEqual({
      activity: 'corrida',
      duration_s: 1680,
      distance_m: 5000,
    });
    expect(call('log_cardio', { activity: 'esteira' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('set_goal valida faixa, audita e get_day_summary mostra o que falta', () => {
    const { db, ex } = makeDb();
    const { call, state } = makeCaller(db);
    expect(call('set_goal', { key: 'protein_g', value: 5000 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    data(call('set_goal', { key: 'protein_g', value: 150 }));
    expect(auditCount(db, state.turnId, 'setting')).toBe(1);
    data(
      call('log_workout', { routine_name: 'x', entries: [{ exercise_id: ex.remada, sets: sets(2, 60, 8) }] }),
    );
    const day = data(
      call<{
        goals: Record<string, number>;
        remaining: { protein_g: number };
        workout: { work_sets: number };
      }>('get_day_summary', {}),
    );
    expect(day.goals).toEqual({ protein_g: 150 });
    expect(day.remaining).toEqual({ protein_g: 150 });
    expect(day.workout.work_sets).toBe(2);
  });
});

describe('undo de turno (/desfazer e D-014)', () => {
  it('desfaz só o último turno: séries, sessão, rotina e meta', () => {
    const { db, ex } = makeDb();
    const { call, newTurn, state } = makeCaller(db, { now: '2026-10-13T21:00:00Z' });
    data(call('define_routine', { name: 'Upper B', exercises: [{ exercise_id: ex.supInc }] }));
    data(call('set_goal', { key: 'kcal', value: 2200 }));
    const t1 = state.turnId;

    newTurn('2026-10-13T21:20:00Z');
    data(call('log_workout', { entries: [{ exercise_id: ex.supInc, sets: sets(3, 30, 10) }] }));
    const t2 = state.turnId;

    expect(undoTurn(db, t2)).toEqual({ entries: 4, byEntity: { set: 3, workout_session: 1 } });
    expect(db.prepare('SELECT count(*) FROM sets WHERE deleted_at IS NULL').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM routines WHERE deleted_at IS NULL').pluck().get()).toBe(1);

    expect(undoTurn(db, t1).entries).toBe(2);
    expect(db.prepare('SELECT count(*) FROM routines WHERE deleted_at IS NULL').pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM settings WHERE key = 'goal.kcal'").pluck().get()).toBe(0);
    expect(undoTurn(db, t1).entries).toBe(0); // idempotente
  });

  it('undo de redefinição de rotina restaura a lista anterior', () => {
    const { db, ex } = makeDb();
    const { call, newTurn, state } = makeCaller(db);
    data(
      call('define_routine', {
        name: 'Upper B',
        exercises: [{ exercise_id: ex.supInc }, { exercise_id: ex.remada }],
      }),
    );
    newTurn();
    data(call('define_routine', { name: 'Upper B', exercises: [{ exercise_id: ex.lateral }] }));
    undoTurn(db, state.turnId);
    expect(db.prepare('SELECT exercise_id FROM routine_exercises ORDER BY position').pluck().all()).toEqual([
      ex.supInc,
      ex.remada,
    ]);
  });

  it('undo de create_exercise remove exercício e apelidos da busca', () => {
    const { db } = makeDb();
    const { call, state } = makeCaller(db);
    const id = data(
      call<{ id: number }>('create_exercise', {
        name_pt: 'Remada máquina T',
        aliases: ['remada tbar'],
        equipment: 'machine',
        load_kind: 'total',
        primary_muscles: ['upper_back'],
        confirm_new: true,
      }),
    ).id;
    expect(
      data(call<{ matches: { id: number }[] }>('search_exercises', { query: 'remada tbar' })).matches[0]?.id,
    ).toBe(id);
    expect(
      call('create_exercise', {
        name_pt: 'remada tbar',
        equipment: 'machine',
        load_kind: 'total',
        primary_muscles: ['lats'],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    undoTurn(db, state.turnId);
    expect(
      data(call<{ matches: { id: number }[] }>('search_exercises', { query: 'remada tbar' })).matches.map(
        (m) => m.id,
      ),
    ).not.toContain(id);
  });

  it('create_exercise recusa duplicata parecida e devolve candidatos; confirm_new força', () => {
    const { db, ex } = makeDb();
    const { call } = makeCaller(db);
    const dup = call('create_exercise', {
      name_pt: 'Remada curvada barra livre',
      equipment: 'barbell',
      load_kind: 'total',
      primary_muscles: ['upper_back'],
    });
    expect(dup).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(JSON.stringify(dup)).toContain(String(ex.remada));
    expect(
      call('create_exercise', {
        name_pt: 'Remada curvada barra livre',
        equipment: 'barbell',
        load_kind: 'total',
        primary_muscles: ['upper_back'],
        confirm_new: true,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('edit_workout', () => {
  it('ajusta horário (hora local), muda série para aquecimento, troca exercício, apaga; /desfazer volta tudo', () => {
    const { db, ex } = makeDb();
    const { call, newTurn, state } = makeCaller(db, { now: '2026-10-15T05:02:00Z' });
    const logged = data(
      call<{ session_id: number }>('log_workout', {
        entries: [
          {
            exercise_id: ex.remada!,
            sets: [
              { weight_kg: 30, reps: 10 },
              { weight_kg: 60, reps: 8 },
              { weight_kg: 60, reps: 8 },
            ],
          },
        ],
      }),
    );
    const ids = db.prepare('SELECT id FROM sets ORDER BY id').pluck().all() as number[];
    const editTurn = newTurn();
    const r = data(
      call<{ started_at: string; ended_at: string; local_date: string; work_sets: number }>('edit_workout', {
        session_id: logged.session_id,
        started_at: '2026-10-14T18:15',
        ended_at: '2026-10-14T20:30',
        set_changes: [
          { set_id: ids[0], set_type: 'warmup' },
          { set_id: ids[1], exercise_id: ex.supInc, reps: 9 },
          { set_id: ids[2], delete: true },
        ],
      }),
    );
    expect(r).toMatchObject({
      started_at: '2026-10-14T21:15:00Z',
      ended_at: '2026-10-14T23:30:00Z',
      local_date: '2026-10-14',
      work_sets: 1,
    });
    expect(db.prepare('SELECT exercise_id, reps FROM sets WHERE id = ?').get(ids[1])).toEqual({
      exercise_id: ex.supInc,
      reps: 9,
    });

    undoTurn(db, editTurn);
    expect(state.turnId).toBe(editTurn);
    expect(db.prepare('SELECT started_at, ended_at FROM workout_sessions').get()).toEqual({
      started_at: '2026-10-15T05:02:00Z',
      ended_at: null,
    });
    expect(db.prepare('SELECT set_type, exercise_id, reps, deleted_at FROM sets ORDER BY id').all()).toEqual([
      { set_type: 'work', exercise_id: ex.remada, reps: 10, deleted_at: null },
      { set_type: 'work', exercise_id: ex.remada, reps: 8, deleted_at: null },
      { set_type: 'work', exercise_id: ex.remada, reps: 8, deleted_at: null },
    ]);
  });

  it('valida: série de outra sessão e fim antes do início', () => {
    const { db, ex } = makeDb();
    const { call } = makeCaller(db);
    const s1 = data(
      call<{ session_id: number }>('log_workout', {
        entries: [{ exercise_id: ex.remada!, sets: [{ weight_kg: 60, reps: 8 }] }],
      }),
    );
    const s2 = data(
      call<{ session_id: number }>('log_workout', {
        new_session: true,
        entries: [{ exercise_id: ex.remada!, sets: [{ weight_kg: 60, reps: 8 }] }],
      }),
    );
    const otherSet = db
      .prepare('SELECT id FROM sets WHERE session_id = ?')
      .pluck()
      .get(s2.session_id) as number;
    expect(
      call('edit_workout', { session_id: s1.session_id, set_changes: [{ set_id: otherSet, reps: 1 }] }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(
      call('edit_workout', {
        session_id: s1.session_id,
        started_at: '2026-10-13T20:00',
        ended_at: '2026-10-13T19:00',
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});

describe('log_cardio com velocidade', () => {
  it('distância calculada no código a partir de speed_kmh × duração', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db);
    expect(data(call('log_cardio', { activity: 'esteira', duration_min: 30, speed_kmh: 6 }))).toMatchObject({
      distance_km: 3,
    });
    expect(db.prepare('SELECT distance_m, duration_s FROM cardio_sessions').get()).toEqual({
      distance_m: 3000,
      duration_s: 1800,
    });
  });
});

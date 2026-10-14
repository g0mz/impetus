import { z } from 'zod';
import { addAlias, searchExercises, syncExerciseFts, upsertExercise } from '../db/repos/exercises.ts';
import {
  exerciseHistory,
  exerciseSessions,
  findRoutine,
  getExercise,
  getSession,
  insertCardio,
  insertRoutine,
  insertSession,
  insertSet,
  lastChatSession,
  latestBodyweight,
  recentSessions,
  replaceRoutineExercises,
  routineExercisesWithNames,
  routineSessions,
  routineSnapshot,
  sessionSets,
  setSessionRoutine,
  type StoredSet,
} from '../db/repos/training.ts';
import { setsCompact } from '../domain/training/format.ts';
import { bestE1rm } from '../domain/training/load.ts';
import { MUSCLES } from '../domain/training/muscles.ts';
import { nextTarget } from '../domain/training/progression.ts';
import { detectPrs, vsLast } from '../domain/training/prs.ts';
import { EQUIPMENT, LOAD_KINDS, isSessionOpen } from '../domain/training/types.ts';
import { normalize } from '../text/normalize.ts';
import { formatDayMonth, resolveWhen } from '../time.ts';
import { defineTool, err, ok, type ToolContext } from './registry.ts';

const when = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/, 'use YYYY-MM-DD ou data/hora ISO')
  .optional()
  .describe('Quando aconteceu (YYYY-MM-DD ou ISO). Sem valor = agora.');

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

function resolve(ctx: ToolContext, input?: string) {
  return resolveWhen(input, ctx.now, ctx.settings.cutoffHour, ctx.settings.timeZone);
}

// ── search_exercises ─────────────────────────────────────────────────────────────────────

export const searchExercisesTool = defineTool({
  name: 'search_exercises',
  scope: 'read',
  description:
    'Busca exercícios por nome ou apelido (PT-BR). Use ANTES de registrar qualquer exercício. ' +
    'Aceita várias consultas de uma vez em `queries` (um treino inteiro numa chamada). ' +
    'Ex.: { "queries": ["supino inclinado halter", "remada curvada"] }. score 1 = apelido exato.',
  input: z
    .object({
      query: z.string().min(1).optional(),
      queries: z.array(z.string().min(1)).min(1).max(10).optional(),
      limit: z.number().int().min(1).max(10).default(5),
    })
    .refine((v) => v.query !== undefined || v.queries !== undefined, 'informe `query` ou `queries`'),
  handler: (ctx, { query, queries, limit }) => {
    const run = (q: string) => searchExercises(ctx.db, q, limit);
    if (queries) return ok({ results: queries.map((q) => ({ query: q, matches: run(q) })) });
    return ok({ matches: run(query as string) });
  },
});

// ── create_exercise / add_exercise_alias ─────────────────────────────────────────────────

const muscle = z.enum(MUSCLES);

export const createExerciseTool = defineTool({
  name: 'create_exercise',
  scope: 'write',
  description:
    'Cria um exercício novo. Só use quando search_exercises não trouxer correspondência razoável. ' +
    'Inclua o termo que o usuário usou em `aliases`. Halteres: load_kind "per_hand".',
  input: z.object({
    name_pt: z.string().trim().min(2).max(80),
    aliases: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
    equipment: z.enum(EQUIPMENT as [string, ...string[]]),
    load_kind: z.enum(LOAD_KINDS as [string, ...string[]]),
    primary_muscles: z.array(muscle).min(1),
    secondary_muscles: z.array(muscle).default([]),
    is_compound: z.boolean().default(false),
    increment_kg: z.number().positive().max(50).optional(),
  }),
  handler: (ctx, input) => {
    const clash = ctx.db
      .prepare(
        `SELECT e.id, e.name_pt FROM exercise_aliases a JOIN exercises e ON e.id = a.exercise_id
          WHERE a.alias_norm = ? AND e.deleted_at IS NULL`,
      )
      .get(normalize(input.name_pt)) as { id: number; name_pt: string } | undefined;
    if (clash) return err('CONFLICT', `já existe um exercício com esse nome: ${clash.name_pt}`, [clash]);

    const id = upsertExercise(ctx.db, {
      name_pt: input.name_pt,
      name_en: null,
      category: 'strength',
      equipment: input.equipment as never,
      load_kind: input.load_kind as never,
      primary_muscles: input.primary_muscles,
      secondary_muscles: input.secondary_muscles.filter((m) => !input.primary_muscles.includes(m)),
      is_compound: input.is_compound,
      increment_kg: input.increment_kg ?? null,
      source: 'custom',
      source_id: null,
    });
    ctx.audit('exercise', id, 'create', undefined, { name_pt: input.name_pt });
    const hints: string[] = [];
    for (const alias of [input.name_pt, ...input.aliases]) {
      const res = addAlias(ctx.db, alias, id, 'llm');
      if (res === 'added')
        ctx.audit('exercise_alias', id, 'create', undefined, { alias_norm: normalize(alias) });
      if (res === 'conflict')
        hints.push(`apelido "${alias}" já pertence a outro exercício; não foi adicionado`);
    }
    syncExerciseFts(ctx.db, id);
    return ok({ id }, hints);
  },
});

export const addExerciseAliasTool = defineTool({
  name: 'add_exercise_alias',
  scope: 'write',
  description:
    'Liga um apelido (como o usuário fala) a um exercício existente. Ex.: { "exercise_id": 12, "alias": "sup inc" }.',
  input: z.object({ exercise_id: z.number().int().positive(), alias: z.string().trim().min(2).max(60) }),
  handler: (ctx, { exercise_id, alias }) => {
    if (!getExercise(ctx.db, exercise_id)) return err('NOT_FOUND', `exercício ${exercise_id} não existe`);
    const res = addAlias(ctx.db, alias, exercise_id, 'llm');
    if (res === 'conflict') return err('CONFLICT', `o apelido "${alias}" já pertence a outro exercício`);
    if (res === 'added') {
      ctx.audit('exercise_alias', exercise_id, 'create', undefined, { alias_norm: normalize(alias) });
      syncExerciseFts(ctx.db, exercise_id);
    }
    return ok({ exercise_id, alias: normalize(alias), added: res === 'added' });
  },
});

// ── define_routine ───────────────────────────────────────────────────────────────────────

export const defineRoutineTool = defineTool({
  name: 'define_routine',
  scope: 'write',
  description:
    'Cria ou substitui uma rotina nomeada ("upper B") com a lista ordenada de exercícios e a faixa de reps. ' +
    'Ex.: "supino inclinado halter 3x8-12" → { exercise_id, target_sets: 3, rep_min: 8, rep_max: 12 }.',
  input: z.object({
    name: z.string().trim().min(1).max(40),
    exercises: z
      .array(
        z
          .object({
            exercise_id: z.number().int().positive(),
            target_sets: z.number().int().min(1).max(20).optional(),
            rep_min: z.number().int().min(1).max(100).optional(),
            rep_max: z.number().int().min(1).max(100).optional(),
          })
          .refine(
            (x) => x.rep_min === undefined || x.rep_max === undefined || x.rep_min <= x.rep_max,
            'rep_min > rep_max',
          ),
      )
      .min(1)
      .max(30),
  }),
  handler: (ctx, { name, exercises }) => {
    const missing = exercises.filter((x) => !getExercise(ctx.db, x.exercise_id)).map((x) => x.exercise_id);
    if (missing.length) return err('NOT_FOUND', `exercícios inexistentes: ${missing.join(', ')}`, missing);

    const existing = findRoutine(ctx.db, name, true);
    let routineId: number;
    if (existing) {
      const before = routineSnapshot(ctx.db, existing);
      ctx.db.prepare('UPDATE routines SET name = ?, deleted_at = NULL WHERE id = ?').run(name, existing.id);
      routineId = existing.id;
      replaceRoutineExercises(ctx.db, routineId, rows(exercises));
      ctx.audit('routine', routineId, 'update', before, { name });
    } else {
      routineId = insertRoutine(ctx.db, name, ctx.now);
      replaceRoutineExercises(ctx.db, routineId, rows(exercises));
      ctx.audit('routine', routineId, 'create', undefined, { name });
    }
    return ok({
      routine_id: routineId,
      name,
      replaced: Boolean(existing),
      exercises: routineExercisesWithNames(ctx.db, routineId),
    });
  },
});

function rows(xs: { exercise_id: number; target_sets?: number; rep_min?: number; rep_max?: number }[]) {
  return xs.map((x) => ({
    exercise_id: x.exercise_id,
    target_sets: x.target_sets ?? null,
    rep_min: x.rep_min ?? null,
    rep_max: x.rep_max ?? null,
  }));
}

// ── log_workout ──────────────────────────────────────────────────────────────────────────

const setSchema = z.object({
  weight_kg: z.number().min(0).max(1000).optional().describe('Como o usuário fala: halter = peso por mão.'),
  reps: z.number().int().min(0).max(200).optional(),
  rpe: z.number().min(1).max(10).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  set_type: z.enum(['work', 'warmup', 'drop', 'failure']).default('work'),
  notes: z.string().max(200).optional(),
});

export const logWorkoutTool = defineTool({
  name: 'log_workout',
  scope: 'write',
  description:
    'Registra séries. Sem session_id e sem new_session, anexa à sessão aberta (atividade nas últimas horas) ou cria uma. ' +
    'Passe routine_name quando o usuário citar a rotina (só vincula se ela existir). Cada série é um item de `sets`: ' +
    '"3x10 30kg" = 3 itens { weight_kg: 30, reps: 10 }. Devolve sets_compact, vs_last e PRs já calculados.',
  input: z.object({
    routine_name: z.string().trim().min(1).optional(),
    session_id: z.number().int().positive().optional(),
    new_session: z.boolean().optional(),
    performed_at: when,
    entries: z
      .array(
        z.object({
          exercise_id: z.number().int().positive(),
          sets: z.array(setSchema).min(1).max(30),
          notes: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(20),
    notes: z.string().max(300).optional(),
  }),
  handler: (ctx, input) => {
    const { at, localDate } = resolve(ctx, input.performed_at);
    const hints: string[] = [];
    for (const e of input.entries) {
      if (!getExercise(ctx.db, e.exercise_id))
        return err('NOT_FOUND', `exercício ${e.exercise_id} não existe`);
    }

    const routine = input.routine_name ? findRoutine(ctx.db, input.routine_name) : undefined;
    if (input.routine_name && !routine) {
      hints.push(`a rotina "${input.routine_name}" não existe; o treino foi registrado sem vínculo`);
    }

    // sessão: explícita → aberta compatível → nova
    let sessionId: number | undefined;
    let appended = false;
    if (input.session_id) {
      if (!getSession(ctx.db, input.session_id))
        return err('NOT_FOUND', `sessão ${input.session_id} não existe`);
      sessionId = input.session_id;
      appended = true;
    } else if (!input.new_session) {
      const open = lastChatSession(ctx.db);
      const compatible = open && (!routine || open.routine_id === null || open.routine_id === routine.id);
      if (open && compatible && isSessionOpen(open.last_activity, at, ctx.settings.openSessionHours)) {
        sessionId = open.id;
        appended = true;
      }
    }
    if (sessionId === undefined) {
      sessionId = insertSession(ctx.db, {
        routine_id: routine?.id ?? null,
        started_at: at,
        local_date: localDate,
        notes: input.notes ?? null,
        now: ctx.now,
      });
      ctx.audit('workout_session', sessionId, 'create');
    } else if (routine) {
      setSessionRoutine(ctx.db, sessionId, routine.id);
    }

    const existing = sessionSets(ctx.db, sessionId);
    const orderOf = new Map(existing.map((s) => [s.exercise_id, s.exercise_order]));
    const countOf = new Map<number, number>();
    for (const s of existing)
      countOf.set(s.exercise_id, Math.max(countOf.get(s.exercise_id) ?? 0, s.set_index));
    let nextOrder = Math.max(0, ...existing.map((s) => s.exercise_order)) + 1;

    const touched: number[] = [];
    for (const e of input.entries) {
      if (!orderOf.has(e.exercise_id)) orderOf.set(e.exercise_id, nextOrder++);
      for (const s of e.sets) {
        const idx = (countOf.get(e.exercise_id) ?? 0) + 1;
        countOf.set(e.exercise_id, idx);
        const id = insertSet(ctx.db, {
          session_id: sessionId,
          exercise_id: e.exercise_id,
          exercise_order: orderOf.get(e.exercise_id) as number,
          set_index: idx,
          weight_kg: s.weight_kg ?? null,
          reps: s.reps ?? null,
          rpe: s.rpe ?? null,
          rir: s.rir ?? null,
          set_type: s.set_type,
          notes: s.notes ?? e.notes ?? null,
          created_at: ctx.now,
        });
        ctx.audit('set', id, 'create');
      }
      if (!touched.includes(e.exercise_id)) touched.push(e.exercise_id);
    }

    const all = sessionSets(ctx.db, sessionId);
    const bw = latestBodyweight(ctx.db);
    const summary = touched.map((exId) => {
      const ex = getExercise(ctx.db, exId)!;
      const current = all.filter((s) => s.exercise_id === exId);
      const last = exerciseSessions(ctx.db, exId, 1, sessionId)[0];
      const vs = last ? vsLast(last.sets, current) : undefined;
      return {
        exercise: ex.name_pt,
        sets_compact: setsCompact(current),
        ...(vs ? { vs_last: vs } : {}),
        prs: detectPrs(exerciseHistory(ctx.db, exId, sessionId), current, ex.load_kind, bw),
      };
    });
    const session = getSession(ctx.db, sessionId)!;
    const routineName = session.routine_id
      ? (ctx.db.prepare('SELECT name FROM routines WHERE id = ?').pluck().get(session.routine_id) as string)
      : undefined;
    return ok(
      {
        session_id: sessionId,
        local_date: session.local_date,
        ...(routineName ? { routine: routineName } : {}),
        appended_to_open_session: appended,
        summary,
        session_totals: {
          work_sets: all.filter((s) => s.set_type !== 'warmup').length,
          exercises: new Set(all.map((s) => s.exercise_id)).size,
        },
      },
      hints,
    );
  },
});

// ── consultas ────────────────────────────────────────────────────────────────────────────

function summarizeSession(ctx: ToolContext, sets: StoredSet[]) {
  const bw = latestBodyweight(ctx.db);
  const byEx = new Map<number, StoredSet[]>();
  for (const s of sets) byEx.set(s.exercise_id, [...(byEx.get(s.exercise_id) ?? []), s]);
  return [...byEx.entries()].map(([exId, xs]) => {
    const ex = getExercise(ctx.db, exId);
    return {
      name: ex?.name_pt ?? `#${exId}`,
      sets_compact: setsCompact(xs),
      best_e1rm: ex ? round1(bestE1rm(xs, ex.load_kind, bw)) : null,
    };
  });
}

export const getLastSessionsTool = defineTool({
  name: 'get_last_sessions',
  scope: 'read',
  description:
    'Últimas sessões de uma rotina (routine_name), de um exercício (exercise_id) ou, sem filtro, as mais recentes. ' +
    'Traz cargas por exercício (sets_compact) e o melhor e1RM.',
  input: z.object({
    routine_name: z.string().trim().min(1).optional(),
    exercise_id: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(5).default(1),
  }),
  handler: (ctx, { routine_name, exercise_id, limit }) => {
    if (exercise_id !== undefined) {
      const ex = getExercise(ctx.db, exercise_id);
      if (!ex) return err('NOT_FOUND', `exercício ${exercise_id} não existe`);
      const bw = latestBodyweight(ctx.db);
      return ok({
        sessions: exerciseSessions(ctx.db, exercise_id, limit).map((s) => ({
          session_id: s.session_id,
          local_date: s.local_date,
          date: formatDayMonth(s.local_date),
          ...(s.routine ? { routine: s.routine } : {}),
          exercises: [
            {
              name: ex.name_pt,
              sets_compact: setsCompact(s.sets),
              best_e1rm: round1(bestE1rm(s.sets, ex.load_kind, bw)),
            },
          ],
        })),
      });
    }
    let list: { id: number; local_date: string; routine?: string | null }[];
    if (routine_name) {
      const r = findRoutine(ctx.db, routine_name);
      if (!r) return err('NOT_FOUND', `rotina "${routine_name}" não existe`, routineNames(ctx));
      list = routineSessions(ctx.db, r.id, limit).map((s) => ({ ...s, routine: r.name }));
    } else list = recentSessions(ctx.db, limit);
    return ok({
      sessions: list.map((s) => ({
        session_id: s.id,
        local_date: s.local_date,
        date: formatDayMonth(s.local_date),
        ...(s.routine ? { routine: s.routine } : {}),
        exercises: summarizeSession(ctx, sessionSets(ctx.db, s.id)),
      })),
    });
  },
});

function routineNames(ctx: ToolContext): string[] {
  return ctx.db
    .prepare('SELECT name FROM routines WHERE deleted_at IS NULL ORDER BY name')
    .pluck()
    .all() as string[];
}

/** Alvos da próxima sessão de uma rotina (usado pela tool e pelo comando /treino). */
export function computeTargets(ctx: Pick<ToolContext, 'db'>, routineName: string) {
  const r = findRoutine(ctx.db, routineName);
  if (!r) return undefined;
  const bw = latestBodyweight(ctx.db);
  const lastSession = routineSessions(ctx.db, r.id, 1)[0];
  const targets = routineExercisesWithNames(ctx.db, r.id).map((re) => {
    const ex = getExercise(ctx.db, re.exercise_id)!;
    const sessions = exerciseSessions(ctx.db, re.exercise_id, 6).map((s) => ({
      sets: s.sets,
      bestE1rm: bestE1rm(s.sets, ex.load_kind, bw),
    }));
    const t = nextTarget({
      sessions,
      repMin: re.rep_min,
      repMax: re.rep_max,
      incrementKg: ex.increment_kg,
      loadKind: ex.load_kind,
    });
    return { exercise: ex.name_pt, ...t };
  });
  return { routine: r.name, last_date: lastSession ? lastSession.local_date : null, targets };
}

export const getNextTargetsTool = defineTool({
  name: 'get_next_targets',
  scope: 'read',
  description:
    'Alvos para a próxima sessão de uma rotina pela progressão dupla: increase (subir carga), hold (+1 rep na série mais fraca), ' +
    'deload (−10%) ou first_time. Use para "o que fiz no último upper B" e "cargas de hoje".',
  input: z.object({ routine_name: z.string().trim().min(1) }),
  handler: (ctx, { routine_name }) => {
    const res = computeTargets(ctx, routine_name);
    if (!res) return err('NOT_FOUND', `rotina "${routine_name}" não existe`, routineNames(ctx));
    return ok({ ...res, ...(res.last_date ? { last_date_br: formatDayMonth(res.last_date) } : {}) });
  },
});

// ── log_cardio ───────────────────────────────────────────────────────────────────────────

export const logCardioTool = defineTool({
  name: 'log_cardio',
  scope: 'write',
  description:
    'Registra cardio: "30 min esteira" → { activity: "esteira", duration_min: 30 }; "corri 5 km em 28 min" → distance_km 5, duration_min 28.',
  input: z
    .object({
      activity: z.string().trim().min(2).max(40),
      duration_min: z
        .number()
        .positive()
        .max(24 * 60)
        .optional(),
      distance_km: z.number().positive().max(500).optional(),
      avg_hr: z.number().int().min(30).max(240).optional(),
      kcal: z.number().positive().max(10000).optional(),
      performed_at: when,
    })
    .refine(
      (v) => v.duration_min !== undefined || v.distance_km !== undefined,
      'informe duração ou distância',
    ),
  handler: (ctx, input) => {
    const { at, localDate } = resolve(ctx, input.performed_at);
    const id = insertCardio(ctx.db, {
      local_date: localDate,
      started_at: at,
      activity: input.activity.toLowerCase(),
      duration_s: input.duration_min === undefined ? null : Math.round(input.duration_min * 60),
      distance_m: input.distance_km === undefined ? null : Math.round(input.distance_km * 1000),
      avg_hr: input.avg_hr ?? null,
      kcal: input.kcal ?? null,
      created_at: ctx.now,
    });
    ctx.audit('cardio_session', id, 'create');
    return ok({ id, local_date: localDate });
  },
});

export const trainingTools = [
  searchExercisesTool,
  createExerciseTool,
  addExerciseAliasTool,
  defineRoutineTool,
  logWorkoutTool,
  getLastSessionsTool,
  getNextTargetsTool,
  logCardioTool,
];

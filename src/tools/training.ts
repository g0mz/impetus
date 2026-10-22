import { z } from 'zod';
import { addAlias, searchExercises, syncExerciseFts, upsertExercise } from '../db/repos/exercises.ts';
import {
  exerciseHistory,
  exerciseSessions,
  findRoutine,
  getExercise,
  getRoutineExercises,
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
  updateRoutineExercise,
  type RoutineExerciseRow,
  type StoredSet,
} from '../db/repos/training.ts';
import { fmtKg, setsCompact } from '../domain/training/format.ts';
import { bestE1rm, type SetLike } from '../domain/training/load.ts';
import { MUSCLES } from '../domain/training/muscles.ts';
import { nextTarget } from '../domain/training/progression.ts';
import { detectPrs, vsLast } from '../domain/training/prs.ts';
import {
  changedLoad,
  isWeightOptional,
  plannedSets,
  savedReps,
  topWorkLoad,
  type SavedPrescription,
} from '../domain/training/routine-plan.ts';
import { EQUIPMENT, LOAD_KINDS, isSessionOpen } from '../domain/training/types.ts';
import { normalize } from '../text/normalize.ts';
import { formatDayMonth, resolveWhen } from '../time.ts';
import { defineTool, err, ok, type Envelope, type ToolContext } from './registry.ts';

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
    'Inclua o termo que o usuário usou em `aliases`. Halteres: load_kind "per_hand". Se existir exercício parecido, ' +
    'a tool devolve CONFLICT com candidatos: prefira usar um deles (e add_exercise_alias com o termo do usuário); ' +
    'só passe confirm_new: true se for mesmo outro movimento.',
  input: z.object({
    name_pt: z.string().trim().min(2).max(80),
    aliases: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
    equipment: z.enum(EQUIPMENT as [string, ...string[]]),
    load_kind: z.enum(LOAD_KINDS as [string, ...string[]]),
    primary_muscles: z.array(muscle).min(1),
    secondary_muscles: z.array(muscle).default([]),
    is_compound: z.boolean().default(false),
    increment_kg: z.number().positive().max(50).optional(),
    confirm_new: z.boolean().optional(),
  }),
  handler: (ctx, input) => {
    if (!input.confirm_new) {
      // evita duplicatas como "Extensora de perna" quando já existe "Cadeira extensora"
      const similar = new Map<number, { id: number; name_pt: string }>();
      for (const q of [input.name_pt, ...input.aliases])
        for (const m of searchExercises(ctx.db, q, 3)) if (m.score >= 0.5) similar.set(m.id, { id: m.id, name_pt: m.name_pt });
      if (similar.size)
        return err(
          'CONFLICT',
          `já existem exercícios parecidos: ${[...similar.values()].map((x) => `${x.name_pt} (${x.id})`).join(', ')}. Use um deles ou confirm_new: true`,
          [...similar.values()],
        );
    }
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
    'Cria ou substitui uma rotina nomeada ("upper B") com a lista ordenada de exercícios, a faixa de reps e, se o usuário ' +
    'disser, a carga e as reps de cada um (ficam salvas para log_routine). ' +
    'Ex.: "supino inclinado halter 3x8-12" → { exercise_id, target_sets: 3, rep_min: 8, rep_max: 12 }; ' +
    '"remada curvada 4x8 60kg" → { exercise_id, target_sets: 4, reps: 8, weight_kg: 60 }. ' +
    'Ao redefinir, exercício sem carga informada mantém a carga que já estava salva.',
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
            weight_kg: z.number().min(0).max(1000).optional().describe('Halter = peso por mão.'),
            reps: z.number().int().min(1).max(100).optional().describe('Reps por série que o usuário faz hoje.'),
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
      const kept = new Map(before.exercises.map((x) => [x.exercise_id, x]));
      ctx.db.prepare('UPDATE routines SET name = ?, deleted_at = NULL WHERE id = ?').run(name, existing.id);
      routineId = existing.id;
      replaceRoutineExercises(ctx.db, routineId, rows(exercises, kept));
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
      exercises: routineExercisesWithNames(ctx.db, routineId).map(routineLine),
    });
  },
});

type RoutineInput = {
  exercise_id: number;
  target_sets?: number;
  rep_min?: number;
  rep_max?: number;
  weight_kg?: number;
  reps?: number;
};

function rows(xs: RoutineInput[], kept = new Map<number, RoutineExerciseRow>()) {
  return xs.map((x) => ({
    exercise_id: x.exercise_id,
    target_sets: x.target_sets ?? null,
    rep_min: x.rep_min ?? null,
    rep_max: x.rep_max ?? null,
    weight_kg: x.weight_kg ?? kept.get(x.exercise_id)?.weight_kg ?? null,
    reps: x.reps ?? kept.get(x.exercise_id)?.reps ?? null,
  }));
}

/**
 * Carga salva como texto: "30kg 3×10", "3×10" (peso corporal), "30kg" (faltam séries).
 * Rotina só com séries e faixa (sem carga nem reps salvas) não tem "salvo".
 */
function savedCompact(p: SavedPrescription): string | undefined {
  if (p.weight_kg === null && p.reps === null) return undefined;
  const reps = savedReps(p);
  const kg = p.weight_kg === null ? '' : `${fmtKg(p.weight_kg)}kg`;
  const scheme = p.target_sets !== null && reps !== null ? `${p.target_sets}×${reps}` : '';
  return [kg, scheme].filter(Boolean).join(' ') || undefined;
}

/** Linha enxuta de exercício da rotina para as respostas das tools. */
function routineLine(re: RoutineExerciseRow & { name_pt: string }) {
  const saved = savedCompact(re);
  return {
    position: re.position,
    exercise_id: re.exercise_id,
    name_pt: re.name_pt,
    ...(re.target_sets !== null ? { target_sets: re.target_sets } : {}),
    ...(re.rep_min !== null ? { rep_min: re.rep_min } : {}),
    ...(re.rep_max !== null ? { rep_max: re.rep_max } : {}),
    ...(saved ? { saved } : {}),
  };
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
  handler: (ctx, input) => writeWorkout(ctx, input),
});

type WorkoutInput = {
  routine_name?: string;
  session_id?: number;
  new_session?: boolean;
  performed_at?: string;
  entries: { exercise_id: number; sets: z.infer<typeof setSchema>[]; notes?: string }[];
  notes?: string;
};

type WorkoutOut = {
  session_id: number;
  local_date: string;
  routine?: string;
  appended_to_open_session: boolean;
  summary: { exercise: string; sets_compact: string; vs_last?: string; prs: string[] }[];
  session_totals: { work_sets: number; exercises: number };
};

/** Grava as séries (sessão explícita → aberta compatível → nova) e devolve o resumo calculado. */
function writeWorkout(ctx: ToolContext, input: WorkoutInput): Envelope<WorkoutOut> {
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
    // séries anotadas sem carga num exercício com carga (D-034) não entram em vs_last nem em PRs
    const comparable = (xs: SetLike[]) => isWeightOptional(ex) || xs.some((x) => x.weight_kg !== null);
    const last = comparable(current)
      ? exerciseSessions(ctx.db, exId, 6, sessionId).find((x) => comparable(x.sets))
      : undefined;
    const vs = last ? vsLast(last.sets, current) : undefined;
    const history = exerciseHistory(ctx.db, exId, sessionId).filter(
      (x) => isWeightOptional(ex) || x.weight_kg !== null,
    );
    return {
      exercise: ex.name_pt,
      sets_compact: setsCompact(current),
      ...(vs ? { vs_last: vs } : {}),
      prs: comparable(current) ? detectPrs(history, current, ex.load_kind, bw) : [],
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
}

// ── log_routine / set_routine_loads ──────────────────────────────────────────────────────

export const logRoutineTool = defineTool({
  name: 'log_routine',
  scope: 'write',
  description:
    'Registra um treino de rotina inteiro com as cargas salvas: "fiz upper A" → { routine_name: "upper A" }. ' +
    'Em `changes` vai só o que foi diferente: "supino subi pra 32" → { exercise_id, weight_kg: 32 }; "remada fiz 10 reps" → ' +
    '{ exercise_id, reps: 10 }; "lateral só 2 séries" → { exercise_id, n_sets: 2 }; séries variadas ("30kg 10/10/9") → ' +
    '{ exercise_id, sets: [...] } como no log_workout; "pulei a lateral" → { exercise_id, skip: true }. Exercício fora da rotina ' +
    'em `changes` (com sets) entra só neste treino. Sem carga salva, usa a última registrada do exercício; sem nenhuma, ' +
    'anota séries e reps sem carga e devolve without_load (avise o usuário). Quando a carga muda, a nova carga fica salva na rotina (loads_updated); ' +
    'se o usuário disser que foi só hoje, passe keep_loads: true.',
  input: z.object({
    routine_name: z.string().trim().min(1),
    performed_at: when,
    new_session: z.boolean().optional(),
    changes: z
      .array(
        z.object({
          exercise_id: z.number().int().positive(),
          weight_kg: z.number().min(0).max(1000).optional().describe('Halter = peso por mão.'),
          reps: z.number().int().min(1).max(200).optional(),
          n_sets: z.number().int().min(1).max(20).optional(),
          sets: z.array(setSchema).min(1).max(30).optional(),
          skip: z.boolean().optional(),
        }),
      )
      .max(30)
      .default([]),
    keep_loads: z.boolean().optional(),
    notes: z.string().max(300).optional(),
  }),
  handler: (ctx, input) => {
    const routine = findRoutine(ctx.db, input.routine_name);
    if (!routine) return err('NOT_FOUND', `rotina "${input.routine_name}" não existe`, routineNames(ctx));
    const plan = getRoutineExercises(ctx.db, routine.id);
    const changes = new Map(input.changes.map((c) => [c.exercise_id, c]));
    for (const c of input.changes)
      if (!getExercise(ctx.db, c.exercise_id)) return err('NOT_FOUND', `exercício ${c.exercise_id} não existe`);

    const entries: WorkoutInput['entries'] = [];
    const missing: { exercise_id: number; exercise: string; missing: string[] }[] = [];
    const skipped: string[] = [];
    const withoutLoad: string[] = [];
    const inRoutine = new Set(plan.map((re) => re.exercise_id));
    const extras = input.changes.filter((c) => !inRoutine.has(c.exercise_id) && !c.skip);
    for (const item of [...plan, ...extras.map(asPrescription)]) {
      const ex = getExercise(ctx.db, item.exercise_id)!;
      const c = changes.get(item.exercise_id);
      if (c?.skip) {
        skipped.push(ex.name_pt);
        continue;
      }
      if (c?.sets) {
        entries.push({ exercise_id: item.exercise_id, sets: c.sets });
        continue;
      }
      // sem carga salva: a última carga registrada do exercício (a 1ª vez não precisa ditar tudo de novo)
      const lastLoad =
        item.weight_kg === null && c?.weight_kg === undefined ? lastLoggedLoad(ctx, item.exercise_id) : null;
      const prescription = lastLoad === null ? item : { ...item, weight_kg: lastLoad };
      const override = {
        ...(c?.weight_kg !== undefined ? { weight_kg: c.weight_kg } : {}),
        ...(c?.reps !== undefined ? { reps: c.reps } : {}),
        ...(c?.n_sets !== undefined ? { sets: c.n_sets } : {}),
      };
      let res = plannedSets(prescription, isWeightOptional(ex), override);
      // nenhuma carga conhecida: anota séries e reps sem carga e avisa (D-034)
      if (!res.ok && res.missing.length === 1 && res.missing[0] === 'weight') {
        res = plannedSets(prescription, true, override);
        withoutLoad.push(ex.name_pt);
      }
      if (res.ok) entries.push({ exercise_id: item.exercise_id, sets: res.sets });
      else missing.push({ exercise_id: item.exercise_id, exercise: ex.name_pt, missing: res.missing });
    }
    if (missing.length) {
      const pt = { sets: 'séries', reps: 'reps', weight: 'carga' } as Record<string, string>;
      return err(
        'VALIDATION',
        `sem dados salvos para montar o treino: ${missing.map((m) => `${m.exercise} (${m.missing.map((k) => pt[k]).join(', ')})`).join('; ')}. ` +
          'Pergunte ao usuário e passe em changes (ou salve com set_routine_loads)',
        missing,
      );
    }
    if (!entries.length) return err('VALIDATION', 'todos os exercícios foram pulados; nada para registrar');

    const logged = writeWorkout(ctx, {
      routine_name: routine.name,
      ...(input.performed_at ? { performed_at: input.performed_at } : {}),
      ...(input.new_session ? { new_session: true } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      entries,
    });
    if (!logged.ok) return logged;

    const loadsUpdated: { exercise: string; from?: string; to: string }[] = [];
    if (!input.keep_loads) {
      const before = routineSnapshot(ctx.db, routine);
      for (const re of plan) {
        const entry = entries.find((e) => e.exercise_id === re.exercise_id);
        if (!entry) continue;
        const next = changedLoad(
          re.weight_kg,
          entry.sets.map((x) => ({ weight_kg: x.weight_kg ?? null, reps: x.reps ?? null, set_type: x.set_type })),
        );
        if (next === null) continue;
        updateRoutineExercise(ctx.db, routine.id, re.position, { ...re, weight_kg: next });
        loadsUpdated.push({
          exercise: getExercise(ctx.db, re.exercise_id)!.name_pt,
          ...(re.weight_kg !== null ? { from: `${fmtKg(re.weight_kg)}kg` } : {}),
          to: `${fmtKg(next)}kg`,
        });
      }
      if (loadsUpdated.length) ctx.audit('routine', routine.id, 'update', before, { loads: loadsUpdated });
    }
    return ok(
      {
        ...logged.data,
        ...(loadsUpdated.length ? { loads_updated: loadsUpdated } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(withoutLoad.length ? { without_load: withoutLoad } : {}),
      },
      withoutLoad.length
        ? [
            ...(logged.hints ?? []),
            `sem carga registrada: ${withoutLoad.join(', ')} — anotado só séries e reps; avise o usuário no início da resposta e peça as cargas`,
          ]
        : logged.hints,
    );
  },
});

/** Carga da sessão mais recente do exercício que teve carga (pula as anotadas sem carga). */
function lastLoggedLoad(ctx: ToolContext, exerciseId: number): number | null {
  for (const sess of exerciseSessions(ctx.db, exerciseId, 6)) {
    const top = topWorkLoad(sess.sets);
    if (top !== null) return top;
  }
  return null;
}

/** Exercício extra (fora da rotina) tratado como prescrição vazia: só vale o que veio em `changes`. */
function asPrescription(c: { exercise_id: number }): SavedPrescription & { exercise_id: number } {
  return { exercise_id: c.exercise_id, target_sets: null, rep_min: null, rep_max: null, weight_kg: null, reps: null };
}

export const setRoutineLoadsTool = defineTool({
  name: 'set_routine_loads',
  scope: 'write',
  description:
    'Muda a carga, as reps ou as séries salvas de exercícios de uma rotina, sem registrar treino: ' +
    '"no upper A o supino agora é 34kg" → { routine_name: "upper A", loads: [{ exercise_id, weight_kg: 34 }] }. ' +
    'weight_kg null = sem carga (peso corporal).',
  input: z.object({
    routine_name: z.string().trim().min(1),
    loads: z
      .array(
        z
          .object({
            exercise_id: z.number().int().positive(),
            weight_kg: z.number().min(0).max(1000).nullable().optional(),
            reps: z.number().int().min(1).max(100).optional(),
            target_sets: z.number().int().min(1).max(20).optional(),
          })
          .refine(
            (x) => x.weight_kg !== undefined || x.reps !== undefined || x.target_sets !== undefined,
            'informe weight_kg, reps ou target_sets',
          ),
      )
      .min(1)
      .max(30),
  }),
  handler: (ctx, { routine_name, loads }) => {
    const routine = findRoutine(ctx.db, routine_name);
    if (!routine) return err('NOT_FOUND', `rotina "${routine_name}" não existe`, routineNames(ctx));
    const before = routineSnapshot(ctx.db, routine);
    for (const l of loads) {
      const re = before.exercises.find((x) => x.exercise_id === l.exercise_id);
      if (!re) return err('NOT_FOUND', `exercício ${l.exercise_id} não está na rotina ${routine.name}`);
      updateRoutineExercise(ctx.db, routine.id, re.position, {
        weight_kg: l.weight_kg !== undefined ? l.weight_kg : re.weight_kg,
        reps: l.reps ?? re.reps,
        target_sets: l.target_sets ?? re.target_sets,
      });
    }
    ctx.audit('routine', routine.id, 'update', before, { loads });
    return ok({ routine: routine.name, exercises: routineExercisesWithNames(ctx.db, routine.id).map(routineLine) });
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
      exercise_id: exId,
      sets_compact: setsCompact(xs),
      set_ids: xs.map((x) => x.id),
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
    const saved = savedCompact(re);
    return { exercise: ex.name_pt, ...(saved ? { saved } : {}), ...t };
  });
  return { routine: r.name, last_date: lastSession ? lastSession.local_date : null, targets };
}

export const getNextTargetsTool = defineTool({
  name: 'get_next_targets',
  scope: 'read',
  description:
    'Carga salva (saved) e alvos para a próxima sessão de uma rotina pela progressão dupla: increase (subir carga), hold (+1 rep na série mais fraca), ' +
    'deload (−10%) ou first_time. Use para "o que fiz no último upper B" e "cargas de hoje".',
  input: z.object({ routine_name: z.string().trim().min(1) }),
  handler: (ctx, { routine_name }) => {
    const res = computeTargets(ctx, routine_name);
    if (!res) return err('NOT_FOUND', `rotina "${routine_name}" não existe`, routineNames(ctx));
    return ok({ ...res, ...(res.last_date ? { last_date_br: formatDayMonth(res.last_date) } : {}) });
  },
});

// ── edit_workout ─────────────────────────────────────────────────────────────────────────

const row = (ctx: ToolContext, table: 'workout_sessions' | 'sets', id: number) =>
  ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;

export const editWorkoutTool = defineTool({
  name: 'edit_workout',
  scope: 'write',
  description:
    'Corrige uma sessão já registrada: horário ("treinei das 18h15 às 20h30" → started_at "2026-10-14T18:15", ended_at ' +
    '"2026-10-14T20:30", hora local), notas, e séries (set_id do <open_session> ou de get_last_sessions): mudar carga, reps, ' +
    'tipo (ex.: aquecimento → set_type "warmup"), trocar o exercício (exercise_id) ou apagar (delete: true). Tudo entra no /desfazer.',
  input: z
    .object({
      session_id: z.number().int().positive(),
      started_at: when,
      ended_at: when,
      notes: z.string().max(300).optional(),
      set_changes: z
        .array(
          z.object({
            set_id: z.number().int().positive(),
            weight_kg: z.number().min(0).max(1000).nullable().optional(),
            reps: z.number().int().min(0).max(1000).nullable().optional(),
            set_type: z.enum(['work', 'warmup', 'drop', 'failure']).optional(),
            exercise_id: z.number().int().positive().optional(),
            delete: z.boolean().optional(),
          }),
        )
        .max(60)
        .default([]),
    })
    .refine(
      (v) => v.started_at || v.ended_at || v.notes !== undefined || v.set_changes.length,
      'nada para alterar',
    ),
  handler: (ctx, input) => {
    const session = getSession(ctx.db, input.session_id);
    if (!session) return err('NOT_FOUND', `sessão ${input.session_id} não existe`);

    if (input.started_at || input.ended_at || input.notes !== undefined) {
      const before = row(ctx, 'workout_sessions', session.id)!;
      const start = input.started_at ? resolve(ctx, input.started_at) : undefined;
      const end = input.ended_at ? resolve(ctx, input.ended_at).at : (before.ended_at as string | null);
      const startAt = start?.at ?? (before.started_at as string);
      if (end && end <= startAt) return err('VALIDATION', 'ended_at precisa ser depois de started_at');
      ctx.db
        .prepare('UPDATE workout_sessions SET started_at = ?, local_date = ?, ended_at = ?, notes = ? WHERE id = ?')
        .run(
          startAt,
          start?.localDate ?? before.local_date,
          end ?? null,
          input.notes ?? before.notes ?? null,
          session.id,
        );
      ctx.audit('workout_session', session.id, 'update', before, row(ctx, 'workout_sessions', session.id));
    }

    for (const c of input.set_changes) {
      const before = row(ctx, 'sets', c.set_id);
      if (!before || before.deleted_at || before.session_id !== session.id)
        return err('NOT_FOUND', `série ${c.set_id} não pertence à sessão ${session.id}`);
      if (c.delete) {
        ctx.db.prepare('UPDATE sets SET deleted_at = ? WHERE id = ?').run(ctx.now, c.set_id);
        ctx.audit('set', c.set_id, 'delete', before);
        continue;
      }
      if (c.exercise_id && !getExercise(ctx.db, c.exercise_id))
        return err('NOT_FOUND', `exercício ${c.exercise_id} não existe`);
      ctx.db
        .prepare('UPDATE sets SET weight_kg = ?, reps = ?, set_type = ?, exercise_id = ? WHERE id = ?')
        .run(
          c.weight_kg !== undefined ? c.weight_kg : before.weight_kg,
          c.reps !== undefined ? c.reps : before.reps,
          c.set_type ?? before.set_type,
          c.exercise_id ?? before.exercise_id,
          c.set_id,
        );
      ctx.audit('set', c.set_id, 'update', before, row(ctx, 'sets', c.set_id));
    }

    const after = row(ctx, 'workout_sessions', session.id)!;
    const sets = sessionSets(ctx.db, session.id);
    return ok({
      session_id: session.id,
      local_date: after.local_date,
      started_at: after.started_at,
      ended_at: after.ended_at,
      summary: summarizeSession(ctx, sets),
      work_sets: sets.filter((x) => x.set_type !== 'warmup').length,
    });
  },
});

// ── log_cardio ───────────────────────────────────────────────────────────────────────────

export const logCardioTool = defineTool({
  name: 'log_cardio',
  scope: 'write',
  description:
    'Registra cardio: "30 min esteira" → { activity: "esteira", duration_min: 30 }; "corri 5 km em 28 min" → distance_km 5, duration_min 28; ' +
    '"30 min na velocidade 6" → duration_min 30, speed_kmh 6 (a distância é calculada aqui; não calcule).',
  input: z
    .object({
      activity: z.string().trim().min(2).max(40),
      duration_min: z
        .number()
        .positive()
        .max(24 * 60)
        .optional(),
      distance_km: z.number().positive().max(500).optional(),
      speed_kmh: z.number().positive().max(60).optional(),
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
    const distanceKm =
      input.distance_km ??
      (input.speed_kmh !== undefined && input.duration_min !== undefined
        ? Math.round(((input.speed_kmh * input.duration_min) / 60) * 100) / 100
        : undefined);
    const id = insertCardio(ctx.db, {
      local_date: localDate,
      started_at: at,
      activity: input.activity.toLowerCase(),
      duration_s: input.duration_min === undefined ? null : Math.round(input.duration_min * 60),
      distance_m: distanceKm === undefined ? null : Math.round(distanceKm * 1000),
      avg_hr: input.avg_hr ?? null,
      kcal: input.kcal ?? null,
      created_at: ctx.now,
    });
    ctx.audit('cardio_session', id, 'create');
    return ok({ id, local_date: localDate, ...(distanceKm !== undefined ? { distance_km: distanceKm } : {}) });
  },
});

export const trainingTools = [
  searchExercisesTool,
  createExerciseTool,
  addExerciseAliasTool,
  defineRoutineTool,
  logWorkoutTool,
  logRoutineTool,
  setRoutineLoadsTool,
  getLastSessionsTool,
  getNextTargetsTool,
  logCardioTool,
  editWorkoutTool,
];

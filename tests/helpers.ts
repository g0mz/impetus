import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { addAlias, rebuildExerciseFts, upsertExercise } from '../src/db/repos/exercises.ts';
import { createTurn } from '../src/db/repos/turns.ts';
import { buildRegistry } from '../src/tools/index.ts';
import { callTool, type Envelope } from '../src/tools/registry.ts';

export const SETTINGS = { cutoffHour: 4, timeZone: 'America/Sao_Paulo', openSessionHours: 3 };

/** Banco em memória com um punhado de exercícios (rápido; o seed completo fica no teste de seeds). */
export function makeDb(): { db: Db; ex: Record<string, number> } {
  const db = openDb(':memory:');
  migrate(db);
  const mk = (
    key: string,
    name: string,
    aliases: string[],
    load_kind: 'total' | 'per_hand' | 'bodyweight_plus',
    equipment: 'barbell' | 'dumbbell' | 'bodyweight',
    primary: ('chest' | 'upper_back' | 'side_delts' | 'lats')[],
    increment: number | null,
  ) => {
    const id = upsertExercise(db, {
      name_pt: name,
      name_en: null,
      category: 'strength',
      equipment,
      load_kind,
      primary_muscles: primary,
      secondary_muscles: [],
      is_compound: true,
      increment_kg: increment,
      source: 'custom',
      source_id: null,
    });
    for (const a of [name, ...aliases]) addAlias(db, a, id, 'seed');
    return [key, id] as const;
  };
  const ex = Object.fromEntries([
    mk(
      'supInc',
      'Supino inclinado com halteres',
      ['supino inclinado halter', 'sup inc halter'],
      'per_hand',
      'dumbbell',
      ['chest'],
      2,
    ),
    mk(
      'supIncBarra',
      'Supino inclinado com barra',
      ['supino inclinado', 'sup inc'],
      'total',
      'barbell',
      ['chest'],
      2.5,
    ),
    mk('remada', 'Remada curvada com barra', ['remada curvada'], 'total', 'barbell', ['upper_back'], 2.5),
    mk(
      'lateral',
      'Elevação lateral com halteres',
      ['elevacao lateral'],
      'per_hand',
      'dumbbell',
      ['side_delts'],
      1,
    ),
    mk('barra', 'Barra fixa', ['barra'], 'bodyweight_plus', 'bodyweight', ['lats'], 2.5),
  ]);
  rebuildExerciseFts(db);
  return { db, ex };
}

/** Chama tools como o MCP chamaria, dentro de um turno. */
export function makeCaller(db: Db, opts: { now?: string; toolScope?: 'all' | 'read'; turnId?: number } = {}) {
  const registry = buildRegistry();
  const state = { now: opts.now ?? '2026-10-13T21:10:00Z', turnId: opts.turnId ?? createTurn(db, 'chat') };
  const call = <T = Record<string, unknown>>(name: string, input: unknown) =>
    callTool(registry, name, input, {
      db,
      now: state.now,
      turnId: state.turnId,
      settings: SETTINGS,
      toolScope: opts.toolScope ?? 'all',
    }) as Envelope<T>;
  return {
    call,
    state,
    /** Começa um novo turno (opcionalmente em outro instante). */
    newTurn(now?: string) {
      state.turnId = createTurn(db, 'chat');
      if (now) state.now = now;
      return state.turnId;
    },
  };
}

export function data<T>(env: Envelope<T>): T {
  if (!env.ok) throw new Error(`esperado ok, veio ${env.error.code}: ${env.error.message}`);
  return env.data;
}

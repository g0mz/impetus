import type { Db } from '../db/index.ts';
import { finishTurn, createTurn } from '../db/repos/turns.ts';
import { normalize } from '../text/normalize.ts';
import { callTool, type Registry, type ToolSettings } from '../tools/registry.ts';

/** Exercício da rotina como o usuário escreve (`as`) e o exercício do catálogo (`exercise`, pelo name_pt). */
export type RoutineItemSpec = {
  as: string;
  exercise: string;
  sets: number;
  reps: [number, number] | number;
  weight_kg?: number;
  /** Cria o exercício se ele não existir no catálogo. */
  create?: { equipment: string; load_kind: string; primary_muscles: string[]; secondary_muscles?: string[] };
};
export type RoutinesSpec = { routines: { name: string; exercises: RoutineItemSpec[] }[] };

export type ImportResult = {
  turnId: number;
  routines: { name: string; exercises: number; replaced: boolean }[];
  created: string[];
  aliases: string[];
};

function findByName(db: Db, name: string): number | undefined {
  const rows = db.prepare('SELECT id, name_pt FROM exercises WHERE deleted_at IS NULL').all() as {
    id: number;
    name_pt: string;
  }[];
  return rows.find((r) => normalize(r.name_pt) === normalize(name))?.id;
}

/**
 * Grava as rotinas pelas mesmas tools do coach (validação, audit_log, /desfazer), num turno de comando.
 * Tudo ou nada: qualquer erro desfaz a importação inteira.
 */
export function importRoutines(
  db: Db,
  registry: Registry,
  settings: ToolSettings,
  spec: RoutinesSpec,
  now: string,
): ImportResult {
  const turnId = createTurn(db, 'command', now);
  const result: ImportResult = { turnId, routines: [], created: [], aliases: [] };
  const call = <T>(name: string, input: unknown): T => {
    const r = callTool(registry, name, input, { db, now, turnId, settings, toolScope: 'all' });
    if (!r.ok) throw new Error(`${name}: ${r.error.message}`);
    return r.data as T;
  };
  db.transaction(() => {
    for (const routine of spec.routines) {
      const exercises = routine.exercises.map((item) => {
        let id = findByName(db, item.exercise);
        if (id === undefined) {
          if (!item.create) throw new Error(`exercício "${item.exercise}" não está no catálogo`);
          id = call<{ id: number }>('create_exercise', {
            name_pt: item.exercise,
            aliases: [item.as],
            ...item.create,
            confirm_new: true,
          }).id;
          result.created.push(item.exercise);
        } else if (normalize(item.as) !== normalize(item.exercise)) {
          const known = db
            .prepare('SELECT 1 FROM exercise_aliases WHERE alias_norm = ?')
            .get(normalize(item.as));
          if (!known) {
            call('add_exercise_alias', { exercise_id: id, alias: item.as });
            result.aliases.push(`${item.as} → ${item.exercise}`);
          }
        }
        const [min, max] = Array.isArray(item.reps) ? item.reps : [item.reps, item.reps];
        return {
          exercise_id: id,
          target_sets: item.sets,
          rep_min: min,
          rep_max: max,
          ...(item.weight_kg !== undefined ? { weight_kg: item.weight_kg } : {}),
        };
      });
      const r = call<{ replaced: boolean }>('define_routine', { name: routine.name, exercises });
      result.routines.push({ name: routine.name, exercises: exercises.length, replaced: r.replaced });
    }
  })();
  finishTurn(db, turnId, { status: 'done' }, now);
  return result;
}

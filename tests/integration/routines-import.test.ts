import { describe, expect, it } from 'vitest';
import { undoTurn } from '../../src/db/undo.ts';
import { importRoutines } from '../../src/ops/routines-import.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { makeDb, SETTINGS } from '../helpers.ts';

const spec = {
  routines: [
    {
      name: 'Upper A',
      exercises: [
        {
          as: 'Supino inclinado halter',
          exercise: 'Supino inclinado com halteres',
          sets: 3,
          reps: [8, 12] as [number, number],
        },
        { as: 'Remada T', exercise: 'Remada curvada com barra', sets: 3, reps: 10, weight_kg: 50 },
        {
          as: 'Elevação lateral na máquina',
          exercise: 'Elevação lateral na máquina',
          sets: 4,
          reps: [12, 20] as [number, number],
          create: { equipment: 'machine', load_kind: 'stack', primary_muscles: ['side_delts'] },
        },
      ],
    },
  ],
};

describe('importRoutines', () => {
  it('cria rotina, exercício novo e apelidos pelas tools; reimportar atualiza; /desfazer volta', () => {
    const { db } = makeDb();
    const r = importRoutines(db, buildRegistry(), SETTINGS, spec, '2026-10-21T12:00:00Z');
    expect(r.routines).toEqual([{ name: 'Upper A', exercises: 3, replaced: false }]);
    expect(r.created).toEqual(['Elevação lateral na máquina']);
    expect(r.aliases).toEqual(['Remada T → Remada curvada com barra']); // "supino inclinado halter" já existia
    expect(
      db
        .prepare('SELECT target_sets, rep_min, rep_max, weight_kg FROM routine_exercises ORDER BY position')
        .all(),
    ).toEqual([
      { target_sets: 3, rep_min: 8, rep_max: 12, weight_kg: null },
      { target_sets: 3, rep_min: 10, rep_max: 10, weight_kg: 50 },
      { target_sets: 4, rep_min: 12, rep_max: 20, weight_kg: null },
    ]);

    const again = importRoutines(db, buildRegistry(), SETTINGS, spec, '2026-10-21T12:05:00Z');
    expect(again.routines[0]?.replaced).toBe(true);
    expect(again.created).toEqual([]);
    undoTurn(db, again.turnId);
    undoTurn(db, r.turnId);
    expect(db.prepare('SELECT count(*) FROM routines WHERE deleted_at IS NULL').pluck().get()).toBe(0);
  });

  it('exercício fora do catálogo sem `create` aborta tudo', () => {
    const { db } = makeDb();
    const bad = {
      routines: [{ name: 'X', exercises: [{ as: 'foo', exercise: 'Não existe', sets: 3, reps: 10 }] }],
    };
    expect(() => importRoutines(db, buildRegistry(), SETTINGS, bad, '2026-10-21T12:00:00Z')).toThrow(
      /Não existe/,
    );
    expect(db.prepare('SELECT count(*) FROM routines').pluck().get()).toBe(0);
  });
});

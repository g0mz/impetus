import type { Db } from '../../src/db/index.ts';
import { createTurn } from '../../src/db/repos/turns.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { callTool } from '../../src/tools/registry.ts';

const SETTINGS = { cutoffHour: 4, timeZone: 'America/Sao_Paulo', openSessionHours: 3 };
const sets = (n: number, weight_kg: number, reps: number) =>
  Array.from({ length: n }, () => ({ weight_kg, reps }));

/**
 * Semana sintética seg 12/10 – dom 18/10/2026 com números conhecidos (testes e eval de relatório):
 * metas 2400 kcal / 140 g / 3 treinos; 3 sessões (remada 60 → 62,5 → 65 kg 3×8 e supino 24 kg 3×10);
 * 4 dias completos de 2400 kcal (150, 150, 120, 120 g de proteína); pesagens 80 e 81 kg.
 */
export function seedReportWeek(db: Db, o: { now: string; remada: number; supino: number }) {
  const registry = buildRegistry();
  const call = (name: string, input: unknown) => {
    const env = callTool(registry, name, input, {
      db,
      now: o.now,
      turnId: createTurn(db, 'chat'),
      settings: SETTINGS,
      toolScope: 'all',
    });
    if (!env.ok) throw new Error(`${name}: ${env.error.message}`);
  };
  for (const [key, value] of [
    ['kcal', 2400],
    ['protein_g', 140],
    ['training_days', 3],
  ] as const)
    call('set_goal', { key, value });
  for (const [d, w] of [
    ['2026-10-12', 60],
    ['2026-10-14', 62.5],
    ['2026-10-16', 65],
  ] as const) {
    call('log_workout', {
      new_session: true,
      performed_at: `${d}T21:00:00Z`,
      entries: [
        { exercise_id: o.remada, sets: sets(3, w, 8) },
        { exercise_id: o.supino, sets: sets(3, 24, 10) },
      ],
    });
  }
  const meal = db.prepare(
    `INSERT INTO meals (eaten_at, local_date, confidence, kcal, protein_g, carbs_g, fat_g, fiber_g, created_at, updated_at)
     VALUES (?, ?, 'high', ?, ?, 0, 0, 0, ?, ?)`,
  );
  for (const [d, p] of [
    ['2026-10-12', 50],
    ['2026-10-13', 50],
    ['2026-10-14', 40],
    ['2026-10-15', 40],
  ] as const)
    for (let k = 0; k < 3; k++) meal.run(`${d}T15:00:00Z`, d, 800, p, o.now, o.now);
  const w = db.prepare(
    "INSERT INTO body_metrics (measured_at, local_date, weight_kg, source, created_at) VALUES (?, ?, ?, 'chat', ?)",
  );
  w.run('2026-10-12T10:00:00Z', '2026-10-12', 80, o.now);
  w.run('2026-10-15T10:00:00Z', '2026-10-15', 81, o.now);
}

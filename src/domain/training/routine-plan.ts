import type { SetLike } from './load.ts';
import type { LoadKind } from './types.ts';

/** O que a rotina guarda por exercício (D-034). */
export type SavedPrescription = {
  target_sets: number | null;
  rep_min: number | null;
  rep_max: number | null;
  weight_kg: number | null;
  reps: number | null;
};

/** Ajustes do dia para um exercício: só o que mudou. */
export type DayOverride = { weight_kg?: number; reps?: number; sets?: number };

export type PlannedSet = { weight_kg?: number; reps: number; set_type: 'work' };

export type PlanResult =
  { ok: true; sets: PlannedSet[] } | { ok: false; missing: ('sets' | 'reps' | 'weight')[] };

/** Exercícios em que carga vazia é válida (só o peso do corpo). */
const WEIGHT_OPTIONAL: readonly LoadKind[] = ['bodyweight_plus', 'assisted'];

/** Reps salvas; sem elas, o menor valor da faixa (mesma regra do registro com faixa). */
export function savedReps(p: SavedPrescription): number | null {
  return p.reps ?? p.rep_min ?? p.rep_max;
}

/** Séries de trabalho do treino salvo com os ajustes do dia; diz o que falta quando não dá para montar. */
export function plannedSets(p: SavedPrescription, loadKind: LoadKind, o: DayOverride = {}): PlanResult {
  const n = o.sets ?? p.target_sets;
  const reps = o.reps ?? savedReps(p);
  const weight = o.weight_kg ?? p.weight_kg;
  const missing: ('sets' | 'reps' | 'weight')[] = [];
  if (n === null) missing.push('sets');
  if (reps === null) missing.push('reps');
  if (weight === null && !WEIGHT_OPTIONAL.includes(loadKind)) missing.push('weight');
  if (missing.length) return { ok: false, missing };
  const set: PlannedSet = {
    ...(weight !== null ? { weight_kg: weight } : {}),
    reps: reps!,
    set_type: 'work',
  };
  return { ok: true, sets: Array.from({ length: n! }, () => ({ ...set })) };
}

/**
 * Carga nova a salvar depois do treino: a maior carga das séries de trabalho, quando difere da salva.
 * Sem carga nas séries (peso corporal), nada muda.
 */
export function changedLoad(savedKg: number | null, sets: SetLike[]): number | null {
  const loads = sets
    .filter((s) => s.set_type === 'work' || s.set_type === 'failure')
    .map((s) => s.weight_kg)
    .filter((w): w is number => w !== null);
  if (!loads.length) return null;
  const top = Math.max(...loads);
  return top === savedKg ? null : top;
}

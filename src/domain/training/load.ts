import type { LoadKind } from './types.ts';

export type SetType = 'work' | 'warmup' | 'drop' | 'failure';

/** Série como o domínio enxerga: peso como o usuário falou (por mão no halter etc.). */
export type SetLike = {
  weight_kg: number | null;
  reps: number | null;
  rpe?: number | null;
  set_type: SetType;
};

/**
 * Peso efetivo (REPORTS.md §2.1): por mão/por lado ×2; peso corporal + carga adicional;
 * assistido = peso corporal − assistência. Sem peso corporal conhecido, exercícios que
 * dependem dele devolvem null.
 */
export function effectiveWeight(
  weightKg: number | null,
  loadKind: LoadKind,
  bodyweightKg: number | null = null,
): number | null {
  switch (loadKind) {
    case 'per_hand':
    case 'per_side':
      return weightKg === null ? null : weightKg * 2;
    case 'bodyweight_plus':
      return bodyweightKg === null ? null : bodyweightKg + (weightKg ?? 0);
    case 'assisted':
      return bodyweightKg === null ? null : bodyweightKg - (weightKg ?? 0);
    default:
      return weightKg;
  }
}

/** Série que conta como trabalho (não aquecimento). */
export function isWorkSet(s: Pick<SetLike, 'set_type'>): boolean {
  return s.set_type !== 'warmup';
}

/** e1RM de Epley: só séries `work` com 1–12 reps e carga > 0. */
export function epley(weightKg: number | null, reps: number | null): number | null {
  if (weightKg === null || reps === null || weightKg <= 0 || reps < 1 || reps > 12) return null;
  return weightKg * (1 + reps / 30);
}

/** Melhor e1RM entre as séries `work` (peso efetivo). */
export function bestE1rm(
  sets: SetLike[],
  loadKind: LoadKind,
  bodyweightKg: number | null = null,
): number | null {
  let best: number | null = null;
  for (const s of sets) {
    if (s.set_type !== 'work') continue;
    const e = epley(effectiveWeight(s.weight_kg, loadKind, bodyweightKg), s.reps);
    if (e !== null && (best === null || e > best)) best = e;
  }
  return best;
}

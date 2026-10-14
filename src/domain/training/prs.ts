import type { LoadKind } from './types.ts';
import { fmtKg } from './format.ts';
import { bestE1rm, type SetLike } from './load.ts';

export type PrKind = 'weight' | 'e1rm' | 'reps_at_weight';

// Séries de trabalho e até a falha contam para carga e reps; aquecimento e drop não.
const work = (sets: SetLike[]) =>
  sets.filter((s) => (s.set_type === 'work' || s.set_type === 'failure') && s.reps !== null && s.reps > 0);

/**
 * PRs da sessão contra todo o histórico do exercício (REPORTS.md §2.1): carga máxima,
 * e1RM máximo, ou mais reps com a mesma carga. Sem histórico não há PR (primeira vez).
 */
export function detectPrs(
  history: SetLike[],
  current: SetLike[],
  loadKind: LoadKind,
  bodyweightKg: number | null = null,
): PrKind[] {
  const past = work(history);
  const now = work(current);
  if (!past.length || !now.length) return [];
  const prs: PrKind[] = [];

  const maxW = (sets: SetLike[]) => Math.max(...sets.map((s) => s.weight_kg ?? -Infinity));
  if (maxW(now) > maxW(past) && maxW(now) > 0) prs.push('weight');

  const pastE = bestE1rm(past, loadKind, bodyweightKg);
  const nowE = bestE1rm(now, loadKind, bodyweightKg);
  if (pastE !== null && nowE !== null && nowE > pastE + 1e-9) prs.push('e1rm');

  const bestRepsAt = new Map<number | null, number>();
  for (const s of past) bestRepsAt.set(s.weight_kg, Math.max(bestRepsAt.get(s.weight_kg) ?? 0, s.reps ?? 0));
  if (now.some((s) => bestRepsAt.has(s.weight_kg) && (s.reps ?? 0) > (bestRepsAt.get(s.weight_kg) ?? 0))) {
    prs.push('reps_at_weight');
  }
  return prs;
}

/**
 * Comparação com a última sessão do exercício: pela maior carga de trabalho; se igual,
 * pelo total de reps nessa carga. Ex.: "+2kg", "-2,5kg", "+1 rep", "-2 reps", "=".
 */
export function vsLast(last: SetLike[], current: SetLike[]): string | undefined {
  const a = work(last);
  const b = work(current);
  if (!a.length || !b.length) return undefined;
  const top = (sets: SetLike[]) => Math.max(...sets.map((s) => s.weight_kg ?? 0));
  const diff = Math.round((top(b) - top(a)) * 10) / 10;
  if (diff !== 0) return `${diff > 0 ? '+' : '-'}${fmtKg(Math.abs(diff))}kg`;
  const repsAt = (sets: SetLike[], w: number) =>
    sets.filter((s) => (s.weight_kg ?? 0) === w).reduce((t, s) => t + (s.reps ?? 0), 0);
  const dr = repsAt(b, top(b)) - repsAt(a, top(a));
  if (dr === 0) return '=';
  return `${dr > 0 ? '+' : '-'}${Math.abs(dr)} ${Math.abs(dr) === 1 ? 'rep' : 'reps'}`;
}

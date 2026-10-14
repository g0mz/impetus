import type { SetLike } from './load.ts';

/** 32.5 → "32,5"; 30 → "30". Uma casa decimal no máximo. */
export function fmtKg(kg: number): string {
  const r = Math.round(kg * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
}

function group(sets: SetLike[]): string {
  if (!sets.length) return '';
  const weights = new Set(sets.map((s) => s.weight_kg));
  const reps = sets.map((s) => (s.reps === null ? '?' : String(s.reps)));
  if (weights.size === 1) {
    const w = sets[0]?.weight_kg ?? null;
    const prefix = w === null ? '' : `${fmtKg(w)}kg `;
    if (new Set(reps).size === 1 && sets.length > 1) return `${prefix}${sets.length}×${reps[0]}`;
    return `${prefix}${reps.join('/')}`;
  }
  return sets.map((s) => `${s.weight_kg === null ? 'PC' : fmtKg(s.weight_kg)}×${s.reps ?? '?'}`).join(', ');
}

/**
 * Resumo compacto das séries: "30kg 3×10", "30kg 10/10/9", "30×10, 32×8".
 * Aquecimentos vêm antes, marcados ("aq 20kg 12 · 30kg 3×10").
 */
export function setsCompact(sets: SetLike[]): string {
  const warm = sets.filter((s) => s.set_type === 'warmup');
  const work = sets.filter((s) => s.set_type !== 'warmup');
  const parts: string[] = [];
  if (warm.length) parts.push(`aq ${group(warm)}`);
  if (work.length) parts.push(group(work));
  return parts.join(' · ');
}

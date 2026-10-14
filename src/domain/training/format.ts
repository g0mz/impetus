import type { SetLike } from './load.ts';

/** 32.5 → "32,5"; 30 → "30". Uma casa decimal no máximo. */
export function fmtKg(kg: number): string {
  const r = Math.round(kg * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
}

/** Um bloco de mesma carga: "30kg 3×10", "30kg 10/10/9", "10/8" (sem carga). */
function run(sets: SetLike[]): string {
  const w = sets[0]?.weight_kg ?? null;
  const reps = sets.map((s) => (s.reps === null ? '?' : String(s.reps)));
  const prefix = w === null ? '' : `${fmtKg(w)}kg `;
  if (new Set(reps).size === 1 && sets.length > 1) return `${prefix}${sets.length}×${reps[0]}`;
  return `${prefix}${reps.join('/')}`;
}

/** Agrupa séries consecutivas de mesma carga: "30kg 3×10, 32kg 10/9/8". */
function group(sets: SetLike[]): string {
  const runs: SetLike[][] = [];
  for (const s of sets) {
    const last = runs.at(-1);
    if (last && last[0]!.weight_kg === s.weight_kg) last.push(s);
    else runs.push([s]);
  }
  return runs.map(run).join(', ');
}

/**
 * Resumo compacto das séries: "30kg 3×10", "30kg 10/10/9", "30kg 3×10, 32kg 10/9/8".
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

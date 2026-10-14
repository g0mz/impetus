/** Quantil com interpolação linear (q em [0,1]) sobre valores ordenados. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export type PriorRow = { label_norm: string; grams: number; created_at: string };
export type Prior = {
  label: string;
  n: number;
  median_g: number;
  p25_g: number;
  p75_g: number;
  last_seen: string;
};

export const PRIOR_WINDOW_DAYS = 120;

/**
 * Porções típicas do usuário por rótulo (NUTRITION.md §3 passo 4; D-007): itens informados,
 * corrigidos ou de rótulo nos últimos 120 dias, só rótulos com n ≥ minN.
 */
export function computePriors(
  rows: PriorRow[],
  now: string,
  minN = 2,
  windowDays = PRIOR_WINDOW_DAYS,
): Prior[] {
  const since = new Date(new Date(now).getTime() - windowDays * 86400_000).toISOString();
  const by = new Map<string, PriorRow[]>();
  for (const r of rows) if (r.created_at >= since) by.set(r.label_norm, [...(by.get(r.label_norm) ?? []), r]);
  const out: Prior[] = [];
  for (const [label, rs] of by) {
    if (rs.length < minN) continue;
    const g = rs.map((r) => r.grams).sort((a, b) => a - b);
    const r5 = (x: number) => Math.round(x / 5) * 5 || Math.round(x);
    out.push({
      label,
      n: rs.length,
      median_g: r5(quantile(g, 0.5)),
      p25_g: r5(quantile(g, 0.25)),
      p75_g: r5(quantile(g, 0.75)),
      last_seen: rs
        .map((r) => r.created_at)
        .sort()
        .at(-1)!,
    });
  }
  return out;
}

export type CorrectionRow = { label_norm: string; old_grams: number; new_grams: number; created_at: string };
export type Bias = { label: string; n: number; down_share: number; median_ratio: number };

/**
 * Viés sistemático (NUTRITION.md §5): em 14 dias, correções de gramas de um mesmo rótulo
 * para baixo em mais de 60% das vezes (n ≥ 3) → razão mediana nova/estimada.
 */
export function detectBias(rows: CorrectionRow[], now: string, windowDays = 14, minN = 3): Bias[] {
  const since = new Date(new Date(now).getTime() - windowDays * 86400_000).toISOString();
  const by = new Map<string, CorrectionRow[]>();
  for (const r of rows) {
    if (r.created_at >= since && r.old_grams > 0) by.set(r.label_norm, [...(by.get(r.label_norm) ?? []), r]);
  }
  const out: Bias[] = [];
  for (const [label, rs] of by) {
    if (rs.length < minN) continue;
    const down = rs.filter((r) => r.new_grams < r.old_grams).length / rs.length;
    if (down <= 0.6) continue;
    const ratios = rs.map((r) => r.new_grams / r.old_grams).sort((a, b) => a - b);
    out.push({
      label,
      n: rs.length,
      down_share: Math.round(down * 100) / 100,
      median_ratio: Math.round(quantile(ratios, 0.5) * 100) / 100,
    });
  }
  return out;
}

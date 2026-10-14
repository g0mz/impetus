export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Desvio-padrão amostral (n − 1). */
export function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Inclinação da regressão linear simples y ~ x. */
export function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2) return null;
  const mx = mean(points.map((p) => p.x))!;
  const my = mean(points.map((p) => p.y))!;
  const den = points.reduce((t, p) => t + (p.x - mx) ** 2, 0);
  if (den === 0) return null;
  return points.reduce((t, p) => t + (p.x - mx) * (p.y - my), 0) / den;
}

/** Postos com empates pela média (para Spearman). */
export function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Correlação de Spearman (Pearson sobre os postos). */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = mean(rx)!;
  const my = mean(ry)!;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

export const round = (n: number | null, d = 0): number | null =>
  n === null ? null : Math.round(n * 10 ** d) / 10 ** d;

/** Variação percentual formatada: "+3%", "−2%", "=". */
export function pctChange(curr: number | null, prev: number | null): string | null {
  if (curr === null || prev === null || prev === 0) return null;
  const p = Math.round(((curr - prev) / Math.abs(prev)) * 100);
  return p === 0 ? '=' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
}

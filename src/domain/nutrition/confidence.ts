export type Confidence = 'high' | 'medium' | 'low';

const SCORE: Record<Confidence, number> = { high: 1, medium: 0.5, low: 0 };

/**
 * Confiança agregada da refeição (D-021): média das confianças dos itens ponderada pela kcal
 * (alta = 1, média = 0,5, baixa = 0). ≥ 0,75 → alta; ≥ 0,4 → média; abaixo → baixa.
 * Refeição sem kcal usa média simples.
 */
export function aggregateConfidence(items: { kcal: number; confidence: Confidence }[]): Confidence {
  if (!items.length) return 'low';
  const total = items.reduce((t, i) => t + Math.max(i.kcal, 0), 0);
  const score =
    total > 0
      ? items.reduce((t, i) => t + SCORE[i.confidence] * Math.max(i.kcal, 0), 0) / total
      : items.reduce((t, i) => t + SCORE[i.confidence], 0) / items.length;
  return score >= 0.75 ? 'high' : score >= 0.4 ? 'medium' : 'low';
}

export const CONFIDENCE_PT: Record<Confidence, string> = { high: 'alta', medium: 'média', low: 'baixa' };

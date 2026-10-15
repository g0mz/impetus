import { normalize } from '../text/normalize.ts';
import type { BrainMode } from './types.ts';

export type ModelConfig = { fast: string; vision: string; report: string };

const ANALYTIC =
  /\b(por ?que|compar\w*|tendenci\w*|afet\w*|relac\w*|evolu\w*|analis\w*|correla\w*|progred\w*)\b/;

/** Roteamento heurístico de modelo (ARCHITECTURE.md §5.3). */
export function chooseModel(
  input: { hasImage: boolean; mode: BrainMode; text: string },
  models: ModelConfig,
): string {
  if (input.hasImage) return models.vision;
  if (input.mode === 'report') return models.report;
  if (ANALYTIC.test(normalize(input.text))) return models.report;
  // registro longo (treino inteiro, várias refeições): o modelo rápido perdia itens e confundia séries (D-031)
  const lines = input.text.split('\n').filter((l) => l.trim()).length;
  const numbers = input.text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  if (lines >= 3 || numbers >= 8) return models.vision;
  return models.fast;
}

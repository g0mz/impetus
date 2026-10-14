export type MealType = 'cafe' | 'almoco' | 'lanche' | 'jantar' | 'ceia' | 'pre_treino' | 'pos_treino';
export const MEAL_TYPES: MealType[] = [
  'cafe',
  'almoco',
  'lanche',
  'jantar',
  'ceia',
  'pre_treino',
  'pos_treino',
];

export const MEAL_TYPE_PT: Record<MealType, string> = {
  cafe: 'Café da manhã',
  almoco: 'Almoço',
  lanche: 'Lanche',
  jantar: 'Jantar',
  ceia: 'Ceia',
  pre_treino: 'Pré-treino',
  pos_treino: 'Pós-treino',
};

/**
 * Tipo de refeição pelo horário local (TASKS Fase 3): café < 10h30, almoço 10h30–15h,
 * lanche 15h–18h30, jantar 18h30–22h30, ceia depois (inclui a madrugada antes da virada).
 */
export function inferMealType(hour: number, minute: number, cutoffHour = 4): MealType {
  const t = hour * 60 + minute;
  if (hour < cutoffHour) return 'ceia';
  if (t < 10 * 60 + 30) return 'cafe';
  if (t < 15 * 60) return 'almoco';
  if (t < 18 * 60 + 30) return 'lanche';
  if (t < 22 * 60 + 30) return 'jantar';
  return 'ceia';
}

export const MUSCLES = [
  'chest',
  'front_delts',
  'side_delts',
  'rear_delts',
  'lats',
  'upper_back',
  'traps',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'adductors',
  'abductors',
  'abs',
  'obliques',
  'lower_back',
  'neck',
] as const;

export type Muscle = (typeof MUSCLES)[number];

export function isMuscle(value: string): value is Muscle {
  return (MUSCLES as readonly string[]).includes(value);
}

const DIRECT: Record<string, Muscle> = {
  abdominals: 'abs',
  abductors: 'abductors',
  adductors: 'adductors',
  biceps: 'biceps',
  calves: 'calves',
  chest: 'chest',
  forearms: 'forearms',
  glutes: 'glutes',
  hamstrings: 'hamstrings',
  lats: 'lats',
  'lower back': 'lower_back',
  'middle back': 'upper_back',
  neck: 'neck',
  quadriceps: 'quads',
  traps: 'traps',
  triceps: 'triceps',
};

/**
 * Mapeia um músculo do free-exercise-db para o vocabulário fixo. A fonte só tem "shoulders",
 * então a cabeça do deltoide é inferida pelo exercício (heurística; o CSV PT-BR sobrescreve
 * os exercícios comuns): rear/reverse/face pull → posterior; lateral/upright → lateral;
 * demais "push" → anterior; demais "pull" → posterior.
 */
export function mapFreeExerciseDbMuscle(
  muscle: string,
  exercise: { name: string; force: string | null },
): Muscle | null {
  const direct = DIRECT[muscle];
  if (direct) return direct;
  if (muscle !== 'shoulders') return null;
  const name = exercise.name.toLowerCase();
  if (/rear|reverse fly|reverse flye|face pull|back fly/.test(name)) return 'rear_delts';
  if (/lateral|upright/.test(name)) return 'side_delts';
  return exercise.force === 'pull' ? 'rear_delts' : 'front_delts';
}

/** Mapeia e deduplica uma lista, sem repetir em `secondary` o que já é primário. */
export function mapMuscleLists(
  primary: string[],
  secondary: string[],
  exercise: { name: string; force: string | null },
): { primary: Muscle[]; secondary: Muscle[] } {
  const map = (list: string[]) => [
    ...new Set(list.map((m) => mapFreeExerciseDbMuscle(m, exercise)).filter((m): m is Muscle => m !== null)),
  ];
  const p = map(primary);
  return { primary: p, secondary: map(secondary).filter((m) => !p.includes(m)) };
}

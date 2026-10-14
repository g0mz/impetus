export type ExerciseCategory = 'strength' | 'cardio' | 'mobility' | 'other';
export type Equipment = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'smith' | 'other';
export type LoadKind = 'total' | 'per_hand' | 'per_side' | 'bodyweight_plus' | 'assisted' | 'stack';

export const EQUIPMENT: readonly Equipment[] = [
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'smith',
  'other',
];
export const LOAD_KINDS: readonly LoadKind[] = [
  'total',
  'per_hand',
  'per_side',
  'bodyweight_plus',
  'assisted',
  'stack',
];

/** Sessão aberta = última atividade (série) há menos de `hours` horas (SPEC §5.1). */
export function isSessionOpen(lastActivityIso: string | null, nowIso: string, hours: number): boolean {
  if (!lastActivityIso) return false;
  const diff = new Date(nowIso).getTime() - new Date(lastActivityIso).getTime();
  return diff >= 0 && diff < hours * 3600_000;
}

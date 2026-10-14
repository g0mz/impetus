import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { REPO_ROOT } from '../config.ts';
import { seedExercises, type ExerciseSeedReport, type FreeExercise } from './exercises.ts';
import { seedPortions } from './portions.ts';
import { seedTaco, type TacoSeedReport } from './taco.ts';
import { verifyVendor } from './vendor.ts';

export const SEEDS_DIR = path.join(REPO_ROOT, 'seeds');

export type SeedReport = { taco: TacoSeedReport; exercises: ExerciseSeedReport; portions: number };

/** Roda todos os seeds a partir de seeds/ (dados versionados, conferidos pelo manifest). */
export function runSeeds(db: Db, seedsDir = SEEDS_DIR): SeedReport {
  verifyVendor(seedsDir);
  const read = (rel: string) => fs.readFileSync(path.join(seedsDir, rel), 'utf8');
  const taco = seedTaco(db, read('vendor/taco/food.csv'), read('vendor/taco/nutrients.csv'));
  const exercises = seedExercises(
    db,
    JSON.parse(read('vendor/free-exercise-db/exercises.json')) as FreeExercise[],
    read('exercises_ptbr.csv'),
  );
  const portions = seedPortions(db, read('portions_ibge.csv'));
  return { taco, exercises, portions };
}

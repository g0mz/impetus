import type { Db } from '../db/index.ts';
import { upsertFood } from '../db/repos/foods.ts';
import { normalize } from '../text/normalize.ts';
import { parseCsvObjects } from './csv.ts';

const PREPARED = /\b(cozid[oa]s?|grelhad[oa]s?|frit[oa]s?|assad[oa]s?|refogad[oa]s?|ensopad[oa]s?|milanesa|pront[oa]s?|preparad[oa]s?)\b/;

/** Categoria "Alimentos preparados" da TACO (seeds/vendor/taco/categories.csv). */
export const TACO_PREPARED_CATEGORY = '13';

/**
 * Alimento pronto para consumo: categoria "Alimentos preparados" ou preparo no nome
 * (cozido, grelhado, frito…). Heurística; ver docs/DECISIONS.md D-011.
 */
export function isPreparedTaco(name: string, categoryId?: string): boolean {
  return categoryId === TACO_PREPARED_CATEGORY || PREPARED.test(normalize(name));
}

const num = (v: string | undefined): number | null => (v === undefined || v.trim() === '' ? null : Number(v));

export type TacoSeedReport = { inserted: number; skipped: { id: string; name: string; reason: string }[] };

/**
 * Importa a TACO 4ª ed. a partir dos CSVs do taco-api (Tr já vem como 0; NA/* vêm vazios).
 * Macros vazios viram 0 (campos NOT NULL); fibra e sódio vazios viram NULL. Alimento sem
 * energia informada é ignorado (não há como registrar sem kcal).
 */
export function seedTaco(db: Db, foodCsv: string, nutrientsCsv: string): TacoSeedReport {
  const foods = parseCsvObjects(foodCsv);
  const nutrients = new Map(parseCsvObjects(nutrientsCsv).map((n) => [n.foodId, n]));
  const report: TacoSeedReport = { inserted: 0, skipped: [] };
  db.transaction(() => {
    for (const f of foods) {
      const id = f.id ?? '';
      const name = f.name ?? '';
      const n = nutrients.get(id);
      const kcal = num(n?.kcal);
      if (!n || kcal === null) {
        report.skipped.push({ id, name, reason: 'sem energia na fonte (* em reavaliação ou NA)' });
        continue;
      }
      upsertFood(db, {
        source: 'taco',
        source_id: id,
        name,
        kcal_100g: kcal,
        protein_100g: num(n.protein) ?? 0,
        carbs_100g: num(n.carbohydrates) ?? 0,
        fat_100g: num(n.lipids) ?? 0,
        fiber_100g: num(n.dietaryFiber),
        sodium_mg_100g: num(n.sodium),
        is_prepared: isPreparedTaco(name, f.categoryId),
      });
      report.inserted++;
    }
  })();
  return report;
}

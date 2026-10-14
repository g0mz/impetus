import type { Db } from '../index.ts';
import { aggregateConfidence, type Confidence } from '../../domain/nutrition/confidence.ts';
import { itemMacros, sumMacros, type Macros, type Per100 } from '../../domain/nutrition/macros.ts';
import type { CorrectionRow, PriorRow } from '../../domain/nutrition/priors.ts';
import { normalize } from '../../text/normalize.ts';

export type FoodRow = Per100 & {
  id: number;
  name: string;
  source: string;
  brand: string | null;
  barcode: string | null;
  deleted_at: string | null;
};

export function getFood(db: Db, id: number): FoodRow | undefined {
  return db
    .prepare(
      `SELECT id, name, source, brand, barcode, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, deleted_at
         FROM foods WHERE id = ?`,
    )
    .get(id) as FoodRow | undefined;
}

export function findFoodByBarcode(db: Db, barcode: string): FoodRow | undefined {
  return db
    .prepare(
      `SELECT id, name, source, brand, barcode, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, deleted_at
         FROM foods WHERE barcode = ? AND deleted_at IS NULL`,
    )
    .get(barcode) as FoodRow | undefined;
}

export type MealRow = {
  id: number;
  eaten_at: string;
  local_date: string;
  meal_type: string | null;
  user_text: string | null;
  photo_paths: string;
  confidence: Confidence;
  assumptions: string | null;
  pending_question: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type MealItemRow = {
  id: number;
  meal_id: number;
  position: number;
  label: string;
  label_norm: string;
  food_id: number | null;
  grams: number;
  grams_low: number | null;
  grams_high: number | null;
  origin: string;
  confidence: Confidence;
  cooking_method: string | null;
  macros_override: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  created_at: string;
  deleted_at: string | null;
};

export function getMeal(db: Db, id: number): MealRow | undefined {
  return db.prepare('SELECT * FROM meals WHERE id = ?').get(id) as MealRow | undefined;
}

export function getMealItem(db: Db, id: number): MealItemRow | undefined {
  return db.prepare('SELECT * FROM meal_items WHERE id = ?').get(id) as MealItemRow | undefined;
}

export function mealItems(db: Db, mealId: number): MealItemRow[] {
  return db
    .prepare('SELECT * FROM meal_items WHERE meal_id = ? AND deleted_at IS NULL ORDER BY position')
    .all(mealId) as MealItemRow[];
}

/** Override de macros guardado com a gramatura de referência (escala se a gramatura mudar). */
export type Override = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; per_grams: number };

/** Macros de um item a partir do alimento (por 100 g) ou do override escalado. */
export function computeItemMacros(
  db: Db,
  item: { food_id: number | null; grams: number; macros_override: string | null },
): Macros {
  if (item.macros_override) {
    const o = JSON.parse(item.macros_override) as Override;
    const f = item.grams / o.per_grams;
    return {
      kcal: o.kcal * f,
      protein_g: o.protein_g * f,
      carbs_g: o.carbs_g * f,
      fat_g: o.fat_g * f,
      fiber_g: null,
    };
  }
  const food = item.food_id === null ? undefined : getFood(db, item.food_id);
  if (!food) throw new Error(`item sem alimento nem override (food_id ${item.food_id})`);
  return itemMacros(food, item.grams);
}

export function insertMeal(
  db: Db,
  m: Pick<
    MealRow,
    'eaten_at' | 'local_date' | 'meal_type' | 'user_text' | 'photo_paths' | 'assumptions' | 'pending_question'
  > & { now: string },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO meals (eaten_at, local_date, meal_type, user_text, photo_paths, confidence, assumptions, pending_question,
                            kcal, protein_g, carbs_g, fat_g, fiber_g, created_at, updated_at)
         VALUES (@eaten_at, @local_date, @meal_type, @user_text, @photo_paths, 'low', @assumptions, @pending_question,
                 0, 0, 0, 0, NULL, @now, @now)`,
      )
      .run(m).lastInsertRowid,
  );
}

export function insertMealItem(
  db: Db,
  it: Omit<
    MealItemRow,
    'id' | 'deleted_at' | 'label_norm' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g'
  >,
): number {
  const macros = computeItemMacros(db, it);
  return Number(
    db
      .prepare(
        `INSERT INTO meal_items (meal_id, position, label, label_norm, food_id, grams, grams_low, grams_high, origin, confidence,
                                 cooking_method, macros_override, kcal, protein_g, carbs_g, fat_g, fiber_g, created_at)
         VALUES (@meal_id, @position, @label, @label_norm, @food_id, @grams, @grams_low, @grams_high, @origin, @confidence,
                 @cooking_method, @macros_override, @kcal, @protein_g, @carbs_g, @fat_g, @fiber_g, @created_at)`,
      )
      .run({ ...it, label_norm: normalize(it.label), ...macros }).lastInsertRowid,
  );
}

/** Recalcula macros do item a partir de food/override e grava. */
export function refreshItemMacros(db: Db, itemId: number): void {
  const it = getMealItem(db, itemId);
  if (!it) return;
  const m = computeItemMacros(db, it);
  db.prepare(
    'UPDATE meal_items SET kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ? WHERE id = ?',
  ).run(m.kcal, m.protein_g, m.carbs_g, m.fat_g, m.fiber_g, itemId);
}

/** Recalcula totais e confiança agregada da refeição a partir dos itens ativos. */
export function refreshMealTotals(db: Db, mealId: number, now: string): void {
  const items = mealItems(db, mealId);
  const t = sumMacros(items);
  db.prepare(
    `UPDATE meals SET kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?, confidence = ?, updated_at = ? WHERE id = ?`,
  ).run(t.kcal, t.protein_g, t.carbs_g, t.fat_g, t.fiber_g, aggregateConfidence(items), now, mealId);
}

export function nextItemPosition(db: Db, mealId: number): number {
  return (
    ((db.prepare('SELECT max(position) FROM meal_items WHERE meal_id = ?').pluck().get(mealId) as
      number | null) ?? 0) + 1
  );
}

/** Base dos priors: itens informados/corrigidos/de rótulo de refeições ativas (D-007). */
export function priorRows(db: Db, labelsNorm: string[]): PriorRow[] {
  if (!labelsNorm.length) return [];
  return db
    .prepare(
      `SELECT i.label_norm, i.grams, i.created_at FROM meal_items i JOIN meals m ON m.id = i.meal_id
        WHERE i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.origin IN ('user_stated','corrected','label')
          AND i.label_norm IN (${labelsNorm.map(() => '?').join(',')})`,
    )
    .all(...labelsNorm) as PriorRow[];
}

/** Correções de gramas (para o detector de viés). */
export function gramsCorrections(db: Db): CorrectionRow[] {
  return db
    .prepare(
      `SELECT i.label_norm, CAST(c.old_value AS REAL) old_grams, CAST(c.new_value AS REAL) new_grams, c.created_at
         FROM meal_corrections c JOIN meal_items i ON i.id = c.meal_item_id
        WHERE c.field = 'grams'`,
    )
    .all() as CorrectionRow[];
}

export function insertCorrection(
  db: Db,
  c: {
    meal_item_id: number;
    field: string;
    old_value: string | null;
    new_value: string | null;
    created_at: string;
  },
): number {
  return Number(
    db
      .prepare(
        'INSERT INTO meal_corrections (meal_item_id, field, old_value, new_value, created_at) VALUES (@meal_item_id, @field, @old_value, @new_value, @created_at)',
      )
      .run(c).lastInsertRowid,
  );
}

export type PortionRow = {
  id: number;
  food_id: number | null;
  food_name: string | null;
  label: string;
  grams: number;
  source: string;
};

export function allPortions(db: Db): (PortionRow & { food: string | null })[] {
  return db
    .prepare(
      `SELECT p.id, p.food_id, p.food_name, p.label, p.grams, p.source, coalesce(f.name, p.food_name) AS food
         FROM food_portions p LEFT JOIN foods f ON f.id = p.food_id AND f.deleted_at IS NULL`,
    )
    .all() as (PortionRow & { food: string | null })[];
}

/** Refeição mais recente do dia com pergunta pendente (para o contexto do turno). */
export function pendingQuestionMeal(db: Db, localDate: string) {
  return db
    .prepare(
      `SELECT id, meal_type, pending_question FROM meals
        WHERE local_date = ? AND deleted_at IS NULL AND pending_question IS NOT NULL ORDER BY eaten_at DESC LIMIT 1`,
    )
    .get(localDate) as { id: number; meal_type: string | null; pending_question: string } | undefined;
}

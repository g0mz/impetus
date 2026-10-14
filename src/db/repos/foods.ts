import type { Db } from '../index.ts';
import { ftsExactQuery, ftsPrefixQuery, normalize } from '../../text/normalize.ts';
import { nowUtcIso } from '../../time.ts';

export type FoodInput = {
  source: 'taco' | 'off' | 'custom';
  source_id: string | null;
  name: string;
  brand?: string | null;
  barcode?: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g?: number | null;
  sodium_mg_100g?: number | null;
  is_prepared: boolean;
};

export type FoodMatch = {
  id: number;
  name: string;
  source: string;
  brand?: string;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  is_prepared: boolean;
};

/** Insere ou atualiza pelo par (source, source_id). Devolve o id. */
export function upsertFood(db: Db, f: FoodInput): number {
  const row = db
    .prepare(
      `INSERT INTO foods (source, source_id, name, name_norm, brand, barcode, kcal_100g, protein_100g, carbs_100g,
                          fat_100g, fiber_100g, sodium_mg_100g, is_prepared, created_at)
       VALUES (@source, @source_id, @name, @name_norm, @brand, @barcode, @kcal_100g, @protein_100g, @carbs_100g,
               @fat_100g, @fiber_100g, @sodium_mg_100g, @is_prepared, @created_at)
       ON CONFLICT (source, source_id) DO UPDATE SET
         name = excluded.name, name_norm = excluded.name_norm, brand = excluded.brand,
         kcal_100g = excluded.kcal_100g, protein_100g = excluded.protein_100g, carbs_100g = excluded.carbs_100g,
         fat_100g = excluded.fat_100g, fiber_100g = excluded.fiber_100g, sodium_mg_100g = excluded.sodium_mg_100g,
         is_prepared = excluded.is_prepared
       RETURNING id`,
    )
    .get({
      ...f,
      brand: f.brand ?? null,
      barcode: f.barcode ?? null,
      fiber_100g: f.fiber_100g ?? null,
      sodium_mg_100g: f.sodium_mg_100g ?? null,
      name_norm: normalize(f.name),
      is_prepared: f.is_prepared ? 1 : 0,
      created_at: nowUtcIso(),
    }) as { id: number };
  return row.id;
}

type FoodRow = Omit<FoodMatch, 'is_prepared' | 'brand'> & { brand: string | null; is_prepared: number };

/**
 * Busca por nome (FTS5), ignorando alimentos apagados. Primeiro casa as palavras exatas;
 * depois completa com prefixos (cozido/cozida etc.).
 */
export function searchFoods(
  db: Db,
  query: string,
  opts: { limit?: number; prepared?: boolean } = {},
): FoodMatch[] {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 10);
  const prepared = opts.prepared === undefined ? null : opts.prepared ? 1 : 0;
  const stmt = db.prepare(
    `SELECT f.id, f.name, f.source, f.brand, f.kcal_100g, f.protein_100g, f.carbs_100g, f.fat_100g, f.is_prepared
       FROM foods_fts
       JOIN foods f ON f.id = foods_fts.rowid
      WHERE foods_fts MATCH @match
        AND f.deleted_at IS NULL
        AND (@prepared IS NULL OR f.is_prepared = @prepared)
      ORDER BY bm25(foods_fts), length(f.name)
      LIMIT @limit`,
  );
  const rows: FoodRow[] = [];
  const seen = new Set<number>();
  for (const match of [ftsExactQuery(query), ftsPrefixQuery(query)]) {
    if (!match || rows.length >= limit) continue;
    for (const r of stmt.all({ match, limit, prepared }) as FoodRow[]) {
      if (rows.length < limit && !seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
  }
  return rows.map(({ brand, is_prepared, ...r }) => ({
    ...r,
    ...(brand ? { brand } : {}),
    is_prepared: is_prepared === 1,
  }));
}

export function countFoods(db: Db, source?: string): number {
  return db
    .prepare('SELECT count(*) FROM foods WHERE deleted_at IS NULL AND (? IS NULL OR source = ?)')
    .pluck()
    .get(source ?? null, source ?? null) as number;
}

export type PortionInput = {
  food_id: number | null;
  food_name: string | null;
  label: string;
  grams: number;
  source: 'ibge' | 'user' | 'label';
  source_ref: string | null;
};

export function insertPortion(db: Db, p: PortionInput): number {
  return Number(
    db
      .prepare(
        `INSERT INTO food_portions (food_id, food_name, label, grams, source, source_ref)
         VALUES (@food_id, @food_name, @label, @grams, @source, @source_ref)`,
      )
      .run(p).lastInsertRowid,
  );
}

export function deletePortionsBySource(db: Db, source: PortionInput['source']): void {
  db.prepare('DELETE FROM food_portions WHERE source = ?').run(source);
}

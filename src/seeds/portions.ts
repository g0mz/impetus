import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { deletePortionsBySource, insertPortion } from '../db/repos/foods.ts';
import { parseCsvObjects } from './csv.ts';

/** Linha de seeds/portions_ibge.csv (valores conferidos no PDF oficial; ver scripts/provenance/). */
export const ibgeRowSchema = z.object({
  codigo_ibge: z.string().regex(/^\d{7}$/),
  alimento: z.string().min(1),
  preparo: z.string().min(1),
  medida: z.string().min(1),
  gramas: z.coerce.number().positive(),
  referencia: z.string().min(1),
  fonte_ref: z.string().regex(/^\d+$/),
  fonte_pagina: z.coerce.number().int().positive(),
});
export type IbgeRow = z.infer<typeof ibgeRowSchema>;

/** "Arroz cozido - colher de sopa cheia" → "colher de sopa cheia"; sem " - ", usa a medida. */
export function portionLabel(row: Pick<IbgeRow, 'medida' | 'referencia'>): string {
  const i = row.referencia.lastIndexOf(' - ');
  return (i >= 0 ? row.referencia.slice(i + 3) : row.medida).trim().toLowerCase();
}

export function portionFoodName(row: Pick<IbgeRow, 'alimento' | 'preparo'>): string {
  return row.preparo === 'Não se aplica' ? row.alimento : `${row.alimento} — ${row.preparo.toLowerCase()}`;
}

/** Recarrega as medidas do IBGE (apaga e reinsere só as de source='ibge'). */
export function seedPortions(db: Db, csv: string): number {
  const rows = parseCsvObjects(csv).map((r, i) => {
    const parsed = ibgeRowSchema.safeParse(r);
    if (!parsed.success) throw new Error(`portions_ibge.csv linha ${i + 2}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  });
  db.transaction(() => {
    deletePortionsBySource(db, 'ibge');
    for (const r of rows) {
      insertPortion(db, {
        food_id: null,
        food_name: portionFoodName(r),
        label: portionLabel(r),
        grams: r.gramas,
        source: 'ibge',
        source_ref: `IBGE POF 2008-2009, Tabela de Medidas Referidas (liv50000.pdf) p.${r.fonte_pagina}; medida "${r.medida}"; referência "${r.referencia}" (fonte ${r.fonte_ref})`,
      });
    }
  })();
  return rows.length;
}

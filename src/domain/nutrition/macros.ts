export type Macros = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
};
export type Per100 = {
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
};

/** Macros de um item: tabela por 100 g × gramas ÷ 100 (o LLM nunca calcula). */
export function itemMacros(food: Per100, grams: number): Macros {
  const f = grams / 100;
  return {
    kcal: food.kcal_100g * f,
    protein_g: food.protein_100g * f,
    carbs_g: food.carbs_100g * f,
    fat_g: food.fat_100g * f,
    fiber_g: food.fiber_100g === null ? null : food.fiber_100g * f,
  };
}

export function sumMacros(items: Macros[]): Macros {
  const hasFiber = items.some((i) => i.fiber_g !== null);
  return items.reduce<Macros>(
    (t, i) => ({
      kcal: t.kcal + i.kcal,
      protein_g: t.protein_g + i.protein_g,
      carbs_g: t.carbs_g + i.carbs_g,
      fat_g: t.fat_g + i.fat_g,
      fiber_g: hasFiber ? (t.fiber_g ?? 0) + (i.fiber_g ?? 0) : null,
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: hasFiber ? 0 : null },
  );
}

/** Arredondamento de exibição (NUTRITION.md §4): kcal e macros inteiros. */
export function roundMacros(m: Macros): Macros {
  return {
    kcal: Math.round(m.kcal),
    protein_g: Math.round(m.protein_g),
    carbs_g: Math.round(m.carbs_g),
    fat_g: Math.round(m.fat_g),
    fiber_g: m.fiber_g === null ? null : Math.round(m.fiber_g),
  };
}

/** Converte uma porção rotulada (ex.: 1 scoop 30 g = 24 g prot) para valores por 100 g. */
export function portionTo100g(p: {
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number | undefined;
}): Per100 {
  const f = 100 / p.grams;
  return {
    kcal_100g: p.kcal * f,
    protein_100g: p.protein_g * f,
    carbs_100g: p.carbs_g * f,
    fat_100g: p.fat_g * f,
    fiber_100g: p.fiber_g === undefined ? null : p.fiber_g * f,
  };
}

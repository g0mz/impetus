import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { insertPortion, searchFoods, upsertFood } from '../db/repos/foods.ts';
import {
  allPortions,
  findFoodByBarcode,
  getFood,
  getMeal,
  getMealItem,
  insertCorrection,
  insertMeal,
  insertMealItem,
  mealItems,
  nextItemPosition,
  priorRows,
  refreshItemMacros,
  refreshMealTotals,
  type MealItemRow,
  type Override,
} from '../db/repos/nutrition.ts';
import { CONFIDENCE_PT } from '../domain/nutrition/confidence.ts';
import { portionTo100g, roundMacros, sumMacros } from '../domain/nutrition/macros.ts';
import { MEAL_TYPES, MEAL_TYPE_PT, inferMealType, type MealType } from '../domain/nutrition/meal-type.ts';
import { computePriors } from '../domain/nutrition/priors.ts';
import { normalize } from '../text/normalize.ts';
import { resolveWhen, wallClock } from '../time.ts';
import { getGoals } from './body.ts';
import { defineTool, err, ok, type ToolContext } from './registry.ts';

const confidence = z.enum(['high', 'medium', 'low']);
const mealType = z.enum(MEAL_TYPES as [MealType, ...MealType[]]);
const grams = z.number().min(1, 'gramas entre 1 e 2.000').max(2000, 'gramas entre 1 e 2.000');

const itemSchema = z
  .object({
    label: z.string().trim().min(1).max(60).describe('Como mostrar ao usuário: "Frango grelhado".'),
    food_id: z.number().int().positive().optional().describe('Obrigatório, exceto com macros_override.'),
    grams,
    grams_low: z.number().min(0).max(2000).optional(),
    grams_high: z.number().min(0).max(2000).optional(),
    origin: z.enum(['user_stated', 'photo_estimate', 'text_estimate', 'prior', 'label']),
    confidence,
    cooking_method: z.string().max(30).optional(),
    macros_override: z
      .object({
        kcal: z.number().min(0),
        protein_g: z.number().min(0),
        carbs_g: z.number().min(0),
        fat_g: z.number().min(0),
      })
      .optional()
      .describe(
        'Macros do item inteiro (para `grams`) quando não há alimento na tabela: rótulo lido, prato sem match.',
      ),
  })
  .refine(
    (i) => i.food_id !== undefined || i.macros_override !== undefined,
    'informe food_id ou macros_override',
  )
  .refine(
    (i) => i.grams_low === undefined || i.grams_high === undefined || i.grams_low <= i.grams_high,
    'grams_low > grams_high',
  );
type ItemIn = z.infer<typeof itemSchema>;

const r5 = (g: number) => Math.max(5, Math.round(g / 5) * 5);
const ESTIMATED = new Set(['photo_estimate', 'text_estimate', 'prior']);

/** Visão da refeição devolvida pelas tools (números já calculados e arredondados). */
export function mealView(db: Db, mealId: number, ctx: Pick<ToolContext, 'settings'>) {
  const meal = getMeal(db, mealId)!;
  const items = mealItems(db, mealId).map((i) => {
    const est = ESTIMATED.has(i.origin);
    const m = roundMacros(i);
    return {
      item_id: i.id,
      label: i.label,
      grams: est ? r5(i.grams) : Math.round(i.grams),
      ...(i.grams_low != null && i.grams_high != null && i.confidence !== 'high'
        ? { range: `${r5(i.grams_low)}–${r5(i.grams_high)}` }
        : {}),
      origin: i.origin,
      confidence: i.confidence,
      kcal: m.kcal,
      protein_g: m.protein_g,
      carbs_g: m.carbs_g,
      fat_g: m.fat_g,
    };
  });
  const day = db
    .prepare(
      `SELECT coalesce(sum(kcal),0) kcal, coalesce(sum(protein_g),0) protein_g, coalesce(sum(carbs_g),0) carbs_g,
              coalesce(sum(fat_g),0) fat_g FROM meals WHERE local_date = ? AND deleted_at IS NULL`,
    )
    .get(meal.local_date) as { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  const goals = getGoals(db);
  const dayGoals = {
    ...(goals.kcal !== undefined ? { kcal: goals.kcal } : {}),
    ...(goals.protein_g !== undefined ? { protein_g: goals.protein_g } : {}),
  };
  const remaining = {
    ...(goals.kcal !== undefined ? { kcal: Math.round(goals.kcal - day.kcal) } : {}),
    ...(goals.protein_g !== undefined ? { protein_g: Math.round(goals.protein_g - day.protein_g) } : {}),
  };
  const t = roundMacros(meal);
  void ctx;
  return {
    meal_id: meal.id,
    local_date: meal.local_date,
    meal_type: meal.meal_type,
    meal_type_pt: meal.meal_type ? MEAL_TYPE_PT[meal.meal_type as MealType] : 'Refeição',
    items,
    totals: {
      kcal: t.kcal,
      protein_g: t.protein_g,
      carbs_g: t.carbs_g,
      fat_g: t.fat_g,
      fiber_g: t.fiber_g ?? 0,
    },
    confidence: meal.confidence,
    confidence_pt: CONFIDENCE_PT[meal.confidence],
    ...(meal.pending_question ? { pending_question: meal.pending_question } : {}),
    ...(meal.deleted_at ? { deleted: true } : {}),
    day: {
      kcal: Math.round(day.kcal),
      protein_g: Math.round(day.protein_g),
      carbs_g: Math.round(day.carbs_g),
      fat_g: Math.round(day.fat_g),
      ...(Object.keys(dayGoals).length ? { goals: dayGoals, remaining } : {}),
    },
  };
}

function validateItems(db: Db, items: ItemIn[]) {
  for (const it of items) {
    if (it.food_id !== undefined) {
      const f = getFood(db, it.food_id);
      if (!f || f.deleted_at) return err('NOT_FOUND', `alimento ${it.food_id} não existe`);
    }
  }
  return null;
}

function addItem(ctx: ToolContext, mealId: number, it: ItemIn): number {
  const override: Override | null = it.macros_override
    ? { ...it.macros_override, per_grams: it.grams }
    : null;
  const id = insertMealItem(ctx.db, {
    meal_id: mealId,
    position: nextItemPosition(ctx.db, mealId),
    label: it.label,
    food_id: override ? null : (it.food_id ?? null),
    grams: it.grams,
    grams_low: it.grams_low ?? null,
    grams_high: it.grams_high ?? null,
    origin: it.origin,
    confidence: it.confidence,
    cooking_method: it.cooking_method ?? null,
    macros_override: override ? JSON.stringify(override) : null,
    created_at: ctx.now,
  });
  ctx.audit('meal_item', id, 'create');
  return id;
}

function totalHints(ctx: ToolContext, mealId: number): string[] {
  const kcal = getMeal(ctx.db, mealId)!.kcal;
  return kcal > 3000 ? ['total incomum, confirme com o usuário'] : [];
}

// ── busca ────────────────────────────────────────────────────────────────────────────────

export const searchFoodsTool = defineTool({
  name: 'search_foods',
  scope: 'read',
  description:
    'Busca alimentos (TACO, personalizados e Open Food Facts importados), valores por 100 g. Escolha o ESTADO que bate com ' +
    'o preparo (cozido, grelhado, frito; cru só se comido cru). Aceita várias consultas em `queries` (uma refeição inteira ' +
    'numa chamada). Ex.: { "queries": ["arroz cozido", "feijão carioca cozido", "frango peito grelhado"] }.',
  input: z
    .object({
      query: z.string().min(1).optional(),
      queries: z.array(z.string().min(1)).min(1).max(12).optional(),
      limit: z.number().int().min(1).max(10).default(6),
      prepared: z
        .boolean()
        .optional()
        .describe('true = só prontos para consumo; false = só crus/ingredientes.'),
    })
    .refine((v) => v.query !== undefined || v.queries !== undefined, 'informe `query` ou `queries`'),
  handler: (ctx, { query, queries, limit, prepared }) => {
    const run = (q: string) =>
      searchFoods(ctx.db, q, { limit, ...(prepared !== undefined ? { prepared } : {}) });
    if (queries) return ok({ results: queries.map((q) => ({ query: q, foods: run(q) })) });
    return ok({ foods: run(query as string) });
  },
});

export const getFoodPriorsTool = defineTool({
  name: 'get_food_priors',
  scope: 'read',
  description:
    'Porções típicas DO USUÁRIO por rótulo (itens informados ou corrigidos nos últimos 120 dias; só n ≥ 2). ' +
    'Com n ≥ 3 e foto compatível com p25–p75, use a mediana (origin "prior").',
  input: z.object({ labels: z.array(z.string().min(1)).min(1).max(15) }),
  handler: (ctx, { labels }) => {
    const norms = [...new Set(labels.map(normalize))];
    return ok({ priors: computePriors(priorRows(ctx.db, norms), ctx.now) });
  },
});

export const getPortionsTool = defineTool({
  name: 'get_portions',
  scope: 'read',
  description:
    'Medidas caseiras (IBGE e do usuário) em gramas. Ex.: "concha feijão", "colher de sopa arroz", "ovo", "fatia pão de forma". ' +
    'Aceita várias consultas em `queries`.',
  input: z
    .object({
      query: z.string().min(1).optional(),
      queries: z.array(z.string().min(1)).min(1).max(12).optional(),
    })
    .refine((v) => v.query !== undefined || v.queries !== undefined, 'informe `query` ou `queries`'),
  handler: (ctx, { query, queries }) => {
    const rows = allPortions(ctx.db).map((p) => ({ p, hay: normalize(`${p.food ?? ''} ${p.label}`) }));
    const run = (q: string) => {
      const terms = normalize(q)
        .split(' ')
        .filter((t) => t.length > 1)
        .map((t) => (t.length >= 5 ? t.replace(/(os|as|o|a|s)$/, '') : t));
      return rows
        .map(({ p, hay }) => ({ p, hits: terms.filter((t) => hay.includes(t)).length }))
        .filter((r) => r.hits > 0)
        .sort((a, b) => b.hits - a.hits || (a.p.source === 'user' ? -1 : 0))
        .slice(0, 8)
        .filter((r, _, all) => r.hits === all[0]!.hits)
        .map(({ p }) => ({
          label: p.label,
          grams: p.grams,
          ...(p.food ? { food: p.food } : {}),
          source: p.source,
        }));
    };
    if (queries) return ok({ results: queries.map((q) => ({ query: q, portions: run(q) })) });
    return ok({ portions: run(query as string) });
  },
});

// ── escrita ──────────────────────────────────────────────────────────────────────────────

export const logMealTool = defineTool({
  name: 'log_meal',
  scope: 'write',
  description:
    'Registra a refeição completa. O servidor calcula macros por item, totais, confiança agregada e o total do dia — use ' +
    'EXATAMENTE esses números na resposta. Gramas informadas pelo usuário: origin "user_stated", confidence "high". ' +
    'Sem meal_type, é inferido pelo horário. pending_question = a única pergunta, se houver.',
  input: z.object({
    eaten_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
      .optional(),
    meal_type: mealType.optional(),
    user_text: z.string().max(1000).optional(),
    photo_paths: z.array(z.string()).max(5).default([]),
    items: z.array(itemSchema).min(1).max(20),
    assumptions: z.array(z.string().max(200)).max(10).default([]),
    pending_question: z.string().max(300).optional(),
  }),
  handler: (ctx, input) => {
    const bad = validateItems(ctx.db, input.items);
    if (bad) return bad;
    const { at, localDate } = resolveWhen(
      input.eaten_at,
      ctx.now,
      ctx.settings.cutoffHour,
      ctx.settings.timeZone,
    );
    const w = wallClock(at, ctx.settings.timeZone);
    const id = insertMeal(ctx.db, {
      eaten_at: at,
      local_date: localDate,
      meal_type: input.meal_type ?? inferMealType(w.hour, w.minute, ctx.settings.cutoffHour),
      user_text: input.user_text ?? null,
      photo_paths: JSON.stringify(input.photo_paths),
      assumptions: input.assumptions.length ? JSON.stringify(input.assumptions) : null,
      pending_question: input.pending_question ?? null,
      now: ctx.now,
    });
    ctx.audit('meal', id, 'create');
    for (const it of input.items) addItem(ctx, id, it);
    refreshMealTotals(ctx.db, id, ctx.now);
    return ok(mealView(ctx.db, id, ctx), totalHints(ctx, id));
  },
});

export const updateMealItemTool = defineTool({
  name: 'update_meal_item',
  scope: 'write',
  description:
    'Corrige um item ("arroz foi 100g", "era patinho", "tira o óleo") e grava a correção (aprendizado). Recalcula a refeição ' +
    'e o dia. Use o item_id do bloco <quoted> ou da refeição mais recente compatível.',
  input: z
    .object({
      meal_item_id: z.number().int().positive(),
      grams: grams.optional(),
      food_id: z.number().int().positive().optional(),
      label: z.string().trim().min(1).max(60).optional(),
      delete: z.boolean().optional(),
    })
    .refine(
      (v) => v.grams !== undefined || v.food_id !== undefined || v.label !== undefined || v.delete,
      'nada para alterar',
    ),
  handler: (ctx, input) => {
    const item = getMealItem(ctx.db, input.meal_item_id);
    if (!item || item.deleted_at) return err('NOT_FOUND', `item ${input.meal_item_id} não existe`);
    if (input.food_id !== undefined) {
      const f = getFood(ctx.db, input.food_id);
      if (!f || f.deleted_at) return err('NOT_FOUND', `alimento ${input.food_id} não existe`);
    }
    const before: MealItemRow = { ...item };
    const corr = (field: string, oldV: unknown, newV: unknown) => {
      const cid = insertCorrection(ctx.db, {
        meal_item_id: item.id,
        field,
        old_value: oldV === null ? null : String(oldV),
        new_value: newV === null ? null : String(newV),
        created_at: ctx.now,
      });
      ctx.audit('meal_correction', cid, 'create');
    };
    if (input.delete) {
      ctx.db.prepare('UPDATE meal_items SET deleted_at = ? WHERE id = ?').run(ctx.now, item.id);
      corr('deleted', null, 'deleted');
    } else {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (input.grams !== undefined && input.grams !== item.grams) {
        sets.push('grams = ?', 'grams_low = NULL', 'grams_high = NULL');
        vals.push(input.grams);
        corr('grams', item.grams, input.grams);
      }
      if (input.food_id !== undefined && input.food_id !== item.food_id) {
        sets.push('food_id = ?', 'macros_override = NULL');
        vals.push(input.food_id);
        corr('food_id', item.food_id, input.food_id);
      }
      if (input.label !== undefined && input.label !== item.label) {
        sets.push('label = ?', 'label_norm = ?');
        vals.push(input.label, normalize(input.label));
        corr('label', item.label, input.label);
      }
      if (sets.length) {
        sets.push("origin = 'corrected'", "confidence = 'high'");
        ctx.db.prepare(`UPDATE meal_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, item.id);
        refreshItemMacros(ctx.db, item.id);
      }
    }
    ctx.audit('meal_item', item.id, 'update', before);
    refreshMealTotals(ctx.db, item.meal_id, ctx.now);
    return ok({ meal: mealView(ctx.db, item.meal_id, ctx) }, totalHints(ctx, item.meal_id));
  },
});

export const addMealItemTool = defineTool({
  name: 'add_meal_item',
  scope: 'write',
  description:
    'Adiciona um item a uma refeição já registrada ("tomei um suco também"). Mesmo formato de item do log_meal.',
  input: z.object({ meal_id: z.number().int().positive(), item: itemSchema }),
  handler: (ctx, { meal_id, item }) => {
    const meal = getMeal(ctx.db, meal_id);
    if (!meal || meal.deleted_at) return err('NOT_FOUND', `refeição ${meal_id} não existe`);
    const bad = validateItems(ctx.db, [item]);
    if (bad) return bad;
    addItem(ctx, meal_id, item);
    refreshMealTotals(ctx.db, meal_id, ctx.now);
    return ok({ meal: mealView(ctx.db, meal_id, ctx) }, totalHints(ctx, meal_id));
  },
});

export const updateMealTool = defineTool({
  name: 'update_meal',
  scope: 'write',
  description:
    'Altera tipo/horário da refeição, limpa a pergunta pendente (após a resposta do usuário) ou apaga a refeição.',
  input: z
    .object({
      meal_id: z.number().int().positive(),
      meal_type: mealType.optional(),
      eaten_at: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
        .optional(),
      clear_pending_question: z.boolean().optional(),
      delete: z.boolean().optional(),
    })
    .refine((v) => v.meal_type || v.eaten_at || v.clear_pending_question || v.delete, 'nada para alterar'),
  handler: (ctx, input) => {
    const meal = getMeal(ctx.db, input.meal_id);
    if (!meal || meal.deleted_at) return err('NOT_FOUND', `refeição ${input.meal_id} não existe`);
    const before = { ...meal };
    if (input.delete) ctx.db.prepare('UPDATE meals SET deleted_at = ? WHERE id = ?').run(ctx.now, meal.id);
    if (input.meal_type)
      ctx.db.prepare('UPDATE meals SET meal_type = ? WHERE id = ?').run(input.meal_type, meal.id);
    if (input.eaten_at) {
      const { at, localDate } = resolveWhen(
        input.eaten_at,
        ctx.now,
        ctx.settings.cutoffHour,
        ctx.settings.timeZone,
      );
      ctx.db
        .prepare('UPDATE meals SET eaten_at = ?, local_date = ? WHERE id = ?')
        .run(at, localDate, meal.id);
    }
    if (input.clear_pending_question)
      ctx.db.prepare('UPDATE meals SET pending_question = NULL WHERE id = ?').run(meal.id);
    ctx.db.prepare('UPDATE meals SET updated_at = ? WHERE id = ?').run(ctx.now, meal.id);
    ctx.audit('meal', meal.id, 'update', before);
    return ok({ meal: mealView(ctx.db, meal.id, ctx) });
  },
});

const macroSet = z.object({
  kcal: z.number().min(0).max(1000),
  protein_g: z.number().min(0).max(100),
  carbs_g: z.number().min(0).max(100),
  fat_g: z.number().min(0).max(100),
  fiber_g: z.number().min(0).max(100).optional(),
});

export const createCustomFoodTool = defineTool({
  name: 'create_custom_food',
  scope: 'write',
  description:
    'Cria (ou atualiza, pelo nome) um alimento personalizado: "meu whey: 1 scoop 30 g = 24 g prot" → per_portion ' +
    '{ grams: 30, kcal, protein_g: 24, ... } + portion_label "scoop". Foto de tabela nutricional: use os valores lidos.',
  input: z
    .object({
      name: z.string().trim().min(2).max(80),
      brand: z.string().trim().max(60).optional(),
      barcode: z
        .string()
        .regex(/^\d{8,14}$/)
        .optional(),
      per_100g: macroSet.optional(),
      per_portion: z
        .object({
          grams: z.number().positive().max(2000),
          kcal: z.number().min(0),
          protein_g: z.number().min(0),
          carbs_g: z.number().min(0),
          fat_g: z.number().min(0),
          fiber_g: z.number().min(0).optional(),
        })
        .optional(),
      portion_label: z.string().trim().min(1).max(40).optional(),
    })
    .refine(
      (v) => v.per_100g !== undefined || v.per_portion !== undefined,
      'informe per_100g ou per_portion',
    ),
  handler: (ctx, input) => {
    const per100 = input.per_100g
      ? {
          kcal_100g: input.per_100g.kcal,
          protein_100g: input.per_100g.protein_g,
          carbs_100g: input.per_100g.carbs_g,
          fat_100g: input.per_100g.fat_g,
          fiber_100g: input.per_100g.fiber_g ?? null,
        }
      : portionTo100g(input.per_portion!);
    if (per100.protein_100g + per100.carbs_100g + per100.fat_100g > 105) {
      return err('VALIDATION', 'macros por 100 g passam de 100 g; confira a porção');
    }
    if (input.barcode) {
      const other = findFoodByBarcode(ctx.db, input.barcode);
      if (other && normalize(other.name) !== normalize(input.name)) {
        return err('CONFLICT', `código de barras já usado por ${other.name}`, [
          { id: other.id, name: other.name },
        ]);
      }
    }
    const existing = ctx.db
      .prepare("SELECT * FROM foods WHERE source = 'custom' AND name_norm = ? AND deleted_at IS NULL")
      .get(normalize(input.name)) as Record<string, unknown> | undefined;
    let foodId: number;
    if (existing) {
      foodId = existing.id as number;
      ctx.db
        .prepare(
          `UPDATE foods SET brand = ?, barcode = coalesce(?, barcode), kcal_100g = ?, protein_100g = ?, carbs_100g = ?,
                  fat_100g = ?, fiber_100g = ? WHERE id = ?`,
        )
        .run(
          input.brand ?? null,
          input.barcode ?? null,
          per100.kcal_100g,
          per100.protein_100g,
          per100.carbs_100g,
          per100.fat_100g,
          per100.fiber_100g,
          foodId,
        );
      ctx.audit('food', foodId, 'update', existing);
    } else {
      foodId = upsertFood(ctx.db, {
        source: 'custom',
        source_id: null,
        name: input.name,
        brand: input.brand ?? null,
        barcode: input.barcode ?? null,
        ...per100,
        is_prepared: true,
      });
      ctx.audit('food', foodId, 'create');
    }
    if (input.per_portion && input.portion_label) {
      const pid = insertPortion(ctx.db, {
        food_id: foodId,
        food_name: null,
        label: input.portion_label,
        grams: input.per_portion.grams,
        source: 'label',
        source_ref: null,
      });
      ctx.audit('food_portion', pid, 'create');
    }
    return ok({
      food_id: foodId,
      updated: Boolean(existing),
      per_100g: roundMacros({
        kcal: per100.kcal_100g,
        protein_g: per100.protein_100g,
        carbs_g: per100.carbs_100g,
        fat_g: per100.fat_100g,
        fiber_g: per100.fiber_100g,
      }),
    });
  },
});

// ── Open Food Facts ──────────────────────────────────────────────────────────────────────

type OffFood = {
  name: string;
  brand: string | null;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sodiumMg: number | null;
};
type OffPrepared = { found: true; food: OffFood } | { found: false; reason: string } | { error: string };

/** Interpreta a resposta da API v2 da Open Food Facts (valores por 100 g). */
export function parseOffProduct(json: unknown): OffPrepared {
  const j = json as {
    status?: number;
    product?: {
      product_name?: string;
      product_name_pt?: string;
      brands?: string;
      nutriments?: Record<string, number>;
    };
  };
  const p = j?.product;
  if (!p || j.status === 0) return { found: false, reason: 'produto não encontrado' };
  const n = p.nutriments ?? {};
  const kcal =
    n['energy-kcal_100g'] ??
    (n.energy_100g !== undefined ? Math.round((n.energy_100g / 4.184) * 10) / 10 : undefined);
  if (
    kcal === undefined ||
    n.proteins_100g === undefined ||
    n.carbohydrates_100g === undefined ||
    n.fat_100g === undefined
  ) {
    return { found: false, reason: 'produto sem tabela nutricional completa' };
  }
  return {
    found: true,
    food: {
      name: (p.product_name_pt || p.product_name || 'Produto').trim(),
      brand: p.brands?.split(',')[0]?.trim() || null,
      kcal,
      protein: n.proteins_100g,
      carbs: n.carbohydrates_100g,
      fat: n.fat_100g,
      fiber: n.fiber_100g ?? null,
      sodiumMg: n.sodium_100g !== undefined ? n.sodium_100g * 1000 : null,
    },
  };
}

export const lookupBarcodeTool = defineTool({
  name: 'lookup_barcode',
  scope: 'write',
  description:
    'Busca um código de barras (EAN) na Open Food Facts e importa o alimento (valores por 100 g) se achar.',
  input: z.object({ ean: z.string().regex(/^\d{8,14}$/, 'EAN com 8 a 14 dígitos') }),
  prepare: async ({ ean }, env) => {
    const ctrl = AbortSignal.timeout(5000);
    const res = await env.fetch(
      `https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=product_name,product_name_pt,brands,nutriments`,
      { headers: { 'User-Agent': env.userAgent }, signal: ctrl },
    );
    if (res.status === 404) return { found: false, reason: 'produto não encontrado' } satisfies OffPrepared;
    if (!res.ok) throw new Error(`Open Food Facts respondeu ${res.status}`);
    return parseOffProduct(await res.json());
  },
  handler: (ctx, { ean }) => {
    const existing = findFoodByBarcode(ctx.db, ean);
    const view = (f: {
      id: number;
      name: string;
      brand: string | null;
      kcal_100g: number;
      protein_100g: number;
      carbs_100g: number;
      fat_100g: number;
    }) => ({
      id: f.id,
      name: f.name,
      brand: f.brand,
      kcal_100g: Math.round(f.kcal_100g),
      protein_100g: f.protein_100g,
      carbs_100g: f.carbs_100g,
      fat_100g: f.fat_100g,
    });
    if (existing) return ok({ found: true, food: view(existing) });
    const prep = ctx.prepared as OffPrepared | undefined;
    if (!prep || 'error' in prep)
      return ok({ found: false }, [
        'Open Food Facts indisponível agora; peça uma foto da tabela nutricional',
      ]);
    if (!prep.found) return ok({ found: false }, [`${prep.reason}; peça uma foto da tabela nutricional`]);
    const f = prep.food;
    const id = upsertFood(ctx.db, {
      source: 'off',
      source_id: ean,
      name: f.name,
      brand: f.brand,
      barcode: ean,
      kcal_100g: f.kcal,
      protein_100g: f.protein,
      carbs_100g: f.carbs,
      fat_100g: f.fat,
      fiber_100g: f.fiber,
      sodium_mg_100g: f.sodiumMg,
      is_prepared: true,
    });
    ctx.audit('food', id, 'create');
    return ok({ found: true, food: view(getFood(ctx.db, id)!) });
  },
});

export const nutritionTools = [
  searchFoodsTool,
  getFoodPriorsTool,
  getPortionsTool,
  logMealTool,
  updateMealItemTool,
  addMealItemTool,
  updateMealTool,
  createCustomFoodTool,
  lookupBarcodeTool,
];

/** Totais de um dia (usados pelo /hoje e pelo contexto). */
export function mealsOfDay(db: Db, localDate: string) {
  const meals = db
    .prepare('SELECT id FROM meals WHERE local_date = ? AND deleted_at IS NULL ORDER BY eaten_at')
    .pluck()
    .all(localDate) as number[];
  return sumMacros(meals.flatMap((id) => mealItems(db, id)));
}

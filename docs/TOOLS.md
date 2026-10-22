# TOOLS — Contratos MCP (servidor `fit`)

O cérebro só lê e escreve dados por estas tools. Elas são definidas uma única vez em `src/tools/registry.ts` (schema zod + handler + `scope: 'read' | 'write'`) e expostas pelo servidor MCP.

## Regras gerais

- **Nomes no MCP:** `mcp__fit__<nome>`. Descrições em PT-BR, curtas e com exemplo; elas são o principal "manual" que o modelo lê.
- **Validação zod** em toda entrada. Rejeite com erro claro em vez de adivinhar.
- **Cálculo no servidor:** as tools recebem gramas, cargas e reps e devolvem macros, totais, comparações e PRs já calculados.
- **Auditoria:** toda tool de escrita grava em `audit_log` com o `turn_id` resolvido pelo token, e registra a entidade para `message_links`.
- **Escopo:** em turnos de relatório (`toolScope='read'`), as tools de escrita retornam `FORBIDDEN`.
- **Envelope de resposta:**

```ts
type Ok<T> = { ok: true; data: T; hints?: string[] };            // hints: sugestões ao modelo
type Err   = { ok: false; error: { code: 'NOT_FOUND' | 'AMBIGUOUS' | 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL';
                                   message: string; candidates?: unknown[] } };
```

- **Datas:** entradas aceitam ISO completo ou `local_date`. Sem data, assume "agora". Saídas trazem `local_date` e horário local formatado.
- **Tamanho:** respostas enxutas (sem campos nulos, listas limitadas). Saída de tool também consome tokens.

---

## Treino

### `search_exercises` (read)
Busca exercícios por nome ou apelido (FTS + aliases). Use **antes** de registrar qualquer exercício.
```ts
in:  { query: string; limit?: number /*1-10, padrão 5*/ }
out: { matches: { id; name_pt; equipment; load_kind; score }[] }
```

### `create_exercise` (write)
Só quando `search_exercises` não trouxer correspondência razoável. Cria o exercício com aliases.
```ts
in:  { name_pt; aliases?: string[]; equipment; load_kind; primary_muscles: Muscle[]; secondary_muscles?: Muscle[];
       is_compound?: boolean; increment_kg?: number }
out: { id }
```

### `add_exercise_alias` (write)
```ts
in:  { exercise_id: number; alias: string }
```

### `define_routine` (write, upsert por nome)
Ao redefinir, exercício sem `weight_kg`/`reps` mantém o que já estava salvo.
```ts
in:  { name: string; exercises: { exercise_id; target_sets?; rep_min?; rep_max?; weight_kg?; reps? }[] }
out: { routine_id; name; exercises: { position; exercise_id; name_pt; target_sets?; rep_min?; rep_max?; saved? /* "30kg 3×10" */ }[] }
```

### `log_routine` (write) — D-034
"Fiz upper A": registra a rotina inteira com as cargas, séries e reps salvas (reps salvas, senão `rep_min`). Em `changes`
vai só o que foi diferente. Depois de gravar (mesma lógica de sessão do `log_workout`), a maior carga de trabalho de cada
exercício da rotina vira a carga salva quando difere dela, salvo `keep_loads`. Exercício fora da rotina entra só no treino.
Sem carga salva, usa a carga da sessão mais recente do exercício que teve carga. Sem nenhuma, anota séries e reps sem
carga e devolve `without_load` (o coach avisa no início da resposta); essas séries não entram em `vs_last` nem em PRs.
Faltou séries ou reps → `VALIDATION` com a lista do que perguntar, nada gravado.
```ts
in: {
  routine_name: string; performed_at?: string; new_session?: boolean; keep_loads?: boolean; notes?: string;
  changes?: { exercise_id; weight_kg?; reps?; n_sets?; sets?: Set[] /* como log_workout */; skip?: boolean }[];
}
out: log_workout.out & { loads_updated?: { exercise; from?: string; to: string }[]; skipped?: string[]; without_load?: string[] }
```

### `set_routine_loads` (write) — D-034
Muda carga, reps ou séries salvas sem registrar treino.
```ts
in:  { routine_name: string; loads: { exercise_id; weight_kg?: number | null; reps?; target_sets? }[] }
out: { routine; exercises: define_routine.out.exercises }
```

### `log_workout` (write)
Registra séries. Sem `session_id` e sem `new_session`, anexa à **sessão aberta** (última atividade há menos de `OPEN_SESSION_HOURS`, padrão 3) se houver; senão cria uma.
```ts
in: {
  routine_name?: string;           // vincula/inferido; cria rotina? NÃO — só vincula se existir
  session_id?: number; new_session?: boolean; performed_at?: string;
  entries: {
    exercise_id: number;
    sets: { weight_kg?: number; reps?: number; rpe?: number; rir?: number;
            set_type?: 'work'|'warmup'|'drop'|'failure'; notes?: string }[];
    notes?: string;
  }[];
  notes?: string;
}
out: {
  session_id; local_date; routine?: string;
  summary: { exercise: string; sets_compact: string /* "30kg 10/10/9" */;
             vs_last?: string /* "+2kg" | "=" | "-1 rep" */; prs: ('weight'|'e1rm'|'reps_at_weight')[] }[];
  session_totals: { work_sets; exercises };
}
```

### `get_last_sessions` (read)
```ts
in:  { routine_name?: string; exercise_id?: number; limit?: number /*1-5*/ }
out: { sessions: { session_id; local_date; routine?; exercises: { name; sets_compact; best_e1rm }[] }[] }
```

### `get_next_targets` (read)
Alvos para a próxima sessão da rotina, pela regra de progressão (REPORTS.md §2.4).
```ts
in:  { routine_name: string }
out: { last_date; targets: { exercise; saved?: string; last: string; target: string; rule: 'increase'|'hold'|'deload'|'first_time'; reason } [] }
```

### `log_cardio` (write)
```ts
in:  { activity: string; duration_min?: number; distance_km?: number; avg_hr?: number; kcal?: number; performed_at?: string }
out: { id; local_date }
```

---

## Nutrição

### `search_foods` (read)
Busca TACO, alimentos personalizados e Open Food Facts já importados. Valores por 100 g.
```ts
in:  { query: string; limit?: number /*1-10, padrão 6*/; prepared?: boolean }
out: { foods: { id; name; source; brand?; kcal_100g; protein_100g; carbs_100g; fat_100g; is_prepared }[] }
```

### `get_food_priors` (read)
Porções típicas **do usuário** para rótulos, a partir de itens informados ou corrigidos nos últimos 120 dias.
```ts
in:  { labels: string[] }
out: { priors: { label; n; median_g; p25_g; p75_g; last_seen }[] }   // só rótulos com n ≥ 2
```

### `get_portions` (read)
Medidas caseiras (IBGE e do usuário).
```ts
in:  { query: string }   // ex.: "concha feijão", "colher de sopa arroz", "ovo"
out: { portions: { label; grams; food?: string; source }[] }
```

### `log_meal` (write)
Registra a refeição completa. O servidor calcula macros por item (`food_id` × gramas ÷ 100, ou `macros_override`), os totais, a confiança agregada e os totais do dia.
```ts
in: {
  eaten_at?: string; meal_type?: MealType;
  user_text?: string; photo_paths?: string[];
  items: {
    label: string;                         // como mostrar ao usuário
    food_id?: number;                      // obrigatório, exceto com macros_override
    grams: number; grams_low?: number; grams_high?: number;
    origin: 'user_stated'|'photo_estimate'|'text_estimate'|'prior'|'label';
    confidence: 'high'|'medium'|'low';
    cooking_method?: string;
    macros_override?: { kcal; protein_g; carbs_g; fat_g };  // ex.: rótulo lido, prato sem match
  }[];
  assumptions?: string[];                  // ex.: ["óleo de preparo estimado em 8 g"]
  pending_question?: string;               // se for perguntar algo ao usuário
}
out: {
  meal_id; local_date; meal_type;
  items: { item_id; label; grams; range?: string; origin; kcal; protein_g; carbs_g; fat_g }[];
  totals: { kcal; protein_g; carbs_g; fat_g; fiber_g };
  confidence: 'high'|'medium'|'low';
  day: { kcal; protein_g; carbs_g; fat_g; goals?: { kcal?; protein_g? }; remaining?: { kcal?; protein_g? } };
}
```
Validações:
- `grams` entre 1 e 2.000.
- Item com `food_id` inexistente gera `NOT_FOUND`.
- Item sem `food_id` e sem `macros_override` gera `VALIDATION`.
- Soma acima de 3.000 kcal numa refeição não é bloqueada, mas gera `hints: ["total incomum, confirme com o usuário"]`.

### `update_meal_item` (write)
Corrige um item e grava em `meal_corrections`. Recalcula a refeição e o dia.
```ts
in:  { meal_item_id: number; grams?: number; food_id?: number; label?: string; delete?: boolean }
out: { meal: <mesmo shape de log_meal.out> }
```

### `add_meal_item` (write)
```ts
in:  { meal_id: number; item: <item de log_meal> }
out: { meal: <mesmo shape> }
```

### `update_meal` (write)
```ts
in:  { meal_id: number; meal_type?: MealType; eaten_at?: string; clear_pending_question?: boolean; delete?: boolean }
```

### `create_custom_food` (write)
```ts
in:  { name: string; brand?: string; barcode?: string;
       per_100g?: { kcal; protein_g; carbs_g; fat_g; fiber_g? };
       per_portion?: { grams; kcal; protein_g; carbs_g; fat_g; fiber_g? };  // convertido p/ 100 g
       portion_label?: string }   // cria food_portion (ex.: "scoop" = 30 g)
out: { food_id }
```

### `lookup_barcode` (write: importa se achar)
Consulta a Open Food Facts (timeout 5 s, User-Agent identificado). Se encontrar, cria `foods(source='off')`.
```ts
in:  { ean: string }
out: { found: boolean; food?: { id; name; brand; kcal_100g; protein_100g; carbs_100g; fat_100g } }
```

---

## Corpo, saúde e metas

### `log_body_metric` (write)
```ts
in:  { weight_kg?: number; body_fat_pct?: number; waist_cm?: number; measured_at?: string }
out: { id; local_date; weight_trend_kg?: number; delta_7d_kg?: number }
```

### `get_day_summary` (read)
```ts
in:  { date?: string }
out: { local_date; meals: { meal_id; meal_type; kcal; protein_g }[]; totals; goals; remaining;
       workout?: { routine?; work_sets; exercises: string[] }; cardio?: {...}[];
       health?: { steps; sleep_minutes; resting_hr; active_kcal }; weight_trend_kg? }
```

### `get_health_range` (read)
```ts
in:  { from: string; to: string; fields?: ('steps'|'sleep'|'resting_hr'|'hrv'|'active_kcal'|'weight')[] }
out: { days: { local_date; ...campos }[] }   // máx. 120 dias
```

### `set_goal` / `get_goals`
```ts
set_goal in: { key: 'kcal'|'protein_g'|'steps'|'sleep_h'|'training_days'|'weight_rate_kg_wk'|'weight_target_kg'; value: number | null }
get_goals out: { goals: Record<string, number> }
```

---

## Coach (Fase 8)

### `remember_note` (write)
```ts
in:  { kind: 'preference'|'observation'|'life_event'; text: string /* 3–200 */; due_date?: string /* AAAA-MM-DD, obrigatório e exclusivo de life_event */; replaces_id?: number }
out: { note_id; kind; replaced_id? }
```

### `resolve_note` (write)
```ts
in:  { note_id: number; outcome?: string }   // só life_event; outcome cria uma observation
out: { note_id; resolved: true; observation_id? }
```

### `forget_note` (write)
```ts
in:  { note_id: number }
out: { note_id; forgotten: true }
```

### `set_weekly_schedule` (write)
```ts
in:  { days: { weekday: 'dom'|'seg'|'ter'|'qua'|'qui'|'sex'|'sab'; routine_name: string }[] }   // substitui a agenda inteira
out: { schedule: { weekday; routine }[] }
```

### `set_plan_override` (write)
```ts
in:  { from_date?: string /* padrão: hoje */; until_date: string /* ≤ from + 60 dias */; text: string;
       changes?: { weekday; routine_name: string | null /* null = folga */ }[] }
out: { override_id; from; until; week: PlannedDay[] }
```

### `end_plan_override` (write)
```ts
in:  { override_id: number }
out: { override_id; ended: true }
```

### `get_week_plan` (read)
```ts
in:  { from_date?: string; days?: number /* 1–14, padrão 7 */ }
out: { days: { local_date; date; weekday; routine: string | null; source: 'schedule'|'override'|'none'; overrides? }[] }
```

`get_next_targets` aceita `routine_name` opcional: sem ele, usa a rotina planejada para hoje e devolve `planned_today`.

---

## Análise

### `get_metrics` (read)
Métricas predefinidas e testadas (definições em REPORTS.md). **Prefira esta à `query_sql`.**
```ts
in:  { metric: 'weekly_volume_by_muscle' | 'e1rm_history' | 'weight_trend' | 'nutrition_daily' |
               'protein_adherence' | 'logging_completeness' | 'sleep_stats' | 'steps_stats' |
               'maintenance_estimate' | 'sleep_vs_performance' | 'training_frequency';
       from: string; to: string; params?: Record<string, unknown> }   // ex.: { exercise_id: 12 }
out: { metric; from; to; data: unknown; n: number; notes?: string[] }
```

### `query_sql` (read)
SQL **somente leitura** para perguntas que as métricas não cobrem.
- Conexão `readonly: true` separada; aceita uma única instrução `SELECT` ou `WITH`.
- Timeout de 2 s (via `progress handler` / interrupção), máximo de 200 linhas.
- A descrição da tool inclui um resumo do schema (tabelas e colunas principais, convenções de `local_date` e `deleted_at`).
```ts
in:  { sql: string }
out: { columns: string[]; rows: unknown[][]; truncated: boolean }
```

### `get_report_brief` (read)
Usado nos turnos de relatório: devolve o `ReportBrief` já calculado (métricas + candidatos de insight).
```ts
in:  { report_id: number }
out: ReportBrief   // ver REPORTS.md §4
```

---

## Tipos auxiliares

```ts
type Muscle = 'chest'|'front_delts'|'side_delts'|'rear_delts'|'lats'|'upper_back'|'traps'|'biceps'|'triceps'
            |'forearms'|'quads'|'hamstrings'|'glutes'|'calves'|'adductors'|'abductors'|'abs'|'obliques'|'lower_back'|'neck';
type MealType = 'cafe'|'almoco'|'lanche'|'jantar'|'ceia'|'pre_treino'|'pos_treino';
```

## Testes obrigatórios das tools

Para cada tool: caso feliz, validação, `NOT_FOUND` e verificação do `audit_log`. Para `log_meal`: soma de macros confere com cálculo manual; confiança agregada ponderada por kcal. Para `log_workout`: anexar à sessão aberta vs. criar nova; detecção de PR; `vs_last`. Para `query_sql`: rejeitar `INSERT`, `UPDATE`, `DELETE`, `ATTACH`, `PRAGMA` e múltiplas instruções.

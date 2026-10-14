# DATA MODEL — FitCoach (SQLite)

## Convenções

- Timestamps em **UTC ISO-8601** (`TEXT`, ex.: `2026-10-13T23:41:00Z`).
- `local_date` (`TEXT 'YYYY-MM-DD'`) é o **dia contábil** em America/Sao_Paulo, com virada às 04:00 (`DAY_CUTOFF_HOUR=4`). É calculado no código ao gravar e indexado. Todas as agregações diárias usam `local_date`.
- Pesos em **kg**, distâncias em **m**, energia em **kcal**, macros em **g**, durações em **s**.
- Soft delete via `deleted_at`. Consultas padrão filtram `deleted_at IS NULL`.
- IDs `INTEGER PRIMARY KEY` (rowid).
- PRAGMAs na conexão: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Migrations em `src/db/migrations/NNN_nome.sql`, aplicadas em ordem e registradas em `schema_migrations`.

## 1. Sistema e mensageria

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE settings (               -- metas, preferências, estado do sistema
  key TEXT PRIMARY KEY,               -- ex.: goal.kcal, goal.protein_g, goal.steps, goal.sleep_h,
                                      --      goal.training_days, goal.weight_rate_kg_wk, owner.ids, proactive.paused
  value TEXT NOT NULL,                -- JSON
  updated_at TEXT NOT NULL
);

-- (turns é definida abaixo; crie-a antes de messages na migration)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,              -- 'whatsapp' | 'terminal' | 'telegram'
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  external_id TEXT,                   -- id da mensagem no canal
  quoted_external_id TEXT,            -- se for resposta citando outra
  kind TEXT NOT NULL,                 -- 'text' | 'image' | 'audio' | 'other'
  text TEXT,
  media_path TEXT,                    -- relativo a DATA_DIR
  turn_id INTEGER REFERENCES turns(id),
  status TEXT NOT NULL DEFAULT 'received', -- received|queued|processed|failed|ignored|sent
  created_at TEXT NOT NULL,
  UNIQUE (channel, direction, external_id)
);
CREATE INDEX idx_messages_created ON messages(created_at);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'chat' | 'report' | 'command'
  status TEXT NOT NULL,               -- running|done|failed|deferred
  model TEXT,
  token_hash TEXT,                    -- sha256 do token de turno (nunca o token em claro)
  prompt_chars INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  num_turns INTEGER,
  cost_usd REAL,                      -- estimativa reportada pela CLI
  usage_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (              -- toda escrita feita por tool ou comando
  id INTEGER PRIMARY KEY,
  turn_id INTEGER REFERENCES turns(id),
  entity TEXT NOT NULL,               -- 'meal' | 'meal_item' | 'workout_session' | 'set' | ...
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,               -- 'create' | 'update' | 'delete'
  before_json TEXT,                   -- estado anterior (para undo de update/delete)
  after_json TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX idx_audit_turn ON audit_log(turn_id);

CREATE TABLE message_links (          -- liga mensagens do bot às entidades (correção por citação)
  message_id INTEGER NOT NULL REFERENCES messages(id),
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (message_id, entity, entity_id)
);
```

## 2. Treino

```sql
CREATE TABLE exercises (
  id INTEGER PRIMARY KEY,
  name_pt TEXT NOT NULL,              -- canônico em PT-BR, ex.: 'Supino inclinado com halteres'
  name_en TEXT,
  category TEXT NOT NULL,             -- 'strength' | 'cardio' | 'mobility' | 'other'
  equipment TEXT,                     -- 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'smith' | 'other'
  load_kind TEXT NOT NULL DEFAULT 'total', -- 'total' | 'per_hand' | 'per_side' | 'bodyweight_plus' | 'assisted' | 'stack'
  primary_muscles TEXT NOT NULL,      -- JSON array, vocabulário fixo (abaixo)
  secondary_muscles TEXT NOT NULL DEFAULT '[]',
  is_compound INTEGER NOT NULL DEFAULT 0,
  increment_kg REAL,                  -- incremento mínimo para progressão (ex.: 2.5 barra, 2 halter)
  source TEXT NOT NULL,               -- 'free-exercise-db' | 'custom'
  source_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE exercise_aliases (
  alias_norm TEXT PRIMARY KEY,        -- normalizado: minúsculas, sem acento, espaços colapsados
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  origin TEXT NOT NULL                -- 'seed' | 'user' | 'llm'
);
CREATE VIRTUAL TABLE exercises_fts USING fts5(name_pt, name_en, aliases, content='');
-- manter sincronizado via código (rebuild após seeds e inserts)

CREATE TABLE routines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                 -- 'Upper B'
  name_norm TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE routine_exercises (
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  position INTEGER NOT NULL,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  target_sets INTEGER,
  rep_min INTEGER,
  rep_max INTEGER,
  PRIMARY KEY (routine_id, position)
);

CREATE TABLE workout_sessions (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER REFERENCES routines(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  local_date TEXT NOT NULL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'chat', -- 'chat' | 'health_connect' | 'import'
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_ws_date ON workout_sessions(local_date);

CREATE TABLE sets (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES workout_sessions(id),
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  exercise_order INTEGER NOT NULL,    -- ordem do exercício na sessão
  set_index INTEGER NOT NULL,         -- 1..n dentro do exercício
  weight_kg REAL,                     -- conforme exercises.load_kind; NULL = só peso corporal
  reps INTEGER,
  rpe REAL,
  rir INTEGER,
  set_type TEXT NOT NULL DEFAULT 'work', -- 'work' | 'warmup' | 'drop' | 'failure'
  notes TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_sets_ex ON sets(exercise_id, created_at);

CREATE TABLE cardio_sessions (
  id INTEGER PRIMARY KEY,
  local_date TEXT NOT NULL,
  started_at TEXT,
  activity TEXT NOT NULL,             -- 'esteira' | 'corrida' | 'bike' | 'caminhada' | ... ou tipo do HC
  duration_s INTEGER,
  distance_m REAL,
  avg_hr INTEGER,
  kcal REAL,
  source TEXT NOT NULL,               -- 'chat' | 'health_connect'
  external_key TEXT UNIQUE,           -- dedupe do HC (tipo+start+end)
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
```

**Vocabulário de músculos** (fixo, usado em volume por grupo): `chest, front_delts, side_delts, rear_delts, lats, upper_back, traps, biceps, triceps, forearms, quads, hamstrings, glutes, calves, adductors, abductors, abs, obliques, lower_back, neck`. O seed mapeia os músculos do free-exercise-db para esse vocabulário.

**`load_kind`**: halteres usam `per_hand` (como se fala na academia: "halter de 30"); barra e máquina, `total`; barra fixa, paralelas e afins, `bodyweight_plus` (o `weight_kg` é a carga adicional). O volume usa peso efetivo: `per_hand` × 2; `bodyweight_plus` + peso corporal da tendência.

## 3. Nutrição

```sql
CREATE TABLE foods (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,               -- 'taco' | 'off' (Open Food Facts) | 'custom'
  source_id TEXT,
  name TEXT NOT NULL,                 -- ex.: 'Arroz, tipo 1, cozido'
  name_norm TEXT NOT NULL,
  brand TEXT,
  barcode TEXT UNIQUE,
  kcal_100g REAL NOT NULL,
  protein_100g REAL NOT NULL,
  carbs_100g REAL NOT NULL,
  fat_100g REAL NOT NULL,
  fiber_100g REAL,
  sodium_mg_100g REAL,
  is_prepared INTEGER NOT NULL DEFAULT 0, -- cozido/grelhado/assado vs. cru
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE VIRTUAL TABLE foods_fts USING fts5(name, brand, content='foods', content_rowid='id',
                                          tokenize="unicode61 remove_diacritics 2");

CREATE TABLE food_portions (          -- medidas caseiras e porções nomeadas
  id INTEGER PRIMARY KEY,
  food_id INTEGER REFERENCES foods(id), -- NULL = medida genérica
  label TEXT NOT NULL,                -- 'concha média', 'colher de sopa cheia', 'scoop', 'unidade média'
  grams REAL NOT NULL,
  source TEXT NOT NULL                -- 'ibge' | 'user' | 'label'
);

CREATE TABLE meals (
  id INTEGER PRIMARY KEY,
  eaten_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  meal_type TEXT,                     -- 'cafe' | 'almoco' | 'lanche' | 'jantar' | 'ceia' | 'pre_treino' | 'pos_treino'
  user_text TEXT,
  photo_paths TEXT NOT NULL DEFAULT '[]', -- JSON array
  confidence TEXT NOT NULL,           -- 'high' | 'medium' | 'low' (pior item ponderado por kcal)
  assumptions TEXT,                   -- JSON array de strings (ex.: "óleo de preparo estimado")
  pending_question TEXT,              -- pergunta feita ao usuário, se houver
  kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL, fiber_g REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_meals_date ON meals(local_date);

CREATE TABLE meal_items (
  id INTEGER PRIMARY KEY,
  meal_id INTEGER NOT NULL REFERENCES meals(id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL,                -- como mostrado ao usuário: 'Frango grelhado'
  label_norm TEXT NOT NULL,           -- chave dos priors pessoais
  food_id INTEGER REFERENCES foods(id), -- NULL se não aterrado (usa macros_override)
  grams REAL NOT NULL,
  grams_low REAL,
  grams_high REAL,
  origin TEXT NOT NULL,               -- 'user_stated' | 'photo_estimate' | 'text_estimate' | 'prior' | 'corrected' | 'label'
  confidence TEXT NOT NULL,           -- 'high' | 'medium' | 'low'
  cooking_method TEXT,                -- 'grelhado' | 'frito' | 'cozido' | 'assado' | 'cru' | ...
  macros_override TEXT,               -- JSON {kcal,protein_g,carbs_g,fat_g} quando sem food_id
  kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL, fiber_g REAL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE meal_corrections (       -- memória de aprendizado
  id INTEGER PRIMARY KEY,
  meal_item_id INTEGER NOT NULL REFERENCES meal_items(id),
  field TEXT NOT NULL,                -- 'grams' | 'food_id' | 'label' | 'deleted'
  old_value TEXT, new_value TEXT,
  created_at TEXT NOT NULL
);

-- Priors pessoais: porções típicas do usuário por rótulo normalizado, últimos 120 dias
CREATE VIEW v_food_priors AS
SELECT label_norm,
       COUNT(*) AS n,
       -- mediana calculada no código (SQLite não tem MEDIAN); a view entrega a base
       group_concat(grams) AS grams_list,
       MAX(created_at) AS last_seen
FROM meal_items
WHERE deleted_at IS NULL
  AND origin IN ('user_stated','corrected','label')
  AND created_at >= datetime('now','-120 days')
GROUP BY label_norm;
```

## 4. Corpo e saúde

```sql
CREATE TABLE body_metrics (
  id INTEGER PRIMARY KEY,
  measured_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  weight_kg REAL,
  body_fat_pct REAL,
  waist_cm REAL,
  source TEXT NOT NULL,               -- 'chat' | 'health_connect'
  external_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_body_date ON body_metrics(local_date);

CREATE TABLE health_raw (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,              -- JSON bruto do HC Webhook
  processed_at TEXT,
  error TEXT
);

CREATE TABLE health_samples (         -- normalizado, uma linha por amostra/intervalo
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                 -- 'steps' | 'heart_rate' | 'resting_heart_rate' | 'hrv' | 'active_kcal'
                                      -- | 'total_kcal' | 'distance' | 'spo2' | 'sleep_session'
  start_at TEXT NOT NULL,
  end_at TEXT,
  value REAL,                         -- unidade padrão do tipo
  extra TEXT,                         -- JSON (ex.: estágios do sono)
  external_key TEXT NOT NULL UNIQUE,  -- type|start|end|value → idempotência entre reenvios
  created_at TEXT NOT NULL
);
CREATE INDEX idx_hs_type_start ON health_samples(type, start_at);

CREATE TABLE health_daily (           -- materializado; recalculado por dia afetado
  local_date TEXT PRIMARY KEY,
  steps INTEGER,
  active_kcal REAL,
  resting_hr INTEGER,
  avg_hr INTEGER,
  hrv_rmssd_ms REAL,
  sleep_minutes INTEGER,              -- sono da noite que TERMINA nesse dia contábil
  sleep_start TEXT, sleep_end TEXT,
  sleep_deep_min INTEGER, sleep_rem_min INTEGER, sleep_light_min INTEGER, sleep_awake_min INTEGER,
  updated_at TEXT NOT NULL
);
```

### Mapeamento do HC Webhook → tabelas

| Chave no payload | Destino |
|---|---|
| `steps[] {count,start_time,end_time}` | `health_samples(type='steps')` → soma por dia |
| `sleep[] {session_end_time,duration_seconds,stages[]}` | `health_samples(type='sleep_session', extra=stages)` → `health_daily.sleep_*` do dia de `session_end_time` |
| `heart_rate[] {bpm,time}` | `health_samples(type='heart_rate')` → média diária |
| `resting_heart_rate[] {bpm,time}` | `health_daily.resting_hr` |
| `heart_rate_variability[] {rmssd_millis,time}` | `health_daily.hrv_rmssd_ms` (média) |
| `active_calories[] {calories,start_time,end_time}` | soma diária |
| `weight[] {kilograms,time}` | `body_metrics(source='health_connect')` |
| `body_fat[] {percentage,time}` | `body_metrics.body_fat_pct` |
| `exercise[] {type,start_time,end_time,duration_seconds,distance_meters?}` | `cardio_sessions(source='health_connect')`; tipos de força viram só referência de duração |

Tipos não listados (ex.: ciclo menstrual, atividade sexual) **não** são processados nem armazenados fora de `health_raw`. Desative-os no app HC Webhook.

O mapeamento de estágios do sono (strings) para deep/rem/light/awake depende do formato que o app envia. Implemente após inspecionar um payload real (Fase 4) e guarde amostras anonimizadas em `tests/fixtures/`.

## 5. Relatórios

```sql
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'daily' | 'weekly' | 'monthly' | 'adhoc'
  period_start TEXT NOT NULL,         -- local_date
  period_end TEXT NOT NULL,
  metrics_json TEXT NOT NULL,         -- ReportBrief completo (números do código)
  insights_json TEXT NOT NULL,        -- candidatos gerados pelos detectores
  text TEXT,                          -- texto final enviado
  used_llm INTEGER NOT NULL,
  chart_paths TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,                  -- 'report.weekly' | 'backup' | 'alert.hc_stale' | ...
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  detail TEXT
);
```

## 6. Seeds

| Seed | Fonte | Observação |
|---|---|---|
| `foods` (TACO) | TACO 4ª ed. (NEPA/Unicamp). Planilha oficial ou dados do repositório `raulfdm/taco-api` | Importer em `scripts/seed-taco.ts`. Valores "Tr"/"NA"/"*" viram 0 ou NULL conforme o campo. Validar contagem e 5 alimentos de amostra contra a tabela oficial |
| `food_portions` | IBGE — Tabela de medidas referidas para os alimentos consumidos no Brasil (POF 2008–2009) | Só as ~60 medidas mais comuns (arroz, feijão, carnes, pão, ovos, frutas, leite). Conferir cada valor na fonte; **não inventar gramaturas** |
| `exercises` | `yuhonas/free-exercise-db` (domínio público) | Importar todos com `name_en`; `seeds/exercises_ptbr.csv` cobre ~80 exercícios comuns com `name_pt`, aliases, `load_kind`, `increment_kg`, `is_compound` |
| `exercise_aliases` | `seeds/exercises_ptbr.csv` | Ex.: "sup inc", "supino inclinado", "supino inclinado halter" → mesmo id |

-- 001_init — schema completo de docs/DATA_MODEL.md
-- Desvios aprovados (docs/DECISIONS.md): D-005 FTS de exercícios com conteúdo próprio,
-- D-006 triggers do foods_fts, D-007 priors calculados no código (sem v_food_priors),
-- D-008 chave do HC sem o valor, D-009 colunas de procedência em food_portions,
-- D-010 UNIQUE(source, source_id) em foods para seeds idempotentes.

-- 1. Sistema e mensageria ---------------------------------------------------------------

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                 -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                  -- 'chat' | 'report' | 'command'
  status TEXT NOT NULL,                -- running|done|failed|deferred
  model TEXT,
  token_hash TEXT,                     -- sha256 do token de turno (nunca o token em claro)
  prompt_chars INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  num_turns INTEGER,
  cost_usd REAL,
  usage_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,               -- 'whatsapp' | 'terminal' | 'telegram'
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  external_id TEXT,
  quoted_external_id TEXT,
  kind TEXT NOT NULL,                  -- 'text' | 'image' | 'audio' | 'other'
  text TEXT,
  media_path TEXT,                     -- relativo a DATA_DIR
  turn_id INTEGER REFERENCES turns(id),
  status TEXT NOT NULL DEFAULT 'received', -- received|queued|processed|failed|ignored|sent
  created_at TEXT NOT NULL,
  UNIQUE (channel, direction, external_id)
);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_messages_turn ON messages(turn_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER REFERENCES turns(id),
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,                -- 'create' | 'update' | 'delete'
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX idx_audit_turn ON audit_log(turn_id);

CREATE TABLE message_links (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (message_id, entity, entity_id)
);

-- 2. Treino --------------------------------------------------------------------------------

CREATE TABLE exercises (
  id INTEGER PRIMARY KEY,
  name_pt TEXT NOT NULL,
  name_en TEXT,
  category TEXT NOT NULL,              -- 'strength' | 'cardio' | 'mobility' | 'other'
  equipment TEXT,                      -- 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'smith' | 'other'
  load_kind TEXT NOT NULL DEFAULT 'total', -- 'total' | 'per_hand' | 'per_side' | 'bodyweight_plus' | 'assisted' | 'stack'
  primary_muscles TEXT NOT NULL,       -- JSON array (vocabulário fixo)
  secondary_muscles TEXT NOT NULL DEFAULT '[]',
  is_compound INTEGER NOT NULL DEFAULT 0,
  increment_kg REAL,
  source TEXT NOT NULL,                -- 'free-exercise-db' | 'custom'
  source_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (source, source_id)
);

CREATE TABLE exercise_aliases (
  alias_norm TEXT PRIMARY KEY,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  origin TEXT NOT NULL                 -- 'seed' | 'user' | 'llm'
);
CREATE INDEX idx_exercise_aliases_ex ON exercise_aliases(exercise_id);

-- rowid = exercises.id; mantido pelo código (src/db/repos/exercises.ts)
CREATE VIRTUAL TABLE exercises_fts USING fts5(
  name_pt, name_en, aliases,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE routines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
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
  exercise_order INTEGER NOT NULL,
  set_index INTEGER NOT NULL,
  weight_kg REAL,
  reps INTEGER,
  rpe REAL,
  rir INTEGER,
  set_type TEXT NOT NULL DEFAULT 'work', -- 'work' | 'warmup' | 'drop' | 'failure'
  notes TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_sets_ex ON sets(exercise_id, created_at);
CREATE INDEX idx_sets_session ON sets(session_id);

CREATE TABLE cardio_sessions (
  id INTEGER PRIMARY KEY,
  local_date TEXT NOT NULL,
  started_at TEXT,
  activity TEXT NOT NULL,
  duration_s INTEGER,
  distance_m REAL,
  avg_hr INTEGER,
  kcal REAL,
  source TEXT NOT NULL,                -- 'chat' | 'health_connect'
  external_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_cardio_date ON cardio_sessions(local_date);

-- 3. Nutrição ------------------------------------------------------------------------------

CREATE TABLE foods (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,                -- 'taco' | 'off' | 'custom'
  source_id TEXT,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  brand TEXT,
  barcode TEXT UNIQUE,
  kcal_100g REAL NOT NULL,
  protein_100g REAL NOT NULL,
  carbs_100g REAL NOT NULL,
  fat_100g REAL NOT NULL,
  fiber_100g REAL,
  sodium_mg_100g REAL,
  is_prepared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (source, source_id)
);
CREATE INDEX idx_foods_name_norm ON foods(name_norm);

CREATE VIRTUAL TABLE foods_fts USING fts5(
  name, brand,
  content = 'foods', content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER foods_ai AFTER INSERT ON foods BEGIN
  INSERT INTO foods_fts(rowid, name, brand) VALUES (new.id, new.name, new.brand);
END;
CREATE TRIGGER foods_ad AFTER DELETE ON foods BEGIN
  INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES ('delete', old.id, old.name, old.brand);
END;
CREATE TRIGGER foods_au AFTER UPDATE OF name, brand ON foods BEGIN
  INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES ('delete', old.id, old.name, old.brand);
  INSERT INTO foods_fts(rowid, name, brand) VALUES (new.id, new.name, new.brand);
END;

CREATE TABLE food_portions (
  id INTEGER PRIMARY KEY,
  food_id INTEGER REFERENCES foods(id), -- NULL = medida não ligada a um alimento da tabela
  food_name TEXT,                      -- nome do alimento na fonte (ex.: IBGE), quando food_id é NULL
  label TEXT NOT NULL,                 -- 'concha média cheia', 'colher de sopa cheia', 'scoop', 'unidade média'
  grams REAL NOT NULL,
  source TEXT NOT NULL,                -- 'ibge' | 'user' | 'label'
  source_ref TEXT                      -- procedência (ex.: 'IBGE POF 2008-2009 liv50000.pdf p.35; ref 1')
);
CREATE INDEX idx_food_portions_food ON food_portions(food_id);

CREATE TABLE meals (
  id INTEGER PRIMARY KEY,
  eaten_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  meal_type TEXT,
  user_text TEXT,
  photo_paths TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL,            -- 'high' | 'medium' | 'low'
  assumptions TEXT,                    -- JSON array
  pending_question TEXT,
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
  label TEXT NOT NULL,
  label_norm TEXT NOT NULL,
  food_id INTEGER REFERENCES foods(id),
  grams REAL NOT NULL,
  grams_low REAL,
  grams_high REAL,
  origin TEXT NOT NULL,                -- 'user_stated' | 'photo_estimate' | 'text_estimate' | 'prior' | 'corrected' | 'label'
  confidence TEXT NOT NULL,
  cooking_method TEXT,
  macros_override TEXT,                -- JSON {kcal,protein_g,carbs_g,fat_g}
  kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL, fiber_g REAL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_meal_items_meal ON meal_items(meal_id);
-- base dos priors pessoais (D-007): filtro por rótulo e janela de datas no código
CREATE INDEX idx_meal_items_priors ON meal_items(label_norm, created_at);

CREATE TABLE meal_corrections (
  id INTEGER PRIMARY KEY,
  meal_item_id INTEGER NOT NULL REFERENCES meal_items(id),
  field TEXT NOT NULL,                 -- 'grams' | 'food_id' | 'label' | 'deleted'
  old_value TEXT, new_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_meal_corrections_item ON meal_corrections(meal_item_id);

-- 4. Corpo e saúde -------------------------------------------------------------------------

CREATE TABLE body_metrics (
  id INTEGER PRIMARY KEY,
  measured_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  weight_kg REAL,
  body_fat_pct REAL,
  waist_cm REAL,
  source TEXT NOT NULL,                -- 'chat' | 'health_connect'
  external_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_body_date ON body_metrics(local_date);

CREATE TABLE health_raw (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

CREATE TABLE health_samples (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  value REAL,
  extra TEXT,
  external_key TEXT NOT NULL UNIQUE,   -- type|start|end (D-008: sem o valor; reenvio atualiza via upsert)
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_hs_type_start ON health_samples(type, start_at);

CREATE TABLE health_daily (
  local_date TEXT PRIMARY KEY,
  steps INTEGER,
  active_kcal REAL,
  resting_hr INTEGER,
  avg_hr INTEGER,
  hrv_rmssd_ms REAL,
  sleep_minutes INTEGER,               -- sono da noite que TERMINA nesse dia contábil
  sleep_start TEXT, sleep_end TEXT,
  sleep_deep_min INTEGER, sleep_rem_min INTEGER, sleep_light_min INTEGER, sleep_awake_min INTEGER,
  updated_at TEXT NOT NULL
);

-- 5. Relatórios ----------------------------------------------------------------------------

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                  -- 'daily' | 'weekly' | 'monthly' | 'adhoc'
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  insights_json TEXT NOT NULL,
  text TEXT,
  used_llm INTEGER NOT NULL,
  chart_paths TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  detail TEXT
);
CREATE INDEX idx_job_runs_job ON job_runs(job, started_at);

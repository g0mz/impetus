-- Fase 8c: agenda semanal das rotinas e ajustes temporários do plano (D-033).
CREATE TABLE routine_schedule (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo; dia ausente = descanso
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  updated_at TEXT NOT NULL
);

-- Muda sessões, nunca metas. Vence pelo filtro de data (until_local_date), sem job.
CREATE TABLE plan_overrides (
  id INTEGER PRIMARY KEY,
  from_local_date TEXT NOT NULL,
  until_local_date TEXT NOT NULL,
  text TEXT NOT NULL,                  -- "viagem a SP, só academia de hotel"
  weekday_changes TEXT,                -- JSON {"4": null, "5": 3}: dia da semana → routine_id (null = folga)
  created_at TEXT NOT NULL,
  turn_id INTEGER REFERENCES turns(id),
  deleted_at TEXT
);
CREATE INDEX idx_plan_overrides_until ON plan_overrides(until_local_date) WHERE deleted_at IS NULL;

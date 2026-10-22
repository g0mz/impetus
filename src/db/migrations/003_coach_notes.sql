-- Fase 8b: memória da pessoa (D-035). Escrita só pelas tools remember_note / resolve_note / forget_note.
CREATE TABLE coach_notes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('preference','observation','life_event')),
  text TEXT NOT NULL,
  due_local_date TEXT,                 -- só life_event: a partir de quando perguntar de novo
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,                    -- life_event já perguntado
  turn_id INTEGER REFERENCES turns(id),
  deleted_at TEXT
);
CREATE INDEX idx_coach_notes_active ON coach_notes(kind) WHERE deleted_at IS NULL AND resolved_at IS NULL;

-- Carga e reps salvas por exercício da rotina: "fiz upper A" registra o treino com elas (D-034).
ALTER TABLE routine_exercises ADD COLUMN weight_kg REAL;
ALTER TABLE routine_exercises ADD COLUMN reps INTEGER;

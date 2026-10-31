import { analysisTools } from './analysis.ts';
import { bodyTools } from './body.ts';
import { coachTools } from './coach.ts';
import { planTools } from './plan.ts';
import { createRegistry, type Registry, type ToolDef } from './registry.ts';
import { nutritionTools } from './nutrition.ts';
import { trainingTools } from './training.ts';
import { vaultTools } from './vault.ts';

/** Registro único das tools servidas pelo MCP (e reutilizáveis por providers de API). */
export function buildRegistry(): Registry {
  return createRegistry([
    ...trainingTools,
    ...nutritionTools,
    ...bodyTools,
    ...analysisTools,
    ...coachTools,
    ...planTools,
    ...vaultTools,
  ] as unknown as ToolDef[]);
}

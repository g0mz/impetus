import { analysisTools } from './analysis.ts';
import { bodyTools } from './body.ts';
import { createRegistry, type Registry, type ToolDef } from './registry.ts';
import { nutritionTools } from './nutrition.ts';
import { trainingTools } from './training.ts';

/** Registro único das tools servidas pelo MCP (e reutilizáveis por providers de API). */
export function buildRegistry(): Registry {
  return createRegistry([...trainingTools, ...nutritionTools, ...bodyTools, ...analysisTools] as unknown as ToolDef[]);
}

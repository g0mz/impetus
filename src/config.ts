import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const int = (def: number) => z.coerce.number().int().default(def);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato HH:MM');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    TZ: z.string().default('America/Sao_Paulo'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATA_DIR: z.string().min(1).default('./data'),
    // cwd do `claude -p`; precisa ficar FORA do repositório (ver docs/DECISIONS.md D-004)
    BRAIN_DIR: z
      .string()
      .min(1)
      .default(path.join(os.homedir(), '.local', 'state', 'impetus', 'brain')),
    DAY_CUTOFF_HOUR: z.coerce.number().int().min(0).max(23).default(4),

    CHANNEL: z.enum(['whatsapp', 'terminal', 'telegram']).default('terminal'),
    WA_SEND_MIN_INTERVAL_MS: int(1000),

    BRAIN_PROVIDER: z.enum(['claude-cli', 'anthropic-api', 'gemini', 'none']).default('claude-cli'),
    CLAUDE_BIN: z.string().default('claude'),
    MODEL_FAST: z.string().default('haiku'),
    MODEL_VISION: z.string().default('sonnet'),
    MODEL_REPORT: z.string().default('sonnet'),
    BRAIN_TIMEOUT_MS: int(120_000),
    BRAIN_MAX_TURNS: int(15),
    BRAIN_RETRY_DELAY_MS: int(5000),
    CLAUDE_TOKEN_EXPIRES_AT: z.iso.date().optional(),
    IMPETUS_ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),

    MCP_PORT: int(8788),
    INGEST_PORT: int(8787),
    INGEST_API_KEY: z.string().min(64, 'use 32+ bytes aleatórios em hex (openssl rand -hex 32)').optional(),

    DEBOUNCE_MS: int(4000),
    DEBOUNCE_IMAGE_MS: int(20_000),
    OPEN_SESSION_HOURS: z.coerce.number().positive().default(3),
    CONTEXT_RECENT_TURNS: int(8),

    REPORT_DAILY: bool.default(false),
    REPORT_DAILY_TIME: hhmm.default('21:30'),
    REPORT_WEEKLY_CRON: z.string().default('0 20 * * 0'),
    REPORT_MONTHLY_CRON: z.string().default('0 9 1 * *'),
    REPORT_CHARTS: bool.default(true),

    OFF_USER_AGENT: z.string().default('Impetus/0.1 (uso pessoal)'),
    HC_STALE_HOURS: int(48),
  })
  .superRefine((c, ctx) => {
    if (c.BRAIN_PROVIDER === 'anthropic-api' && !c.IMPETUS_ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMPETUS_ANTHROPIC_API_KEY'],
        message: 'obrigatória com BRAIN_PROVIDER=anthropic-api',
      });
    }
    if (c.BRAIN_PROVIDER === 'gemini' && !c.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'obrigatória com BRAIN_PROVIDER=gemini',
      });
    }
    if (c.NODE_ENV === 'production' && !c.INGEST_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['INGEST_API_KEY'], message: 'obrigatória em produção' });
    }
  });

export type Config = z.infer<typeof schema> & { dbPath: string; mediaDir: string };

/** Raiz do repositório (este arquivo vive em src/ ou dist/). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Valida o ambiente. Lança ConfigError com a lista de problemas, sem ecoar valores. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`);
    throw new ConfigError(`Configuração inválida:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const dataDir = path.resolve(c.DATA_DIR);
  const brainDir = path.resolve(c.BRAIN_DIR);
  if (isInside(brainDir, REPO_ROOT)) {
    throw new ConfigError(
      `Configuração inválida:\n  - BRAIN_DIR: precisa ficar fora do repositório (${REPO_ROOT}), senão o coach herda o CLAUDE.md de desenvolvimento`,
    );
  }
  return {
    ...c,
    DATA_DIR: dataDir,
    dbPath: path.join(dataDir, 'impetus.db'),
    BRAIN_DIR: brainDir,
    mediaDir: path.join(dataDir, 'media'),
  };
}

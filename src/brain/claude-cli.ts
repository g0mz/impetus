import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Logger } from '../logger.ts';
import type { Brain, BrainErrorKind, BrainInput, BrainResult } from './types.ts';

export type ClaudeCliOptions = {
  bin: string;
  /** cwd do processo filho: pasta vazia FORA do repositório (D-004). */
  cwd: string;
  systemPromptFile: string;
  mcpUrl: string;
  mcpServerName: string;
  mediaDir: string;
  maxTurns: number;
  timeoutMs: number;
  /** Flags de isolamento (D-018), ex.: ['--setting-sources', '']. */
  isolationArgs: string[];
  /** Modelo de reserva por modelo principal (ex.: haiku → sonnet). */
  fallbackModels?: Record<string, string>;
  logger: Logger;
};

/** Caminho absoluto no formato das regras de permissão do Claude Code ("//abs/path"; C:\x → //c/x). */
export function permissionPath(abs: string): string {
  let p = (path.isAbsolute(abs) ? abs : path.resolve(abs)).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(p);
  if (drive) p = `/${drive[1]!.toLowerCase()}/${p.slice(3)}`;
  return `/${p.replace(/\/+$/, '')}`;
}

/** Argumentos do `claude -p` (ARCHITECTURE.md §5.1 + D-015/D-016/D-018). O prompt vai por stdin. */
export function buildClaudeArgs(
  input: Pick<BrainInput, 'model'>,
  opts: Pick<
    ClaudeCliOptions,
    'systemPromptFile' | 'mcpServerName' | 'mediaDir' | 'maxTurns' | 'isolationArgs' | 'fallbackModels'
  >,
  mcpConfigPath: string,
): string[] {
  const fallback = opts.fallbackModels?.[input.model];
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    input.model,
    ...(fallback && fallback !== input.model ? ['--fallback-model', fallback] : []),
    '--system-prompt-file',
    opts.systemPromptFile,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--tools',
    'Read',
    '--allowedTools',
    `mcp__${opts.mcpServerName}__*`,
    `Read(${permissionPath(opts.mediaDir)}/**)`,
    '--permission-mode',
    'dontAsk',
    '--add-dir',
    opts.mediaDir,
    '--max-turns',
    String(opts.maxTurns),
    '--no-session-persistence',
    ...opts.isolationArgs,
  ];
}

type CliJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
};

export function classifyError(message: string, subtype?: string): BrainErrorKind {
  if (subtype === 'error_max_turns') return 'max_turns';
  if (/usage limit|limit reached|rate limit|quota|limite de uso/i.test(message)) return 'usage_limit';
  if (/authenticat|oauth|\b401\b|log ?in|credential/i.test(message)) return 'auth';
  return 'error';
}

/** Interpreta a saída `--output-format json` (campos tratados como opcionais). */
export function parseCliOutput(stdout: string, stderr: string, durationMs: number): BrainResult {
  let json: CliJson;
  try {
    json = JSON.parse(stdout.trim()) as CliJson;
  } catch {
    const msg = (stderr || stdout).trim().slice(0, 500) || 'saída vazia do claude';
    return { ok: false, text: '', errorKind: classifyError(msg), errorMessage: msg, durationMs };
  }
  const base = {
    durationMs,
    ...(json.usage !== undefined ? { usage: json.usage } : {}),
    ...(typeof json.total_cost_usd === 'number' ? { costUsd: json.total_cost_usd } : {}),
    ...(typeof json.num_turns === 'number' ? { numTurns: json.num_turns } : {}),
  };
  const text = (json.result ?? '').trim();
  if (json.is_error || (json.subtype && json.subtype !== 'success') || !text) {
    const msg = text || json.subtype || 'resposta vazia';
    return {
      ...base,
      ok: false,
      text: '',
      errorKind: classifyError(msg, json.subtype),
      errorMessage: msg.slice(0, 500),
    };
  }
  return { ...base, ok: true, text };
}

/** Ambiente do filho: sem ANTHROPIC_API_KEY (conflita com o token OAuth; DEPLOY.md §3). */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function createClaudeCliBrain(opts: ClaudeCliOptions): Brain {
  return {
    name: 'claude-cli',
    async run(input: BrainInput): Promise<BrainResult> {
      fs.mkdirSync(opts.cwd, { recursive: true });
      // D-016: config MCP com o token num arquivo 600, apagado ao fim (fora da linha de comando)
      const mcpConfigPath = path.join(os.tmpdir(), `impetus-mcp-${randomBytes(8).toString('hex')}.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [opts.mcpServerName]: {
              type: 'http',
              url: opts.mcpUrl,
              headers: { Authorization: `Bearer ${input.turnToken}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      const args = buildClaudeArgs(input, opts, mcpConfigPath);
      const started = Date.now();
      try {
        const r = await execa(opts.bin, args, {
          cwd: opts.cwd,
          input: input.prompt,
          timeout: opts.timeoutMs,
          reject: false,
          extendEnv: false,
          env: childEnv(),
          stripFinalNewline: true,
        });
        const durationMs = Date.now() - started;
        if (r.timedOut) {
          return {
            ok: false,
            text: '',
            errorKind: 'timeout',
            errorMessage: `timeout de ${opts.timeoutMs} ms`,
            durationMs,
          };
        }
        const res = parseCliOutput(String(r.stdout ?? ''), String(r.stderr ?? ''), durationMs);
        opts.logger.info(
          {
            model: input.model,
            ok: res.ok,
            ms: durationMs,
            numTurns: res.numTurns,
            costUsd: res.costUsd,
            errorKind: res.errorKind,
          },
          'brain: claude -p',
        );
        if (!res.ok)
          opts.logger.warn(
            { stderr: String(r.stderr ?? '').slice(0, 1000), errorMessage: res.errorMessage },
            'brain: falha',
          );
        return res;
      } finally {
        fs.rmSync(mcpConfigPath, { force: true });
      }
    },
  };
}

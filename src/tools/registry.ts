import type { z } from 'zod';
import type { Db } from '../db/index.ts';
import { recordAudit, type AuditAction } from '../db/repos/audit.ts';
import type { Logger } from '../logger.ts';

export type ErrorCode = 'NOT_FOUND' | 'AMBIGUOUS' | 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL';
export type Ok<T> = { ok: true; data: T; hints?: string[] };
export type Err = { ok: false; error: { code: ErrorCode; message: string; candidates?: unknown[] } };
export type Envelope<T = unknown> = Ok<T> | Err;

export const ok = <T>(data: T, hints?: string[]): Ok<T> =>
  hints?.length ? { ok: true, data, hints } : { ok: true, data };
export const err = (code: ErrorCode, message: string, candidates?: unknown[]): Err => ({
  ok: false,
  error: candidates?.length ? { code, message, candidates } : { code, message },
});

export type ToolScope = 'read' | 'write';

/** Escopo do token do turno: `vault` enxerga só as tools do grupo `vault`; os demais nunca as enxergam. */
export type ToolScopeGrant = 'all' | 'read' | 'vault';

export const visibleInScope = (def: Pick<ToolDef, 'group'>, scope: ToolScopeGrant): boolean =>
  (def.group === 'vault') === (scope === 'vault');

export type ToolSettings = {
  cutoffHour: number;
  timeZone: string;
  openSessionHours: number;
  /** Cofre do Obsidian (Fase 9); ausente = tools `vault_*` recusam. */
  vaultDir?: string | undefined;
  /** Máximo de notas novas por turno de organização. */
  vaultMaxNotes?: number | undefined;
};

export type ToolContext = {
  db: Db;
  /** Instante "agora" do turno (UTC ISO); fixo para o turno inteiro. */
  now: string;
  turnId: number | null;
  settings: ToolSettings;
  audit: (entity: string, entityId: number, action: AuditAction, before?: unknown, after?: unknown) => void;
  /** Resultado da etapa assíncrona `prepare` (I/O de rede antes da transação; D-022). */
  prepared?: unknown;
};

/** Dependências de I/O das etapas `prepare` (injetáveis nos testes). */
export type PrepareEnv = { fetch: typeof fetch; userAgent: string };

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  scope: ToolScope;
  /** `vault` = só aparece em turnos de organização do cofre (escopo `vault`), nunca no chat. */
  group?: 'vault';
  input: S;
  handler: (ctx: ToolContext, input: z.infer<S>) => Envelope;
  /** Etapa assíncrona opcional (rede) executada fora da transação, antes do handler. */
  prepare?: (input: z.infer<S>, env: PrepareEnv) => Promise<unknown>;
};

/** Ajuda o TypeScript a inferir o tipo da entrada a partir do schema. */
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export type Registry = Map<string, ToolDef>;

export function createRegistry(defs: ToolDef[]): Registry {
  const reg: Registry = new Map();
  for (const d of defs) {
    if (reg.has(d.name)) throw new Error(`tool duplicada: ${d.name}`);
    reg.set(d.name, d);
  }
  return reg;
}

class Rollback extends Error {
  readonly envelope: Err;
  constructor(envelope: Err) {
    super('rollback');
    this.envelope = envelope;
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(entrada)'}: ${i.message}`)
    .join('; ');
}

/**
 * Executa uma tool: escopo, validação zod, transação (erro esperado desfaz as escritas da
 * chamada) e auditoria com o `turn_id` do turno. Nunca lança: devolve sempre o envelope.
 */
type CallBase = Omit<ToolContext, 'audit'> & { toolScope: ToolScopeGrant; logger?: Logger };

export function callTool(registry: Registry, name: string, rawInput: unknown, base: CallBase): Envelope {
  const def = registry.get(name);
  if (!def) return err('NOT_FOUND', `tool desconhecida: ${name}`);
  if (!visibleInScope(def, base.toolScope)) {
    return err('FORBIDDEN', `${name} não está disponível neste turno`);
  }
  if (def.scope === 'write' && base.toolScope === 'read') {
    return err('FORBIDDEN', `${name} grava dados e não está disponível neste turno (somente leitura)`);
  }
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) return err('VALIDATION', formatZodError(parsed.error));

  const ctx: ToolContext = {
    db: base.db,
    now: base.now,
    turnId: base.turnId,
    settings: base.settings,
    ...(base.prepared !== undefined ? { prepared: base.prepared } : {}),
    audit: (entity, entityId, action, before, after) =>
      recordAudit(base.db, { turnId: base.turnId, entity, entityId, action, before, after }),
  };
  try {
    return base.db.transaction(() => {
      const res = def.handler(ctx, parsed.data);
      if (!res.ok) throw new Rollback(res);
      return res;
    })();
  } catch (e) {
    if (e instanceof Rollback) return e.envelope;
    base.logger?.error({ err: e, tool: name }, 'tool falhou');
    return err('INTERNAL', 'erro interno ao executar a tool');
  }
}

/** Como `callTool`, mas executa antes a etapa `prepare` da tool (se houver), fora da transação. */
export async function callToolAsync(
  registry: Registry,
  name: string,
  rawInput: unknown,
  base: CallBase & { env?: PrepareEnv },
): Promise<Envelope> {
  const def = registry.get(name);
  if (!def?.prepare) return callTool(registry, name, rawInput, base);
  if (def.scope === 'write' && base.toolScope === 'read') return callTool(registry, name, rawInput, base);
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) return err('VALIDATION', formatZodError(parsed.error));
  let prepared: unknown;
  try {
    prepared = await def.prepare(parsed.data, base.env ?? { fetch, userAgent: 'Impetus/0.1' });
  } catch (e) {
    base.logger?.warn({ err: e, tool: name }, 'prepare falhou');
    prepared = { error: String(e) };
  }
  return callTool(registry, name, rawInput, { ...base, prepared });
}

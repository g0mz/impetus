import type { Db } from '../db/index.ts';
import { touchedEntities } from '../db/repos/audit.ts';
import { setMessagesTurn } from '../db/repos/messages.ts';
import { createTurn, finishTurn, startAttempt } from '../db/repos/turns.ts';
import { undoTurn } from '../db/undo.ts';
import { buildTurnPrompt, type QuotedEntity } from '../brain/context-builder.ts';
import { chooseModel, type ModelConfig } from '../brain/router.ts';
import type { Brain, BrainMode, BrainResult } from '../brain/types.ts';
import { t } from '../i18n/pt-br.ts';
import type { Logger } from '../logger.ts';
import type { TokenStore } from '../mcp/server.ts';
import type { ToolSettings } from '../tools/registry.ts';
import { nowUtcIso } from '../time.ts';

export type TurnRunnerDeps = {
  db: Db;
  brain: Brain;
  tokens: TokenStore;
  settings: ToolSettings;
  models: ModelConfig;
  recentTurns: number;
  retryDelayMs: number;
  logger: Logger;
  clock?: () => string;
  sleep?: (ms: number) => Promise<void>;
};

export type TurnRequest = {
  userText: string;
  images: string[];
  quoted?: QuotedEntity[];
  inboundMessageIds: number[];
  mode?: BrainMode;
  extraInstructions?: string;
};

export type TurnOutcome = {
  turnId: number;
  status: 'done' | 'failed' | 'deferred';
  /** Texto a enviar ao usuário (resposta do cérebro ou aviso de falha). */
  text: string;
  /** Entidades criadas/alteradas no turno, para `message_links`. */
  entities: { entity: string; entity_id: number }[];
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Executa um turno no cérebro (ARCHITECTURE.md §4.3): token por tentativa, 1 retry após falha
 * transitória, desfazendo antes as escritas da tentativa que falhou (D-014).
 */
export function createTurnRunner(deps: TurnRunnerDeps) {
  const clock = deps.clock ?? nowUtcIso;
  const sleep = deps.sleep ?? defaultSleep;

  return async function runTurn(req: TurnRequest): Promise<TurnOutcome> {
    const now = clock();
    const mode = req.mode ?? 'turn';
    const toolScope = mode === 'report' ? 'read' : 'all';
    const turnId = createTurn(deps.db, mode === 'report' ? 'report' : 'chat', now);
    setMessagesTurn(deps.db, req.inboundMessageIds, turnId, 'queued');
    const log = deps.logger.child({ turnId });

    const prompt = buildTurnPrompt(deps.db, {
      now,
      settings: deps.settings,
      userText: req.userText,
      images: req.images,
      recentTurns: deps.recentTurns,
      currentTurnId: turnId,
      ...(req.quoted ? { quoted: req.quoted } : {}),
      ...(req.extraInstructions ? { extraInstructions: req.extraInstructions } : {}),
    });
    const model = chooseModel({ hasImage: req.images.length > 0, mode, text: req.userText }, deps.models);
    const started = Date.now();

    let result: BrainResult | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { token, hash } = deps.tokens.issue({ turnId, toolScope, now });
      startAttempt(deps.db, turnId, { tokenHash: hash, model, promptChars: prompt.length });
      try {
        result = await deps.brain.run({
          prompt,
          images: req.images,
          mode,
          toolScope,
          turnToken: token,
          model,
        });
      } catch (e) {
        result = {
          ok: false,
          text: '',
          errorKind: 'error',
          errorMessage: String(e),
          durationMs: Date.now() - started,
        };
      } finally {
        deps.tokens.revoke(hash);
      }
      if (result.ok) break;
      const undone = undoTurn(deps.db, turnId);
      log.warn(
        { attempt, errorKind: result.errorKind, error: result.errorMessage, undone: undone.entries },
        'turno falhou',
      );
      const retryable =
        result.errorKind === 'error' || result.errorKind === 'timeout' || result.errorKind === 'max_turns';
      if (!retryable || attempt === 2) break;
      await sleep(deps.retryDelayMs);
    }
    const r = result!;
    const status = r.ok ? 'done' : r.errorKind === 'usage_limit' ? 'deferred' : 'failed';
    finishTurn(
      deps.db,
      turnId,
      {
        status,
        durationMs: Date.now() - started,
        numTurns: r.numTurns ?? null,
        costUsd: r.costUsd ?? null,
        usage: r.usage,
        error: r.ok ? null : `${r.errorKind}: ${r.errorMessage ?? ''}`.slice(0, 500),
      },
      clock(),
    );
    setMessagesTurn(deps.db, req.inboundMessageIds, turnId, r.ok ? 'processed' : 'failed');
    const text = r.ok
      ? r.text
      : status === 'deferred'
        ? t.brainDeferred
        : r.errorKind === 'unavailable'
          ? t.brainUnavailable
          : t.brainFailed;
    return { turnId, status, text, entities: r.ok ? touchedEntities(deps.db, turnId) : [] };
  };
}

export type RunTurn = ReturnType<typeof createTurnRunner>;

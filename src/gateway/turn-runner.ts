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

/** A resposta afirma que algo foi gravado? (✅, "registrado", "anotei", "salvo", "corrigido"…) */
export function claimsWrite(text: string): boolean {
  return /✅|\b(registr|anot|salv|atualiz|corrig|lanç|adicion|alter)(ad[oa]s?|ei|amos)\b/i.test(text);
}

const writesInTurn = (db: Db, turnId: number) =>
  db
    .prepare('SELECT count(*) FROM audit_log WHERE turn_id = ? AND undone_at IS NULL')
    .pluck()
    .get(turnId) as number;

/** Checagem anexada quando o modelo afirma ter gravado sem ter chamado tool de escrita (D-031). */
export function writeCheckNote(previous: string): string {
  return [
    '<system_check>',
    'Sua resposta anterior afirmava que algo foi registrado/alterado, mas NENHUMA tool de escrita foi chamada neste turno.',
    '- Se o usuário mandou dados para registrar (ou corrigir), chame as tools agora e responda com o resultado real.',
    '- Se era só um resumo de algo registrado em turnos anteriores, responda de novo deixando isso claro (sem ✅, use 📋).',
    '- Se faltam dados para registrar, pergunte só o que falta, citando o que você já entendeu.',
    `Resposta anterior: "${previous.slice(0, 1500)}"`,
    '</system_check>',
  ].join('\n');
}

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
    let r = result!;
    // Trava (D-031): resposta diz "✅ registrado" mas o turno não gravou nada → nova tentativa com aviso,
    // no modelo mais forte. Se ainda assim nada for gravado, o usuário é avisado explicitamente.
    if (r.ok && mode === 'turn' && claimsWrite(r.text) && writesInTurn(deps.db, turnId) === 0) {
      log.warn({ text: r.text.slice(0, 200) }, 'resposta afirma registro sem escrita; checando de novo');
      const fixPrompt = `${prompt}\n${writeCheckNote(r.text)}`;
      const { token, hash } = deps.tokens.issue({ turnId, toolScope, now });
      startAttempt(deps.db, turnId, {
        tokenHash: hash,
        model: deps.models.vision,
        promptChars: fixPrompt.length,
      });
      let second: BrainResult;
      try {
        second = await deps.brain.run({
          prompt: fixPrompt,
          images: req.images,
          mode,
          toolScope,
          turnToken: token,
          model: deps.models.vision,
        });
      } catch (e) {
        second = { ok: false, text: '', errorKind: 'error', errorMessage: String(e), durationMs: 0 };
      } finally {
        deps.tokens.revoke(hash);
      }
      if (second.ok) r = { ...second, costUsd: (r.costUsd ?? 0) + (second.costUsd ?? 0) };
      if (claimsWrite(r.text) && !r.text.includes('📋') && writesInTurn(deps.db, turnId) === 0)
        r = { ...r, text: `${r.text}\n\n${t.unconfirmedWrite}` };
    }
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

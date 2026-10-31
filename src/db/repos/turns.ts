import type { Db } from '../index.ts';
import { nowUtcIso } from '../../time.ts';

export type TurnKind = 'chat' | 'report' | 'command' | 'checkin' | 'organize';
export type TurnStatus = 'running' | 'done' | 'failed' | 'deferred';

export function createTurn(db: Db, kind: TurnKind, now = nowUtcIso()): number {
  return Number(
    db.prepare("INSERT INTO turns (kind, status, started_at) VALUES (?, 'running', ?)").run(kind, now)
      .lastInsertRowid,
  );
}

export function startAttempt(
  db: Db,
  turnId: number,
  fields: { tokenHash: string; model: string; promptChars: number },
) {
  db.prepare(
    'UPDATE turns SET status = ?, token_hash = ?, model = ?, prompt_chars = ?, attempts = attempts + 1 WHERE id = ?',
  ).run('running', fields.tokenHash, fields.model, fields.promptChars, turnId);
}

export function finishTurn(
  db: Db,
  turnId: number,
  f: {
    status: Exclude<TurnStatus, 'running'>;
    durationMs?: number;
    numTurns?: number | null;
    costUsd?: number | null;
    usage?: unknown;
    error?: string | null;
  },
  now = nowUtcIso(),
): void {
  db.prepare(
    `UPDATE turns SET status = @status, finished_at = @now, duration_ms = @durationMs, num_turns = @numTurns,
            cost_usd = @costUsd, usage_json = @usage, error = @error
      WHERE id = @turnId`,
  ).run({
    turnId,
    now,
    status: f.status,
    durationMs: f.durationMs ?? null,
    numTurns: f.numTurns ?? null,
    costUsd: f.costUsd ?? null,
    usage: f.usage === undefined ? null : JSON.stringify(f.usage),
    error: f.error ?? null,
  });
}

import path from 'node:path';
import type { Brain, BrainResult } from '../brain/types.ts';
import { REPO_ROOT } from '../config.ts';
import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repos/settings.ts';
import { createTurn, finishTurn, startAttempt } from '../db/repos/turns.ts';
import type { Logger } from '../logger.ts';
import type { TokenStore } from '../mcp/server.ts';
import { addDays, toLocalDate } from '../time.ts';
import { diaryEntries } from './diary.ts';

/** Instruções do coach para organizar o cofre; o `claude-cli` as usa como prompt de sistema do modo `organize`. */
export const ORGANIZE_PROMPT_FILE = path.join(REPO_ROOT, 'runtime', 'prompts', 'vault-organize.md');

/** Dias fechados organizados por execução (recupera noites perdidas sem estourar a cota). */
const MAX_DAYS_PER_RUN = 3;
/** Depois de tantas falhas seguidas no mesmo dia, desiste dele para não travar os dias seguintes. */
const MAX_FAILS_PER_DAY = 2;

export function createOrganizer(deps: {
  db: Db;
  brain: Brain;
  tokens: TokenStore;
  model: string;
  cutoffHour: number;
  timeZone: string;
  logger: Logger;
}) {
  const o = { cutoffHour: deps.cutoffHour, timeZone: deps.timeZone };

  /** true = organizou; false = dia sem mensagens (nada a fazer). Lança se o coach falhar. */
  async function organizeDay(day: string, now: string): Promise<boolean> {
    const entries = diaryEntries(deps.db, day, o);
    if (!entries.length) return false;
    // o texto do dono não pode fechar a tag <diary> nem abrir outra
    const diary = entries.join('\n').replace(/</g, '&lt;');
    const prompt = `<day>${day}</day>\n<diary>\n${diary}\n</diary>`;
    const turnId = createTurn(deps.db, 'organize', now);
    const { token, hash } = deps.tokens.issue({ turnId, toolScope: 'vault', now });
    startAttempt(deps.db, turnId, { tokenHash: hash, model: deps.model, promptChars: prompt.length });
    const started = Date.now();
    let r: BrainResult;
    try {
      r = await deps.brain.run({
        prompt,
        images: [],
        mode: 'organize',
        toolScope: 'vault',
        turnToken: token,
        model: deps.model,
      });
    } catch (e) {
      r = {
        ok: false,
        text: '',
        errorKind: 'error',
        errorMessage: String(e),
        durationMs: Date.now() - started,
      };
    } finally {
      deps.tokens.revoke(hash);
    }
    finishTurn(deps.db, turnId, {
      status: r.ok ? 'done' : 'failed',
      durationMs: Date.now() - started,
      numTurns: r.numTurns ?? null,
      costUsd: r.costUsd ?? null,
      usage: r.usage,
      error: r.ok ? null : `${r.errorKind}: ${r.errorMessage ?? ''}`.slice(0, 500),
    });
    if (!r.ok) throw new Error(`organização de ${day} falhou (${r.errorKind}): ${r.errorMessage ?? ''}`);
    deps.logger.info({ turnId, day, summary: r.text.slice(0, 200) }, 'cofre organizado');
    return true;
  }

  /** Job `vault.organize`: organiza cada dia fechado ainda não organizado (primeira vez: só ontem). */
  return async (now: string): Promise<string> => {
    const yesterday = addDays(toLocalDate(now, o.cutoffHour, o.timeZone), -1);
    const through = getSetting<string>(deps.db, 'vault.organized_through');
    const days: string[] = [];
    for (
      let d = through ? addDays(through, 1) : yesterday;
      d <= yesterday && days.length < MAX_DAYS_PER_RUN;
      d = addDays(d, 1)
    )
      days.push(d);
    if (!days.length) return 'nada a organizar';

    let done = 0;
    const skipped: string[] = [];
    for (const day of days) {
      try {
        if (await organizeDay(day, now)) done++;
      } catch (e) {
        const key = `vault.organize.fails:${day}`;
        const fails = (getSetting<number>(deps.db, key) ?? 0) + 1;
        setSetting(deps.db, key, fails);
        if (fails < MAX_FAILS_PER_DAY) throw e;
        deps.logger.warn({ day, err: e }, 'cofre: desistindo do dia depois de falhas repetidas');
        skipped.push(day);
      }
      setSetting(deps.db, 'vault.organized_through', day);
    }
    return `${done} dia(s) organizado(s)${skipped.length ? `, pulado(s): ${skipped.join(', ')}` : ''}`;
  };
}

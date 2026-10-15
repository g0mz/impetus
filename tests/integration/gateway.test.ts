import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Brain, BrainInput, BrainResult } from '../../src/brain/types.ts';
import type { Channel, InboundMessage } from '../../src/channels/types.ts';
import type { Db } from '../../src/db/index.ts';
import { createInbox } from '../../src/gateway/inbox.ts';
import { createTurnRunner } from '../../src/gateway/turn-runner.ts';
import { t } from '../../src/i18n/pt-br.ts';
import { createLogger } from '../../src/logger.ts';
import { createTokenStore, startMcpServer, type RunningMcp } from '../../src/mcp/server.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** "Roteiro" do LLM falso: recebe o prompt e chama tools de verdade pelo MCP. */
type Script = (
  input: BrainInput,
  call: Call,
  attempt: number,
) => Promise<Partial<BrainResult> & { text?: string }>;

let running: RunningMcp | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function setup(makeScript: (ex: Record<string, number>) => Script) {
  const { db, ex } = makeDb();
  const script = makeScript(ex);
  const tokens = createTokenStore();
  const registry = buildRegistry();
  const logger = createLogger('silent');
  running = await startMcpServer({ db, registry, tokens, settings: SETTINGS, logger }, 0);
  const url = running.url;
  const prompts: string[] = [];
  let attempts = 0;

  const brain: Brain = {
    name: 'fake',
    async run(input) {
      prompts.push(input.prompt);
      attempts++;
      const client = new Client({ name: 'fake-llm', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${input.turnToken}` } },
        }),
      );
      const call: Call = async (name, args) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
        return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
      };
      try {
        const res = await script(input, call, attempts);
        return { ok: true, text: res.text ?? 'ok', durationMs: 1, ...res } as BrainResult;
      } finally {
        await client.close();
      }
    },
  };

  const sent: string[] = [];
  let n = 0;
  const channel: Channel = {
    name: 'terminal',
    start: async () => {},
    send: async (text) => {
      sent.push(text);
      return { externalIds: [`out-${++n}`] };
    },
    stop: async () => {},
  };
  let clockNow = '2026-10-13T21:10:00Z';
  const runTurn = createTurnRunner({
    db,
    brain,
    tokens,
    settings: SETTINGS,
    models: { fast: 'haiku', vision: 'sonnet', report: 'sonnet' },
    recentTurns: 8,
    retryDelayMs: 0,
    logger,
    clock: () => clockNow,
    sleep: async () => {},
  });
  const handle = createInbox({
    db,
    channel,
    registry,
    settings: SETTINGS,
    runTurn,
    logger,
    clock: () => clockNow,
  });
  let inSeq = 0;
  const say = async (text: string, extra: Partial<InboundMessage> = {}) => {
    await handle({
      externalId: `in-${++inSeq}`,
      text,
      imagePath: null,
      quotedExternalId: null,
      at: clockNow,
      ...extra,
    });
    return sent.at(-1)!;
  };
  return {
    db,
    ex,
    tokens,
    sent,
    prompts,
    say,
    setNow: (iso: string) => (clockNow = iso),
    getAttempts: () => attempts,
  };
}

const count = (db: Db, sql: string) => db.prepare(sql).pluck().get() as number;

/** LLM falso que registra treinos de forma fixa (os exercícios do helper). */
function workoutScript(ex: Record<string, number>): Script {
  return async (input, call) => {
    const msg = /<user_message>\n([\s\S]*?)\n<\/user_message>/.exec(input.prompt)![1]!;
    if (msg.startsWith('meu upper B')) {
      await call('define_routine', {
        name: 'Upper B',
        exercises: [
          { exercise_id: ex.supInc, target_sets: 3, rep_min: 8, rep_max: 12 },
          { exercise_id: ex.remada, target_sets: 4, rep_min: 6, rep_max: 10 },
          { exercise_id: ex.lateral, target_sets: 3, rep_min: 12, rep_max: 15 },
        ],
      });
      return { text: 'Rotina Upper B salva.' };
    }
    if (msg.startsWith('upper B:')) {
      const r = await call('log_workout', {
        routine_name: 'upper B',
        entries: [
          { exercise_id: ex.supInc, sets: Array(3).fill({ weight_kg: 30, reps: 10 }) },
          { exercise_id: ex.remada, sets: Array(4).fill({ weight_kg: 60, reps: 8 }) },
          { exercise_id: ex.lateral, sets: Array(3).fill({ weight_kg: 10, reps: 15 }) },
        ],
      });
      return {
        text: `✅ registrado (${(r.data as { session_totals: { work_sets: number } }).session_totals.work_sets} séries)`,
      };
    }
    if (msg.startsWith('supino 32kg')) {
      const r = await call('log_workout', {
        entries: [{ exercise_id: ex.supInc, sets: [10, 9, 8].map((reps) => ({ weight_kg: 32, reps })) }],
      });
      const d = r.data as { appended_to_open_session: boolean; session_totals: { work_sets: number } };
      return {
        text: `✅ ${d.appended_to_open_session ? 'anexado' : 'nova sessão'} (${d.session_totals.work_sets} séries)`,
      };
    }
    return { text: 'ok' };
  };
}

describe('gateway ponta a ponta (cérebro falso via MCP)', () => {
  it('cenários de aceite 1–5 da Fase 1', async () => {
    const g = await setup(workoutScript);

    // 1. define a rotina
    expect(
      await g.say(
        'meu upper B é: supino inclinado halter 3x8-12, remada curvada 4x6-10, elevação lateral 3x12-15',
      ),
    ).toBe('Rotina Upper B salva.');
    // 2. treino completo: 10 séries, ligadas à resposta (message_links)
    expect(
      await g.say(
        'upper B: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg, elevação lateral 3x15 10kg',
      ),
    ).toBe('✅ registrado (10 séries)');
    expect(count(g.db, "SELECT count(*) FROM message_links WHERE entity = 'set'")).toBe(10);

    // 3. /treino mostra cargas e alvos (sem LLM)
    g.setNow('2026-10-13T21:20:00Z');
    const treino = await g.say('/treino upper B');
    expect(treino).toContain('📋 Último Upper B (13/10)');
    expect(treino).toContain('• Supino inclinado com halteres: 30kg 3×10 → alvo: 30kg 11/10/10');
    expect(treino).toContain('• Remada curvada com barra: 60kg 4×8 → alvo: 60kg 9/8/8/8');

    // 4. série a série anexa à sessão aberta
    g.setNow('2026-10-13T21:40:00Z');
    expect(await g.say('supino 32kg 10 9 8')).toBe('✅ anexado (13 séries)');
    expect(count(g.db, 'SELECT count(*) FROM workout_sessions WHERE deleted_at IS NULL')).toBe(1);

    // 5. /desfazer remove só o último turno
    expect(await g.say('/desfazer')).toBe('↩️ Desfeito: 3 séries.');
    expect(count(g.db, 'SELECT count(*) FROM sets WHERE deleted_at IS NULL')).toBe(10);
    expect(await g.say('/desfazer')).toBe('↩️ Desfeito: 10 séries, 1 sessão de treino.');
    expect(count(g.db, 'SELECT count(*) FROM routines WHERE deleted_at IS NULL')).toBe(1);

    // tokens revogados ao fim de cada turno
    expect(g.tokens.size).toBe(0);
  });

  it('o prompt do turno traz now, snapshot, sessão aberta e histórico', async () => {
    const g = await setup(workoutScript);
    await g.say('meu upper B é: …');
    await g.say('upper B: …');
    g.setNow('2026-10-13T21:30:00Z');
    await g.say('supino 32kg 10 9 8');
    const p = g.prompts.at(-1)!;
    expect(p).toContain('<now>2026-10-13T18:30:00-03:00 (terça) — dia contábil 2026-10-13</now>');
    expect(p).toMatch(/<today_snapshot>\nkcal 0\/— · proteína 0\/— g · treino: Upper B \(10 séries\)/);
    expect(p.replace(/exercise_id \d+/g, 'exercise_id N')).toContain(
      [
        '<open_session>Upper B (session_id 1) iniciado 18:10 — 3 exercícios, 10 séries',
        '- Supino inclinado com halteres (exercise_id N): 30kg 3×10 · set_id 1,2,3',
        '- Remada curvada com barra (exercise_id N): 60kg 4×8 · set_id 4,5,6,7',
        '- Elevação lateral com halteres (exercise_id N): 10kg 3×15 · set_id 8,9,10</open_session>',
      ].join('\n'),
    );
    expect(p).toContain(
      '- usuário: "upper B: …" → [registrou 1 sessão de treino, 10 séries] → coach: "✅ registrado (10 séries)"',
    );
    expect(p).toContain('<user_message>\nsupino 32kg 10 9 8\n</user_message>');
  });

  it('retry após falha não duplica registros (D-014)', async () => {
    const g = await setup((ex) => async (_input, call, attempt) => {
      await call('log_workout', {
        entries: [{ exercise_id: ex.remada, sets: [{ weight_kg: 60, reps: 8 }] }],
      });
      if (attempt === 1) return { ok: false, errorKind: 'timeout', errorMessage: 'timeout' };
      return { text: 'registrado na 2ª tentativa' };
    });
    expect(await g.say('remada 60kg 8')).toBe('registrado na 2ª tentativa');
    expect(g.getAttempts()).toBe(2);
    expect(count(g.db, 'SELECT count(*) FROM sets WHERE deleted_at IS NULL')).toBe(1);
    expect(count(g.db, 'SELECT attempts FROM turns ORDER BY id DESC LIMIT 1')).toBe(2);
  });

  it('trava D-031: "✅ registrado" sem escrita → checa de novo e registra de verdade', async () => {
    const g = await setup((ex) => async (input, call) => {
      if (!input.prompt.includes('<system_check>')) return { text: '✅ Gêmeos e extensora registrados!' };
      await call('log_workout', {
        entries: [{ exercise_id: ex.remada, sets: [{ weight_kg: 60, reps: 8 }] }],
      });
      return { text: '✅ Remada 60kg 8 registrada' };
    });
    expect(await g.say('já mandei')).toBe('✅ Remada 60kg 8 registrada');
    expect(g.getAttempts()).toBe(2);
    expect(count(g.db, 'SELECT count(*) FROM sets WHERE deleted_at IS NULL')).toBe(1);
  });

  it('trava D-031: se insistir sem gravar, o usuário é avisado; resumo com 📋 passa', async () => {
    const g = await setup(
      () => async (input) =>
        input.prompt.includes('<system_check>') ? { text: '✅ tudo registrado' } : { text: '✅ registrado' },
    );
    expect(await g.say('já mandei')).toBe(`✅ tudo registrado

${t.unconfirmedWrite}`);

    await running?.close();
    const h = await setup(
      () => async (input) =>
        input.prompt.includes('<system_check>')
          ? { text: '📋 Resumo: 18 séries registradas antes' }
          : { text: '✅ Treino registrado' },
    );
    expect(await h.say('me dá o resumo')).toBe('📋 Resumo: 18 séries registradas antes');

    await running?.close();
    const q = await setup(() => async () => ({ text: 'Quantas reps?' }));
    expect(await q.say('supino 30kg')).toBe('Quantas reps?');
    expect(q.getAttempts()).toBe(1);
  });

  it('limite de uso vira deferred, sem retry; falha dupla vira failed', async () => {
    const g = await setup(() => async () => ({
      ok: false,
      errorKind: 'usage_limit',
      errorMessage: 'usage limit reached',
    }));
    expect(await g.say('oi')).toBe(t.brainDeferred);
    expect(g.getAttempts()).toBe(1);
    expect(g.db.prepare('SELECT status FROM turns').pluck().get()).toBe('deferred');

    await running?.close();
    const h = await setup(() => async () => ({ ok: false, errorKind: 'error', errorMessage: 'boom' }));
    expect(await h.say('oi')).toBe(t.brainFailed);
    expect(h.getAttempts()).toBe(2);
    expect(h.db.prepare("SELECT status FROM messages WHERE direction = 'in'").pluck().get()).toBe('failed');
  });

  it('comandos /meta, /metas, /ultimo e /desfazer de meta', async () => {
    const g = await setup(workoutScript);
    expect(await g.say('/metas')).toBe(t.goalsEmpty);
    expect(await g.say('/meta proteina 150')).toBe('🎯 Meta de proteína: 150 g');
    expect(await g.say('/meta ritmo_peso -0,5')).toBe('🎯 Meta de ritmo de peso: -0,5 kg/semana');
    expect(await g.say('/meta proteina 5000')).toMatch(/^⚠️ .*protein_g deve ficar entre/);
    expect(await g.say('/meta xyz 1')).toMatch(/desconhecida/);
    expect(await g.say('/metas')).toBe('🎯 Metas\n• proteína: 150 g\n• ritmo de peso: -0,5 kg/semana');
    expect(await g.say('/desfazer')).toBe('↩️ Desfeito: 1 meta.');
    expect(await g.say('/metas')).toBe('🎯 Metas\n• proteína: 150 g');

    await g.say('upper B: …');
    expect(await g.say('/ultimo elevação lateral')).toBe(
      '📈 Elevação lateral com halteres — últimas sessões\n• 13/10: 10kg 3×15',
    );

    expect(await g.say('/xpto')).toBe(t.unknownCommand('xpto'));
  });

  it('mensagem duplicada (mesmo id externo) é ignorada', async () => {
    const g = await setup(() => async () => ({ text: 'ok' }));
    await g.say('/ajuda', { externalId: 'dup' });
    await g.say('/ajuda', { externalId: 'dup' });
    expect(g.sent).toHaveLength(1);
  });
});

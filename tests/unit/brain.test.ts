import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  classifyError,
  parseCliOutput,
  permissionPath,
} from '../../src/brain/claude-cli.ts';
import { chooseModel } from '../../src/brain/router.ts';
import { parseCommand } from '../../src/gateway/commands.ts';

const opts = {
  systemPromptFile: '/repo/runtime/prompts/system.md',
  mcpServerName: 'fit',
  mediaDir: '/home/impetus/impetus/data/media',
  maxTurns: 15,
  isolationArgs: ['--setting-sources', ''],
  fallbackModels: { haiku: 'sonnet' },
};

describe('buildClaudeArgs (ARCHITECTURE.md §5.1)', () => {
  const args = buildClaudeArgs({ model: 'haiku' }, opts, '/tmp/impetus-mcp-x.json');

  it('usa os flags do spec, sem prompt na linha de comando', () => {
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--model', 'haiku']);
    for (const f of ['--strict-mcp-config', '--no-session-persistence']) expect(args).toContain(f);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--system-prompt-file')).toBe(opts.systemPromptFile);
    expect(at('--mcp-config')).toBe('/tmp/impetus-mcp-x.json');
    expect(at('--tools')).toBe('Read');
    expect(at('--permission-mode')).toBe('dontAsk');
    expect(at('--max-turns')).toBe('15');
    expect(at('--fallback-model')).toBe('sonnet');
    expect(at('--setting-sources')).toBe('');
  });

  it('libera só as tools do MCP e o Read da pasta de mídia (D-015)', () => {
    const i = args.indexOf('--allowedTools');
    expect(args.slice(i + 1, i + 3)).toEqual(['mcp__fit__*', 'Read(//home/impetus/impetus/data/media/**)']);
    expect(args[i + 3]).toBe('--permission-mode'); // nada além das duas regras
    expect(args.join(' ')).not.toMatch(/Bearer/); // D-016: token fica no arquivo
  });

  it('sem fallback quando o modelo já é o de reserva', () => {
    expect(buildClaudeArgs({ model: 'sonnet' }, opts, 'x')).not.toContain('--fallback-model');
  });

  it('permissionPath converte caminhos do Windows', () => {
    expect(permissionPath('C:\\Users\\me\\impetus\\data\\media\\')).toBe('//c/Users/me/impetus/data/media');
  });
});

describe('parseCliOutput', () => {
  const ok = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: ' ✅ ok ',
    num_turns: 3,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10 },
  });

  it('sucesso', () => {
    expect(parseCliOutput(ok, '', 1200)).toEqual({
      ok: true,
      text: '✅ ok',
      numTurns: 3,
      costUsd: 0.01,
      usage: { input_tokens: 10 },
      durationMs: 1200,
    });
  });

  it('classifica erros', () => {
    const err = (result: string, subtype = 'success') =>
      parseCliOutput(JSON.stringify({ is_error: true, subtype, result }), '', 1);
    expect(err('Claude AI usage limit reached|1760000000').errorKind).toBe('usage_limit');
    expect(err('Failed to authenticate: OAuth session expired').errorKind).toBe('auth');
    expect(
      parseCliOutput(JSON.stringify({ subtype: 'error_max_turns', is_error: true }), '', 1).errorKind,
    ).toBe('max_turns');
    expect(parseCliOutput('não é json', 'boom', 1)).toMatchObject({
      ok: false,
      errorKind: 'error',
      errorMessage: 'boom',
    });
    expect(classifyError('algo deu errado')).toBe('error');
  });
});

describe('roteamento de modelo (§5.3)', () => {
  const m = { fast: 'haiku', vision: 'sonnet', report: 'sonnet-r' };
  it('imagem → visão; relatório e perguntas analíticas → report; resto → fast', () => {
    expect(chooseModel({ hasImage: true, mode: 'turn', text: 'almoço' }, m)).toBe('sonnet');
    expect(chooseModel({ hasImage: false, mode: 'report', text: '' }, m)).toBe('sonnet-r');
    expect(chooseModel({ hasImage: false, mode: 'turn', text: 'dormir pouco afeta meu treino?' }, m)).toBe(
      'sonnet-r',
    );
    expect(chooseModel({ hasImage: false, mode: 'turn', text: 'Por que estagnei no supino?' }, m)).toBe(
      'sonnet-r',
    );
    expect(chooseModel({ hasImage: false, mode: 'turn', text: 'supino 32kg 10 9 8' }, m)).toBe('haiku');
  });
});

describe('parseCommand', () => {
  it('separa nome e argumentos', () => {
    expect(parseCommand('/treino upper B')).toEqual({ name: 'treino', args: 'upper B' });
    expect(parseCommand('/AJUDA')).toEqual({ name: 'ajuda', args: '' });
    expect(parseCommand('supino 30kg')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { optionsForMode, type ClaudeCliOptions } from '../../src/brain/claude-cli.ts';
import { createLogger } from '../../src/logger.ts';

const base: ClaudeCliOptions = {
  bin: 'claude',
  cwd: '/tmp/brain',
  systemPromptFile: '/repo/runtime/prompts/system.md',
  mcpUrl: 'http://127.0.0.1:8788/mcp',
  mcpServerName: 'fit',
  mediaDir: '/tmp/media',
  maxTurns: 15,
  timeoutMs: 120_000,
  isolationArgs: [],
  logger: createLogger('silent'),
  modeOverrides: {
    organize: {
      systemPromptFile: '/repo/runtime/prompts/vault-organize.md',
      maxTurns: 30,
      timeoutMs: 300_000,
    },
  },
};

describe('optionsForMode', () => {
  it('modo organize troca prompt de sistema, max-turns e timeout', () => {
    const o = optionsForMode(base, 'organize');
    expect(o.systemPromptFile).toBe('/repo/runtime/prompts/vault-organize.md');
    expect(o.maxTurns).toBe(30);
    expect(o.timeoutMs).toBe(300_000);
  });

  it('os outros modos ficam como estão', () => {
    for (const mode of ['turn', 'report', 'checkin'] as const) expect(optionsForMode(base, mode)).toBe(base);
  });
});

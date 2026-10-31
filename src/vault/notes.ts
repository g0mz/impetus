import path from 'node:path';

/** Pastas de `impetus/` em que o coach pode ler e acrescentar. O diário é gerado e fica de fora. */
export const VAULT_FOLDERS = ['metas', 'objetivos', 'estudos', 'projetos', 'ideias'] as const;

const REL = /^([a-z0-9-]+)\/[a-z0-9-]+\.md$/;

/** `pasta/nome.md` (relativo a `impetus/`) → caminho absoluto; null se não for uma nota permitida. */
export function resolveNotePath(vaultDir: string, rel: string): string | null {
  const m = REL.exec(rel);
  if (!m || !(VAULT_FOLDERS as readonly string[]).includes(m[1]!)) return null;
  return path.join(vaultDir, 'impetus', rel);
}

/** Dono da nota: do bot só se o frontmatter tiver `origem: impetus`; qualquer outra coisa é do dono. */
export function parseNote(content: string): { owner: 'impetus' | 'dono'; title?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const owner = fm && /^origem:\s*impetus\s*$/m.test(fm) ? 'impetus' : 'dono';
  const title = fm?.match(/^titulo:\s*(.+?)\s*$/m)?.[1]?.replace(/^"(.*)"$/, '$1');
  return title ? { owner, title } : { owner };
}

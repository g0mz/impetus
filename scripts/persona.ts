// Formato das personas de evals/personas/*.md (Fase 8f).
type Moment = { at: string; checkin: boolean; instruction: string };

/** `- 2026-10-26T07:30-03:00 | instrução` ou `- 2026-10-26T07:30-03:00 checkin`. */
export function parsePersona(md: string): { name: string; who: string; moments: Moment[] } {
  const name = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? 'persona';
  const who = /##\s+Quem é\s*\n([\s\S]*?)\n##\s/.exec(md)?.[1]?.trim() ?? '';
  const moments = [...md.matchAll(/^-\s+(\S+)\s+(checkin\s*$|\|\s*(.+)$)/gm)].map((m) => {
    const at = new Date(m[1]!);
    if (Number.isNaN(at.getTime())) throw new Error(`data inválida no momento: ${m[1]}`);
    return {
      at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      checkin: !m[3],
      instruction: m[3]?.trim() ?? '',
    };
  });
  if (!moments.length) throw new Error('persona sem momentos (## Momentos)');
  return { name, who, moments };
}

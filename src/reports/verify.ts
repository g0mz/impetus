import type { ReportBrief } from './build.ts';

/** Números de um texto em pt-BR ("2.400", "80,1", "−0,5", "62,5kg") como valores absolutos. */
export function numbersInText(text: string): number[] {
  const clean = text
    .replace(/\d{1,2}[–-]\d{1,2}\/[a-zç]{3}/gi, ' ') // período "12–18/out"
    .replace(/\d{1,2}\/\d{1,2}/g, ' ') // datas "18/10"
    .replace(/^\s*\d+\.\s/gm, ' '); // numeração de lista "1. "
  return [...clean.matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g)].map((m) =>
    Number(m[0].replace(/\./g, '').replace(',', '.')),
  );
}

function briefNumbers(brief: ReportBrief): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.add(Math.abs(v));
    // strings do brief vêm do código, ex.: "62,5kg×8"
    else if (typeof v === 'string')
      for (const m of v.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(Number(m[0].replace(',', '.')));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(brief);
  out.add(brief.nutrition.days_in_period);
  return out;
}

/**
 * Números do relatório que não estão no brief (regra: o LLM só usa números do brief). Aceita a mesma
 * grandeza com 1 casa decimal (80,1 ↔ 80.1) e ignora 0–3 (contagens triviais). A linha "➡️ Foco" fica de
 * fora: é uma meta proposta ("5 dos 7 dias"), não um dado.
 */
export function numbersNotInBrief(text: string, brief: ReportBrief): string[] {
  const known = [...briefNumbers(brief)];
  const body = text
    .split('\n')
    .filter((l) => !l.startsWith('➡️'))
    .join('\n');
  return [...new Set(numbersInText(body))]
    .filter((n) => n > 3 && !known.some((k) => Math.abs(k - n) < 0.051))
    .map((n) => String(n).replace('.', ','));
}

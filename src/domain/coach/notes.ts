import { addDays, formatDayMonth } from '../../time.ts';

export const NOTE_KINDS = ['preference', 'observation', 'life_event'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export type CoachNote = { id: number; kind: NoteKind; text: string; due_local_date: string | null };

/** Orçamento do bloco <coach_notes> no prompt do turno (Fase 8b). */
export const NOTES_BUDGET_CHARS = 1500;
/** Eventos de vida entram no contexto a partir de N dias antes da data. */
export const LIFE_EVENT_LEAD_DAYS = 2;

function line(n: CoachNote, localDate: string): string {
  if (n.kind === 'preference') return `- [${n.id}] preferência: ${n.text}`;
  if (n.kind === 'observation') return `- [${n.id}] observação: ${n.text}`;
  const due = n.due_local_date!;
  const when = due <= localDate ? 'pergunte agora' : `perguntar a partir de ${formatDayMonth(due)}`;
  return `- [${n.id}] evento (${when}): ${n.text}`;
}

/**
 * Linhas do bloco <coach_notes>: todas as preferências, eventos de vida vencidos ou a até 2 dias da data,
 * e as observações mais recentes. Acima do orçamento, cortam-se primeiro as observações mais antigas,
 * depois os eventos mais distantes. Entrada em ordem de criação (mais antigas primeiro).
 */
export function notesForContext(
  notes: CoachNote[],
  localDate: string,
  budget = NOTES_BUDGET_CHARS,
): string[] {
  const horizon = addDays(localDate, LIFE_EVENT_LEAD_DAYS);
  const prefs = notes.filter((n) => n.kind === 'preference');
  const events = notes
    .filter((n) => n.kind === 'life_event' && n.due_local_date !== null && n.due_local_date <= horizon)
    .sort((a, b) => a.due_local_date!.localeCompare(b.due_local_date!));
  const obs = notes.filter((n) => n.kind === 'observation').reverse();

  const out: string[] = [];
  let used = 0;
  const take = (n: CoachNote) => {
    const l = line(n, localDate);
    if (used + l.length + 1 > budget) return false;
    out.push(l);
    used += l.length + 1;
    return true;
  };
  for (const n of prefs) take(n);
  for (const n of events) if (!take(n)) break;
  for (const n of obs) if (!take(n)) break;
  return out;
}

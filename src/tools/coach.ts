import { z } from 'zod';
import {
  getNote,
  insertNote,
  resolveNoteRow,
  softDeleteNote,
  type CoachNoteRow,
} from '../db/repos/coach-notes.ts';
import { NOTE_KINDS } from '../domain/coach/notes.ts';
import { defineTool, err, ok, type ToolContext } from './registry.ts';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD (data local)');
const noteText = z.string().trim().min(3).max(200);

/** Nota existente e ativa, ou o envelope de erro. */
function activeNote(ctx: ToolContext, id: number): CoachNoteRow | ReturnType<typeof err> {
  const n = getNote(ctx.db, id);
  if (!n || n.deleted_at) return err('NOT_FOUND', `nota ${id} não existe`);
  return n;
}

const isErr = (x: unknown): x is ReturnType<typeof err> =>
  typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

export const rememberNoteTool = defineTool({
  name: 'remember_note',
  scope: 'write',
  description:
    'Guarda uma nota sobre a pessoa (memória do coach). kind: "preference" = algo que ele PEDIU sobre como você ' +
    'deve agir ("não me fala de tendência", "pode ser mais direto"); "observation" = algo que você percebeu sobre ' +
    'ele ("responde melhor a números secos", "treina de manhã antes do trabalho"); "life_event" = algo datado da ' +
    'vida para perguntar depois (viagem, dor, prova, filho doente), com due_date = dia local a partir do qual ' +
    'perguntar. Texto curto, em terceira pessoa. Se a nota nova substitui ou contradiz outra, passe replaces_id.',
  input: z
    .object({
      kind: z.enum(NOTE_KINDS),
      text: noteText,
      due_date: localDate.optional(),
      replaces_id: z.number().int().positive().optional(),
    })
    .superRefine((v, c) => {
      if (v.kind === 'life_event' && !v.due_date)
        c.addIssue({ code: 'custom', path: ['due_date'], message: 'life_event exige due_date' });
      if (v.kind !== 'life_event' && v.due_date)
        c.addIssue({ code: 'custom', path: ['due_date'], message: 'due_date só vale para life_event' });
    }),
  handler: (ctx, { kind, text, due_date, replaces_id }) => {
    let replaced: number | undefined;
    if (replaces_id !== undefined) {
      const old = activeNote(ctx, replaces_id);
      if (isErr(old)) return old;
      softDeleteNote(ctx.db, old.id, ctx.now);
      ctx.audit('coach_note', old.id, 'delete', old);
      replaced = old.id;
    }
    const id = insertNote(ctx.db, {
      kind,
      text,
      due_local_date: due_date ?? null,
      turn_id: ctx.turnId,
      now: ctx.now,
    });
    ctx.audit('coach_note', id, 'create', undefined, getNote(ctx.db, id));
    return ok({ note_id: id, kind, ...(replaced ? { replaced_id: replaced } : {}) });
  },
});

export const resolveNoteTool = defineTool({
  name: 'resolve_note',
  scope: 'write',
  description:
    'Marca um life_event como resolvido depois que você perguntou e ele respondeu. Se a resposta vale lembrar ' +
    '("joelho melhorou", "viagem foi boa, treinou no hotel"), passe outcome: vira uma observation.',
  input: z.object({ note_id: z.number().int().positive(), outcome: noteText.optional() }),
  handler: (ctx, { note_id, outcome }) => {
    const n = activeNote(ctx, note_id);
    if (isErr(n)) return n;
    if (n.kind !== 'life_event') return err('VALIDATION', `nota ${note_id} é ${n.kind}; só life_event é resolvido`);
    if (n.resolved_at) return err('CONFLICT', `nota ${note_id} já foi resolvida`);
    resolveNoteRow(ctx.db, n.id, ctx.now);
    ctx.audit('coach_note', n.id, 'update', n, getNote(ctx.db, n.id));
    let observationId: number | undefined;
    if (outcome) {
      observationId = insertNote(ctx.db, {
        kind: 'observation',
        text: outcome,
        due_local_date: null,
        turn_id: ctx.turnId,
        now: ctx.now,
      });
      ctx.audit('coach_note', observationId, 'create', undefined, getNote(ctx.db, observationId));
    }
    return ok({ note_id: n.id, resolved: true, ...(observationId ? { observation_id: observationId } : {}) });
  },
});

export const forgetNoteTool = defineTool({
  name: 'forget_note',
  scope: 'write',
  description: 'Apaga uma nota quando ele pede para esquecer algo ou ela deixou de valer.',
  input: z.object({ note_id: z.number().int().positive() }),
  handler: (ctx, { note_id }) => {
    const n = activeNote(ctx, note_id);
    if (isErr(n)) return n;
    softDeleteNote(ctx.db, n.id, ctx.now);
    ctx.audit('coach_note', n.id, 'delete', n);
    return ok({ note_id: n.id, forgotten: true });
  },
});

export const coachTools = [rememberNoteTool, resolveNoteTool, forgetNoteTool];

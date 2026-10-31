import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeIfChanged } from '../vault/fs.ts';
import { parseNote, resolveNotePath, VAULT_FOLDERS } from '../vault/notes.ts';
import { redactSecrets } from '../vault/redact.ts';
import { defineTool, err, ok, type ToolContext } from './registry.ts';

const MAX_NOTE_BYTES = 20_000;
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD (data local)');
const FOLDERS_PT = VAULT_FOLDERS.join(', ');
const BAD_PATH = `caminho inválido: use <pasta>/<nome-em-minusculas-sem-acento>.md, com pasta em ${FOLDERS_PT}`;

const vaultDir = (ctx: ToolContext) => ctx.settings.vaultDir;
const off = () => err('FORBIDDEN', 'cofre desligado (VAULT_DIR não definido)');

export const vaultListTool = defineTool({
  name: 'vault_list',
  scope: 'read',
  group: 'vault',
  description:
    `Lista as notas do cofre em impetus/ (${FOLDERS_PT}): caminho, título e dono. owner "impetus" = nota que você ` +
    'pode acrescentar; owner "dono" = nota dele, só leitura (nunca altere).',
  input: z.object({}),
  handler: (ctx) => {
    const dir = vaultDir(ctx);
    if (!dir) return off();
    // ponytail: lê todos os arquivos a cada chamada; indexar quando o cofre passar de alguns milhares de notas
    const notes = VAULT_FOLDERS.flatMap((folder) => {
      const d = path.join(dir, 'impetus', folder);
      if (!fs.existsSync(d)) return [];
      return fs
        .readdirSync(d)
        .filter((f) => /^[a-z0-9-]+\.md$/.test(f))
        .map((f) => {
          const meta = parseNote(fs.readFileSync(path.join(d, f), 'utf8'));
          return { path: `${folder}/${f}`, title: meta.title ?? f.replace(/\.md$/, ''), owner: meta.owner };
        });
    });
    return ok({ notes: notes.slice(0, 500) });
  },
});

export const vaultReadTool = defineTool({
  name: 'vault_read',
  scope: 'read',
  group: 'vault',
  description: 'Lê uma nota do cofre (caminho relativo a impetus/, ex.: "metas/emagrecer.md").',
  input: z.object({ path: z.string() }),
  handler: (ctx, { path: rel }) => {
    const dir = vaultDir(ctx);
    if (!dir) return off();
    const file = resolveNotePath(dir, rel);
    if (!file) return err('VALIDATION', BAD_PATH);
    if (!fs.existsSync(file)) return err('NOT_FOUND', `nota ${rel} não existe`);
    const content = fs.readFileSync(file, 'utf8');
    return ok({ path: rel, owner: parseNote(content).owner, content: content.slice(0, MAX_NOTE_BYTES) });
  },
});

export const vaultUpsertTool = defineTool({
  name: 'vault_upsert',
  scope: 'write',
  group: 'vault',
  description:
    'Cria uma nota do cofre ou ACRESCENTA uma entrada datada numa nota sua (origem: impetus). Nunca reescreve nem ' +
    `edita nota do dono. path = "<pasta>/<nome-em-minusculas-sem-acento>.md" com pasta em ${FOLDERS_PT}. title = título ` +
    'legível (usado só ao criar). entry = uma linha curta, em terceira pessoa, do que aconteceu ou foi decidido. ' +
    'day = dia local (AAAA-MM-DD) do diário de onde veio; a entrada ganha o link [[diario/AAAA-MM-DD]]. Você pode ' +
    'citar outras notas com [[pasta/nome]] dentro de entry.',
  input: z.object({
    path: z.string(),
    title: z.string().trim().min(1).max(80),
    entry: z.string().trim().min(3).max(500),
    day: localDate,
  }),
  handler: (ctx, { path: rel, title, entry, day }) => {
    const dir = vaultDir(ctx);
    if (!dir) return off();
    const file = resolveNotePath(dir, rel);
    if (!file) return err('VALIDATION', BAD_PATH);

    const line = `- ${day} — ${redactSecrets(entry.replace(/\s*[\r\n]+\s*/g, ' '))} · [[diario/${day}]]`;
    if (fs.existsSync(file)) {
      const cur = fs.readFileSync(file, 'utf8');
      if (parseNote(cur).owner !== 'impetus') return err('FORBIDDEN', `${rel} é do dono (sem origem: impetus); não edite`);
      if (cur.includes(line)) return ok({ path: rel, action: 'unchanged' });
      if (Buffer.byteLength(cur) > MAX_NOTE_BYTES) return err('CONFLICT', `${rel} está cheia; crie outra nota`);
      writeIfChanged(file, `${cur.replace(/\n*$/, '\n')}${line}\n`);
      ctx.audit('vault_note', 0, 'update', undefined, { path: rel, day });
      return ok({ path: rel, action: 'updated' });
    }

    const created = ctx.db
      // por dia (e não por turno): uma tentativa que falhou no meio e foi refeita não reabre o limite
      .prepare(
        "SELECT count(*) FROM audit_log WHERE entity = 'vault_note' AND action = 'create' AND json_extract(after_json, '$.day') = ?",
      )
      .pluck()
      .get(day) as number;
    if (created >= (ctx.settings.vaultMaxNotes ?? 10))
      return err('CONFLICT', `limite de notas novas para ${day} atingido`);
    const safeTitle = title.replace(/\s*\n\s*/g, ' ').replace(/"/g, "'");
    const content = [
      '---',
      'origem: impetus',
      `titulo: "${safeTitle}"`,
      `tags: [${rel.split('/')[0]}]`,
      `criado: ${day}`,
      '---',
      `# ${safeTitle}`,
      '',
      line,
      '',
    ].join('\n');
    writeIfChanged(file, content);
    // audit_log exige entity_id inteiro: notas são arquivos, então vale 0 e o caminho vai em after_json
    ctx.audit('vault_note', 0, 'create', undefined, { path: rel, day });
    return ok({ path: rel, action: 'created' });
  },
});

export const vaultTools = [vaultListTool, vaultReadTool, vaultUpsertTool];

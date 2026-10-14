import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Channel, InboundHandler, InboundMessage } from './types.ts';
import { nowUtcIso } from '../time.ts';

export type TerminalOptions = {
  mediaDir: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Canal de desenvolvimento: REPL no terminal. Extras:
 * - `/img <caminho> [legenda]` envia uma imagem (copiada para data/media/AAAA/MM/);
 * - `/citar <n> <texto>` responde citando a resposta [n] do bot.
 * Linhas são processadas uma de cada vez (também funciona com stdin redirecionado).
 */
export function createTerminalChannel(opts: TerminalOptions): Channel {
  const out = opts.output ?? process.stdout;
  const outIds = new Map<number, string>();
  const runId = Date.now().toString(36);
  let inSeq = 0;
  let outSeq = 0;
  let rl: readline.Interface | undefined;

  const print = (s: string) => out.write(`${s}\n`);

  function saveImage(src: string): string {
    const abs = path.resolve(src.replace(/^"(.*)"$/, '$1'));
    if (!fs.existsSync(abs)) throw new Error(`arquivo não encontrado: ${abs}`);
    const ext = path.extname(abs).toLowerCase();
    if (!IMAGE_EXT.has(ext)) throw new Error(`formato não suportado: ${ext}`);
    const d = new Date();
    const dir = path.join(
      opts.mediaDir,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
    );
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${randomUUID()}${ext === '.jpeg' ? '.jpg' : ext}`);
    fs.copyFileSync(abs, dest);
    return dest;
  }

  function toInbound(line: string): InboundMessage {
    const base = {
      externalId: `term-${runId}-in-${++inSeq}`,
      at: nowUtcIso(),
      imagePath: null,
      quotedExternalId: null,
    };
    const img = /^\/img\s+("[^"]+"|\S+)\s*([\s\S]*)$/.exec(line);
    if (img) return { ...base, imagePath: saveImage(img[1]!), text: img[2]!.trim() || null };
    const cite = /^\/citar\s+(\d+)\s+([\s\S]+)$/.exec(line);
    if (cite) {
      const quoted = outIds.get(Number(cite[1]));
      if (!quoted) throw new Error(`resposta [${cite[1]}] não existe nesta sessão`);
      return { ...base, quotedExternalId: quoted, text: cite[2]!.trim() };
    }
    return { ...base, text: line };
  }

  return {
    name: 'terminal',
    async start(onMessage: InboundHandler) {
      rl = readline.createInterface({ input: opts.input ?? process.stdin, terminal: false });
      print(
        'Impetus — terminal. /ajuda para comandos, /img <arquivo> [legenda], /citar <n> <texto>. Ctrl+D sai.',
      );
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) continue;
        print(`\nvocê> ${line}`);
        let msg: InboundMessage;
        try {
          msg = toInbound(line);
        } catch (e) {
          print(`(erro) ${(e as Error).message}`);
          continue;
        }
        await onMessage(msg);
      }
    },
    async send(text: string) {
      const n = ++outSeq;
      const externalId = `term-${runId}-out-${n}`;
      outIds.set(n, externalId);
      print(`impetus [${n}]> ${text}`);
      return { externalIds: [externalId] };
    },
    async stop() {
      rl?.close();
    },
  };
}

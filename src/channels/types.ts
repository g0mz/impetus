/** Mensagem recebida, já normalizada pelo canal. */
export type InboundMessage = {
  externalId: string;
  /** Identificadores do remetente (JID e, se houver, LID/alternativo). Vazio = próprio terminal. */
  senderIds?: string[];
  /** Chat para responder (JID). */
  chatId?: string;
  text: string | null;
  /** Caminho absoluto da imagem salva em data/media (se houver). */
  imagePath: string | null;
  /** Caminho absoluto do áudio salvo (mensagem de voz), transcrito no gateway. */
  audioPath?: string | null;
  /** Duração informada pelo canal, em segundos. */
  audioSeconds?: number | null;
  /** Id externo da mensagem do bot citada (correção por citação). */
  quotedExternalId: string | null;
  at: string;
};

export type InboundHandler = (m: InboundMessage) => Promise<void>;

export type SendOptions = { to?: string };

/** Canal abstrato: nada fora de channels/ conhece Baileys, readline etc. */
export interface Channel {
  readonly name: 'terminal' | 'whatsapp' | 'telegram';
  start(onMessage: InboundHandler): Promise<void>;
  /** Envia texto (dividido em partes se longo). Devolve os ids externos de cada parte. */
  send(text: string, opts?: SendOptions): Promise<{ externalIds: string[] }>;
  sendImage?(path: string, caption: string | null, opts?: SendOptions): Promise<{ externalIds: string[] }>;
  /** Indicador de processamento (👀 / "digitando…"); opcional por canal. */
  processing?(m: InboundMessage, on: boolean): Promise<void>;
  /** Reage à mensagem do usuário (substitui o 👀). Devolve false se não conseguiu. */
  react?(m: InboundMessage, emoji: string): Promise<boolean>;
  /** Estado da conexão para o /status. */
  status?(): string;
  stop(): Promise<void>;
}

/** Emojis que podem virar reação (todos aceitos pelo Telegram, que tem lista fechada). */
export const REACTION_EMOJIS = ['👍', '🔥', '👏'] as const;

/** Resposta que é só um emoji da allowlist vira reação em vez de texto (Fase 8a). */
export function reactionOnly(text: string): string | null {
  const t = text.trim();
  return (REACTION_EMOJIS as readonly string[]).includes(t) ? t : null;
}

/** Divide texto longo em até `maxParts` partes, quebrando em linhas (SPEC/TASKS Fase 2). */
export function splitMessage(text: string, maxLen = 3500, maxParts = 3): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLen && parts.length < maxParts - 1) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > maxLen) rest = `${rest.slice(0, maxLen - 1)}…`;
  parts.push(rest);
  return parts;
}

/** Espera o canal conectar (até `timeoutMs`); canais sem status (terminal) estão sempre prontos. */
export async function waitChannelOpen(
  channel: Channel,
  timeoutMs = 30 * 60_000,
  stepMs = 30_000,
): Promise<boolean> {
  const open = () => !channel.status || channel.status().startsWith('open');
  for (let waited = 0; !open(); waited += stepMs) {
    if (waited >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}

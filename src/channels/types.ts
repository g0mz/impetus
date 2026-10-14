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
  /** Estado da conexão para o /status. */
  status?(): string;
  stop(): Promise<void>;
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

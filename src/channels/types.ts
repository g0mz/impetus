/** Mensagem recebida do dono, já normalizada pelo canal. */
export type InboundMessage = {
  externalId: string;
  text: string | null;
  /** Caminho absoluto da imagem salva em data/media (se houver). */
  imagePath: string | null;
  /** Id externo da mensagem do bot citada (correção por citação). */
  quotedExternalId: string | null;
  at: string;
};

export type InboundHandler = (m: InboundMessage) => Promise<void>;

/** Canal abstrato: nada fora de channels/ conhece Baileys, readline etc. */
export interface Channel {
  readonly name: 'terminal' | 'whatsapp' | 'telegram';
  start(onMessage: InboundHandler): Promise<void>;
  send(text: string): Promise<{ externalId: string }>;
  /** Indicador de processamento (👀 / "digitando…"); opcional por canal. */
  processing?(m: InboundMessage, on: boolean): Promise<void>;
  stop(): Promise<void>;
}

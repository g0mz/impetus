// Extração pura de dados de uma mensagem do WhatsApp (formato Baileys), testável sem conexão.

type Ctx = { stanzaId?: string | null } | null | undefined;

export type WaLike = {
  key: {
    id?: string | null;
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
    fromMe?: boolean | null;
  };
  messageTimestamp?: number | { toNumber(): number } | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null; contextInfo?: Ctx } | null;
    imageMessage?: { caption?: string | null; contextInfo?: Ctx } | null;
    ephemeralMessage?: { message?: WaLike['message'] } | null;
    viewOnceMessage?: { message?: WaLike['message'] } | null;
    audioMessage?: { seconds?: number | null; contextInfo?: Ctx } | null;
  } | null;
};

export type ParsedWa = {
  id: string;
  chatId: string;
  senderIds: string[];
  text: string | null;
  hasImage: boolean;
  hasAudio: boolean;
  audioSeconds: number | null;
  quotedId: string | null;
  at: string;
};

/** Normaliza o JID (remove sufixo de dispositivo ":12" antes do "@"). */
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, '');
}

function unwrap(m: WaLike['message']): WaLike['message'] {
  return m?.ephemeralMessage?.message ?? m?.viewOnceMessage?.message ?? m;
}

/** Devolve null para mensagens que não são do usuário (próprias, grupos, status, sem conteúdo). */
export function parseWaMessage(msg: WaLike): ParsedWa | null {
  const { key } = msg;
  if (!key.id || !key.remoteJid || key.fromMe) return null;
  if (
    key.remoteJid.endsWith('@g.us') ||
    key.remoteJid === 'status@broadcast' ||
    key.remoteJid.endsWith('@newsletter')
  ) {
    return null;
  }
  const m = unwrap(msg.message);
  if (!m) return null;
  const text = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? null;
  const ctx =
    m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.audioMessage?.contextInfo ?? null;
  const hasImage = Boolean(m.imageMessage);
  const hasAudio = Boolean(m.audioMessage);
  if (!text && !hasImage && !hasAudio) return null;
  const ts = msg.messageTimestamp;
  const secs = typeof ts === 'number' ? ts : ts ? ts.toNumber() : Date.now() / 1000;
  const senderIds = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt]
    .filter((x): x is string => Boolean(x))
    .map(normalizeJid);
  return {
    id: key.id,
    chatId: key.remoteJid,
    senderIds: [...new Set(senderIds)],
    text: text?.trim() || null,
    hasImage,
    hasAudio,
    audioSeconds: m.audioMessage?.seconds ?? null,
    quotedId: ctx?.stanzaId ?? null,
    at: new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

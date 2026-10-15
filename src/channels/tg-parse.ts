// Extração pura de dados de um update do Telegram (Bot API), testável sem rede.

type TgPhotoSize = { file_id: string; width: number; height: number; file_size?: number };

export type TgMessage = {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string };
  voice?: unknown;
  audio?: unknown;
  reply_to_message?: { message_id: number };
};

export type TgUpdate = { update_id: number; message?: TgMessage };

export type ParsedTg = {
  id: string;
  chatId: string;
  senderIds: string[];
  text: string | null;
  /** file_id da imagem (maior resolução da foto, ou documento image/*). */
  imageFileId: string | null;
  hasAudio: boolean;
  quotedId: string | null;
  at: string;
};

/** Id externo único: message_id só é único dentro do chat. */
export function tgMessageId(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Devolve null para o que não é mensagem do usuário em chat privado. */
export function parseTgUpdate(u: TgUpdate): ParsedTg | null {
  const m = u.message;
  if (!m || m.chat.type !== 'private' || !m.from || m.from.is_bot) return null;
  const text = (m.text ?? m.caption)?.trim() || null;
  let imageFileId: string | null = null;
  if (m.photo?.length) {
    imageFileId = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0]!.file_id;
  } else if (m.document?.mime_type?.startsWith('image/')) imageFileId = m.document.file_id;
  const hasAudio = Boolean(m.voice ?? m.audio);
  if (!text && !imageFileId && !hasAudio) return null;
  return {
    id: tgMessageId(m.chat.id, m.message_id),
    chatId: String(m.chat.id),
    senderIds: [`tg:${m.from.id}`],
    text,
    imageFileId,
    hasAudio,
    quotedId: m.reply_to_message ? tgMessageId(m.chat.id, m.reply_to_message.message_id) : null,
    at: new Date(m.date * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

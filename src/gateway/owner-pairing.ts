import { randomInt } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repos/settings.ts';
import type { Logger } from '../logger.ts';

const MAX_WRONG = 5;

/**
 * Allowlist do dono (DEPLOY.md §5): sem dono definido, gera um código de 6 dígitos (mostrado no log);
 * a mensagem "PAREAR <código>" grava os identificadores do remetente (JID e LID) em owner.ids.
 * Mensagens de quem não é o dono são descartadas em silêncio.
 */
export function createOwnerGuard(db: Db, logger: Logger) {
  let code: string | null = null;
  let wrong = 0;

  const ownerIds = () => getSetting<string[]>(db, 'owner.ids') ?? [];

  function newCode() {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    wrong = 0;
    logger.warn({ code }, `Sem dono pareado. Do seu número pessoal, envie ao bot: PAREAR ${code}`);
  }

  if (!ownerIds().length) newCode();

  return {
    hasOwner: () => ownerIds().length > 0,
    defaultChat: () => getSetting<string>(db, 'owner.chat_jid'),
    /** 'owner' = atender; 'paired' = acabou de parear (responder confirmação); 'ignore' = descartar. */
    check(senderIds: string[], text: string | null, chatId?: string): 'owner' | 'paired' | 'ignore' {
      const ids = ownerIds();
      if (senderIds.some((s) => ids.includes(s))) {
        // o WhatsApp migra para LID: aprende identificadores novos do mesmo remetente
        const merged = [...new Set([...ids, ...senderIds])];
        if (merged.length !== ids.length) setSetting(db, 'owner.ids', merged);
        if (chatId && getSetting<string>(db, 'owner.chat_jid') !== chatId)
          setSetting(db, 'owner.chat_jid', chatId);
        return 'owner';
      }
      const m = /^PAREAR\s+(\d{6})$/i.exec(text?.trim() ?? '');
      if (!ids.length && code && m) {
        if (m[1] === code) {
          setSetting(db, 'owner.ids', senderIds);
          if (chatId) setSetting(db, 'owner.chat_jid', chatId);
          code = null;
          logger.info({ ids: senderIds.length }, 'dono pareado');
          return 'paired';
        }
        if (++wrong >= MAX_WRONG) newCode();
      }
      logger.debug('mensagem de remetente fora da allowlist ignorada');
      return 'ignore';
    },
  };
}
export type OwnerGuard = ReturnType<typeof createOwnerGuard>;

import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger };

/** Campos que nunca podem aparecer em log (tokens, chaves, credenciais do WhatsApp). */
export const REDACT_PATHS = [
  'token',
  '*.token',
  'turnToken',
  '*.turnToken',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers["x-api-key"]',
  'apiKey',
  '*.apiKey',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'INGEST_API_KEY',
  'IMPETUS_ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'creds',
  '*.creds',
];

export function createLogger(level = 'info', destination?: pino.DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redigido]' }, base: undefined }, destination);
}

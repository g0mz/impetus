const SECRETS: RegExp[] = [
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // token de bot do Telegram
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // chave Anthropic
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\b[a-f0-9]{64}\b/g, // token/chave de 32 bytes em hex (INGEST_API_KEY etc.)
];

/** Tira tokens e chaves do texto antes de ele ir para um arquivo que sincroniza com outros aparelhos. */
export function redactSecrets(text: string): string {
  return SECRETS.reduce((s, re) => s.replace(re, '[redigido]'), text);
}

/**
 * O coach às vezes responde em Markdown "de chat" (**negrito**, ## título, [link](url)). O WhatsApp usa
 * *negrito*, _itálico_, ~riscado~; o Telegram (sem parse_mode) mostra texto puro. Blocos ``` ficam intactos.
 */
export function toChatFormat(text: string, target: 'whatsapp' | 'plain'): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((chunk, i) => (i % 2 ? chunk : convert(chunk, target)))
    .join('');
}

function convert(s: string, target: 'whatsapp' | 'plain'): string {
  const bold = target === 'whatsapp' ? '*$1*' : '$1';
  return s
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, bold) // títulos
    .replace(/\*\*(.+?)\*\*/g, bold)
    .replace(/__(.+?)__/g, bold)
    .replace(/~~(.+?)~~/g, target === 'whatsapp' ? '~$1~' : '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^(\s*)[-*]\s+(?=\S)/gm, '$1• ') // listas "- " / "* " viram "• "
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ''); // linhas horizontais
}

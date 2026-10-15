import { describe, expect, it } from 'vitest';
import { toChatFormat } from '../../src/text/chat-format.ts';

describe('toChatFormat', () => {
  it('Markdown de chat → WhatsApp', () => {
    const md = [
      '## Treino de perna',
      '• **Leg press 45°**: 50kg 8',
      '- __Hack__: 60kg 3×6',
      '---',
      'Veja [o guia](https://exemplo.com/x) ~~antigo~~',
      '*já no formato* e _itálico_',
    ].join('\n');
    expect(toChatFormat(md, 'whatsapp')).toBe(
      [
        '*Treino de perna*',
        '• *Leg press 45°*: 50kg 8',
        '• *Hack*: 60kg 3×6',
        '',
        'Veja o guia (https://exemplo.com/x) ~antigo~',
        '*já no formato* e _itálico_',
      ].join('\n'),
    );
  });

  it('texto puro (Telegram) e blocos de código intactos', () => {
    expect(toChatFormat('**oi** ```**x**```', 'plain')).toBe('oi ```**x**```');
  });

  it('não mexe em multiplicação nem em "3×10 30kg"', () => {
    expect(toChatFormat('supino 3x10 * 30kg e 2*3', 'whatsapp')).toBe('supino 3x10 * 30kg e 2*3');
  });
});

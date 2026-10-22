import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePersona } from '../../scripts/persona.ts';

describe('parsePersona (Fase 8f)', () => {
  it('lê nome, perfil e momentos com fuso; checkin sem instrução', () => {
    const p = parsePersona(
      '# Teste\n\n## Quem é\n\nAlguém que treina.\n\n## Momentos\n\n- 2026-10-26T07:30-03:00 checkin\n- 2026-10-26T20:00-03:00 | Mande o peso.\n',
    );
    expect(p).toEqual({
      name: 'Teste',
      who: 'Alguém que treina.',
      moments: [
        { at: '2026-10-26T10:30:00Z', checkin: true, instruction: '' },
        { at: '2026-10-26T23:00:00Z', checkin: false, instruction: 'Mande o peso.' },
      ],
    });
  });

  it('as personas do repositório são válidas e em ordem cronológica', () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'evals', 'personas');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const p = parsePersona(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(p.who.length, f).toBeGreaterThan(20);
      const ats = p.moments.map((m) => m.at);
      expect([...ats].sort(), f).toEqual(ats);
    }
  });

  it('data inválida ou sem momentos → erro', () => {
    expect(() => parsePersona('# X\n## Quem é\na\n## Momentos\n- ontem | oi\n')).toThrow(/inválida/);
    expect(() => parsePersona('# X\n## Quem é\na\n## Momentos\n')).toThrow(/sem momentos/);
  });
});

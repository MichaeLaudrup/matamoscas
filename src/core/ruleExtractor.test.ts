import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  EXTRACT_BODY_CHARS,
  toSuggestions,
  type EmailToExtract,
} from './ruleExtractor';

function email(id: string, over: Partial<EmailToExtract> = {}): EmailToExtract {
  return {
    id,
    from: `ofertas@${id}.com`,
    subject: `Rebajas ${id}`,
    receivedAt: Date.UTC(2026, 9, 1),
    text: 'Solo hoy',
    ...over,
  };
}

describe('buildExtractionPrompt', () => {
  it('numera los correos desde 1 y lista las reglas actuales', () => {
    const prompt = buildExtractionPrompt([email('a'), email('b')], ['las ofertas de x.com']);
    expect(prompt).toContain('- las ofertas de x.com');
    expect(prompt).toContain('<email numero="1">\nDe: ofertas@a.com');
    expect(prompt).toContain('<email numero="2">\nDe: ofertas@b.com');
  });

  it('sin reglas lo dice', () => {
    expect(buildExtractionPrompt([email('a')], [])).toContain('(ninguna)');
  });

  it('recorta los cuerpos largos', () => {
    const prompt = buildExtractionPrompt([email('a', { text: 'x'.repeat(EXTRACT_BODY_CHARS + 500) })], []);
    expect(prompt).toContain(`${'x'.repeat(EXTRACT_BODY_CHARS)}…`);
    expect(prompt).not.toContain('x'.repeat(EXTRACT_BODY_CHARS + 1));
  });
});

describe('toSuggestions', () => {
  const emails = [email('a'), email('b'), email('c')];
  const rule = (over: object = {}) => ({
    text: 'las ofertas de a.com',
    kind: 'filter' as const,
    action: 'trash' as const,
    why: ' Mismo dominio ',
    emails: [1],
    ...over,
  });

  it('traduce los números de correo a ids', () => {
    const [s] = toSuggestions({ rules: [rule({ emails: [1, 3] })] }, emails);
    expect(s).toEqual({
      text: 'las ofertas de a.com',
      kind: 'filter',
      action: 'trash',
      why: 'Mismo dominio',
      emailIds: ['a', 'c'],
    });
  });

  it('ignora números que no existen o repetidos', () => {
    const [s] = toSuggestions({ rules: [rule({ emails: [0, 2, 2, 9, 1.5] })] }, emails);
    expect(s?.emailIds).toEqual(['b']);
  });

  it('descarta propuestas vacías o repetidas', () => {
    const out = toSuggestions(
      { rules: [rule(), rule({ text: '  ' }), rule({ text: 'LAS OFERTAS DE A.COM ' })] },
      emails,
    );
    expect(out).toHaveLength(1);
  });

  it('se queda con 6 como mucho', () => {
    const many = Array.from({ length: 9 }, (_, i) => rule({ text: `regla ${i}` }));
    expect(toSuggestions({ rules: many }, emails)).toHaveLength(6);
  });
});

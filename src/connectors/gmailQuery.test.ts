import { describe, it, expect } from 'vitest';
import { toGmailQuery } from './gmailQuery';

describe('toGmailQuery', () => {
  it('un filtro vacío no se puede buscar', () => {
    expect(toGmailQuery({})).toBeNull();
    expect(toGmailQuery({ subjectMatches: ['^oferta'] })).toBeNull();
  });

  it('une remitentes con O y el resto con Y', () => {
    expect(
      toGmailQuery({
        fromDomains: ['zalando.es', '@shein.com'],
        fromAddresses: ['news@tienda.com'],
        olderThanDays: 30,
        unread: true,
      }),
    ).toBe('{from:@zalando.es from:@shein.com from:news@tienda.com} older_than:30d is:unread');
  });

  it('pone comillas a los textos con espacios y quita las comillas del usuario', () => {
    expect(toGmailQuery({ subjectContains: ['black friday', 'rebajas'] })).toBe(
      '{subject:"black friday" subject:rebajas}',
    );
    expect(toGmailQuery({ bodyContains: ['date de "baja"'] })).toBe('"date de baja"');
  });

  it('traduce las etiquetas de sistema y deja las del usuario como label:', () => {
    expect(toGmailQuery({ hasLabels: ['\\Inbox'] })).toBe('in:inbox');
    expect(toGmailQuery({ hasLabels: ['Promociones viejas', '\\Starred'] })).toBe(
      '{label:"Promociones viejas" is:starred}',
    );
  });

  it('distingue leídos de no leídos', () => {
    expect(toGmailQuery({ fromDomains: ['a.com'], unread: false })).toBe('from:@a.com is:read');
  });
});

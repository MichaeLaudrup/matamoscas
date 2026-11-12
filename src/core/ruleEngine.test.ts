import { describe, it, expect } from 'vitest';
import { matchesFilter, evaluateRules } from './ruleEngine';
import type { Filter, Message, Rule } from './types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // epoch fijo para tests deterministas

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    account: 'gmail',
    from: 'ofertas@tienda.com',
    fromName: 'Tienda',
    subject: 'Grandes ofertas de verano',
    receivedAt: NOW - 2 * DAY,
    unread: true,
    labels: ['INBOX'],
    snippet: 'Aprovecha el 50% de descuento',
    ...over,
  };
}

describe('matchesFilter', () => {
  it('filtro vacío no coincide (evita borrados accidentales masivos)', () => {
    expect(matchesFilter(msg(), {}, NOW)).toBe(false);
  });

  it('coincide por dominio del remitente', () => {
    const f: Filter = { fromDomains: ['tienda.com'] };
    expect(matchesFilter(msg(), f, NOW)).toBe(true);
    expect(matchesFilter(msg({ from: 'jefe@trabajo.com' }), f, NOW)).toBe(false);
  });

  it('el dominio no distingue mayúsculas', () => {
    expect(matchesFilter(msg({ from: 'X@Tienda.COM' }), { fromDomains: ['tienda.com'] }, NOW)).toBe(true);
  });

  it('coincide por dirección exacta', () => {
    const f: Filter = { fromAddresses: ['ofertas@tienda.com'] };
    expect(matchesFilter(msg(), f, NOW)).toBe(true);
    expect(matchesFilter(msg({ from: 'otro@tienda.com' }), f, NOW)).toBe(false);
  });

  it('coincide por subcadena en asunto (case-insensitive)', () => {
    expect(matchesFilter(msg(), { subjectContains: ['OFERTAS'] }, NOW)).toBe(true);
    expect(matchesFilter(msg(), { subjectContains: ['factura'] }, NOW)).toBe(false);
  });

  it('coincide por regex en asunto', () => {
    expect(matchesFilter(msg(), { subjectMatches: ['^Grandes'] }, NOW)).toBe(true);
    expect(matchesFilter(msg(), { subjectMatches: ['\\d{4}'] }, NOW)).toBe(false);
  });

  it('regex inválida no lanza y no coincide', () => {
    expect(matchesFilter(msg(), { subjectMatches: ['('] }, NOW)).toBe(false);
  });

  it('coincide por antigüedad', () => {
    expect(matchesFilter(msg({ receivedAt: NOW - 40 * DAY }), { olderThanDays: 30 }, NOW)).toBe(true);
    expect(matchesFilter(msg({ receivedAt: NOW - 10 * DAY }), { olderThanDays: 30 }, NOW)).toBe(false);
  });

  it('coincide por estado de lectura', () => {
    expect(matchesFilter(msg({ unread: true }), { unread: true }, NOW)).toBe(true);
    expect(matchesFilter(msg({ unread: false }), { unread: true }, NOW)).toBe(false);
  });

  it('coincide por etiqueta', () => {
    expect(matchesFilter(msg({ labels: ['INBOX', 'PROMO'] }), { hasLabels: ['PROMO'] }, NOW)).toBe(true);
    expect(matchesFilter(msg(), { hasLabels: ['PROMO'] }, NOW)).toBe(false);
  });

  it('coincide por cuerpo/snippet', () => {
    expect(matchesFilter(msg(), { bodyContains: ['descuento'] }, NOW)).toBe(true);
  });

  it('combina campos con AND', () => {
    const f: Filter = { fromDomains: ['tienda.com'], subjectContains: ['ofertas'], unread: true };
    expect(matchesFilter(msg(), f, NOW)).toBe(true);
    expect(matchesFilter(msg({ unread: false }), f, NOW)).toBe(false);
  });
});

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    text: 'borra ofertas de tiendas',
    accounts: [],
    action: 'trash',
    enabled: true,
    filter: { fromDomains: ['tienda.com'] },
    compileStatus: 'compiled',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('evaluateRules', () => {
  it('devuelve una coincidencia por regla activa y compilada', () => {
    const matches = evaluateRules([msg()], [rule()], NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.ruleId).toBe('r1');
    expect(matches[0]!.action).toBe('trash');
  });

  it('ignora reglas desactivadas', () => {
    expect(evaluateRules([msg()], [rule({ enabled: false })], NOW)).toHaveLength(0);
  });

  it('ignora reglas no compiladas o con error', () => {
    expect(evaluateRules([msg()], [rule({ filter: null, compileStatus: 'uncompiled' })], NOW)).toHaveLength(0);
    expect(evaluateRules([msg()], [rule({ compileStatus: 'error' })], NOW)).toHaveLength(0);
  });

  it('respeta el filtro de cuentas de la regla', () => {
    expect(evaluateRules([msg({ account: 'gmail' })], [rule({ accounts: ['proton'] })], NOW)).toHaveLength(0);
    expect(evaluateRules([msg({ account: 'gmail' })], [rule({ accounts: ['gmail'] })], NOW)).toHaveLength(1);
  });

  it('un correo que coincide con varias reglas produce una sola coincidencia (primera gana)', () => {
    const r1 = rule({ id: 'r1', action: 'trash' });
    const r2 = rule({ id: 'r2', action: 'delete' });
    const matches = evaluateRules([msg()], [r1, r2], NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.ruleId).toBe('r1');
  });

  it('propaga labelName en acciones de etiqueta', () => {
    const matches = evaluateRules([msg()], [rule({ action: 'label', labelName: 'Basura' })], NOW);
    expect(matches[0]!.labelName).toBe('Basura');
  });
});

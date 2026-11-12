/**
 * Motor de reglas determinista. No hace red ni I/O: recibe correos ya cargados
 * y reglas ya compiladas, y decide qué acciones aplicar. Esto lo hace trivial
 * de testear y auditar, que es crítico porque algunas acciones son destructivas.
 */
import type { Filter, Match, Message, Rule } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Extrae el dominio (en minúsculas) de una dirección de correo. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/**
 * ¿El correo cumple el filtro? Semántica AND entre campos presentes; dentro de
 * cada campo (que es una lista) la semántica es OR.
 *
 * Un filtro vacío devuelve `false` a propósito: una regla sin criterios no debe
 * arrasar con toda la bandeja.
 *
 * @param now epoch ms tomado como "ahora" (inyectado para tests deterministas).
 */
export function matchesFilter(message: Message, filter: Filter, now: number): boolean {
  const criteria: boolean[] = [];

  if (filter.fromDomains && filter.fromDomains.length > 0) {
    const dom = domainOf(message.from);
    criteria.push(filter.fromDomains.some((d) => dom === d.toLowerCase()));
  }

  if (filter.fromAddresses && filter.fromAddresses.length > 0) {
    const addr = message.from.toLowerCase();
    criteria.push(filter.fromAddresses.some((a) => addr === a.toLowerCase()));
  }

  if (filter.subjectContains && filter.subjectContains.length > 0) {
    const subj = message.subject.toLowerCase();
    criteria.push(filter.subjectContains.some((s) => subj.includes(s.toLowerCase())));
  }

  if (filter.subjectMatches && filter.subjectMatches.length > 0) {
    criteria.push(filter.subjectMatches.some((pattern) => safeRegexTest(pattern, message.subject)));
  }

  if (typeof filter.olderThanDays === 'number') {
    const ageDays = (now - message.receivedAt) / DAY_MS;
    criteria.push(ageDays >= filter.olderThanDays);
  }

  if (typeof filter.unread === 'boolean') {
    criteria.push(message.unread === filter.unread);
  }

  if (filter.hasLabels && filter.hasLabels.length > 0) {
    criteria.push(filter.hasLabels.some((l) => message.labels.includes(l)));
  }

  if (filter.bodyContains && filter.bodyContains.length > 0) {
    const body = (message.snippet ?? '').toLowerCase();
    criteria.push(filter.bodyContains.some((s) => body.includes(s.toLowerCase())));
  }

  // Filtro vacío => sin criterios => no coincide.
  if (criteria.length === 0) return false;
  return criteria.every(Boolean);
}

/** Test de regex tolerante a patrones inválidos (no lanza, devuelve false). */
function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
}

/** ¿La regla es aplicable (activa y compilada con filtro)? */
function isApplicable(rule: Rule): rule is Rule & { filter: Filter } {
  return rule.enabled && rule.compileStatus === 'compiled' && rule.filter !== null;
}

/**
 * Evalúa todos los correos contra todas las reglas. Devuelve, para cada correo,
 * a lo sumo UNA coincidencia: gana la primera regla (en el orden dado) que
 * aplique. Así una acción destructiva no compite con una reversible sobre el
 * mismo correo de forma impredecible; el orden de las reglas es la prioridad.
 */
export function evaluateRules(messages: Message[], rules: Rule[], now: number): Match[] {
  const applicable = rules.filter(isApplicable);
  const matches: Match[] = [];

  for (const message of messages) {
    for (const rule of applicable) {
      if (rule.accounts.length > 0 && !rule.accounts.includes(message.account)) continue;
      if (!matchesFilter(message, rule.filter, now)) continue;

      matches.push({
        message,
        ruleId: rule.id,
        action: rule.action,
        ...(rule.labelName ? { labelName: rule.labelName } : {}),
      });
      break; // primera regla que aplica gana
    }
  }

  return matches;
}

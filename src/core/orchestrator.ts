/**
 * Orquestador de la limpieza: junta conectores + reglas + motor.
 *
 * Separa explícitamente "previsualizar" (qué se haría, sin tocar nada) de
 * "ejecutar" (aplicar acciones). Esto es lo que hace segura una app con
 * acciones destructivas: siempre se puede ver antes de borrar.
 */
import type { MailConnector } from '../connectors/types';
import { evaluateRules } from './ruleEngine';
import type { AccountKind, ActionKind, Match, Rule } from './types';

/** Resultado de aplicar una acción a un correo concreto. */
export interface ActionOutcome {
  account: AccountKind;
  messageId: string;
  ruleId: string;
  action: ActionKind;
  from: string;
  subject: string;
  ok: boolean;
  error?: string;
  /** epoch ms en que se aplicó. */
  at: number;
}

/**
 * Previsualiza la limpieza: trae los correos de cada conector y evalúa las
 * reglas. No aplica ninguna acción.
 */
export async function previewRun(
  connectors: MailConnector[],
  rules: Rule[],
  now: number,
  opts: { limit?: number } = {},
): Promise<Match[]> {
  const all: Match[] = [];
  for (const connector of connectors) {
    const messages = await connector.listMessages({ ...(opts.limit ? { limit: opts.limit } : {}) });
    all.push(...evaluateRules(messages, rules, now));
  }
  return all;
}

/**
 * Ejecuta las acciones de una lista de coincidencias. Cada acción se intenta de
 * forma aislada: un fallo en un correo no detiene el resto. Devuelve el
 * resultado por correo para registrarlo en auditoría.
 */
export async function executeMatches(
  connectors: MailConnector[],
  matches: Match[],
  now: number,
): Promise<ActionOutcome[]> {
  const byAccount = new Map<AccountKind, MailConnector>();
  for (const c of connectors) byAccount.set(c.account, c);

  const outcomes: ActionOutcome[] = [];
  for (const match of matches) {
    const connector = byAccount.get(match.message.account);
    const base = {
      account: match.message.account,
      messageId: match.message.id,
      ruleId: match.ruleId,
      action: match.action,
      from: match.message.from,
      subject: match.message.subject,
      at: now,
    };

    if (!connector) {
      outcomes.push({ ...base, ok: false, error: `Sin conector para la cuenta ${match.message.account}.` });
      continue;
    }

    try {
      await connector.apply(match.action, match.message.id, match.labelName);
      outcomes.push({ ...base, ok: true });
    } catch (err) {
      outcomes.push({ ...base, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

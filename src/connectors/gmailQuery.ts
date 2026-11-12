/**
 * Traduce un `Filter` a la sintaxis de búsqueda de Gmail (la misma de la caja
 * de búsqueda web), que IMAP acepta con la extensión X-GM-RAW. Así Gmail busca
 * en todo el buzón en sus servidores, sin descargar los correos.
 *
 * `subjectMatches` (expresiones regulares) no tiene equivalente en Gmail: se
 * omite aquí y se comprueba después sobre los correos descargados.
 */
import type { Filter } from '../core/types';

/** Etiquetas de sistema de Gmail tal como llegan por IMAP → operador de búsqueda. */
const SYSTEM_LABELS: Record<string, string> = {
  '\\inbox': 'in:inbox',
  '\\important': 'is:important',
  '\\starred': 'is:starred',
  '\\sent': 'in:sent',
  '\\draft': 'in:drafts',
};

/** Consulta de Gmail para `filter`, o `null` si no hay nada traducible. */
export function toGmailQuery(filter: Filter): string | null {
  const parts: string[] = [];
  const domains = clean(filter.fromDomains).map((d) => d.replace(/^@/, '')).filter(Boolean);
  const anyOf = (terms: string[]) => (terms.length === 1 ? terms[0]! : `{${terms.join(' ')}}`);

  const senders = [
    ...domains.map((d) => `from:${quote(`@${d}`)}`),
    ...clean(filter.fromAddresses).map((a) => `from:${quote(a)}`),
  ];
  if (senders.length > 0) parts.push(anyOf(senders));

  const subjects = clean(filter.subjectContains).map((s) => `subject:${quote(s)}`);
  if (subjects.length > 0) parts.push(anyOf(subjects));

  const labels = clean(filter.hasLabels).map(
    (l) => SYSTEM_LABELS[l.toLowerCase()] ?? `label:${quote(l)}`,
  );
  if (labels.length > 0) parts.push(anyOf(labels));

  const body = clean(filter.bodyContains).map(quote);
  if (body.length > 0) parts.push(anyOf(body));

  if (filter.olderThanDays !== undefined && filter.olderThanDays > 0) {
    parts.push(`older_than:${Math.floor(filter.olderThanDays)}d`);
  }
  if (filter.unread !== undefined) parts.push(filter.unread ? 'is:unread' : 'is:read');

  return parts.length > 0 ? parts.join(' ') : null;
}

function clean(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s.replace(/"/g, '').trim()).filter(Boolean);
}

/** Entre comillas si lleva espacios u otros caracteres que Gmail interpretaría. */
function quote(term: string): string {
  return /^[\p{L}\p{N}@._+-]+$/u.test(term) ? term : `"${term}"`;
}

/**
 * Conector de Gmail por IMAP (imap.gmail.com:993, TLS) con contraseña de
 * aplicación. Lista carpetas y correos y, cuando el usuario lo confirma, aplica
 * la acción de una regla por lotes (y la deshace).
 *
 * Cada operación abre su propia conexión y la cierra al terminar. Es algo más
 * lento que mantener una sesión abierta, pero no deja conexiones colgadas si
 * la red se cae o el usuario cierra la ventana.
 */
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import { simpleParser } from 'mailparser';
import { matchesFilter } from '../core/ruleEngine';
import type { ActionKind, Filter, Message } from '../core/types';
import type { Folder, FolderKind, MessagePage, RulePreview } from '../shared/ipc';
import { toGmailQuery } from './gmailQuery';
import type { MailConnector } from './types';

export interface GmailCredentials {
  email: string;
  /** Contraseña de aplicación de 16 letras (se aceptan con o sin espacios). */
  appPassword: string;
}

/** Lo mínimo que usamos de ImapFlow; permite sustituirlo en las pruebas. */
export type ImapClient = Pick<
  ImapFlow,
  | 'connect'
  | 'logout'
  | 'list'
  | 'getMailboxLock'
  | 'fetchAll'
  | 'search'
  | 'mailbox'
  | 'messageMove'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageDelete'
  | 'mailboxCreate'
>;
export type ImapClientFactory = (creds: GmailCredentials) => ImapClient;

export const PAGE_SIZE = 50;
/** Bytes del principio de cada mensaje que descargamos para sacar el extracto. */
const SNIPPET_SOURCE_BYTES = 16 * 1024;
const SNIPPET_LENGTH = 140;
/** Máximo de coincidencias que descargamos para comprobar patrones de asunto. */
const REGEX_SCAN_LIMIT = 2000;
/** Correos por comando IMAP: Gmail corta las líneas de comando muy largas. */
const BATCH_SIZE = 500;
/** Correos por mover o etiquetar de una vez: Gmail tarda varios minutos con 500, y así la barra avanza. */
const ACTION_BATCH_SIZE = 50;
/** X-GM-MSGID que buscamos de una vez, unidos con OR. */
const ID_SEARCH_CHUNK = 50;
/** Lo que nunca tocamos, aunque cumpla la regla. */
const PROTECTED_QUERY = '-is:starred -is:important';
/** Correos de Recibidos que lee una regla con IA en cada pasada. */
export const AI_SCAN_LIMIT = 200;
/** Bytes del mensaje que se descargan para leerlo entero (adjuntos aparte). */
const BODY_SOURCE_BYTES = 128 * 1024;
/** Caracteres de cuerpo que se guardan para el modelo. */
const BODY_TEXT_LENGTH = 8000;

/** Un correo que una acción va a tocar, tal como estaba al buscarlo. */
export interface Target {
  /** UID en «Todos los correos». */
  uid: number;
  /** X-GM-MSGID: no cambia aunque el correo cambie de carpeta. */
  emailId: string;
  labels: string[];
}

/** Resultado de buscar qué tocaría una acción, antes de confirmar. */
export interface Collected {
  query: string;
  /** Coincidencias que se podrían tocar (puede ser más que `targets`). */
  total: number;
  approximate: boolean;
  /** UIDVALIDITY de «Todos»: si cambia, los UID ya no valen. */
  uidValidity: string;
  /** Del más antiguo al más nuevo, con el tope ya aplicado. */
  targets: Target[];
}

/** Lo necesario para deshacer una acción. Se guarda en disco tal cual. */
export interface UndoData {
  action: Exclude<ActionKind, 'delete'>;
  labelName?: string;
  messages: Array<{ emailId: string; labels: string[] }>;
}

export interface Executed {
  done: number;
  /** null para «Borrar para siempre» o si no se tocó nada. */
  undo: UndoData | null;
  /** Si Gmail falló a mitad: lo hecho hasta entonces sigue en `done`. */
  error?: string;
}

export type ProgressFn = (done: number, total: number) => void;

/** Correos recientes de Recibidos, con su texto, para que los lea el modelo. */
export interface InboxScan {
  query: string;
  uidValidity: string;
  /** Del más nuevo al más antiguo. */
  items: Array<{ target: Target; message: Message; text: string }>;
}

const FOLDERS: ReadonlyArray<{ kind: FolderKind; flag: string; name: string }> = [
  { kind: 'inbox', flag: '\\Inbox', name: 'Recibidos' },
  { kind: 'sent', flag: '\\Sent', name: 'Enviados' },
  { kind: 'junk', flag: '\\Junk', name: 'Spam' },
  { kind: 'trash', flag: '\\Trash', name: 'Papelera' },
  { kind: 'all', flag: '\\All', name: 'Todos los correos' },
];

export const defaultImapClientFactory: ImapClientFactory = (creds) =>
  new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.email, pass: creds.appPassword.replace(/\s+/g, '') },
    logger: false,
  });

export class GmailImapConnector implements MailConnector {
  readonly account = 'gmail' as const;

  constructor(
    private readonly creds: GmailCredentials,
    private readonly createClient: ImapClientFactory = defaultImapClientFactory,
  ) {}

  async verify(): Promise<void> {
    await this.withClient(async () => undefined);
  }

  async listFolders(): Promise<Folder[]> {
    return this.withClient(async (client) => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true } });
      return pickFolders(list);
    });
  }

  /** Página `page` de la carpeta `path`, del correo más nuevo al más antiguo. */
  async listPage(path: string, page: number): Promise<MessagePage> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const total = client.mailbox ? client.mailbox.exists : 0;
        const range = pageRange(total, page);
        if (!range) return { messages: [], total, page, pageSize: PAGE_SIZE, hasMore: false };

        const fetched = await client.fetchAll(range, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          labels: true,
          emailId: true,
          source: { maxLength: SNIPPET_SOURCE_BYTES },
        });
        const messages = await Promise.all(
          fetched.map(async (m) => toMessage(m, await snippetFrom(m.source))),
        );
        messages.sort((a, b) => b.receivedAt - a.receivedAt);
        return {
          messages,
          total,
          page,
          pageSize: PAGE_SIZE,
          hasMore: (page + 1) * PAGE_SIZE < total,
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Busca en «Todos los correos» (sin Spam ni Papelera) los correos que cumplen
   * `filter`, en solo lectura. Devuelve cuántos hay y los `limit` más recientes.
   */
  async search(filter: Filter, limit = PAGE_SIZE): Promise<RulePreview> {
    const query = requireQuery(filter);
    const regexes = subjectRegexes(filter);

    return this.withClient(async (client) => {
      const all = pickFolders(await client.list()).find((f) => f.kind === 'all');
      const lock = await client.getMailboxLock(all?.path ?? 'INBOX', { readOnly: true });
      try {
        const uids = ((await client.search({ gmraw: query }, { uid: true })) || []).sort((a, b) => a - b);
        const wanted = regexes ? uids.slice(-REGEX_SCAN_LIMIT) : uids.slice(-limit);
        if (wanted.length === 0) return { query, total: 0, approximate: false, messages: [] };

        const fetched = await client.fetchAll(
          wanted.join(','),
          { uid: true, envelope: true, flags: true, internalDate: true, labels: true, emailId: true },
          { uid: true },
        );
        const now = Date.now();
        let messages = fetched.map((m) => toMessage(m));
        if (regexes) messages = messages.filter((m) => matchesFilter(m, regexes, now));
        messages.sort((a, b) => b.receivedAt - a.receivedAt);
        return {
          query,
          total: regexes ? messages.length : uids.length,
          approximate: regexes !== null && uids.length > REGEX_SCAN_LIMIT,
          messages: messages.slice(0, limit),
        };
      } finally {
        lock.release();
      }
    });
  }

  async listMessages(opts?: { limit?: number }): Promise<Message[]> {
    const { messages } = await this.listPage('INBOX', 0);
    return opts?.limit === undefined ? messages : messages.slice(0, opts.limit);
  }

  /** En Gmail las acciones van por lotes: `collect` y luego `execute`. */
  async apply(_action: ActionKind, _messageId: string): Promise<void> {
    throw new Error('En Gmail las reglas se aplican por lotes, no correo a correo.');
  }

  /**
   * Busca, en solo lectura, los correos que `action` tocaría: sin destacados ni
   * importantes, solo los que la acción cambia de verdad y como mucho `max`
   * (los más recientes).
   */
  async collect(
    filter: Filter,
    action: ActionKind,
    labelName: string | undefined,
    max: number,
  ): Promise<Collected> {
    const query = [requireQuery(filter), PROTECTED_QUERY, action === 'archive' ? 'in:inbox' : '']
      .filter(Boolean)
      .join(' ');
    const regexes = subjectRegexes(filter);

    return this.withClient(async (client) => {
      const paths = folderPaths(await client.list());
      const lock = await client.getMailboxLock(paths.all, { readOnly: true });
      try {
        const uidValidity = String(client.mailbox ? client.mailbox.uidValidity : '');
        const uids = ((await client.search({ gmraw: query }, { uid: true })) || []).sort((a, b) => a - b);
        const scan = uids.slice(-(regexes ? REGEX_SCAN_LIMIT : max));
        if (scan.length === 0) return { query, total: 0, approximate: false, uidValidity, targets: [] };

        const fetched = await client.fetchAll(
          scan.join(','),
          { uid: true, emailId: true, flags: true, labels: true, envelope: regexes !== null },
          { uid: true },
        );
        const now = Date.now();
        const eligible = fetched
          .filter(
            (m) =>
              m.emailId &&
              !isProtected(m) &&
              changes(action, m, labelName) &&
              (!regexes || matchesFilter(toMessage(m), regexes, now)),
          )
          .sort((a, b) => a.uid - b.uid);
        // Sin patrones, lo que no hemos descargado cumple la regla igual.
        const unseen = uids.length - scan.length;
        return {
          query,
          total: eligible.length + (regexes ? 0 : unseen),
          approximate: unseen > 0 && (regexes !== null || action === 'label'),
          uidValidity,
          targets: eligible.slice(-max).map((m) => ({
            uid: m.uid,
            emailId: m.emailId as string,
            labels: [...(m.labels ?? [])],
          })),
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Los últimos `limit` correos de Recibidos que la acción cambiaría, con el
   * cuerpo en texto. Nunca trae destacados ni importantes.
   */
  async recentInbox(
    action: ActionKind,
    labelName: string | undefined,
    limit = AI_SCAN_LIMIT,
  ): Promise<InboxScan> {
    const query = `in:inbox ${PROTECTED_QUERY}`;
    return this.withClient(async (client) => {
      const paths = folderPaths(await client.list());
      const lock = await client.getMailboxLock(paths.all, { readOnly: true });
      try {
        const uidValidity = String(client.mailbox ? client.mailbox.uidValidity : '');
        const uids = ((await client.search({ gmraw: query }, { uid: true })) || []).sort((a, b) => a - b);
        const scan = uids.slice(-limit);
        if (scan.length === 0) return { query, uidValidity, items: [] };

        const fetched = await client.fetchAll(
          scan.join(','),
          {
            uid: true,
            emailId: true,
            flags: true,
            labels: true,
            envelope: true,
            internalDate: true,
            source: { maxLength: BODY_SOURCE_BYTES },
          },
          { uid: true },
        );
        const eligible = fetched
          .filter((m) => m.emailId && !isProtected(m) && changes(action, m, labelName))
          .sort((a, b) => b.uid - a.uid);
        const items = [];
        for (const m of eligible) {
          const text = await bodyText(m.source, BODY_TEXT_LENGTH);
          items.push({
            target: { uid: m.uid, emailId: m.emailId as string, labels: [...(m.labels ?? [])] },
            message: toMessage(m, text ? clip(text, SNIPPET_LENGTH) : undefined),
            text: text ?? '',
          });
        }
        return { query, uidValidity, items };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Lee, en solo lectura, los correos `emailIds` de la carpeta `path` con el
   * cuerpo en texto (con sus saltos de línea). Devuelve los que sigan ahí, en
   * el orden pedido.
   */
  async readMessages(path: string, emailIds: string[]): Promise<Array<{ message: Message; text: string }>> {
    if (emailIds.length === 0) return [];
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const uids = await uidsByEmailId(client, emailIds);
        if (uids.size === 0) return [];
        const fetched = await client.fetchAll(
          [...uids.values()].join(','),
          {
            uid: true,
            emailId: true,
            flags: true,
            labels: true,
            envelope: true,
            internalDate: true,
            source: { maxLength: BODY_SOURCE_BYTES },
          },
          { uid: true },
        );
        const byId = new Map<string, { message: Message; text: string }>();
        for (const m of fetched) {
          if (!m.emailId) continue;
          const text = (await bodyText(m.source, BODY_TEXT_LENGTH, true)) ?? '';
          byId.set(m.emailId, { message: toMessage(m, text ? clip(compact(text), SNIPPET_LENGTH) : undefined), text });
        }
        return emailIds.flatMap((id) => byId.get(id) ?? []);
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Aplica `action` a lo que devolvió `collect`. Antes vuelve a comprobar cada
   * correo: si ya no está, es otro o alguien lo ha destacado, se salta.
   */
  async execute(
    action: ActionKind,
    collected: Collected,
    labelName?: string,
    onProgress?: ProgressFn,
  ): Promise<Executed> {
    if (action === 'label' && !labelName) throw new Error('Falta el nombre de la etiqueta.');
    if (collected.targets.length === 0) return { done: 0, undo: null };

    return this.withClient(async (client) => {
      const list = await client.list();
      const paths = folderPaths(list);
      if (action === 'label' && labelName && !list.some((b) => b.path === labelName)) {
        await client.mailboxCreate(labelName);
      }

      const lock = await client.getMailboxLock(paths.all);
      let ok: FetchMessageObject[] = [];
      let done = 0;
      let error: string | undefined;
      try {
        if (String(client.mailbox ? client.mailbox.uidValidity : '') !== collected.uidValidity) {
          throw new Error('Gmail ha reorganizado el buzón desde la búsqueda. Vuelve a intentarlo.');
        }
        const expected = new Map(collected.targets.map((t) => [t.uid, t.emailId]));
        const fresh = await client.fetchAll(
          [...expected.keys()].join(','),
          { uid: true, emailId: true, flags: true, labels: true },
          { uid: true },
        );
        ok = fresh
          .filter((m) => expected.get(m.uid) === m.emailId && !isProtected(m) && changes(action, m, labelName))
          .sort((a, b) => a.uid - b.uid);

        try {
          for (const batch of chunks(ok, ACTION_BATCH_SIZE)) {
            const range = batch.map((m) => m.uid).join(',');
            if (action === 'trash' || action === 'delete') {
              await client.messageMove(range, paths.trash, { uid: true });
            } else if (action === 'spam') {
              await client.messageMove(range, paths.junk, { uid: true });
            } else if (action === 'archive') {
              await client.messageFlagsRemove(range, ['\\Inbox'], { uid: true, useLabels: true });
            } else {
              await client.messageFlagsAdd(range, [labelName as string], { uid: true, useLabels: true });
            }
            done += batch.length;
            onProgress?.(done, ok.length);
          }
        } catch (err) {
          error = describeError(err);
        }
      } finally {
        lock.release();
      }

      const touched = ok.slice(0, done);
      if (action === 'delete') {
        // Ya están en la Papelera: borrarlos de ahí los elimina para siempre.
        const trashLock = await client.getMailboxLock(paths.trash);
        try {
          const found = await uidsByEmailId(client, touched.map((m) => m.emailId as string));
          for (const batch of chunks([...found.values()], BATCH_SIZE)) {
            await client.messageDelete(batch.join(','), { uid: true });
          }
        } finally {
          trashLock.release();
        }
        return withError({ done, undo: null }, error);
      }

      const undo: UndoData | null =
        done === 0
          ? null
          : {
              action,
              ...(action === 'label' ? { labelName } : {}),
              messages: touched.map((m) => ({ emailId: m.emailId as string, labels: [...(m.labels ?? [])] })),
            };
      return withError({ done, undo }, error);
    });
  }

  /** Deshace `execute`. Devuelve cuántos correos se han podido devolver. */
  async undo(data: UndoData): Promise<number> {
    const ids = data.messages.map((m) => m.emailId);
    return this.withClient(async (client) => {
      const paths = folderPaths(await client.list());

      if (data.action === 'archive' || data.action === 'label') {
        const lock = await client.getMailboxLock(paths.all);
        try {
          const found = await uidsByEmailId(client, ids);
          for (const batch of chunks([...found.values()], BATCH_SIZE)) {
            const range = batch.join(',');
            if (data.action === 'archive') {
              await client.messageFlagsAdd(range, ['\\Inbox'], { uid: true, useLabels: true });
            } else {
              await client.messageFlagsRemove(range, [data.labelName as string], { uid: true, useLabels: true });
            }
          }
          return found.size;
        } finally {
          lock.release();
        }
      }

      // Papelera o Spam: se devuelven a Recibidos y luego cada uno queda como estaba.
      const lock = await client.getMailboxLock(data.action === 'trash' ? paths.trash : paths.junk);
      let found: Map<string, number>;
      try {
        found = await uidsByEmailId(client, ids);
        for (const batch of chunks([...found.values()], BATCH_SIZE)) {
          await client.messageMove(batch.join(','), paths.inbox, { uid: true });
        }
      } finally {
        lock.release();
      }
      if (found.size === 0) return 0;

      const inboxLock = await client.getMailboxLock(paths.inbox);
      try {
        const back = await uidsByEmailId(client, [...found.keys()]);
        const before = new Map(data.messages.map((m) => [m.emailId, m.labels]));
        const byLabels = new Map<string, number[]>();
        const archived: number[] = [];
        for (const [emailId, uid] of back) {
          const labels = before.get(emailId) ?? [];
          const own = labels.filter((l) => !l.startsWith('\\'));
          if (own.length) {
            const key = JSON.stringify(own);
            byLabels.set(key, [...(byLabels.get(key) ?? []), uid]);
          }
          if (!labels.includes('\\Inbox')) archived.push(uid);
        }
        for (const [key, uids] of byLabels) {
          for (const batch of chunks(uids, BATCH_SIZE)) {
            await client.messageFlagsAdd(batch.join(','), JSON.parse(key) as string[], {
              uid: true,
              useLabels: true,
            });
          }
        }
        for (const batch of chunks(archived, BATCH_SIZE)) {
          await client.messageFlagsRemove(batch.join(','), ['\\Inbox'], { uid: true, useLabels: true });
        }
      } finally {
        inboxLock.release();
      }
      return found.size;
    });
  }

  private async withClient<T>(fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = this.createClient(this.creds);
    try {
      await client.connect();
    } catch (err) {
      throw new Error(describeConnectError(err));
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

/**
 * Rango de números de secuencia de la página `page` (0 = la más reciente).
 * IMAP numera del 1 (el más antiguo) a `total` (el más nuevo).
 */
export function pageRange(total: number, page: number, size = PAGE_SIZE): string | null {
  const end = total - page * size;
  if (page < 0 || end < 1) return null;
  return `${Math.max(1, end - size + 1)}:${end}`;
}

/** Elige y ordena las carpetas por su uso especial: Gmail traduce los nombres. */
export function pickFolders(list: ListResponse[]): Folder[] {
  const folders: Folder[] = [];
  for (const def of FOLDERS) {
    const box = list.find(
      (b) => b.specialUse === def.flag || (def.kind === 'inbox' && b.path.toUpperCase() === 'INBOX'),
    );
    if (!box) continue;
    folders.push({
      kind: def.kind,
      path: box.path,
      name: def.name,
      total: box.status?.messages ?? 0,
      unread: box.status?.unseen ?? 0,
    });
  }
  return folders;
}

/** Rutas de las carpetas que necesitan las acciones; sin ellas no seguimos. */
function folderPaths(list: ListResponse[]): Record<'inbox' | 'trash' | 'junk' | 'all', string> {
  const folders = pickFolders(list);
  const path = (kind: FolderKind) => {
    const found = folders.find((f) => f.kind === kind);
    if (!found) throw new Error('No encuentro todas las carpetas de Gmail. ¿Está activado IMAP en tu cuenta?');
    return found.path;
  };
  return { inbox: path('inbox'), trash: path('trash'), junk: path('junk'), all: path('all') };
}

function requireQuery(filter: Filter): string {
  const query = toGmailQuery(filter);
  if (!query) {
    throw new Error(
      'Esta regla no tiene ningún criterio que Gmail pueda buscar (remitente, asunto, palabras, antigüedad…).',
    );
  }
  return query;
}

function subjectRegexes(filter: Filter): Filter | null {
  return filter.subjectMatches?.length ? { subjectMatches: filter.subjectMatches } : null;
}

/** Destacados e importantes no se tocan nunca. */
export function isProtected(m: FetchMessageObject): boolean {
  return Boolean(m.flags?.has('\\Flagged') || m.labels?.has('\\Starred') || m.labels?.has('\\Important'));
}

/** false si la acción no cambiaría nada (archivar algo fuera de Recibidos…). */
function changes(action: ActionKind, m: FetchMessageObject, labelName?: string): boolean {
  if (action === 'archive') return m.labels?.has('\\Inbox') ?? false;
  if (action === 'label') return !m.labels?.has(labelName ?? '');
  return true;
}

/** UID en la carpeta abierta de cada X-GM-MSGID que siga en ella. */
async function uidsByEmailId(client: ImapClient, ids: string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const chunk of chunks(ids, ID_SEARCH_CHUNK)) {
    const wanted = new Set(chunk);
    const query = chunk.length === 1 ? { emailId: chunk[0] } : { or: chunk.map((emailId) => ({ emailId })) };
    const uids = (await client.search(query, { uid: true })) || [];
    if (uids.length === 0) continue;
    const fetched = await client.fetchAll(uids.join(','), { uid: true, emailId: true }, { uid: true });
    for (const m of fetched) if (m.emailId && wanted.has(m.emailId)) found.set(m.emailId, m.uid);
  }
  return found;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function withError(result: Executed, error: string | undefined): Executed {
  return error ? { ...result, error } : result;
}

function describeError(err: unknown): string {
  return `Gmail dio un error: ${err instanceof Error ? err.message : String(err)}`;
}

export function toMessage(m: FetchMessageObject, snippet?: string): Message {
  const sender = m.envelope?.from?.[0];
  const date = m.internalDate ?? m.envelope?.date;
  const message: Message = {
    id: m.emailId ?? String(m.uid),
    account: 'gmail',
    from: sender?.address ?? '',
    subject: m.envelope?.subject ?? '',
    receivedAt: date ? new Date(date).getTime() : 0,
    unread: !(m.flags?.has('\\Seen') ?? false),
    labels: [...(m.labels ?? [])],
  };
  if (sender?.name) message.fromName = sender.name;
  if (snippet) message.snippet = snippet;
  return message;
}

/** Saca un extracto legible del principio del mensaje (puede venir cortado). */
export async function snippetFrom(source: Buffer | undefined): Promise<string | undefined> {
  const text = await bodyText(source);
  return text ? clip(text, SNIPPET_LENGTH) : undefined;
}

/**
 * Texto plano del cuerpo, compactado. Con `keepLines` conserva los saltos de
 * línea (para leerlo una persona). Sin cuerpo legible, `undefined`.
 */
export async function bodyText(
  source: Buffer | undefined,
  max = Infinity,
  keepLines = false,
): Promise<string | undefined> {
  if (!source || source.length === 0) return undefined;
  try {
    const parsed = await simpleParser(source);
    const raw = parsed.text || (typeof parsed.html === 'string' ? stripHtml(parsed.html) : '');
    const text = keepLines
      ? raw
          .replace(/[ \t\f\v ]+/g, ' ')
          .replace(/ ?\r?\n ?/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      : compact(raw);
    if (!text) return undefined;
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return undefined;
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Lo que tocaría una acción sobre los correos elegidos de una pasada con IA. */
export function pickTargets(scan: InboxScan, emailIds: string[]): Collected {
  const wanted = new Set(emailIds);
  const targets = scan.items
    .filter((i) => wanted.has(i.target.emailId))
    .map((i) => i.target)
    .sort((a, b) => a.uid - b.uid);
  return { query: scan.query, total: targets.length, approximate: false, uidValidity: scan.uidValidity, targets };
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function describeConnectError(err: unknown): string {
  const e = err as { authenticationFailed?: boolean; code?: string } | undefined;
  if (e?.authenticationFailed) {
    return 'Gmail rechazó el correo o la contraseña. Comprueba que usas una contraseña de aplicación, no tu contraseña normal.';
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT') {
    return 'No se pudo conectar con imap.gmail.com. Revisa tu conexión a internet.';
  }
  return `No se pudo conectar con Gmail: ${err instanceof Error ? err.message : String(err)}`;
}

import { describe, it, expect, vi } from 'vitest';
import type { FetchMessageObject, ListResponse } from 'imapflow';
import {
  GmailImapConnector,
  pageRange,
  pickFolders,
  pickTargets,
  snippetFrom,
  toMessage,
  type ImapClient,
} from './gmailImap';

function box(path: string, specialUse?: string, messages = 0, unseen = 0): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path.split('/').pop() ?? path,
    delimiter: '/',
    parent: [],
    parentPath: '',
    flags: new Set(),
    specialUse,
    listed: true,
    subscribed: true,
    status: { path, messages, unseen },
  };
}

describe('pageRange', () => {
  it('la página 0 son los 50 correos más nuevos', () => {
    expect(pageRange(120, 0)).toBe('71:120');
    expect(pageRange(120, 1)).toBe('21:70');
  });

  it('la última página empieza en 1', () => {
    expect(pageRange(120, 2)).toBe('1:20');
  });

  it('sin correos o fuera de rango no hay página', () => {
    expect(pageRange(0, 0)).toBeNull();
    expect(pageRange(120, 3)).toBeNull();
    expect(pageRange(120, -1)).toBeNull();
  });
});

describe('pickFolders', () => {
  it('elige carpetas por uso especial aunque Gmail las traduzca', () => {
    const folders = pickFolders([
      box('[Gmail]/Papelera', '\\Trash'),
      box('INBOX', '\\Inbox', 340, 12),
      box('[Gmail]/Enviados', '\\Sent'),
      box('[Gmail]/Importantes', '\\Important'),
      box('[Gmail]/Spam', '\\Junk', 5, 5),
      box('[Gmail]/Todos', '\\All'),
      box('Trabajo'),
    ]);
    expect(folders.map((f) => [f.kind, f.path])).toEqual([
      ['inbox', 'INBOX'],
      ['sent', '[Gmail]/Enviados'],
      ['junk', '[Gmail]/Spam'],
      ['trash', '[Gmail]/Papelera'],
      ['all', '[Gmail]/Todos'],
    ]);
    expect(folders[0]).toMatchObject({ name: 'Recibidos', total: 340, unread: 12 });
  });

  it('reconoce INBOX aunque no traiga la marca \\Inbox', () => {
    expect(pickFolders([box('INBOX')]).map((f) => f.kind)).toEqual(['inbox']);
  });
});

describe('toMessage', () => {
  const base: FetchMessageObject = {
    seq: 1,
    uid: 42,
    emailId: '1780000000000000001',
    envelope: { subject: 'Hola', from: [{ name: 'Ana García', address: 'ana@ejemplo.com' }] },
    internalDate: new Date('2026-10-20T10:00:00Z'),
    flags: new Set(['\\Seen']),
    labels: new Set(['\\Inbox', 'Familia']),
  };

  it('convierte el sobre IMAP en un Message', () => {
    expect(toMessage(base, 'Nos vemos el sábado')).toEqual({
      id: '1780000000000000001',
      account: 'gmail',
      from: 'ana@ejemplo.com',
      fromName: 'Ana García',
      subject: 'Hola',
      receivedAt: Date.parse('2026-10-20T10:00:00Z'),
      unread: false,
      labels: ['\\Inbox', 'Familia'],
      snippet: 'Nos vemos el sábado',
    });
  });

  it('sin \\Seen está sin leer; sin emailId usa el uid', () => {
    const m = toMessage({ ...base, flags: new Set(), emailId: undefined });
    expect(m.unread).toBe(true);
    expect(m.id).toBe('42');
    expect(m.snippet).toBeUndefined();
  });

  it('aguanta sobres incompletos', () => {
    const m = toMessage({ seq: 1, uid: 7 });
    expect(m).toMatchObject({ from: '', subject: '', receivedAt: 0, unread: true, labels: [] });
    expect(m.fromName).toBeUndefined();
  });
});

describe('snippetFrom', () => {
  it('extrae el texto plano y lo compacta', async () => {
    const src = Buffer.from(
      'From: a@b.com\r\nSubject: x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHola,\r\n\r\n  ¿qué tal?\r\n',
    );
    expect(await snippetFrom(src)).toBe('Hola, ¿qué tal?');
  });

  it('si solo hay HTML quita las etiquetas', async () => {
    const src = Buffer.from(
      'Content-Type: text/html; charset=utf-8\r\n\r\n<style>p{}</style><p>Oferta <b>hoy</b></p>',
    );
    expect(await snippetFrom(src)).toBe('Oferta hoy');
  });

  it('recorta los textos largos', async () => {
    const src = Buffer.from(`Content-Type: text/plain\r\n\r\n${'a'.repeat(500)}`);
    const s = await snippetFrom(src);
    expect(s?.length).toBe(141);
    expect(s?.endsWith('…')).toBe(true);
  });

  it('sin cuerpo no hay extracto', async () => {
    expect(await snippetFrom(undefined)).toBeUndefined();
  });
});

describe('GmailImapConnector', () => {
  function fakeClient(over: Partial<Record<keyof ImapClient, unknown>> = {}) {
    const release = vi.fn();
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      getMailboxLock: vi.fn().mockResolvedValue({ path: 'INBOX', release }),
      fetchAll: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      messageMove: vi.fn().mockResolvedValue({}),
      messageFlagsAdd: vi.fn().mockResolvedValue(true),
      messageFlagsRemove: vi.fn().mockResolvedValue(true),
      messageDelete: vi.fn().mockResolvedValue(true),
      mailboxCreate: vi.fn().mockResolvedValue({}),
      mailbox: { exists: 0, uidValidity: 7n },
      ...over,
    };
    return { client: client as unknown as ImapClient, release, raw: client };
  }
  const creds = { email: 'yo@gmail.com', appPassword: 'abcd efgh ijkl mnop' };

  it('traduce un fallo de autenticación a un mensaje claro y no deja la conexión abierta', async () => {
    const err = Object.assign(new Error('Command failed'), { authenticationFailed: true });
    const { client } = fakeClient({ connect: vi.fn().mockRejectedValue(err) });
    await expect(new GmailImapConnector(creds, () => client).verify()).rejects.toThrow(
      /contraseña de aplicación/,
    );
  });

  it('pide la página en solo lectura, libera el bloqueo y cierra sesión', async () => {
    const { client, release, raw } = fakeClient({
      mailbox: { exists: 120 },
      fetchAll: vi.fn().mockResolvedValue([
        { seq: 119, uid: 1, internalDate: new Date(1000) },
        { seq: 120, uid: 2, internalDate: new Date(2000) },
      ]),
    });
    const page = await new GmailImapConnector(creds, () => client).listPage('INBOX', 0);

    expect(raw.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(raw.fetchAll).toHaveBeenCalledWith('71:120', expect.objectContaining({ envelope: true }));
    expect(page.messages.map((m) => m.id)).toEqual(['2', '1']); // más nuevo primero
    expect(page).toMatchObject({ total: 120, page: 0, hasMore: true });
    expect(release).toHaveBeenCalled();
    expect(raw.logout).toHaveBeenCalled();
  });

  it('carpeta vacía: sin fetch y sin más páginas', async () => {
    const { client, raw } = fakeClient();
    const page = await new GmailImapConnector(creds, () => client).listPage('INBOX', 0);
    expect(page).toEqual({ messages: [], total: 0, page: 0, pageSize: 50, hasMore: false });
    expect(raw.fetchAll).not.toHaveBeenCalled();
  });

  it('no aplica acciones correo a correo: van por lotes', async () => {
    const { client } = fakeClient();
    await expect(new GmailImapConnector(creds, () => client).apply('trash', '1')).rejects.toThrow(
      /por lotes/,
    );
  });

  const allBoxes = [
    box('INBOX', '\\Inbox'),
    box('[Gmail]/Papelera', '\\Trash'),
    box('[Gmail]/Spam', '\\Junk'),
    box('[Gmail]/Todos', '\\All'),
  ];
  const msg = (uid: number, emailId: string, labels: string[] = ['\\Inbox'], flags: string[] = []) => ({
    seq: uid,
    uid,
    emailId,
    labels: new Set(labels),
    flags: new Set(flags),
  });

  describe('collect', () => {
    it('excluye destacados e importantes en la búsqueda y al descargar', async () => {
      const { client, raw, release } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValue([3, 1, 2]),
        fetchAll: vi.fn().mockResolvedValue([
          msg(1, 'a'),
          msg(2, 'b', ['\\Inbox', '\\Starred']),
          msg(3, 'c', ['\\Inbox'], ['\\Flagged']),
        ]),
      });
      const result = await new GmailImapConnector(creds, () => client).collect(
        { fromDomains: ['tienda.com'] },
        'trash',
        undefined,
        100,
      );
      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Todos', { readOnly: true });
      expect(raw.search).toHaveBeenCalledWith(
        { gmraw: 'from:@tienda.com -is:starred -is:important' },
        { uid: true },
      );
      expect(result).toMatchObject({ total: 1, approximate: false, uidValidity: '7' });
      expect(result.targets).toEqual([{ uid: 1, emailId: 'a', labels: ['\\Inbox'] }]);
      expect(release).toHaveBeenCalled();
    });

    it('archivar solo busca en Recibidos', async () => {
      const { client, raw } = fakeClient({ list: vi.fn().mockResolvedValue(allBoxes) });
      await new GmailImapConnector(creds, () => client).collect({ unread: true }, 'archive', undefined, 10);
      expect(raw.search).toHaveBeenCalledWith(
        { gmraw: 'is:unread -is:starred -is:important in:inbox' },
        { uid: true },
      );
    });

    it('aplica el tope a los más recientes y cuenta el resto', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5]),
        fetchAll: vi.fn().mockResolvedValue([msg(4, 'd'), msg(5, 'e')]),
      });
      const result = await new GmailImapConnector(creds, () => client).collect(
        { unread: true },
        'trash',
        undefined,
        2,
      );
      expect(raw.fetchAll).toHaveBeenCalledWith('4,5', expect.anything(), { uid: true });
      expect(result.total).toBe(5);
      expect(result.targets.map((t) => t.uid)).toEqual([4, 5]);
    });
  });

  describe('execute', () => {
    const collected = (targets: Array<[number, string]>, uidValidity = '7') => ({
      query: 'q',
      total: targets.length,
      approximate: false,
      uidValidity,
      targets: targets.map(([uid, emailId]) => ({ uid, emailId, labels: ['\\Inbox'] })),
    });

    it('si cambió UIDVALIDITY no toca nada', async () => {
      const { client, raw, release } = fakeClient({ list: vi.fn().mockResolvedValue(allBoxes) });
      await expect(
        new GmailImapConnector(creds, () => client).execute('trash', collected([[1, 'a']], '8')),
      ).rejects.toThrow(/reorganizado/);
      expect(raw.messageMove).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    });

    it('se salta los que cambiaron o se destacaron, mueve el resto y guarda cómo deshacerlo', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        fetchAll: vi.fn().mockResolvedValue([
          msg(1, 'a', ['\\Inbox', 'Compras']),
          msg(2, 'otro'),
          msg(3, 'c', ['\\Inbox', '\\Important']),
        ]),
      });
      const progress = vi.fn();
      const result = await new GmailImapConnector(creds, () => client).execute(
        'trash',
        collected([
          [1, 'a'],
          [2, 'b'],
          [3, 'c'],
        ]),
        undefined,
        progress,
      );
      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Todos');
      expect(raw.messageMove).toHaveBeenCalledTimes(1);
      expect(raw.messageMove).toHaveBeenCalledWith('1', '[Gmail]/Papelera', { uid: true });
      expect(progress).toHaveBeenCalledWith(1, 1);
      expect(result).toEqual({
        done: 1,
        undo: { action: 'trash', messages: [{ emailId: 'a', labels: ['\\Inbox', 'Compras'] }] },
      });
    });

    it('va por lotes de 50 para que la barra avance', async () => {
      const many = Array.from({ length: 1200 }, (_, i) => msg(i + 1, `m${i + 1}`));
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        fetchAll: vi.fn().mockResolvedValue(many),
      });
      const result = await new GmailImapConnector(creds, () => client).execute(
        'archive',
        collected(many.map((m) => [m.uid, m.emailId])),
      );
      expect(raw.messageFlagsRemove).toHaveBeenCalledTimes(24);
      expect(raw.messageFlagsRemove).toHaveBeenCalledWith(expect.any(String), ['\\Inbox'], {
        uid: true,
        useLabels: true,
      });
      expect(result.done).toBe(1200);
    });

    it('etiquetar crea la etiqueta si no existe', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        fetchAll: vi.fn().mockResolvedValue([msg(1, 'a')]),
      });
      const result = await new GmailImapConnector(creds, () => client).execute(
        'label',
        collected([[1, 'a']]),
        'Ofertas',
      );
      expect(raw.mailboxCreate).toHaveBeenCalledWith('Ofertas');
      expect(raw.messageFlagsAdd).toHaveBeenCalledWith('1', ['Ofertas'], { uid: true, useLabels: true });
      expect(result.undo).toMatchObject({ action: 'label', labelName: 'Ofertas' });
    });

    it('borrar para siempre pasa por la Papelera, la vacía de esos correos y no se puede deshacer', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        fetchAll: vi
          .fn()
          .mockResolvedValueOnce([msg(1, 'a')])
          .mockResolvedValueOnce([{ seq: 1, uid: 77, emailId: 'a' }]),
        search: vi.fn().mockResolvedValue([77]),
      });
      const result = await new GmailImapConnector(creds, () => client).execute('delete', collected([[1, 'a']]));
      expect(raw.messageMove).toHaveBeenCalledWith('1', '[Gmail]/Papelera', { uid: true });
      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Papelera');
      expect(raw.search).toHaveBeenCalledWith({ emailId: 'a' }, { uid: true });
      expect(raw.messageDelete).toHaveBeenCalledWith('77', { uid: true });
      expect(result).toEqual({ done: 1, undo: null });
    });

    it('si Gmail falla a mitad informa del error y guarda lo hecho', async () => {
      const many = Array.from({ length: 600 }, (_, i) => msg(i + 1, `m${i + 1}`));
      const { client } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        fetchAll: vi.fn().mockResolvedValue(many),
        messageMove: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('se cortó')),
      });
      const result = await new GmailImapConnector(creds, () => client).execute(
        'spam',
        collected(many.map((m) => [m.uid, m.emailId])),
      );
      expect(result.done).toBe(50);
      expect(result.error).toMatch(/se cortó/);
      expect(result.undo?.messages).toHaveLength(50);
    });
  });

  describe('undo', () => {
    it('desarchivar vuelve a poner \\Inbox', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValue([10, 11]),
        fetchAll: vi.fn().mockResolvedValue([
          { seq: 1, uid: 10, emailId: 'a' },
          { seq: 2, uid: 11, emailId: 'b' },
        ]),
      });
      const n = await new GmailImapConnector(creds, () => client).undo({
        action: 'archive',
        messages: [
          { emailId: 'a', labels: ['\\Inbox'] },
          { emailId: 'b', labels: ['\\Inbox'] },
        ],
      });
      expect(raw.search).toHaveBeenCalledWith({ or: [{ emailId: 'a' }, { emailId: 'b' }] }, { uid: true });
      expect(raw.messageFlagsAdd).toHaveBeenCalledWith('10,11', ['\\Inbox'], { uid: true, useLabels: true });
      expect(n).toBe(2);
    });

    it('quitar una etiqueta puesta', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValue([10]),
        fetchAll: vi.fn().mockResolvedValue([{ seq: 1, uid: 10, emailId: 'a' }]),
      });
      await new GmailImapConnector(creds, () => client).undo({
        action: 'label',
        labelName: 'Ofertas',
        messages: [{ emailId: 'a', labels: [] }],
      });
      expect(raw.messageFlagsRemove).toHaveBeenCalledWith('10', ['Ofertas'], { uid: true, useLabels: true });
    });

    it('sacar de la Papelera devuelve las etiquetas y vuelve a archivar lo que estaba archivado', async () => {
      const { client, raw } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValueOnce([5, 6]).mockResolvedValueOnce([90, 91]),
        fetchAll: vi
          .fn()
          .mockResolvedValueOnce([
            { seq: 1, uid: 5, emailId: 'a' },
            { seq: 2, uid: 6, emailId: 'b' },
          ])
          .mockResolvedValueOnce([
            { seq: 1, uid: 90, emailId: 'a' },
            { seq: 2, uid: 91, emailId: 'b' },
          ]),
      });
      const n = await new GmailImapConnector(creds, () => client).undo({
        action: 'trash',
        messages: [
          { emailId: 'a', labels: ['\\Inbox', 'Compras'] },
          { emailId: 'b', labels: [] },
        ],
      });
      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Papelera');
      expect(raw.messageMove).toHaveBeenCalledWith('5,6', 'INBOX', { uid: true });
      expect(raw.messageFlagsAdd).toHaveBeenCalledWith('90', ['Compras'], { uid: true, useLabels: true });
      expect(raw.messageFlagsRemove).toHaveBeenCalledWith('91', ['\\Inbox'], { uid: true, useLabels: true });
      expect(n).toBe(2);
    });

    it('si ya no queda ninguno en la Papelera no hace nada más', async () => {
      const { client, raw } = fakeClient({ list: vi.fn().mockResolvedValue(allBoxes) });
      const n = await new GmailImapConnector(creds, () => client).undo({
        action: 'spam',
        messages: [{ emailId: 'a', labels: ['\\Inbox'] }],
      });
      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Spam');
      expect(raw.messageMove).not.toHaveBeenCalled();
      expect(n).toBe(0);
    });
  });

  describe('search', () => {
    const lists = [box('INBOX', '\\Inbox'), box('[Gmail]/Todos', '\\All')];

    it('busca con X-GM-RAW en «Todos» en solo lectura y devuelve los más nuevos', async () => {
      const { client, raw, release } = fakeClient({
        list: vi.fn().mockResolvedValue(lists),
        search: vi.fn().mockResolvedValue([30, 10, 20]),
        fetchAll: vi.fn().mockResolvedValue([
          { seq: 1, uid: 20, internalDate: new Date(2000) },
          { seq: 2, uid: 30, internalDate: new Date(3000) },
        ]),
      });
      const result = await new GmailImapConnector(creds, () => client).search(
        { fromDomains: ['tienda.com'] },
        2,
      );

      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Todos', { readOnly: true });
      expect(raw.search).toHaveBeenCalledWith({ gmraw: 'from:@tienda.com' }, { uid: true });
      expect(raw.fetchAll).toHaveBeenCalledWith('20,30', expect.anything(), { uid: true });
      expect(result).toMatchObject({ query: 'from:@tienda.com', total: 3, approximate: false });
      expect(result.messages.map((m) => m.id)).toEqual(['30', '20']);
      expect(release).toHaveBeenCalled();
      expect(raw.logout).toHaveBeenCalled();
    });

    it('sin coincidencias no descarga nada', async () => {
      const { client, raw } = fakeClient({ list: vi.fn().mockResolvedValue(lists) });
      const result = await new GmailImapConnector(creds, () => client).search({ unread: true });
      expect(result).toEqual({ query: 'is:unread', total: 0, approximate: false, messages: [] });
      expect(raw.fetchAll).not.toHaveBeenCalled();
    });

    it('los patrones de asunto se comprueban sobre lo descargado', async () => {
      const { client } = fakeClient({
        list: vi.fn().mockResolvedValue(lists),
        search: vi.fn().mockResolvedValue([1, 2]),
        fetchAll: vi.fn().mockResolvedValue([
          { seq: 1, uid: 1, envelope: { subject: 'Oferta flash 50%' } },
          { seq: 2, uid: 2, envelope: { subject: 'Tu pedido' } },
        ]),
      });
      const result = await new GmailImapConnector(creds, () => client).search({
        fromDomains: ['tienda.com'],
        subjectMatches: ['^oferta'],
      });
      expect(result.total).toBe(1);
      expect(result.messages.map((m) => m.subject)).toEqual(['Oferta flash 50%']);
    });

    it('un filtro sin nada buscable da un error claro sin conectar', async () => {
      const { client, raw } = fakeClient();
      await expect(
        new GmailImapConnector(creds, () => client).search({ subjectMatches: ['x'] }),
      ).rejects.toThrow(/ningún criterio/);
      expect(raw.connect).not.toHaveBeenCalled();
    });
  });

  describe('recentInbox', () => {
    const mail = (uid: number, emailId: string, labels: string[] = ['\\Inbox'], flags: string[] = []) => ({
      ...msg(uid, emailId, labels, flags),
      envelope: { subject: `Asunto ${uid}`, from: [{ name: 'Tienda', address: 'ofertas@tienda.com' }] },
      internalDate: new Date('2026-10-20T10:00:00Z'),
      source: Buffer.from(`Subject: x\r\n\r\nHola   ${'mundo '.repeat(40)}`),
    });

    it('lee los últimos de Recibidos en solo lectura, con el cuerpo, sin protegidos', async () => {
      const { client, raw, release } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValue([5, 1, 9, 3]),
        fetchAll: vi.fn().mockResolvedValue([mail(3, 'c'), mail(5, 'e', ['\\Inbox', '\\Important']), mail(9, 'i')]),
      });
      const scan = await new GmailImapConnector(creds, () => client).recentInbox('trash', undefined, 3);
      expect(raw.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Todos', { readOnly: true });
      expect(raw.search).toHaveBeenCalledWith({ gmraw: 'in:inbox -is:starred -is:important' }, { uid: true });
      expect(raw.fetchAll).toHaveBeenCalledWith('3,5,9', expect.anything(), { uid: true });
      expect(scan.uidValidity).toBe('7');
      expect(scan.items.map((i) => i.target.emailId)).toEqual(['i', 'c']);
      expect(scan.items[0]?.text.startsWith('Hola mundo mundo')).toBe(true);
      expect(scan.items[0]?.message).toMatchObject({ id: 'i', subject: 'Asunto 9', from: 'ofertas@tienda.com' });
      expect(scan.items[0]?.message.snippet?.endsWith('…')).toBe(true);
      expect(release).toHaveBeenCalled();
    });

    it('Recibidos vacío: sin fetch', async () => {
      const { client, raw } = fakeClient({ list: vi.fn().mockResolvedValue(allBoxes) });
      const scan = await new GmailImapConnector(creds, () => client).recentInbox('trash', undefined);
      expect(scan.items).toEqual([]);
      expect(raw.fetchAll).not.toHaveBeenCalled();
    });

    it('readMessages lee los elegidos en solo lectura, en el orden pedido y con saltos de línea', async () => {
      const withLines = (uid: number, emailId: string) => ({
        ...mail(uid, emailId),
        source: Buffer.from(`Subject: x\r\n\r\nHola,\r\n\r\n\r\n\r\n  hasta   luego ${uid}\r\n`),
      });
      const { client, raw, release } = fakeClient({
        search: vi.fn().mockResolvedValue([4, 8]),
        fetchAll: vi
          .fn()
          .mockResolvedValueOnce([msg(4, 'd'), msg(8, 'h')]) // ids → uids
          .mockResolvedValueOnce([withLines(4, 'd'), withLines(8, 'h')]),
      });
      const read = await new GmailImapConnector(creds, () => client).readMessages('INBOX', ['h', 'zz', 'd']);
      expect(raw.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
      expect(read.map((r) => r.message.id)).toEqual(['h', 'd']);
      expect(read[0]?.text).toBe('Hola,\n\nhasta luego 8');
      expect(read[0]?.message.snippet).toBe('Hola, hasta luego 8');
      expect(release).toHaveBeenCalled();
    });

    it('readMessages sin ids no abre conexión', async () => {
      const { client, raw } = fakeClient();
      expect(await new GmailImapConnector(creds, () => client).readMessages('INBOX', [])).toEqual([]);
      expect(raw.connect).not.toHaveBeenCalled();
    });

    it('pickTargets se queda solo con los elegidos, del más antiguo al más nuevo', async () => {
      const { client } = fakeClient({
        list: vi.fn().mockResolvedValue(allBoxes),
        search: vi.fn().mockResolvedValue([1, 2, 3]),
        fetchAll: vi.fn().mockResolvedValue([mail(1, 'a'), mail(2, 'b'), mail(3, 'c')]),
      });
      const scan = await new GmailImapConnector(creds, () => client).recentInbox('trash', undefined);
      expect(pickTargets(scan, ['c', 'a', 'zz'])).toEqual({
        query: scan.query,
        total: 2,
        approximate: false,
        uidValidity: '7',
        targets: [
          { uid: 1, emailId: 'a', labels: ['\\Inbox'] },
          { uid: 3, emailId: 'c', labels: ['\\Inbox'] },
        ],
      });
    });
  });
});

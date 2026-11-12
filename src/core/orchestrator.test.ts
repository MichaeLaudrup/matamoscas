import { describe, it, expect } from 'vitest';
import { previewRun, executeMatches } from './orchestrator';
import type { MailConnector } from '../connectors/types';
import type { AccountKind, ActionKind, Message, Rule } from './types';

const NOW = 1_700_000_000_000;

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    account: 'gmail',
    from: 'ofertas@tienda.com',
    subject: 'Ofertas',
    receivedAt: NOW,
    unread: true,
    labels: ['INBOX'],
    ...over,
  };
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    text: 't',
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

/** Conector falso que registra las acciones aplicadas. */
class FakeConnector implements MailConnector {
  applied: Array<{ action: ActionKind; id: string; label?: string }> = [];
  constructor(
    readonly account: AccountKind,
    private readonly messages: Message[],
    private readonly failOn: Set<string> = new Set(),
  ) {}
  async listMessages(): Promise<Message[]> {
    return this.messages;
  }
  async apply(action: ActionKind, messageId: string, labelName?: string): Promise<void> {
    if (this.failOn.has(messageId)) throw new Error('IMAP caído');
    this.applied.push({ action, id: messageId, ...(labelName ? { label: labelName } : {}) });
  }
  async verify(): Promise<void> {}
}

describe('previewRun', () => {
  it('evalúa reglas sobre los correos de todos los conectores', async () => {
    const gmail = new FakeConnector('gmail', [msg({ id: 'g1' })]);
    const proton = new FakeConnector('proton', [msg({ id: 'p1', account: 'proton' })]);
    const matches = await previewRun([gmail, proton], [rule()], NOW);
    expect(matches.map((m) => m.message.id).sort()).toEqual(['g1', 'p1']);
  });

  it('no aplica ninguna acción', async () => {
    const gmail = new FakeConnector('gmail', [msg()]);
    await previewRun([gmail], [rule()], NOW);
    expect(gmail.applied).toHaveLength(0);
  });
});

describe('executeMatches', () => {
  it('aplica cada acción al conector de su cuenta', async () => {
    const gmail = new FakeConnector('gmail', [msg({ id: 'g1' })]);
    const matches = await previewRun([gmail], [rule()], NOW);
    const outcomes = await executeMatches([gmail], matches, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
    expect(gmail.applied).toEqual([{ action: 'trash', id: 'g1' }]);
  });

  it('aísla fallos: un correo que falla no detiene los demás', async () => {
    const gmail = new FakeConnector('gmail', [msg({ id: 'g1' }), msg({ id: 'g2' })], new Set(['g1']));
    const matches = await previewRun([gmail], [rule()], NOW);
    const outcomes = await executeMatches([gmail], matches, NOW);
    const byId = Object.fromEntries(outcomes.map((o) => [o.messageId, o]));
    expect(byId['g1']!.ok).toBe(false);
    expect(byId['g1']!.error).toContain('IMAP');
    expect(byId['g2']!.ok).toBe(true);
  });

  it('marca error si no hay conector para la cuenta', async () => {
    const proton = new FakeConnector('proton', [msg({ id: 'p1', account: 'proton' })]);
    const matches = await previewRun([proton], [rule()], NOW);
    const outcomes = await executeMatches([], matches, NOW); // sin conectores al ejecutar
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toContain('Sin conector');
  });

  it('propaga labelName en acciones de etiqueta', async () => {
    const gmail = new FakeConnector('gmail', [msg({ id: 'g1' })]);
    const matches = await previewRun([gmail], [rule({ action: 'label', labelName: 'Basura' })], NOW);
    await executeMatches([gmail], matches, NOW);
    expect(gmail.applied[0]).toEqual({ action: 'label', id: 'g1', label: 'Basura' });
  });
});

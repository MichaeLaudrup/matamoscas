import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_LIMIT, HistoryStore, markUndone, record, type HistoryState } from './historyStore';
import type { HistoryEntry } from '../shared/ipc';

const entry = (id: string): HistoryEntry => ({
  id,
  ruleId: 'r1',
  ruleText: 'Borra las ofertas',
  action: 'trash',
  count: 3,
  at: 1000,
  undone: false,
});
const undo = { action: 'trash' as const, messages: [{ emailId: 'a', labels: ['\\Inbox'] }] };
const empty: HistoryState = { entries: [], lastUndo: null };

describe('record', () => {
  it('pone la pasada la primera y la deja para deshacer', () => {
    const s = record(record(empty, entry('1'), undo), entry('2'), undo);
    expect(s.entries.map((e) => e.id)).toEqual(['2', '1']);
    expect(s.lastUndo).toEqual({ entryId: '2', data: undo });
  });

  it('sin datos para deshacer (borrar para siempre) ya no se puede deshacer la anterior', () => {
    const s = record(record(empty, entry('1'), undo), entry('2'), null);
    expect(s.lastUndo).toBeNull();
  });

  it('se queda con las últimas', () => {
    let s = empty;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) s = record(s, entry(String(i)), null);
    expect(s.entries).toHaveLength(HISTORY_LIMIT);
    expect(s.entries[0]?.id).toBe(String(HISTORY_LIMIT + 4));
  });
});

describe('markUndone', () => {
  it('marca la última como deshecha y no deja deshacer dos veces', () => {
    const s = markUndone(record(record(empty, entry('1'), null), entry('2'), undo));
    expect(s.entries.map((e) => [e.id, e.undone])).toEqual([
      ['2', true],
      ['1', false],
    ]);
    expect(s.lastUndo).toBeNull();
  });
});

describe('HistoryStore', () => {
  it('sin archivo empieza vacío; guarda y vuelve a leer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'matamoscas-'));
    const store = new HistoryStore(join(dir, 'history.json'));
    expect(await store.load()).toEqual(empty);

    const s = record(empty, entry('1'), undo);
    await store.save(s);
    expect(await store.load()).toEqual(s);
  });

  it('aguanta un archivo con campos que faltan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'matamoscas-'));
    const file = join(dir, 'history.json');
    await writeFile(file, '{}', 'utf8');
    expect(await new HistoryStore(file).load()).toEqual(empty);
    expect(await readFile(file, 'utf8')).toBe('{}');
  });
});

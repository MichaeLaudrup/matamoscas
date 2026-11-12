/**
 * Guarda en `history.json` las últimas pasadas de las reglas y lo necesario
 * para deshacer la más reciente. Solo hay identificadores de Gmail y
 * etiquetas, nunca el contenido de los correos.
 */
import { promises as fs } from 'node:fs';
import type { UndoData } from '../connectors/gmailImap';
import type { HistoryEntry } from '../shared/ipc';

/** Pasadas que se conservan en el historial. */
export const HISTORY_LIMIT = 50;

export interface HistoryState {
  /** Del más reciente al más antiguo. */
  entries: HistoryEntry[];
  /** Solo la última pasada se puede deshacer. */
  lastUndo: { entryId: string; data: UndoData } | null;
}

export class HistoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<HistoryState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], lastUndo: null };
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<HistoryState>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      lastUndo: parsed.lastUndo ?? null,
    };
  }

  /** Escribe en un archivo temporal y lo renombra: un corte a mitad no deja el JSON roto. */
  async save(state: HistoryState): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    const trimmed: HistoryState = { ...state, entries: state.entries.slice(0, HISTORY_LIMIT) };
    await fs.writeFile(tmp, JSON.stringify(trimmed), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

/** Añade una pasada al principio. Solo se puede deshacer si trae `undo`. */
export function record(state: HistoryState, entry: HistoryEntry, undo: UndoData | null): HistoryState {
  return {
    entries: [entry, ...state.entries].slice(0, HISTORY_LIMIT),
    lastUndo: undo ? { entryId: entry.id, data: undo } : null,
  };
}

/** Marca como deshecha la última pasada; ya no se puede volver a deshacer. */
export function markUndone(state: HistoryState): HistoryState {
  const id = state.lastUndo?.entryId;
  return {
    entries: state.entries.map((e) => (e.id === id ? { ...e, undone: true } : e)),
    lastUndo: null,
  };
}

/**
 * Contrato entre el proceso principal de Electron y la interfaz. Solo tipos:
 * ambos lados lo importan con `import type`, así que no existe en tiempo de
 * ejecución.
 */
import type { ActionKind, Message, Rule, RuleKind, RuleSuggestion } from '../core/types';

/** Carpetas de Gmail que mostramos, identificadas por su uso especial IMAP. */
export type FolderKind = 'inbox' | 'sent' | 'junk' | 'trash' | 'all';

export interface Folder {
  kind: FolderKind;
  /** Ruta IMAP real (Gmail la traduce según el idioma de la cuenta). */
  path: string;
  /** Nombre en español para la interfaz. */
  name: string;
  total: number;
  unread: number;
}

export interface MessagePage {
  messages: Message[];
  /** Correos totales en la carpeta. */
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Vista previa de una regla: lo que tocaría, sin tocar nada. */
export interface RulePreview {
  /** Consulta de Gmail usada, por si el usuario quiere probarla en la web. */
  query: string;
  /** Correos que cumplen la regla en todo el buzón. */
  total: number;
  /** true si `total` es una cota inferior (había demasiados para revisarlos todos). */
  approximate: boolean;
  /** Los más recientes, del más nuevo al más antiguo. */
  messages: Message[];
}

/** Lo que haría «Aplicar» ahora mismo, para que el usuario lo confirme. */
export interface ApplyPlan {
  /** Identifica esta búsqueda: «Aplicar» toca exactamente estos correos. */
  token: string;
  ruleId: string;
  action: ActionKind;
  labelName?: string;
  /** Correos que se tocarán (sin destacados ni importantes, con el tope ya aplicado). */
  count: number;
  /** Coincidencias en total; si es mayor que `count`, el resto queda para otra pasada. */
  total: number;
  approximate: boolean;
}

export interface ApplyProgress {
  token: string;
  done: number;
  total: number;
}

/** Un correo leído por una regla con IA. */
export interface ScanItem {
  message: Message;
  /** 0–100; null si no se pudo analizar (ver `error`). */
  probability: number | null;
  reason: string;
  error?: string;
}

/** Resultado de «Analizar con IA», para revisarlo antes de aplicar. */
export interface RuleScan {
  /** Identifica esta pasada: «Aplicar» solo puede tocar correos de aquí. */
  token: string;
  ruleId: string;
  /** De más a menos probable; los que fallaron, al final. */
  items: ScanItem[];
  /** Probabilidad a partir de la cual se preseleccionan. */
  threshold: number;
}

export interface ScoreProgress {
  ruleId: string;
  done: number;
  total: number;
}

/** Una pasada de una regla, para el historial. */
export interface HistoryEntry {
  id: string;
  ruleId: string;
  ruleText: string;
  action: ActionKind;
  labelName?: string;
  count: number;
  at: number;
  /** Si Gmail falló a mitad, qué dijo. */
  error?: string;
  undone: boolean;
}

export interface History {
  /** Del más reciente al más antiguo. */
  entries: HistoryEntry[];
  /** La única pasada que se puede deshacer (la última, si no fue un borrado definitivo). */
  undoableId: string | null;
}

export type ConnectResult = { ok: true } | { ok: false; error: string };

/** Lo que el usuario escribe al crear o editar una regla. */
export interface RuleDraft {
  text: string;
  action: ActionKind;
  labelName?: string;
  /** Sin indicar, una regla de filtro. No se puede cambiar después. */
  kind?: RuleKind;
}

export type RulePatch = Partial<Omit<RuleDraft, 'kind'>> & { enabled?: boolean };

/** API que el preload expone en `window.matamoscas`. */
export interface MatamoscasApi {
  getAccount(): Promise<{ email: string } | null>;
  connect(email: string, appPassword: string): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  listFolders(): Promise<Folder[]>;
  listMessages(path: string, page: number): Promise<MessagePage>;
  openExternal(url: string): Promise<void>;
  /** Cuerpo en texto de un correo de la carpeta `path`. Solo lee. */
  readMessage(path: string, emailId: string): Promise<string>;
  /** Claude lee los correos elegidos y propone reglas para quitarlos. No crea nada. */
  extractRules(path: string, emailIds: string[]): Promise<RuleSuggestion[]>;

  listRules(): Promise<Rule[]>;
  /** Crea la regla y la manda a compilar con Claude. */
  createRule(draft: RuleDraft): Promise<Rule>;
  /** Cambiar el texto vuelve a compilar; cambiar solo `enabled` no. */
  updateRule(id: string, patch: RulePatch): Promise<Rule>;
  deleteRule(id: string): Promise<void>;
  compileRule(id: string): Promise<Rule>;
  /** Busca en Gmail lo que cumple la regla. Solo lee. */
  previewRule(id: string): Promise<RulePreview>;
  /** Busca de nuevo y cuenta lo que tocaría «Aplicar». Solo lee. */
  planRule(id: string): Promise<ApplyPlan>;
  /** Aplica una búsqueda de `planRule`. «Borrar para siempre» exige `confirmText === 'BORRAR'`. */
  applyPlan(token: string, confirmText?: string): Promise<HistoryEntry>;
  /** Avisa del progreso de `applyPlan`. Devuelve la función para dejar de escuchar. */
  onApplyProgress(listener: (progress: ApplyProgress) => void): () => void;
  /** Regla con IA: Claude lee los últimos correos de Recibidos y los puntúa. Solo lee. */
  scoreRule(id: string): Promise<RuleScan>;
  /** Avisa del progreso de `scoreRule`. Devuelve la función para dejar de escuchar. */
  onScoreProgress(listener: (progress: ScoreProgress) => void): () => void;
  /** Prepara «Aplicar» sobre los correos elegidos de una pasada de `scoreRule`. */
  planScan(token: string, emailIds: string[]): Promise<ApplyPlan>;
  getHistory(): Promise<History>;
  /** Deshace la última pasada. */
  undoLast(): Promise<HistoryEntry>;

  /** Solo dice si hay clave: la clave nunca vuelve a la interfaz. */
  hasAnthropicKey(): Promise<boolean>;
  setAnthropicKey(key: string): Promise<ConnectResult>;
  clearAnthropicKey(): Promise<void>;
}

/**
 * Proceso principal de Electron: crea la ventana y atiende las peticiones de
 * la interfaz. Toda la red (IMAP) y el acceso a la contraseña ocurren aquí;
 * la interfaz nunca ve la contraseña guardada.
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import {
  GmailImapConnector,
  pickTargets,
  type Collected,
  type GmailCredentials,
  type InboxScan,
} from '../connectors/gmailImap';
import { ClaudeJunkScorer, scoreAll } from '../core/junkClassifier';
import { ClaudeRuleCompiler, type RuleCompiler } from '../core/ruleCompiler';
import { ClaudeRuleExtractor, MAX_EXTRACT_EMAILS } from '../core/ruleExtractor';
import { compileRule, createRule, ruleKind } from '../core/ruleService';
import type { ActionKind, Rule, RuleKind } from '../core/types';
import type {
  ApplyPlan,
  ConnectResult,
  History,
  HistoryEntry,
  RuleDraft,
  RulePatch,
  RuleScan,
  ScanItem,
} from '../shared/ipc';
import { CredentialStore, SecretStore, type Cipher } from './credentials';
import { HistoryStore, markUndone, record, type HistoryState } from './historyStore';
import { RuleStore } from './ruleStore';

let store: CredentialStore;
let creds: GmailCredentials | null = null;
let keyStore: SecretStore;
let anthropicKey: string | null = null;
let ruleStore: RuleStore;
let rules: Rule[] = [];
let historyStore: HistoryStore;
let history: HistoryState = { entries: [], lastUndo: null };

/** Búsquedas de `rules:plan` pendientes de confirmar. */
const plans = new Map<string, { plan: ApplyPlan; ruleText: string; collected: Collected; at: number }>();
/** Una búsqueda caduca: el buzón cambia y el usuario debe ver números frescos. */
const PLAN_TTL_MS = 10 * 60 * 1000;
/** Correos como mucho por pasada; el resto queda para la siguiente. */
const MAX_PER_RUN = 5000;
/** Solo una operación que escribe en Gmail a la vez. */
let busy = false;

/** Pasadas de `rules:score` pendientes de revisar: «Aplicar» solo elige entre estos correos. */
const scans = new Map<string, { ruleId: string; scan: InboxScan; at: number }>();
/** Reglas con IA analizando ahora mismo (cada pasada cuesta dinero: una a la vez por regla). */
const scoring = new Set<string>();
/** Probabilidad a partir de la cual un correo sale ya marcado. */
const SCAN_THRESHOLD = 80;

const ACTIONS: readonly ActionKind[] = ['trash', 'spam', 'archive', 'label', 'delete'];
const KINDS: readonly RuleKind[] = ['filter', 'ai'];
const MAX_RULE_LENGTH = 1000;

const MISSING_KEY = 'Falta tu clave de Anthropic: añádela en Ajustes.';

/** Sin clave, la compilación falla con un mensaje que lleva a Ajustes. */
const missingKeyCompiler: RuleCompiler = {
  compile: () => Promise.reject(new Error(MISSING_KEY)),
  compileClassifier: () => Promise.reject(new Error(MISSING_KEY)),
};

function connector(): GmailImapConnector {
  if (!creds) throw new Error('No hay ninguna cuenta de Gmail conectada.');
  return new GmailImapConnector(creds);
}

/** Valida lo que llega de la interfaz antes de guardarlo. */
function checkDraft(draft: Partial<RuleDraft>, current?: Rule): RuleDraft {
  const text = String(draft.text ?? current?.text ?? '').trim();
  const action = draft.action ?? current?.action;
  const labelName = String(draft.labelName ?? current?.labelName ?? '').trim();
  if (!text) throw new Error('Escribe qué correos quieres quitar de en medio.');
  if (text.length > MAX_RULE_LENGTH) throw new Error('La regla es demasiado larga.');
  if (!action || !ACTIONS.includes(action)) throw new Error('Elige qué hacer con esos correos.');
  if (action === 'label' && !labelName) throw new Error('Escribe el nombre de la etiqueta.');
  // El tipo se elige al crear; al editar manda el de la regla guardada.
  const kind = current ? ruleKind(current) : (draft.kind ?? 'filter');
  if (!KINDS.includes(kind)) throw new Error('Tipo de regla desconocido.');
  return { text, action, ...(action === 'label' ? { labelName } : {}), kind };
}

/** Correos de una regla de filtro; las reglas con IA van por `rules:score`. */
function filterOf(rule: Rule) {
  if (ruleKind(rule) === 'ai') throw new Error('Esta regla es con IA: usa «Analizar con IA».');
  if (!rule.filter) throw new Error('Esta regla aún no está traducida.');
  return rule.filter;
}

function dropExpired(): void {
  const now = Date.now();
  for (const [token, p] of plans) if (now - p.at > PLAN_TTL_MS) plans.delete(token);
  for (const [token, s] of scans) if (now - s.at > PLAN_TTL_MS) scans.delete(token);
}

/** Puntuados de más a menos probable; los que fallaron, al final. */
function sortScan(items: ScanItem[]): ScanItem[] {
  return [...items].sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1));
}

function findRule(id: string): Rule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error('Esa regla ya no existe.');
  return rule;
}

async function putRule(rule: Rule): Promise<Rule> {
  const exists = rules.some((r) => r.id === rule.id);
  rules = exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
  await ruleStore.save(rules);
  return rule;
}

async function compileAndSave(rule: Rule): Promise<Rule> {
  const compiler = anthropicKey
    ? new ClaudeRuleCompiler({ apiKey: anthropicKey })
    : missingKeyCompiler;
  const compiled = await compileRule(rule, compiler, Date.now());
  // Mientras Claude contestaba, la regla pudo borrarse o editarse otra vez.
  const latest = rules.find((r) => r.id === rule.id);
  if (!latest || latest.text !== rule.text) return latest ?? compiled;
  const { filter, classifier, compileStatus, compileError, updatedAt } = compiled;
  return putRule({ ...latest, filter, classifier, compileStatus, compileError, updatedAt });
}

/** Ejecuta `fn` si no hay otra escritura en marcha. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('Ya hay una regla aplicándose. Espera a que termine.');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function publicHistory(): History {
  return { entries: history.entries, undoableId: history.lastUndo?.entryId ?? null };
}

function registerIpc(): void {
  ipcMain.handle('account:get', () => (creds ? { email: creds.email } : null));

  ipcMain.handle(
    'account:connect',
    async (_e, email: string, appPassword: string): Promise<ConnectResult> => {
      const candidate = { email: email.trim(), appPassword: appPassword.replace(/\s+/g, '') };
      if (!candidate.email || !candidate.appPassword) {
        return { ok: false, error: 'Escribe tu correo y la contraseña de aplicación.' };
      }
      try {
        await new GmailImapConnector(candidate).verify();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      await store.save(candidate);
      if (creds?.email !== candidate.email) {
        plans.clear();
        scans.clear();
        history = { ...history, lastUndo: null };
        await historyStore.save(history);
      }
      creds = candidate;
      return { ok: true };
    },
  );

  ipcMain.handle('account:disconnect', async () => {
    await store.clear();
    creds = null;
    // Lo pendiente o deshacible era de esa cuenta: no debe tocar la siguiente.
    plans.clear();
    scans.clear();
    history = { ...history, lastUndo: null };
    await historyStore.save(history);
  });

  ipcMain.handle('mail:folders', () => connector().listFolders());

  ipcMain.handle('mail:list', (_e, path: string, page: number) => connector().listPage(path, page));

  ipcMain.handle('mail:read', async (_e, path: string, emailId: string): Promise<string> => {
    const [found] = await connector().readMessages(String(path), [String(emailId)]);
    if (!found) throw new Error('Este correo ya no está en la carpeta. Pulsa «Actualizar».');
    return found.text;
  });

  ipcMain.handle('mail:extractRules', async (_e, path: string, emailIds: string[]) => {
    if (!anthropicKey) throw new Error(MISSING_KEY);
    if (!Array.isArray(emailIds) || emailIds.length === 0) throw new Error('Marca al menos un correo.');
    if (emailIds.length > MAX_EXTRACT_EMAILS) {
      throw new Error(`Marca ${MAX_EXTRACT_EMAILS} correos como mucho.`);
    }
    const read = await connector().readMessages(String(path), emailIds.map(String));
    if (read.length === 0) throw new Error('Esos correos ya no están en la carpeta. Pulsa «Actualizar».');
    return new ClaudeRuleExtractor({ apiKey: anthropicKey }).extract(
      read.map(({ message, text }) => ({ ...message, text })),
      rules.map((r) => r.text),
    );
  });

  ipcMain.handle('rules:list', () => rules);

  ipcMain.handle('rules:create', async (_e, draft: RuleDraft) => {
    const rule = createRule(checkDraft(draft), randomUUID(), Date.now());
    await putRule(rule);
    return compileAndSave(rule);
  });

  ipcMain.handle('rules:update', async (_e, id: string, patch: RulePatch) => {
    const current = findRule(id);
    const { kind: _kind, ...draft } = checkDraft(patch, current);
    const updated: Rule = {
      ...current,
      ...draft,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      updatedAt: Date.now(),
    };
    if (draft.action !== 'label') delete updated.labelName;
    await putRule(updated);
    return draft.text !== current.text ? compileAndSave(updated) : updated;
  });

  ipcMain.handle('rules:delete', async (_e, id: string) => {
    rules = rules.filter((r) => r.id !== id);
    await ruleStore.save(rules);
  });

  ipcMain.handle('rules:compile', (_e, id: string) => compileAndSave(findRule(id)));

  ipcMain.handle('rules:preview', (_e, id: string) => connector().search(filterOf(findRule(id))));

  /** Guarda lo que tocaría «Aplicar» para que el usuario lo confirme. */
  const savePlan = (rule: Rule, collected: Collected): ApplyPlan => {
    dropExpired();
    const plan: ApplyPlan = {
      token: randomUUID(),
      ruleId: rule.id,
      action: rule.action,
      ...(rule.labelName ? { labelName: rule.labelName } : {}),
      count: collected.targets.length,
      total: collected.total,
      approximate: collected.approximate,
    };
    plans.set(plan.token, { plan, ruleText: rule.text, collected, at: Date.now() });
    return plan;
  };

  ipcMain.handle('rules:plan', async (_e, id: string): Promise<ApplyPlan> => {
    const rule = findRule(id);
    const collected = await connector().collect(filterOf(rule), rule.action, rule.labelName, MAX_PER_RUN);
    return savePlan(rule, collected);
  });

  ipcMain.handle('rules:score', async (e, id: string): Promise<RuleScan> => {
    const rule = findRule(id);
    if (ruleKind(rule) !== 'ai') throw new Error('Esta regla no es con IA.');
    if (!anthropicKey) throw new Error(MISSING_KEY);
    const classifier = rule.classifier;
    if (!classifier) throw new Error('Esta regla aún no está traducida.');
    if (scoring.has(id)) throw new Error('Esta regla ya se está analizando.');
    scoring.add(id);
    try {
      const scan = await connector().recentInbox(rule.action, rule.labelName);
      const send = (done: number, total: number) => {
        if (!e.sender.isDestroyed()) e.sender.send('rules:scoreProgress', { ruleId: id, done, total });
      };
      send(0, scan.items.length);
      const results = await scoreAll(
        classifier,
        scan.items.map((i) => ({ ...i.message, text: i.text })),
        new ClaudeJunkScorer({ apiKey: anthropicKey }),
        { onProgress: send },
      );
      dropExpired();
      const token = randomUUID();
      scans.set(token, { ruleId: id, scan, at: Date.now() });
      const items = scan.items.map((i, n): ScanItem => {
        const r = results[n]!;
        return r.error
          ? { message: i.message, probability: null, reason: '', error: r.error }
          : { message: i.message, probability: r.probability, reason: r.reason };
      });
      return { token, ruleId: id, items: sortScan(items), threshold: SCAN_THRESHOLD };
    } finally {
      scoring.delete(id);
    }
  });

  ipcMain.handle('rules:planScan', (_e, token: string, emailIds: string[]): ApplyPlan => {
    const pending = scans.get(token);
    if (!pending || Date.now() - pending.at > PLAN_TTL_MS) {
      scans.delete(token);
      throw new Error('Este análisis ha caducado. Vuelve a pulsar «Analizar con IA».');
    }
    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      throw new Error('Marca al menos un correo.');
    }
    const rule = findRule(pending.ruleId);
    // Solo correos de esta pasada: la interfaz no puede colar otros.
    return savePlan(rule, pickTargets(pending.scan, emailIds.map(String)));
  });

  ipcMain.handle('rules:apply', (e, token: string, confirmText?: string) =>
    exclusive(async (): Promise<HistoryEntry> => {
      const pending = plans.get(token);
      if (!pending || Date.now() - pending.at > PLAN_TTL_MS) {
        plans.delete(token);
        throw new Error('Esta búsqueda ha caducado. Vuelve a pulsar «Aplicar».');
      }
      const { plan, ruleText, collected } = pending;
      if (plan.action === 'delete' && confirmText !== 'BORRAR') {
        throw new Error('Para borrar para siempre escribe BORRAR.');
      }
      plans.delete(token);

      const result = await connector().execute(plan.action, collected, plan.labelName, (done, total) => {
        if (!e.sender.isDestroyed()) e.sender.send('rules:progress', { token, done, total });
      });
      const entry: HistoryEntry = {
        id: randomUUID(),
        ruleId: plan.ruleId,
        ruleText,
        action: plan.action,
        ...(plan.labelName ? { labelName: plan.labelName } : {}),
        count: result.done,
        at: Date.now(),
        ...(result.error ? { error: result.error } : {}),
        undone: false,
      };
      // Aunque Gmail falle a mitad, lo ya hecho queda apuntado y se puede deshacer.
      history = record(history, entry, result.undo);
      await historyStore.save(history);
      return entry;
    }),
  );

  ipcMain.handle('history:get', () => publicHistory());

  ipcMain.handle('history:undo', () =>
    exclusive(async (): Promise<HistoryEntry> => {
      const last = history.lastUndo;
      if (!last) throw new Error('No hay nada que deshacer.');
      await connector().undo(last.data);
      history = markUndone(history);
      await historyStore.save(history);
      const entry = history.entries.find((x) => x.id === last.entryId);
      if (!entry) throw new Error('No se encontró esa pasada en el historial.');
      return entry;
    }),
  );

  ipcMain.handle('settings:hasKey', () => anthropicKey !== null);

  ipcMain.handle('settings:setKey', async (_e, key: string): Promise<ConnectResult> => {
    const clean = typeof key === 'string' ? key.trim() : '';
    if (!/^sk-ant-[\w-]{20,}$/.test(clean)) {
      return { ok: false, error: 'Eso no parece una clave de Anthropic (empieza por «sk-ant-»).' };
    }
    await keyStore.save(clean);
    anthropicKey = clean;
    return { ok: true };
  });

  ipcMain.handle('settings:clearKey', async () => {
    await keyStore.clear();
    anthropicKey = null;
  });

  ipcMain.handle('shell:open', async (_e, url: string) => {
    // Solo enlaces web: la interfaz no debe poder abrir archivos locales.
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#07070d',
    title: 'matamoscas',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const rendererDir = join(__dirname, '..', 'web', 'renderer');
  void win.loadFile(join(rendererDir, 'index.html'));
  if (process.env.MATAMOSCAS_DEV) reloadOnChange(win, rendererDir);
}

/**
 * Solo con `npm run dev`: recarga la ventana cuando cambia la interfaz
 * compilada. Compara el contenido porque el compilador reescribe archivos
 * aunque no hayan cambiado.
 */
function reloadOnChange(win: BrowserWindow, dir: string): void {
  const seen = new Map<string, string>();
  const read = (file: string) => {
    try {
      return readFileSync(join(dir, file), 'utf8');
    } catch {
      return '';
    }
  };
  for (const file of ['index.html', 'styles.css', 'app.js']) seen.set(file, read(file));

  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, (_event, file) => {
    if (!file || !seen.has(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...seen.keys()].filter((f) => read(f) !== seen.get(f));
      if (changed.length === 0 || win.isDestroyed()) return;
      for (const f of changed) seen.set(f, read(f));
      console.log(`[dev] recargando ventana (${changed.join(', ')})`);
      win.webContents.reloadIgnoringCache();
    }, 150);
  });
  win.on('closed', () => watcher.close());
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  const cipher: Cipher = {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  };
  store = new CredentialStore(join(dataDir, 'accounts.json'), cipher);
  keyStore = new SecretStore(join(dataDir, 'anthropic-key.json'), cipher);
  ruleStore = new RuleStore(join(dataDir, 'rules.json'));
  historyStore = new HistoryStore(join(dataDir, 'history.json'));
  // Archivo dañado o cifrado por otro usuario de Windows: se pide de nuevo.
  creds = await store.load().catch(() => null);
  anthropicKey = await keyStore.load().catch(() => null);
  rules = await ruleStore.load().catch(() => []);
  history = await historyStore.load().catch(() => ({ entries: [], lastUndo: null }));
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

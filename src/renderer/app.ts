/**
 * Interfaz de matamoscas: pantalla para conectar Gmail, bandeja de lectura,
 * reglas y ajustes. Habla con el proceso principal solo a través de
 * `window.matamoscas`.
 *
 * Los textos de los correos (y de las reglas) se pintan siempre con
 * `textContent`, nunca como HTML.
 */
import type {
  ApplyPlan,
  Folder,
  History,
  HistoryEntry,
  MatamoscasApi,
  RulePreview,
  RuleScan,
  ScanItem,
} from '../shared/ipc';
import type {
  ActionKind,
  Filter,
  Message,
  Rule,
  RuleKind,
  RuleSuggestion,
  SuggestedAction,
} from '../core/types';

declare global {
  interface Window {
    matamoscas: MatamoscasApi;
  }
}

const api = window.matamoscas;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta el elemento #${id}`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(target: HTMLElement, message: string | null): void {
  target.textContent = message ?? '';
  target.hidden = message === null;
}

function errorText(err: unknown): string {
  // Electron antepone "Error invoking remote method '...': Error: " al mensaje.
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

// ---------- Pantalla 1 · Conectar ----------

const connectScreen = $<HTMLElement>('connect-screen');
const connectForm = $<HTMLFormElement>('connect-form');
const emailInput = $<HTMLInputElement>('email');
const passInput = $<HTMLInputElement>('pass');
const togglePass = $<HTMLButtonElement>('toggle-pass');
const connectBtn = $<HTMLButtonElement>('connect-btn');
const connectError = $<HTMLElement>('connect-error');

togglePass.addEventListener('click', () => {
  const show = passInput.type === 'password';
  passInput.type = show ? 'text' : 'password';
  togglePass.setAttribute('aria-pressed', String(show));
  togglePass.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
});

connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(connectError, null);
  const email = emailInput.value.trim();
  if (!email || !passInput.value.trim()) {
    showError(connectError, 'Escribe tu correo y la contraseña de aplicación.');
    return;
  }
  connectBtn.disabled = true;
  connectBtn.textContent = 'Conectando…';
  try {
    const result = await api.connect(email, passInput.value);
    if (!result.ok) {
      showError(connectError, result.error);
      return;
    }
    passInput.value = '';
    await openInbox(email);
  } catch (err) {
    showError(connectError, errorText(err));
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Conectar y ver mis correos';
  }
});

document.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-external]');
  if (!link) return;
  e.preventDefault();
  void api.openExternal(link.href);
});

function showConnect(): void {
  inboxScreen.hidden = true;
  connectScreen.hidden = false;
  emailInput.focus();
}

// ---------- Pantalla 2 · Bandeja ----------

const inboxScreen = $<HTMLElement>('inbox-screen');
const accountEmail = $<HTMLElement>('account-email');
const foldersNav = $<HTMLElement>('folders');
const folderTitle = $<HTMLElement>('folder-title');
const folderCount = $<HTMLElement>('folder-count');
const searchInput = $<HTMLInputElement>('search');
const messagesBox = $<HTMLElement>('messages');
const pageRange = $<HTMLElement>('page-range');
const pageLabel = $<HTMLElement>('page-label');
const prevBtn = $<HTMLButtonElement>('prev-btn');
const nextBtn = $<HTMLButtonElement>('next-btn');
const refreshBtn = $<HTMLButtonElement>('refresh-btn');
const disconnectBtn = $<HTMLButtonElement>('disconnect-btn');
const inboxError = $<HTMLElement>('inbox-error');

const state = {
  folders: [] as Folder[],
  current: null as Folder | null,
  messages: [] as Message[],
  total: 0,
  page: 0,
  pageSize: 50,
  hasMore: false,
  loading: false,
  /** Correos marcados de la página actual, por id. */
  selected: new Map<string, Message>(),
  /** Correos desplegados. */
  expanded: new Set<string>(),
};

/** Cuerpo de un correo desplegado: se pide la primera vez que se abre. */
type BodyState = { status: 'loading' } | { status: 'done'; text: string } | { status: 'error'; error: string };
const bodies = new Map<string, BodyState>();

async function openInbox(email: string): Promise<void> {
  accountEmail.textContent = email;
  connectScreen.hidden = true;
  inboxScreen.hidden = false;
  void loadRules();
  await refresh();
}

async function refresh(): Promise<void> {
  showError(inboxError, null);
  refreshBtn.disabled = true;
  try {
    state.folders = await api.listFolders();
    const keep = state.current && state.folders.find((f) => f.path === state.current?.path);
    state.current = keep ?? state.folders[0] ?? null;
    renderFolders();
    if (state.current) folderTitle.textContent = state.current.name;
    await loadPage(keep ? state.page : 0);
  } catch (err) {
    showError(inboxError, errorText(err));
  } finally {
    refreshBtn.disabled = false;
  }
}

/** Cada carga lleva un número; solo se pinta la respuesta de la última. */
let lastRequest = 0;

/** Carga la página `page` de la carpeta actual y sustituye la lista. */
async function loadPage(page: number): Promise<void> {
  const folder = state.current;
  if (!folder) {
    state.messages = [];
    renderMessages();
    return;
  }
  const request = ++lastRequest;
  state.loading = true;
  showError(inboxError, null);
  renderPlaceholder('Cargando correos…');
  updatePager();
  try {
    const result = await api.listMessages(folder.path, page);
    if (request !== lastRequest) return; // llegó otra petición mientras tanto
    state.messages = result.messages;
    state.total = result.total;
    state.page = result.page;
    state.pageSize = result.pageSize;
    state.hasMore = result.hasMore;
    // Como en Gmail, lo marcado y lo desplegado solo vale para la página a la vista.
    const ids = new Set(result.messages.map((m) => m.id));
    for (const id of state.selected.keys()) if (!ids.has(id)) state.selected.delete(id);
    for (const id of state.expanded) if (!ids.has(id)) state.expanded.delete(id);
  } catch (err) {
    if (request === lastRequest) showError(inboxError, errorText(err));
  } finally {
    if (request === lastRequest) {
      state.loading = false;
      renderMessages();
      messagesBox.scrollTop = 0;
    }
  }
}

function updatePager(): void {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const first = state.total === 0 ? 0 : state.page * state.pageSize + 1;
  const last = Math.min(state.total, (state.page + 1) * state.pageSize);
  pageRange.textContent = `${formatCount(first)}–${formatCount(last)} de ${formatCount(state.total)}`;
  pageLabel.textContent = `Página ${formatCount(state.page + 1)} de ${formatCount(pages)}`;
  prevBtn.disabled = state.loading || state.page === 0;
  nextBtn.disabled = state.loading || !state.hasMore;
}

function renderFolders(): void {
  foldersNav.replaceChildren(
    ...state.folders.map((f) => {
      const btn = el('button', 'folder');
      btn.type = 'button';
      markCurrent(btn, view === 'mail' && f === state.current);
      btn.append(el('span', undefined, f.name));
      if (f.unread > 0 && f.kind !== 'all' && f.kind !== 'sent') {
        btn.append(el('span', 'folder__count', formatCount(f.unread)));
      }
      btn.addEventListener('click', () => {
        if (f === state.current) {
          showView('mail');
          return;
        }
        state.current = f;
        searchInput.value = '';
        folderTitle.textContent = f.name;
        state.total = f.total;
        state.page = 0;
        showView('mail');
        void loadPage(0);
      });
      return btn;
    }),
  );
}

function renderPlaceholder(text: string): void {
  messagesBox.replaceChildren(el('p', 'list__empty', text));
}

/** Correos de la página que pasan la búsqueda. */
function visibleMessages(): Message[] {
  const query = searchInput.value.trim().toLowerCase();
  return query
    ? state.messages.filter((m) =>
        [m.from, m.fromName ?? '', m.subject].some((s) => s.toLowerCase().includes(query)),
      )
    : state.messages;
}

function renderMessages(): void {
  const query = searchInput.value.trim().toLowerCase();
  const visible = visibleMessages();
  syncSelectionBar();

  folderCount.textContent = query
    ? `${formatCount(state.total)} correos · ${formatCount(visible.length)} coinciden en esta página`
    : `${formatCount(state.total)} correos`;
  updatePager();

  if (visible.length === 0) {
    const text = query
      ? 'Ningún correo de esta página coincide con la búsqueda.'
      : 'No hay correos en esta carpeta.';
    messagesBox.replaceChildren(el('p', 'list__empty', text));
    return;
  }
  messagesBox.replaceChildren(...visible.map(renderInboxItem));
}

/** Correo de la bandeja: casilla para marcarlo y fila que se despliega con el cuerpo. */
function renderInboxItem(m: Message): HTMLElement {
  const item = el('div', state.selected.has(m.id) ? 'inbox-item inbox-item--selected' : 'inbox-item');
  const check = el('input', 'inbox-item__check');
  check.type = 'checkbox';
  check.checked = state.selected.has(m.id);
  check.setAttribute('aria-label', `Marcar: ${m.subject || '(sin asunto)'}`);
  check.addEventListener('change', () => {
    if (check.checked) state.selected.set(m.id, m);
    else state.selected.delete(m.id);
    item.classList.toggle('inbox-item--selected', check.checked);
    syncSelectionBar();
  });

  const main = el('div', 'inbox-item__main');
  const row = renderMessage(m);
  const body = el('div', 'inbox-item__body');
  body.id = `mail-body-${m.id}`;
  const open = state.expanded.has(m.id);
  body.hidden = !open;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-expanded', String(open));
  row.setAttribute('aria-controls', body.id);
  row.append(chevron());
  // Abrir o cerrar no repinta la lista: así no salta el scroll.
  const toggle = () => {
    const now = !state.expanded.has(m.id);
    if (now) state.expanded.add(m.id);
    else state.expanded.delete(m.id);
    row.setAttribute('aria-expanded', String(now));
    body.hidden = !now;
    if (now) fillBody(body, m);
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  if (open) fillBody(body, m);
  main.append(row, body);
  item.append(check, main);
  return item;
}

function chevron(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'mail__chevron');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.append(path);
  return svg;
}

/** Pinta el cuerpo de un correo desplegado; la primera vez lo pide a Gmail. */
function fillBody(box: HTMLElement, m: Message): void {
  const body = bodies.get(m.id);
  const meta = el('div', 'inbox-item__meta');
  meta.append(el('span', undefined, m.fromName ? `${m.fromName} <${m.from}>` : m.from || '(sin remitente)'));
  if (m.receivedAt) meta.append(el('span', undefined, new Date(m.receivedAt).toLocaleString('es-ES')));

  if (!body || body.status === 'loading') {
    box.replaceChildren(meta, el('p', 'muted small', 'Abriendo el correo…'));
    if (!body) void loadBody(m);
    return;
  }
  if (body.status === 'error') {
    const retry = el('button', 'btn-ghost btn--sm panel__end', 'Reintentar');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      bodies.delete(m.id);
      fillBody(box, m);
    });
    box.replaceChildren(meta, el('p', 'error', body.error), retry);
    return;
  }

  const extractOne = el('button', 'btn-secondary btn--sm panel__end', 'Extraer reglas de este correo');
  extractOne.type = 'button';
  extractOne.disabled = extract?.status === 'loading';
  extractOne.addEventListener('click', () => void startExtract([m]));
  box.replaceChildren(meta, el('pre', 'inbox-item__text', body.text || '(Este correo no tiene texto.)'), extractOne);
}

async function loadBody(m: Message): Promise<void> {
  const folder = state.current;
  if (!folder) return;
  bodies.set(m.id, { status: 'loading' });
  let next: BodyState;
  try {
    next = { status: 'done', text: await api.readMessage(folder.path, m.id) };
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  bodies.set(m.id, next);
  // La lista pudo repintarse mientras tanto: buscamos el desplegable que haya ahora.
  const box = document.getElementById(`mail-body-${m.id}`);
  if (box && state.expanded.has(m.id)) fillBody(box, m);
}

// ---------- Marcar correos y extraer reglas ----------

const selectAll = $<HTMLInputElement>('select-all');
const selectionCount = $<HTMLElement>('selection-count');
const clearSelection = $<HTMLButtonElement>('clear-selection');
const extractBtn = $<HTMLButtonElement>('extract-btn');
const extractLabel = $<HTMLElement>('extract-label');
const extractPanel = $<HTMLElement>('extract-panel');

/** Correos como mucho por extracción (igual que en el proceso principal). */
const MAX_EXTRACT = 50;

/** Una propuesta de Claude, con lo que el usuario cambie antes de crearla. */
interface SuggestionDraft {
  suggestion: RuleSuggestion;
  text: string;
  action: SuggestedAction;
  status: 'idle' | 'creating' | 'created' | 'error';
  error?: string;
}

type ExtractState =
  | { status: 'loading'; count: number }
  | { status: 'done'; emails: Map<string, Message>; drafts: SuggestionDraft[] }
  | { status: 'error'; error: string };

let extract: ExtractState | null = null;

function syncSelectionBar(): void {
  const n = state.selected.size;
  const visible = visibleMessages();
  const marked = visible.filter((m) => state.selected.has(m.id)).length;
  selectAll.disabled = visible.length === 0;
  selectAll.checked = visible.length > 0 && marked === visible.length;
  selectAll.indeterminate = marked > 0 && marked < visible.length;
  selectionCount.textContent =
    n === 0
      ? 'Marca correos para sacar reglas de ellos'
      : n === 1
        ? '1 correo marcado'
        : `${formatCount(n)} correos marcados`;
  clearSelection.hidden = n === 0;
  const loading = extract?.status === 'loading';
  extractBtn.disabled = n === 0 || n > MAX_EXTRACT || loading;
  extractBtn.title = n > MAX_EXTRACT ? `Marca ${MAX_EXTRACT} como mucho` : '';
  extractLabel.textContent = loading ? 'Claude está leyendo…' : 'Extraer reglas de eliminación';
}

selectAll.addEventListener('change', () => {
  for (const m of visibleMessages()) {
    if (selectAll.checked) state.selected.set(m.id, m);
    else state.selected.delete(m.id);
  }
  renderMessages();
});

clearSelection.addEventListener('click', () => {
  state.selected.clear();
  renderMessages();
});

extractBtn.addEventListener('click', () => void startExtract([...state.selected.values()]));

/** Claude lee los correos y propone reglas. No crea nada hasta que el usuario lo pide. */
async function startExtract(emails: Message[]): Promise<void> {
  const folder = state.current;
  if (!folder || emails.length === 0) return;
  extract = { status: 'loading', count: emails.length };
  renderExtract();
  syncSelectionBar();
  let next: ExtractState;
  try {
    const suggestions = await api.extractRules(folder.path, emails.map((m) => m.id));
    next = {
      status: 'done',
      emails: new Map(emails.map((m) => [m.id, m])),
      drafts: suggestions.map((s) => ({ suggestion: s, text: s.text, action: s.action, status: 'idle' })),
    };
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  // Si lo cerraron mientras Claude leía, no lo volvemos a abrir.
  if (!extract) return;
  extract = next;
  renderExtract();
  syncSelectionBar();
}

const SUGGESTED_ACTIONS: SuggestedAction[] = ['trash', 'spam', 'archive'];

function renderExtract(): void {
  extractPanel.hidden = extract === null;
  if (!extract) return;

  const head = el('div', 'extract__head');
  const titles = el('div');
  const close = el('button', 'btn-ghost btn--sm', 'Cerrar');
  close.type = 'button';
  close.addEventListener('click', () => {
    extract = null;
    renderExtract();
    syncSelectionBar();
  });
  head.append(titles, close);

  if (extract.status === 'loading') {
    const n = extract.count;
    titles.append(
      el('strong', undefined, n === 1 ? 'Claude está leyendo el correo…' : `Claude está leyendo ${formatCount(n)} correos…`),
      el('span', 'muted small', 'Buscará qué tienen en común para proponerte reglas. No se toca nada.'),
    );
    extractPanel.replaceChildren(head, el('progress'));
    return;
  }
  if (extract.status === 'error') {
    titles.append(el('strong', undefined, 'No se pudieron sacar reglas'));
    extractPanel.replaceChildren(head, el('p', 'error', extract.error));
    return;
  }

  const { drafts, emails } = extract;
  titles.append(
    el(
      'strong',
      undefined,
      drafts.length === 0
        ? 'Claude no ve una regla segura para estos correos'
        : drafts.length === 1
          ? 'Claude propone 1 regla'
          : `Claude propone ${formatCount(drafts.length)} reglas`,
    ),
    el(
      'span',
      'muted small',
      drafts.length === 0
        ? 'Puede que sean correos que conviene conservar. Prueba a marcar otros.'
        : 'Revísalas, cámbialas si quieres y crea las que te convenzan. Después podrás ver qué correos tocan antes de aplicarlas.',
    ),
  );
  extractPanel.replaceChildren(head, ...drafts.map((d) => renderSuggestion(d, emails)));
}

function renderSuggestion(draft: SuggestionDraft, emails: Map<string, Message>): HTMLElement {
  const { suggestion } = draft;
  const done = draft.status === 'created';
  const card = el('article', done ? 'suggestion suggestion--created' : 'suggestion');

  const text = el('textarea', 'input textarea');
  text.rows = 2;
  text.maxLength = 1000;
  text.value = draft.text;
  text.disabled = done || draft.status === 'creating';
  text.setAttribute('aria-label', 'Texto de la regla');
  text.addEventListener('input', () => {
    draft.text = text.value;
  });

  const chips = el('div', 'suggestion__row');
  chips.append(
    el('span', 'chip chip--brand', suggestion.kind === 'ai' ? 'Con IA' : 'Filtro'),
    el(
      'span',
      'chip',
      suggestion.emailIds.length === 1
        ? 'Cubre 1 correo marcado'
        : `Cubre ${formatCount(suggestion.emailIds.length)} correos marcados`,
    ),
  );
  card.append(text, chips);
  if (suggestion.why) card.append(el('p', 'suggestion__why', suggestion.why));

  const covered = suggestion.emailIds.flatMap((id) => emails.get(id) ?? []);
  if (covered.length > 0) {
    const details = el('details', 'suggestion__covers');
    const list = el('ul');
    list.append(
      ...covered.map((m) => el('li', undefined, `${m.fromName || m.from} — ${m.subject || '(sin asunto)'}`)),
    );
    details.append(el('summary', undefined, 'Ver qué correos cubre'), list);
    card.append(details);
  }

  const row = el('div', 'suggestion__row');
  if (done) {
    const go = el('button', 'btn-secondary btn--sm', 'Ver en Reglas');
    go.type = 'button';
    go.addEventListener('click', () => showView('rules'));
    row.append(el('span', 'chip chip--ok', `Creada · ${ACTION_NAMES[draft.action]}`), go);
  } else {
    const action = el('select', 'input select');
    action.setAttribute('aria-label', 'Qué hacer con esos correos');
    action.disabled = draft.status === 'creating';
    for (const a of SUGGESTED_ACTIONS) {
      const option = el('option', undefined, ACTION_NAMES[a]);
      option.value = a;
      option.selected = a === draft.action;
      action.append(option);
    }
    action.addEventListener('change', () => {
      draft.action = action.value as SuggestedAction;
    });
    const create = el('button', 'btn-secondary btn--sm', draft.status === 'creating' ? 'Creando…' : 'Crear regla');
    create.type = 'button';
    create.disabled = draft.status === 'creating';
    create.addEventListener('click', () => void createFromSuggestion(draft));
    row.append(action, create);
  }
  card.append(row);
  if (draft.status === 'error' && draft.error) card.append(el('p', 'error', draft.error));
  return card;
}

/** Crea la regla propuesta; se traduce como cualquier otra. */
async function createFromSuggestion(draft: SuggestionDraft): Promise<void> {
  const text = draft.text.trim();
  if (!text) {
    draft.status = 'error';
    draft.error = 'Escribe qué correos quieres quitar de en medio.';
    renderExtract();
    return;
  }
  draft.status = 'creating';
  draft.error = undefined;
  renderExtract();
  try {
    const rule = await api.createRule({ text, action: draft.action, kind: draft.suggestion.kind });
    rulesState.rules = [...rulesState.rules.filter((r) => r.id !== rule.id), rule];
    draft.status = 'created';
    renderRules();
  } catch (err) {
    draft.status = 'error';
    draft.error = errorText(err);
  }
  renderExtract();
}

function renderMessage(m: Message): HTMLElement {
  const row = el('div', m.unread ? 'mail mail--unread' : 'mail');
  const sender = m.fromName || m.from || '(sin remitente)';
  const from = el('div', 'mail__from', sender);
  from.title = m.from;
  const text = el('div', 'mail__text');
  text.append(el('span', 'mail__subject', m.subject || '(sin asunto)'));
  if (m.snippet) text.append(el('span', 'mail__snippet', ` — ${m.snippet}`));
  const date = el('div', 'mail__date', formatDate(m.receivedAt));
  if (m.receivedAt) date.title = new Date(m.receivedAt).toLocaleString('es-ES');
  const dot = el('span', 'mail__dot');
  dot.setAttribute('aria-hidden', 'true');
  row.append(dot, from, text, date);
  if (m.unread) row.setAttribute('aria-label', `Sin leer: ${sender}, ${m.subject}`);
  return row;
}

const numberFmt = new Intl.NumberFormat('es-ES');
const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const yearFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

function formatCount(n: number): string {
  return numberFmt.format(n);
}

/** Hoy → "10:42", ayer → "Ayer", este año → "20 oct", antes → "20 oct 2024". */
function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return timeFmt.format(d);
  if (ms >= startOfToday - 24 * 60 * 60 * 1000) return 'Ayer';
  return (d.getFullYear() === today.getFullYear() ? dayFmt : yearFmt).format(d).replace('.', '');
}

searchInput.addEventListener('input', renderMessages);
prevBtn.addEventListener('click', () => void loadPage(state.page - 1));
nextBtn.addEventListener('click', () => void loadPage(state.page + 1));
refreshBtn.addEventListener('click', () => void refresh());
disconnectBtn.addEventListener('click', async () => {
  await api.disconnect();
  state.folders = [];
  state.current = null;
  state.messages = [];
  emailInput.value = accountEmail.textContent ?? '';
  showView('mail');
  showConnect();
});

// ---------- Vistas: correos, reglas y ajustes ----------

type View = 'mail' | 'rules' | 'settings';

const mailView = $<HTMLElement>('mail-view');
const rulesView = $<HTMLElement>('rules-view');
const settingsView = $<HTMLElement>('settings-view');
const navRules = $<HTMLButtonElement>('nav-rules');
const navSettings = $<HTMLButtonElement>('nav-settings');

let view: View = 'mail';

function markCurrent(btn: HTMLElement, current: boolean): void {
  if (current) btn.setAttribute('aria-current', 'page');
  else btn.removeAttribute('aria-current');
}

function showView(next: View): void {
  view = next;
  mailView.hidden = next !== 'mail';
  rulesView.hidden = next !== 'rules';
  settingsView.hidden = next !== 'settings';
  markCurrent(navRules, next === 'rules');
  markCurrent(navSettings, next === 'settings');
  renderFolders();
  if (next === 'rules') renderRules();
  if (next === 'settings') renderKeyStatus();
}

navRules.addEventListener('click', () => showView('rules'));
navSettings.addEventListener('click', () => showView('settings'));

// ---------- Reglas ----------

const rulesCount = $<HTMLElement>('rules-count');
const keyMissing = $<HTMLElement>('key-missing');
const goSettings = $<HTMLButtonElement>('go-settings');
const ruleForm = $<HTMLFormElement>('rule-form');
const ruleText = $<HTMLTextAreaElement>('rule-text');
const ruleKind = $<HTMLDivElement>('rule-kind');
const ruleAction = $<HTMLSelectElement>('rule-action');
const labelField = $<HTMLElement>('label-field');
const ruleLabel = $<HTMLInputElement>('rule-label');
const deleteConfirm = $<HTMLElement>('delete-confirm');
const deleteOk = $<HTMLInputElement>('delete-ok');
const ruleBtn = $<HTMLButtonElement>('rule-btn');
const ruleError = $<HTMLElement>('rule-error');
const rulesError = $<HTMLElement>('rules-error');
const rulesBox = $<HTMLElement>('rules');
const historyPanel = $<HTMLElement>('history-panel');
const historyBox = $<HTMLElement>('history');
const historyError = $<HTMLElement>('history-error');

const ACTION_NAMES: Record<ActionKind, string> = {
  trash: 'A la papelera',
  spam: 'Marcar como spam',
  archive: 'Archivar',
  label: 'Etiquetar',
  delete: 'Borrar para siempre',
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'done'; result: RulePreview }
  | { status: 'error'; error: string };

/** Un «Aplicar» en curso: contar → confirmar → aplicar → resultado. */
type ApplyState =
  | { status: 'planning' }
  | { status: 'confirm'; plan: ApplyPlan; typed: string }
  | { status: 'running'; plan: ApplyPlan; done: number }
  | { status: 'done'; entry: HistoryEntry }
  | { status: 'error'; error: string };

/** Un «Analizar con IA»: Claude puntúa los correos y el usuario elige cuáles tocar. */
type ScanState =
  | { status: 'loading'; done: number; total: number }
  | { status: 'done'; scan: RuleScan; selected: Set<string> }
  | { status: 'error'; error: string };

const rulesState = {
  rules: [] as Rule[],
  hasKey: false,
  /** Reglas con una petición en curso (traducir, activar…). */
  busy: new Set<string>(),
  /** Vistas previas abiertas, por id de regla. */
  previews: new Map<string, PreviewState>(),
  /** «Aplicar» abiertos, por id de regla. */
  applies: new Map<string, ApplyState>(),
  /** Análisis con IA abiertos, por id de regla. */
  scans: new Map<string, ScanState>(),
  history: { entries: [], undoableId: null } as History,
  undoing: false,
};

async function loadRules(): Promise<void> {
  try {
    [rulesState.rules, rulesState.hasKey, rulesState.history] = await Promise.all([
      api.listRules(),
      api.hasAnthropicKey(),
      api.getHistory(),
    ]);
  } catch (err) {
    showError(rulesError, errorText(err));
  }
  renderRules();
  renderKeyStatus();
}

function renderRules(): void {
  rulesCount.textContent = rulesState.rules.length ? formatCount(rulesState.rules.length) : '';
  keyMissing.hidden = rulesState.hasKey;
  renderHistory();
  if (rulesState.rules.length === 0) {
    rulesBox.replaceChildren(
      el('p', 'muted small', 'Aún no tienes reglas. Escribe la primera arriba.'),
    );
    return;
  }
  // La más reciente, arriba.
  rulesBox.replaceChildren(...[...rulesState.rules].reverse().map(renderRule));
}

function renderRule(rule: Rule): HTMLElement {
  const busy = rulesState.busy.has(rule.id);
  const ai = rule.kind === 'ai';
  const card = el('article', rule.enabled ? 'card rule' : 'card rule rule--off');

  const head = el('div', 'rule__head');
  const toggle = el('label', 'switch');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = rule.enabled;
  check.disabled = busy;
  check.addEventListener('change', () => {
    void changeRule(rule.id, () => api.updateRule(rule.id, { enabled: check.checked }));
  });
  toggle.append(check, el('span', undefined, 'Activa'));
  head.append(el('p', 'rule__text', rule.text), toggle);

  const chips = el('div', 'rule__chips');
  const actionName =
    rule.action === 'label' ? `Etiquetar: ${rule.labelName ?? ''}` : ACTION_NAMES[rule.action];
  chips.append(el('span', rule.action === 'delete' ? 'chip chip--danger' : 'chip', actionName));
  if (ai) chips.append(el('span', 'chip chip--brand', 'Con IA'));
  if (busy && rule.compileStatus !== 'compiled') {
    chips.append(el('span', 'chip', 'Traduciendo…'));
  } else if (rule.compileStatus === 'compiled') {
    chips.append(el('span', 'chip chip--ok', 'Traducida'));
  } else if (rule.compileStatus === 'error') {
    chips.append(el('span', 'chip chip--error', 'No se pudo traducir'));
  } else {
    chips.append(el('span', 'chip', 'Sin traducir'));
  }
  card.append(head, chips);

  if (rule.compileStatus === 'compiled' && rule.filter) {
    const filter = el('div', 'rule__filter');
    filter.append(
      el('span', 'muted small', 'Busca correos:'),
      ...describeFilter(rule.filter).map((t) => el('span', 'chip chip--brand', t)),
    );
    card.append(filter);
  }
  if (ai && rule.compileStatus === 'compiled' && rule.classifier) {
    const prompt = el('details', 'rule__prompt');
    prompt.append(
      el('summary', undefined, 'Ver las instrucciones que sigue Claude'),
      el('pre', undefined, rule.classifier.instructions),
    );
    card.append(prompt);
  }
  if (rule.compileStatus === 'error' && rule.compileError) {
    card.append(el('p', 'error', rule.compileError));
  }

  const actions = el('div', 'rule__actions');
  const preview = rulesState.previews.get(rule.id);
  const apply = rulesState.applies.get(rule.id);
  const scan = rulesState.scans.get(rule.id);
  const applying = apply !== undefined && apply.status !== 'done' && apply.status !== 'error';
  if (ai && rule.compileStatus === 'compiled') {
    const scanning = scan?.status === 'loading';
    const scanBtn = el(
      'button',
      'btn-secondary',
      scanning ? 'Analizando…' : scan ? 'Analizar de nuevo' : 'Analizar con IA',
    );
    scanBtn.type = 'button';
    scanBtn.disabled = busy || scanning || applying;
    scanBtn.addEventListener('click', () => void startScan(rule.id));
    actions.append(scanBtn);
  } else if (rule.compileStatus === 'compiled') {
    const previewBtn = el('button', 'btn-secondary', preview ? 'Ocultar correos' : 'Ver correos');
    previewBtn.type = 'button';
    previewBtn.disabled = busy;
    previewBtn.addEventListener('click', () => void togglePreview(rule.id));
    const applyBtn = el('button', 'btn-secondary', apply?.status === 'planning' ? 'Contando…' : 'Aplicar…');
    applyBtn.type = 'button';
    applyBtn.disabled = busy || applying;
    applyBtn.addEventListener('click', () => void planApply(rule.id));
    actions.append(previewBtn, applyBtn);
  } else {
    const retryBtn = el('button', 'btn-secondary', busy ? 'Traduciendo…' : 'Traducir de nuevo');
    retryBtn.type = 'button';
    retryBtn.disabled = busy;
    retryBtn.addEventListener('click', () => {
      rulesState.previews.delete(rule.id);
      void changeRule(rule.id, () => api.compileRule(rule.id));
    });
    actions.append(retryBtn);
  }
  const deleteBtn = el('button', 'btn-ghost', 'Borrar regla');
  deleteBtn.type = 'button';
  deleteBtn.disabled = busy;
  deleteBtn.addEventListener('click', () => void removeRule(rule));
  actions.append(deleteBtn);
  card.append(actions);

  const applyBox = apply ? renderApply(rule.id, apply) : null;
  // Con análisis, la confirmación va debajo de la lista (junto al botón que la abrió),
  // si no quedaría arriba, fuera de la vista, y parecería que no pasa nada.
  if (applyBox && !scan) card.append(applyBox);
  if (preview) card.append(renderPreview(preview));
  if (scan) card.append(renderScan(rule.id, scan, applying));
  if (applyBox && scan) {
    card.append(applyBox);
    if (apply?.status === 'confirm') requestAnimationFrame(() => applyBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  return card;
}

/** Pide a Claude que puntúe los últimos correos de Recibidos. Solo lee. */
async function startScan(ruleId: string): Promise<void> {
  rulesState.scans.set(ruleId, { status: 'loading', done: 0, total: 0 });
  rulesState.applies.delete(ruleId);
  showError(rulesError, null);
  renderRules();
  let next: ScanState;
  try {
    const scan = await api.scoreRule(ruleId);
    const selected = new Set(
      scan.items
        .filter((i) => i.probability !== null && i.probability >= scan.threshold)
        .map((i) => i.message.id),
    );
    next = { status: 'done', scan, selected };
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  // Si borraron la regla mientras analizaba, no lo volvemos a abrir.
  if (!rulesState.scans.has(ruleId)) return;
  rulesState.scans.set(ruleId, next);
  renderRules();
}

api.onScoreProgress(({ ruleId, done, total }) => {
  const scan = rulesState.scans.get(ruleId);
  if (scan?.status !== 'loading') return;
  rulesState.scans.set(ruleId, { status: 'loading', done, total });
  renderRules();
});

function scanCloseButton(ruleId: string): HTMLButtonElement {
  const btn = el('button', 'btn-ghost', 'Cerrar');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    rulesState.scans.delete(ruleId);
    renderRules();
  });
  return btn;
}

function renderScan(ruleId: string, scan: ScanState, applying: boolean): HTMLElement {
  const box = el('div', 'rule__preview');
  const head = el('div', 'rule__preview-head');
  box.append(head);

  if (scan.status === 'loading') {
    const bar = el('progress');
    if (scan.total > 0) {
      bar.max = scan.total;
      bar.value = scan.done;
    }
    head.append(
      el(
        'span',
        'muted small',
        scan.total > 0
          ? `Claude está leyendo tus correos: ${formatCount(scan.done)} de ${formatCount(scan.total)}…`
          : 'Leyendo los últimos correos de Recibidos…',
      ),
      bar,
    );
    return box;
  }
  if (scan.status === 'error') {
    box.append(el('p', 'error', scan.error), scanCloseButton(ruleId));
    return box;
  }

  const { scan: result, selected } = scan;
  const failed = result.items.filter((i) => i.probability === null).length;
  head.append(
    el(
      'strong',
      undefined,
      result.items.length === 0
        ? 'No hay correos en Recibidos que analizar.'
        : `Claude ha leído los ${formatCount(result.items.length)} correos más recientes de Recibidos`,
    ),
    el(
      'span',
      'muted small',
      `Marcados los de ${result.threshold}% o más. Revisa la lista y quita o pon marcas: solo se tocan los marcados.`,
    ),
  );
  if (failed > 0) {
    head.append(
      el('span', 'error small', failed === 1 ? '1 correo no se pudo analizar.' : `${formatCount(failed)} correos no se pudieron analizar.`),
    );
  }

  const applyBtn = el('button', 'btn-secondary');
  applyBtn.type = 'button';
  const syncApply = () => {
    const n = selected.size;
    applyBtn.textContent = n === 1 ? 'Aplicar al marcado…' : `Aplicar a ${formatCount(n)} marcados…`;
    applyBtn.disabled = n === 0 || applying;
  };
  syncApply();
  applyBtn.addEventListener('click', () => void planFromScan(ruleId, result.token, [...selected]));

  if (result.items.length > 0) {
    const list = el('div', 'rule__mails');
    // Marcar no repinta la tarjeta: así la lista no pierde el scroll.
    list.append(...result.items.map((item) => renderScanItem(item, result.threshold, selected, syncApply)));
    box.append(list);
  }
  const row = el('div', 'rule__actions');
  row.append(applyBtn, scanCloseButton(ruleId));
  box.append(row);
  return box;
}

function renderScanItem(
  item: ScanItem,
  threshold: number,
  selected: Set<string>,
  onChange: () => void,
): HTMLElement {
  const id = item.message.id;
  const row = el('label', 'scan__item');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = selected.has(id);
  check.addEventListener('change', () => {
    if (check.checked) selected.add(id);
    else selected.delete(id);
    onChange();
  });

  const p = item.probability;
  const level = p === null ? 'low' : p >= threshold ? 'high' : p >= threshold / 2 ? 'mid' : 'low';
  const score = el('span', `scan__score scan__score--${level}`, p === null ? '—' : `${p}%`);
  score.title = 'Probabilidad de que cumpla la regla, según Claude';

  const body = el('div', 'scan__body');
  const why = item.error ? `No se pudo analizar: ${item.error}` : item.reason;
  body.append(renderMessage(item.message));
  if (why) {
    const reason = el('span', 'scan__why', why);
    reason.title = why;
    body.append(reason);
  }
  row.append(check, score, body);
  return row;
}

/** Cuenta lo que haría «Aplicar» sobre los correos marcados y pide confirmación. */
async function planFromScan(ruleId: string, token: string, emailIds: string[]): Promise<void> {
  rulesState.applies.set(ruleId, { status: 'planning' });
  renderRules();
  let next: ApplyState;
  try {
    next = { status: 'confirm', plan: await api.planScan(token, emailIds), typed: '' };
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  if (!rulesState.applies.has(ruleId)) return;
  rulesState.applies.set(ruleId, next);
  renderRules();
}

/** «Mover 342 correos a la papelera», con el verbo que toca. */
function actionPhrase(action: ActionKind, n: number, labelName?: string): string {
  const mails = n === 1 ? '1 correo' : `${formatCount(n)} correos`;
  switch (action) {
    case 'trash':
      return `Mover ${mails} a la papelera`;
    case 'spam':
      return `Marcar ${mails} como spam`;
    case 'archive':
      return `Archivar ${mails}`;
    case 'label':
      return `Etiquetar ${mails} con «${labelName ?? ''}»`;
    case 'delete':
      return `Borrar para siempre ${mails}`;
  }
}

/** «342 correos movidos a la papelera». */
function actionResult(action: ActionKind, n: number, labelName?: string): string {
  const mails = n === 1 ? '1 correo' : `${formatCount(n)} correos`;
  const s = n === 1 ? '' : 's';
  switch (action) {
    case 'trash':
      return `${mails} movido${s} a la papelera`;
    case 'spam':
      return `${mails} marcado${s} como spam`;
    case 'archive':
      return `${mails} archivado${s}`;
    case 'label':
      return `${mails} etiquetado${s} con «${labelName ?? ''}»`;
    case 'delete':
      return `${mails} borrado${s} para siempre`;
  }
}

function closeButton(ruleId: string, className = 'btn-ghost'): HTMLButtonElement {
  const btn = el('button', className, 'Cerrar');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    rulesState.applies.delete(ruleId);
    renderRules();
  });
  return btn;
}

function undoButton(): HTMLButtonElement {
  const btn = el('button', 'btn-secondary', rulesState.undoing ? 'Deshaciendo…' : 'Deshacer');
  btn.type = 'button';
  btn.disabled = rulesState.undoing;
  btn.addEventListener('click', () => void undoLast());
  return btn;
}

function renderApply(ruleId: string, apply: ApplyState): HTMLElement {
  const danger = 'plan' in apply && apply.plan.action === 'delete';
  const box = el('div', danger ? 'rule__apply rule__apply--danger' : 'rule__apply');

  if (apply.status === 'error') {
    box.append(el('p', 'error', apply.error), closeButton(ruleId, 'btn-ghost panel__end'));
    return box;
  }

  if (apply.status === 'planning') {
    // Sin valor, la barra se mueve sola: Gmail no dice cuánto le falta para contar.
    box.append(el('progress'), el('span', 'muted small', 'Buscando en Gmail los correos que cumplen la regla…'));
    return box;
  }

  if (apply.status === 'running') {
    const { plan, done } = apply;
    const bar = el('progress');
    if (done > 0) {
      bar.max = plan.count;
      bar.value = done;
    }
    const percent = Math.min(100, Math.floor((done / Math.max(1, plan.count)) * 100));
    box.append(
      el('strong', undefined, `${actionPhrase(plan.action, plan.count, plan.labelName)}…`),
      bar,
      el(
        'span',
        'muted small',
        done === 0
          ? 'Comprobando los correos con Gmail… No cierres la app.'
          : done >= plan.count && plan.action === 'delete'
            ? 'Vaciándolos de la Papelera… No cierres la app.'
            : `${formatCount(done)} de ${formatCount(plan.count)} (${percent} %). No cierres la app.`,
      ),
    );
    return box;
  }

  if (apply.status === 'done') {
    const { entry } = apply;
    const result = actionResult(entry.action, entry.count, entry.labelName);
    box.append(
      entry.error
        ? el('p', 'error', `Se paró a mitad: ${result}. ${entry.error}`)
        : el('strong', 'success', `Hecho: ${result}.`),
    );
    const row = el('div', 'rule__actions');
    if (rulesState.history.undoableId === entry.id) row.append(undoButton());
    else if (entry.undone) row.append(el('span', 'chip', 'Deshecho'));
    row.append(closeButton(ruleId));
    box.append(row);
    return box;
  }

  const { plan } = apply;
  if (plan.count === 0) {
    box.append(
      el('p', undefined, 'No hay ningún correo que tocar con esta regla.'),
      closeButton(ruleId, 'btn-ghost panel__end'),
    );
    return box;
  }

  box.append(el('strong', undefined, `¿${actionPhrase(plan.action, plan.count, plan.labelName)}?`));
  if (plan.total > plan.count) {
    const total = `${plan.approximate ? 'más de ' : ''}${formatCount(plan.total)}`;
    box.append(
      el(
        'p',
        'muted small',
        `Hay ${total} en total. Se hacen como mucho ${formatCount(plan.count)} por pasada: aplica otra vez para seguir.`,
      ),
    );
  }
  box.append(
    el(
      'p',
      'muted small',
      plan.action === 'delete'
        ? 'No pasan por la papelera: no se podrán recuperar ni deshacer. Los destacados e importantes no se tocan.'
        : 'Los destacados e importantes no se tocan. Podrás deshacerlo justo después.',
    ),
  );

  const confirmBtn = el('button', plan.action === 'delete' ? 'btn-danger' : 'btn-secondary', 'Confirmar');
  confirmBtn.type = 'button';
  if (plan.action === 'delete') {
    const field = el('div', 'stack-8');
    const input = el('input', 'input input--mono');
    input.id = `borrar-${ruleId}`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = apply.typed;
    const label = el('label', 'label', 'Escribe BORRAR para confirmar');
    label.htmlFor = input.id;
    confirmBtn.disabled = apply.typed !== 'BORRAR';
    input.addEventListener('input', () => {
      apply.typed = input.value.trim();
      confirmBtn.disabled = apply.typed !== 'BORRAR';
    });
    field.append(label, input);
    box.append(field);
  }
  confirmBtn.addEventListener('click', () => void runApply(ruleId, plan, apply.typed));
  const row = el('div', 'rule__actions');
  const cancelBtn = closeButton(ruleId);
  cancelBtn.textContent = 'Cancelar';
  row.append(confirmBtn, cancelBtn);
  box.append(row);
  return box;
}

/** Cuenta en Gmail lo que haría la regla y pide confirmación. Solo lee. */
async function planApply(ruleId: string): Promise<void> {
  rulesState.applies.set(ruleId, { status: 'planning' });
  renderRules();
  let next: ApplyState;
  try {
    next = { status: 'confirm', plan: await api.planRule(ruleId), typed: '' };
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  // Si borraron la regla mientras contaba, no la volvemos a abrir.
  if (!rulesState.applies.has(ruleId)) return;
  rulesState.applies.set(ruleId, next);
  renderRules();
}

async function runApply(ruleId: string, plan: ApplyPlan, typed: string): Promise<void> {
  rulesState.applies.set(ruleId, { status: 'running', plan, done: 0 });
  renderRules();
  let next: ApplyState;
  try {
    next = { status: 'done', entry: await api.applyPlan(plan.token, plan.action === 'delete' ? typed : undefined) };
    // La vista previa y el análisis ya no reflejan el buzón.
    rulesState.previews.delete(ruleId);
    rulesState.scans.delete(ruleId);
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  rulesState.applies.set(ruleId, next);
  await reloadHistory();
  void refresh();
}

api.onApplyProgress(({ token, done }) => {
  for (const [ruleId, apply] of rulesState.applies) {
    if (apply.status === 'running' && apply.plan.token === token) {
      rulesState.applies.set(ruleId, { ...apply, done });
      renderRules();
    }
  }
});

async function reloadHistory(): Promise<void> {
  try {
    rulesState.history = await api.getHistory();
  } catch (err) {
    showError(historyError, errorText(err));
  }
  renderRules();
}

async function undoLast(): Promise<void> {
  rulesState.undoing = true;
  showError(historyError, null);
  renderRules();
  try {
    const entry = await api.undoLast();
    for (const [ruleId, apply] of rulesState.applies) {
      if (apply.status === 'done' && apply.entry.id === entry.id) {
        rulesState.applies.set(ruleId, { status: 'done', entry });
      }
    }
  } catch (err) {
    showError(historyError, errorText(err));
  } finally {
    rulesState.undoing = false;
  }
  await reloadHistory();
  void refresh();
}

const historyFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function renderHistory(): void {
  const { entries, undoableId } = rulesState.history;
  historyPanel.hidden = entries.length === 0;
  historyBox.replaceChildren(
    ...entries.map((entry) => {
      const item = el('li', 'history__item');
      item.append(
        el('p', 'history__text', entry.ruleText),
        el(
          'span',
          entry.action === 'delete' ? 'chip chip--danger' : 'chip',
          actionResult(entry.action, entry.count, entry.labelName),
        ),
        el('span', 'muted small', historyFmt.format(entry.at)),
      );
      if (entry.error) item.append(el('span', 'chip chip--error', 'Se paró a mitad'));
      if (entry.undone) item.append(el('span', 'chip', 'Deshecho'));
      if (entry.id === undoableId) item.append(undoButton());
      return item;
    }),
  );
}

function renderPreview(preview: PreviewState): HTMLElement {
  const box = el('div', 'rule__preview');
  if (preview.status === 'loading') {
    const head = el('div', 'rule__preview-head');
    head.append(el('span', 'muted small', 'Buscando en todo tu Gmail…'));
    box.append(head);
    return box;
  }
  if (preview.status === 'error') {
    box.append(el('p', 'error', preview.error));
    return box;
  }
  const { total, approximate, query, messages } = preview.result;
  const head = el('div', 'rule__preview-head');
  let summary = 'Ningún correo cumple esta regla.';
  if (total > 0) {
    const count = `${approximate ? 'Más de ' : ''}${formatCount(total)}`;
    summary = total === 1 ? '1 correo cumple esta regla' : `${count} correos cumplen esta regla`;
    if (messages.length < total) summary += ` · aquí van los ${formatCount(messages.length)} más recientes`;
  }
  head.append(
    el('strong', undefined, summary),
    el('span', 'muted small', 'Vista previa: no se toca nada.'),
    el('span', 'code', `Búsqueda en Gmail: ${query}`),
  );
  box.append(head);
  if (messages.length > 0) {
    const list = el('div', 'rule__mails');
    list.append(...messages.map(renderMessage));
    box.append(list);
  }
  return box;
}

/** Resume el filtro en frases cortas, en el orden en que el usuario lo pensaría. */
function describeFilter(f: Filter): string[] {
  const parts: string[] = [];
  const list = (items: string[]) => items.map((s) => `«${s}»`).join(' o ');
  const senders = [...(f.fromDomains ?? []), ...(f.fromAddresses ?? [])];
  if (senders.length) parts.push(`de ${senders.join(', ')}`);
  if (f.subjectContains?.length) parts.push(`asunto con ${list(f.subjectContains)}`);
  if (f.subjectMatches?.length) parts.push(`asunto que encaja con ${list(f.subjectMatches)}`);
  if (f.bodyContains?.length) parts.push(`que mencionan ${list(f.bodyContains)}`);
  if (f.hasLabels?.length) parts.push(`con la etiqueta ${list(f.hasLabels)}`);
  if (f.olderThanDays !== undefined) {
    parts.push(f.olderThanDays === 1 ? 'de hace más de 1 día' : `de hace más de ${formatCount(f.olderThanDays)} días`);
  }
  if (f.unread === true) parts.push('sin leer');
  if (f.unread === false) parts.push('ya leídos');
  return parts.length ? parts : ['todos los correos'];
}

/** Lanza un cambio sobre una regla y pinta el resultado (o el error). */
async function changeRule(id: string, change: () => Promise<Rule>): Promise<void> {
  rulesState.busy.add(id);
  showError(rulesError, null);
  renderRules();
  try {
    const updated = await change();
    rulesState.rules = rulesState.rules.map((r) => (r.id === id ? updated : r));
  } catch (err) {
    showError(rulesError, errorText(err));
  } finally {
    rulesState.busy.delete(id);
    renderRules();
  }
}

async function removeRule(rule: Rule): Promise<void> {
  if (!confirm(`¿Borrar la regla «${rule.text}»? No afecta a ningún correo.`)) return;
  showError(rulesError, null);
  try {
    await api.deleteRule(rule.id);
    rulesState.rules = rulesState.rules.filter((r) => r.id !== rule.id);
    rulesState.previews.delete(rule.id);
    rulesState.applies.delete(rule.id);
    rulesState.scans.delete(rule.id);
  } catch (err) {
    showError(rulesError, errorText(err));
  }
  renderRules();
}

async function togglePreview(id: string): Promise<void> {
  const current = rulesState.previews.get(id);
  if (current && current.status !== 'loading') {
    rulesState.previews.delete(id);
    renderRules();
    return;
  }
  rulesState.previews.set(id, { status: 'loading' });
  renderRules();
  let next: PreviewState;
  try {
    next = { status: 'done', result: await api.previewRule(id) };
  } catch (err) {
    next = { status: 'error', error: errorText(err) };
  }
  // Si la ocultaron mientras buscaba, no la volvemos a abrir.
  if (!rulesState.previews.has(id)) return;
  rulesState.previews.set(id, next);
  renderRules();
}

function syncActionFields(): void {
  const action = ruleAction.value as ActionKind;
  labelField.hidden = action !== 'label';
  deleteConfirm.hidden = action !== 'delete';
  if (action !== 'delete') deleteOk.checked = false;
}

ruleAction.addEventListener('change', syncActionFields);
goSettings.addEventListener('click', () => showView('settings'));

ruleText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ruleForm.requestSubmit();
});

ruleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(ruleError, null);
  const text = ruleText.value.trim();
  const action = ruleAction.value as ActionKind;
  const kind = (ruleKind.querySelector<HTMLInputElement>('input:checked')?.value ?? 'filter') as RuleKind;
  const labelName = ruleLabel.value.trim();
  if (!text) return showError(ruleError, 'Escribe qué correos quieres quitar de en medio.');
  if (action === 'label' && !labelName) return showError(ruleError, 'Escribe el nombre de la etiqueta.');
  if (action === 'delete' && !deleteOk.checked) {
    return showError(ruleError, 'Marca la casilla para confirmar el borrado definitivo.');
  }
  ruleBtn.disabled = true;
  ruleBtn.textContent = 'Traduciendo con Claude…';
  try {
    const rule = await api.createRule(
      action === 'label' ? { text, action, kind, labelName } : { text, action, kind },
    );
    rulesState.rules = [...rulesState.rules.filter((r) => r.id !== rule.id), rule];
    ruleText.value = '';
    ruleLabel.value = '';
    deleteOk.checked = false;
    renderRules();
  } catch (err) {
    showError(ruleError, errorText(err));
  } finally {
    ruleBtn.disabled = false;
    ruleBtn.textContent = 'Crear regla';
  }
});

// ---------- Ajustes ----------

const keyForm = $<HTMLFormElement>('key-form');
const keyStatus = $<HTMLElement>('key-status');
const keyInput = $<HTMLInputElement>('key-input');
const keySave = $<HTMLButtonElement>('key-save');
const keyError = $<HTMLElement>('key-error');
const keyOk = $<HTMLElement>('key-ok');
const keyClear = $<HTMLButtonElement>('key-clear');

/** Solo sabemos si hay clave: la clave nunca vuelve a la interfaz. */
function renderKeyStatus(): void {
  const has = rulesState.hasKey;
  keyStatus.textContent = has ? 'Configurada' : 'Sin configurar';
  keyStatus.className = has ? 'chip chip--ok' : 'chip';
  keyInput.placeholder = has ? 'Escribe otra para sustituirla' : 'sk-ant-…';
  keyClear.hidden = !has;
  keyMissing.hidden = has;
}

keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(keyError, null);
  keyOk.hidden = true;
  if (!keyInput.value.trim()) return showError(keyError, 'Pega aquí tu clave de Anthropic.');
  keySave.disabled = true;
  try {
    const result = await api.setAnthropicKey(keyInput.value);
    if (!result.ok) return showError(keyError, result.error);
    keyInput.value = '';
    rulesState.hasKey = true;
    keyOk.textContent = 'Clave guardada y cifrada en este ordenador.';
    keyOk.hidden = false;
    renderKeyStatus();
  } catch (err) {
    showError(keyError, errorText(err));
  } finally {
    keySave.disabled = false;
  }
});

keyClear.addEventListener('click', async () => {
  if (!confirm('¿Quitar la clave? Las reglas ya traducidas se conservan.')) return;
  showError(keyError, null);
  keyOk.hidden = true;
  try {
    await api.clearAnthropicKey();
    rulesState.hasKey = false;
    renderKeyStatus();
  } catch (err) {
    showError(keyError, errorText(err));
  }
});

// ---------- Arranque ----------

const account = await api.getAccount();
if (account) {
  void openInbox(account.email);
} else {
  showConnect();
}

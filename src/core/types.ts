/**
 * Tipos de dominio de matamoscas.
 *
 * Una regla la escribe el usuario en lenguaje natural (`text`). El compilador
 * (Claude) la traduce a un `filter` estructurado y determinista que el motor
 * evalúa contra cada correo. La acción se configura por regla.
 */

/** Cuentas soportadas. */
export type AccountKind = 'gmail' | 'proton';

/** Acción a aplicar sobre un correo que coincide con una regla. */
export type ActionKind =
  | 'trash' // mover a papelera (reversible)
  | 'delete' // borrado permanente (destructivo)
  | 'spam' // marcar como spam
  | 'archive' // archivar (quitar de bandeja de entrada)
  | 'label'; // etiquetar (requiere `labelName`)

/** Un correo, en la forma mínima que necesita el motor de reglas. */
export interface Message {
  id: string;
  account: AccountKind;
  from: string; // dirección del remitente, p. ej. "ofertas@tienda.com"
  fromName?: string; // nombre visible del remitente
  subject: string;
  /** Fecha de recepción en epoch milisegundos. */
  receivedAt: number;
  unread: boolean;
  labels: string[]; // etiquetas/carpetas actuales
  /** Fragmento o cuerpo en texto plano (opcional; el matching básico no lo requiere). */
  snippet?: string;
}

/**
 * Filtro estructurado producido por el compilador. Todos los campos son
 * opcionales; un campo ausente no restringe. Un correo coincide cuando cumple
 * TODOS los campos presentes (AND).
 */
export interface Filter {
  /** Coincide si el remitente pertenece a alguno de estos dominios (p. ej. "tienda.com"). */
  fromDomains?: string[];
  /** Coincide si la dirección del remitente es exactamente una de estas. */
  fromAddresses?: string[];
  /** Coincide si el asunto contiene alguna de estas subcadenas (sin distinguir mayúsculas). */
  subjectContains?: string[];
  /** Coincide si el asunto cumple alguna de estas expresiones regulares. */
  subjectMatches?: string[];
  /** Coincide si el correo tiene al menos esta antigüedad (en días). */
  olderThanDays?: number;
  /** Coincide según estado de lectura: true = solo no leídos, false = solo leídos. */
  unread?: boolean;
  /** Coincide si el correo tiene alguna de estas etiquetas. */
  hasLabels?: string[];
  /** Coincide si el cuerpo/snippet contiene alguna de estas subcadenas. */
  bodyContains?: string[];
}

/** Estado de compilación de una regla. */
export type RuleCompileStatus = 'compiled' | 'uncompiled' | 'error';

/**
 * Tipo de regla: `filter` se traduce a un `Filter` determinista; `ai` se
 * traduce a un clasificador que un modelo pequeño aplica correo a correo.
 */
export type RuleKind = 'filter' | 'ai';

/** Ejemplo resuelto para el clasificador (few-shot). */
export interface ClassifierExample {
  /** Correo de ejemplo en el mismo formato que verá el modelo. */
  email: string;
  /** Probabilidad (0–100) de que encaje con la regla. */
  probability: number;
  reason: string;
}

/** Clasificador generado desde el texto de una regla con IA. */
export interface Classifier {
  /** Rol y criterios, escritos para el modelo que puntúa. */
  instructions: string;
  examples: ClassifierExample[];
}

/** Una regla tal como se persiste (CRUD de texto libre + filtro compilado). */
export interface Rule {
  id: string;
  /** Texto libre escrito por el usuario. Fuente de verdad editable. */
  text: string;
  /** Cuentas sobre las que aplica. Vacío = todas. */
  accounts: AccountKind[];
  action: ActionKind;
  /** Nombre de etiqueta cuando `action === 'label'`. */
  labelName?: string;
  enabled: boolean;
  /** Tipo de regla; si falta es `filter` (reglas guardadas antes de existir `ai`). */
  kind?: RuleKind;
  /** Filtro compilado desde `text`. `null` mientras no se haya compilado. */
  filter: Filter | null;
  /** Clasificador compilado desde `text` (solo reglas `ai`). */
  classifier?: Classifier | null;
  compileStatus: RuleCompileStatus;
  /** Mensaje de error de compilación, si `compileStatus === 'error'`. */
  compileError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Acciones que Claude puede proponer: nunca el borrado definitivo. */
export type SuggestedAction = Extract<ActionKind, 'trash' | 'spam' | 'archive'>;

/** Regla propuesta por Claude a partir de unos correos que el usuario eligió. */
export interface RuleSuggestion {
  /** Texto de la regla, listo para crearla tal cual. */
  text: string;
  kind: RuleKind;
  action: SuggestedAction;
  /** Por qué la propone, en una frase. */
  why: string;
  /** Correos elegidos que cubriría. */
  emailIds: string[];
}

/** Coincidencia entre un correo y una regla (para previsualización y ejecución). */
export interface Match {
  message: Message;
  ruleId: string;
  action: ActionKind;
  labelName?: string;
}

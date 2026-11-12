/**
 * Compilador de reglas: traduce una regla en lenguaje natural a un `Filter`
 * estructurado y determinista usando Claude con salida estructurada.
 *
 * La app depende de la interfaz `RuleCompiler`, no de la implementación
 * concreta, para que el resto del código (y los tests) puedan usar un mock.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AccountKind, Classifier, Filter } from './types';

/** Interfaz mínima que consume la app. */
export interface RuleCompiler {
  /**
   * Compila el texto libre de una regla a un filtro estructurado.
   * @param text texto en lenguaje natural escrito por el usuario.
   * @param accounts cuentas sobre las que aplica (contexto para el modelo).
   * @throws si el modelo no devuelve un filtro válido.
   */
  compile(text: string, accounts: AccountKind[]): Promise<Filter>;
  /**
   * Convierte el texto de una regla con IA en un clasificador (instrucciones
   * y ejemplos) para el modelo que puntúa cada correo.
   * @throws si el modelo no devuelve un clasificador válido.
   */
  compileClassifier(text: string): Promise<Classifier>;
}

/**
 * Esquema Zod del filtro. Se envía a Claude como salida estructurada, de modo
 * que la respuesta ya viene validada contra esta forma. Debe mantenerse
 * alineado con el tipo `Filter` de `types.ts`.
 */
const FilterSchema = z.object({
  fromDomains: z.array(z.string()).optional(),
  fromAddresses: z.array(z.string()).optional(),
  subjectContains: z.array(z.string()).optional(),
  subjectMatches: z.array(z.string()).optional(),
  olderThanDays: z.number().optional(),
  unread: z.boolean().optional(),
  hasLabels: z.array(z.string()).optional(),
  bodyContains: z.array(z.string()).optional(),
});

const SYSTEM_PROMPT = `Eres el compilador de reglas de "matamoscas", una app que elimina correo basura.
Traduces una regla escrita en lenguaje natural por el usuario a un filtro estructurado
que un motor determinista aplicará a cada correo.

Reglas de traducción:
- Usa SOLO los campos del esquema. Un campo ausente no restringe.
- Un correo coincide cuando cumple TODOS los campos que rellenes (AND); dentro de cada
  lista, cualquier elemento cuenta (OR).
- "de la tienda X" / "correos de dominio.com" -> fromDomains o fromAddresses.
- Palabras clave en el asunto -> subjectContains (subcadenas en minúsculas).
- Patrones complejos de asunto -> subjectMatches (regex de JavaScript).
- "que no he leído" -> unread: true. "ya leídos" -> unread: false.
- "más viejos de N días/semanas/meses" -> olderThanDays (convierte a días).
- "en la carpeta/etiqueta X" -> hasLabels.
- Contenido del cuerpo -> bodyContains.
- Sé conservador: es mejor un filtro que no borre de más. Nunca devuelvas un filtro
  vacío; si la regla es demasiado vaga, elige el criterio más específico que puedas
  inferir del texto.`;

const ClassifierSchema = z.object({
  instructions: z.string(),
  examples: z.array(
    z.object({ email: z.string(), probability: z.number(), reason: z.string() }),
  ),
});

const CLASSIFIER_SYSTEM_PROMPT = `Eres un experto en prompts para modelos de Claude. Trabajas para "matamoscas",
una app que limpia el correo de Gmail del usuario.

El usuario describe con sus palabras qué correos quiere quitarse de encima. Tú conviertes
esa descripción en el prompt de sistema de un clasificador. Otro modelo, más pequeño y
rápido (Claude Haiku), leerá cada correo con ese prompt y devolverá la probabilidad
(0 a 100) de que el correo encaje con lo que el usuario describe, más un motivo corto.

Devuelve dos cosas:

1. "instructions": el rol y los criterios del clasificador, en español y en segunda
   persona ("Eres…", "Considera…"). Debe incluir:
   - Un rol concreto: quién es y para qué clasifica.
   - Qué SÍ encaja, con señales observables en el correo (remitente, asunto, tono,
     llamadas a la acción, enlaces de baja, ofertas, etc.).
   - Qué NO encaja aunque se parezca. Protege siempre lo que una persona no querría
     perder: correos que personas reales escriben al usuario, facturas y recibos de
     compras hechas, avisos de seguridad de sus cuentas, citas, reservas, trámites
     con administraciones, bancos o trabajo. Si el usuario pide expresamente algo de
     esta lista, respétalo.
   - Cómo graduar la probabilidad: 90–100 sin duda, 60–89 probable, 30–59 dudoso,
     0–29 no encaja. Ante la duda, más bajo: un falso positivo puede borrar algo
     importante.
   No describas el formato de salida: la app lo añade.

2. "examples": entre 4 y 6 correos de ejemplo realistas e inventados, variados, con la
   probabilidad y el motivo ideales. Incluye al menos un caso claro que encaja, uno
   claro que no y uno límite. Cada correo va en este formato exacto:

De: Nombre <direccion@dominio.com>
Asunto: …
Fecha: 2026-10-01
Cuerpo:
…

   El motivo es una frase corta en español (máximo 15 palabras) que cite la señal decisiva.`;

/** Implementación real contra la API de Claude. */
export class ClaudeRuleCompiler implements RuleCompiler {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? 'claude-sonnet-5-5';
  }

  async compile(text: string, accounts: AccountKind[]): Promise<Filter> {
    const accountsHint =
      accounts.length > 0 ? `Cuentas: ${accounts.join(', ')}.` : 'Cuentas: todas.';

    let response;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${accountsHint}

Regla del usuario:
"""${text}"""`,
          },
        ],
        output_config: { effort: 'medium', format: zodOutputFormat(FilterSchema) },
      });
    } catch (err) {
      throw new Error(describeApiError(err));
    }

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude no ha querido traducir esta regla. Prueba a escribirla de otra forma.');
    }
    const filter = response.parsed_output;
    if (!filter || Object.keys(filter).length === 0) {
      throw new Error('Claude no ha sabido traducir esta regla. Prueba a concretar más (remitente, asunto…).');
    }
    return filter;
  }

  async compileClassifier(text: string): Promise<Classifier> {
    let response;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 8192,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `<descripcion_del_usuario>\n${text}\n</descripcion_del_usuario>` }],
        output_config: { effort: 'medium', format: zodOutputFormat(ClassifierSchema) },
      });
    } catch (err) {
      throw new Error(describeApiError(err));
    }

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude no ha querido preparar esta regla. Prueba a escribirla de otra forma.');
    }
    const out = response.parsed_output;
    if (!out || !out.instructions.trim()) {
      throw new Error('Claude no ha sabido preparar esta regla. Prueba a describir mejor qué correos quieres quitar.');
    }
    return {
      instructions: out.instructions.trim(),
      examples: out.examples.map((e) => ({ ...e, probability: clampProbability(e.probability) })),
    };
  }
}

/** Deja una probabilidad en un entero entre 0 y 100. */
export function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(100, Math.max(0, p)));
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'La clave de Anthropic no es válida. Revísala en Ajustes.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'Tu clave de Anthropic no tiene permiso para usar este modelo.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Demasiadas peticiones a Claude seguidas. Espera un momento y vuelve a intentarlo.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'No se pudo conectar con Claude. Revisa tu conexión a internet.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude devolvió un error (${err.status ?? 'sin código'}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

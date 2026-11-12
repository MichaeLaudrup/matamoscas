/**
 * Lógica de reglas independiente de I/O: crear una regla nueva y compilar el
 * texto libre a filtro (o a clasificador, en las reglas con IA). La
 * persistencia y la generación de IDs viven fuera (proceso main), lo que
 * mantiene esto puro y testeable.
 */
import type { RuleCompiler } from './ruleCompiler';
import type { AccountKind, ActionKind, Rule, RuleKind } from './types';

/** Datos que aporta el usuario al crear/editar una regla. */
export interface RuleInput {
  text: string;
  action: ActionKind;
  kind?: RuleKind;
  accounts?: AccountKind[];
  labelName?: string;
  enabled?: boolean;
}

/** Tipo de una regla; las guardadas antes de existir las reglas con IA son filtros. */
export function ruleKind(rule: Pick<Rule, 'kind'>): RuleKind {
  return rule.kind ?? 'filter';
}

/** Construye una regla nueva sin compilar. El ID y el reloj se inyectan. */
export function createRule(input: RuleInput, id: string, now: number): Rule {
  return {
    id,
    text: input.text,
    accounts: input.accounts ?? [],
    action: input.action,
    ...(input.labelName ? { labelName: input.labelName } : {}),
    enabled: input.enabled ?? true,
    ...(input.kind === 'ai' ? { kind: 'ai' as const, classifier: null } : {}),
    filter: null,
    compileStatus: 'uncompiled',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Compila el texto de una regla a filtro (o a clasificador). Devuelve una
 * copia nueva de la regla con el resultado; nunca lanza: un fallo de
 * compilación se refleja en `compileStatus: 'error'` para que el motor la
 * ignore (no borra nada).
 */
export async function compileRule(rule: Rule, compiler: RuleCompiler, now: number): Promise<Rule> {
  const ai = ruleKind(rule) === 'ai';
  try {
    const compiled = ai
      ? { filter: null, classifier: await compiler.compileClassifier(rule.text) }
      : { filter: await compiler.compile(rule.text, rule.accounts) };
    return {
      ...rule,
      ...compiled,
      compileStatus: 'compiled',
      compileError: undefined,
      updatedAt: now,
    };
  } catch (err) {
    return {
      ...rule,
      filter: null,
      ...(ai ? { classifier: null } : {}),
      compileStatus: 'error',
      compileError: err instanceof Error ? err.message : String(err),
      updatedAt: now,
    };
  }
}

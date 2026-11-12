import { describe, it, expect } from 'vitest';
import { compileRule, createRule } from './ruleService';
import type { RuleCompiler } from './ruleCompiler';
import type { Classifier, Filter, Rule } from './types';

const NOW = 1_700_000_000_000;

/** Compilador falso para tests: devuelve un filtro fijo o lanza. */
function fakeCompiler(result: Filter | Error, classifier: Classifier | Error = new Error('no')): RuleCompiler {
  return {
    async compile() {
      if (result instanceof Error) throw result;
      return result;
    },
    async compileClassifier() {
      if (classifier instanceof Error) throw classifier;
      return classifier;
    },
  };
}

const CLASSIFIER: Classifier = {
  instructions: 'Eres un clasificador de publicidad.',
  examples: [{ email: 'De: a@b.com', probability: 90, reason: 'Oferta' }],
};

function baseRule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    text: 'borra ofertas de tienda.com',
    accounts: [],
    action: 'trash',
    enabled: true,
    filter: null,
    compileStatus: 'uncompiled',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('createRule', () => {
  it('crea una regla sin compilar con los campos dados', () => {
    const rule = createRule({ text: 'spam', action: 'delete', accounts: ['gmail'] }, 'id-1', NOW);
    expect(rule.id).toBe('id-1');
    expect(rule.text).toBe('spam');
    expect(rule.action).toBe('delete');
    expect(rule.accounts).toEqual(['gmail']);
    expect(rule.enabled).toBe(true);
    expect(rule.filter).toBeNull();
    expect(rule.compileStatus).toBe('uncompiled');
    expect(rule.createdAt).toBe(NOW);
    expect(rule.kind).toBeUndefined();
  });

  it('una regla con IA empieza sin clasificador', () => {
    const rule = createRule({ text: 'promociones', action: 'trash', kind: 'ai' }, 'id-2', NOW);
    expect(rule.kind).toBe('ai');
    expect(rule.classifier).toBeNull();
    expect(rule.filter).toBeNull();
  });
});

describe('compileRule', () => {
  it('rellena el filtro y marca compiled en éxito', async () => {
    const filter: Filter = { fromDomains: ['tienda.com'] };
    const result = await compileRule(baseRule(), fakeCompiler(filter), NOW + 1);
    expect(result.compileStatus).toBe('compiled');
    expect(result.filter).toEqual(filter);
    expect(result.compileError).toBeUndefined();
    expect(result.updatedAt).toBe(NOW + 1);
  });

  it('marca error y deja el filtro nulo si el compilador lanza', async () => {
    const result = await compileRule(baseRule(), fakeCompiler(new Error('boom')), NOW + 2);
    expect(result.compileStatus).toBe('error');
    expect(result.filter).toBeNull();
    expect(result.compileError).toContain('boom');
  });

  it('no muta la regla original (devuelve copia)', async () => {
    const original = baseRule();
    await compileRule(original, fakeCompiler({ unread: true }), NOW + 3);
    expect(original.filter).toBeNull();
    expect(original.compileStatus).toBe('uncompiled');
  });

  it('una regla con IA guarda el clasificador y no un filtro', async () => {
    const rule = baseRule({ kind: 'ai', classifier: null });
    const result = await compileRule(rule, fakeCompiler(new Error('no debe usarse'), CLASSIFIER), NOW + 4);
    expect(result.compileStatus).toBe('compiled');
    expect(result.classifier).toEqual(CLASSIFIER);
    expect(result.filter).toBeNull();
  });

  it('si falla el clasificador queda en error sin clasificador', async () => {
    const rule = baseRule({ kind: 'ai', classifier: CLASSIFIER });
    const result = await compileRule(rule, fakeCompiler({}, new Error('sin clave')), NOW + 5);
    expect(result.compileStatus).toBe('error');
    expect(result.classifier).toBeNull();
    expect(result.compileError).toContain('sin clave');
  });
});

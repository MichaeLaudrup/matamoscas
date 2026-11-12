import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRule } from '../core/ruleService';
import { RuleStore } from './ruleStore';

describe('RuleStore', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'matamoscas-')), 'rules.json');

  it('sin archivo no hay reglas', async () => {
    expect(await new RuleStore(file()).load()).toEqual([]);
  });

  it('guarda y recupera las reglas sin dejar el temporal', async () => {
    const path = file();
    const store = new RuleStore(path);
    const rule = createRule({ text: 'Ofertas de Zalando', action: 'trash' }, 'r1', 1000);
    await store.save([rule]);
    expect(await store.load()).toEqual([rule]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

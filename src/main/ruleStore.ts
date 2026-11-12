/**
 * Guarda las reglas en `rules.json` dentro de la carpeta de datos de la app.
 * No contienen secretos, así que van en claro y se pueden revisar a mano.
 */
import { promises as fs } from 'node:fs';
import type { Rule } from '../core/types';

export class RuleStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Rule[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(raw) as { rules?: Rule[] };
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  }

  /** Escribe en un archivo temporal y lo renombra: un corte a mitad no deja el JSON roto. */
  async save(rules: Rule[]): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ rules }, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

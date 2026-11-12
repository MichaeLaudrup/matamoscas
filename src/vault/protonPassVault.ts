/**
 * Bóveda de credenciales respaldada por el CLI de Proton Pass.
 *
 * matamoscas NO almacena secretos: guarda referencias `pass://vault/item/field`
 * y las resuelve en tiempo de ejecución invocando el CLI (que el usuario ya
 * tiene instalado y con sesión iniciada). Toda la interacción con el proceso
 * externo pasa por `exec`, inyectable para poder testear sin el CLI real.
 */

/** Resultado de ejecutar un comando externo. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Ejecuta un comando y devuelve su salida. */
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

export interface VaultStatus {
  installed: boolean;
  loggedIn: boolean;
  /** Mensaje orientativo cuando falta algo (p. ej. cómo iniciar sesión). */
  hint?: string;
}

/** Una referencia `pass://vault/item/field`. */
export function isPassRef(value: string): boolean {
  return /^pass:\/\/[^/]+\/[^/]+\/[^/]+$/.test(value.trim());
}

export class ProtonPassVault {
  private readonly exec: Exec;
  private readonly bin: string;

  constructor(exec: Exec, opts: { bin?: string } = {}) {
    this.exec = exec;
    this.bin = opts.bin ?? 'proton-pass';
  }

  /** ¿Está el CLI instalado y con sesión iniciada? */
  async status(): Promise<VaultStatus> {
    let version: ExecResult;
    try {
      version = await this.exec(this.bin, ['--version']);
    } catch {
      return {
        installed: false,
        loggedIn: false,
        hint: 'Instala el CLI de Proton Pass y vuelve a intentarlo.',
      };
    }
    if (version.code !== 0) {
      return { installed: false, loggedIn: false, hint: 'El CLI de Proton Pass no responde.' };
    }

    const session = await this.exec(this.bin, ['whoami']);
    if (session.code !== 0) {
      return {
        installed: true,
        loggedIn: false,
        hint: 'Inicia sesión ejecutando `proton-pass login` en una terminal.',
      };
    }
    return { installed: true, loggedIn: true };
  }

  /**
   * Resuelve una referencia `pass://vault/item/field` a su valor secreto.
   * @throws si la referencia es inválida o el CLI falla.
   */
  async resolve(ref: string): Promise<string> {
    if (!isPassRef(ref)) {
      throw new Error(`Referencia de Proton Pass inválida: "${ref}". Formato esperado pass://vault/item/field.`);
    }
    const result = await this.exec(this.bin, ['read', ref]);
    if (result.code !== 0) {
      throw new Error(`No se pudo leer ${ref} de Proton Pass: ${result.stderr.trim() || 'error desconocido'}`);
    }
    const value = result.stdout.replace(/\r?\n$/, '');
    if (value === '') {
      throw new Error(`Proton Pass devolvió un valor vacío para ${ref}.`);
    }
    return value;
  }
}

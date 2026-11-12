/**
 * Guarda la cuenta de Gmail en `accounts.json` dentro de la carpeta de datos
 * de la app. La contraseña nunca se escribe en claro: se cifra con
 * `safeStorage` de Electron (DPAPI en Windows, llavero en macOS).
 */
import { promises as fs } from 'node:fs';
import type { GmailCredentials } from '../connectors/gmailImap';

export interface Cipher {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

interface StoredAccount {
  email: string;
  /** Contraseña cifrada, en base64. */
  password: string;
}

export class CredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async load(): Promise<GmailCredentials | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const stored = JSON.parse(raw) as Partial<StoredAccount>;
    if (!stored.email || !stored.password) return null;
    return {
      email: stored.email,
      appPassword: this.cipher.decrypt(Buffer.from(stored.password, 'base64')),
    };
  }

  async save(creds: GmailCredentials): Promise<void> {
    const stored: StoredAccount = {
      email: creds.email,
      password: this.cipher.encrypt(creds.appPassword).toString('base64'),
    };
    await fs.writeFile(this.filePath, JSON.stringify(stored, null, 2), 'utf8');
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

/**
 * Un único secreto (la clave de Anthropic) cifrado con el mismo `Cipher`. El
 * archivo solo guarda el texto cifrado en base64.
 */
export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async load(): Promise<string | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const stored = JSON.parse(raw) as { secret?: string };
    if (!stored.secret) return null;
    return this.cipher.decrypt(Buffer.from(stored.secret, 'base64'));
  }

  async save(secret: string): Promise<void> {
    const stored = { secret: this.cipher.encrypt(secret).toString('base64') };
    await fs.writeFile(this.filePath, JSON.stringify(stored, null, 2), 'utf8');
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

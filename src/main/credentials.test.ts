import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, SecretStore, type Cipher } from './credentials';

/** Cifrado de juguete: invierte los bytes, suficiente para comprobar que no se guarda en claro. */
const cipher: Cipher = {
  encrypt: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decrypt: (data) => Buffer.from(data).reverse().toString('utf8'),
};

describe('CredentialStore', () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'matamoscas-')), 'accounts.json');
  });

  it('sin archivo no hay cuenta', async () => {
    expect(await new CredentialStore(file, cipher).load()).toBeNull();
  });

  it('guarda y recupera la cuenta', async () => {
    const store = new CredentialStore(file, cipher);
    await store.save({ email: 'yo@gmail.com', appPassword: 'abcdefghijklmnop' });
    expect(await store.load()).toEqual({ email: 'yo@gmail.com', appPassword: 'abcdefghijklmnop' });
  });

  it('la contraseña nunca queda en claro en el archivo', async () => {
    await new CredentialStore(file, cipher).save({ email: 'yo@gmail.com', appPassword: 'abcdefghijklmnop' });
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('yo@gmail.com');
    expect(raw).not.toContain('abcdefghijklmnop');
  });

  it('clear borra la cuenta y se puede llamar dos veces', async () => {
    const store = new CredentialStore(file, cipher);
    await store.save({ email: 'yo@gmail.com', appPassword: 'x' });
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('SecretStore', () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'matamoscas-')), 'anthropic.json');
  });

  it('guarda cifrado, recupera y borra la clave', async () => {
    const store = new SecretStore(file, cipher);
    expect(await store.load()).toBeNull();
    await store.save('sk-ant-secreta');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-secreta');
    expect(await store.load()).toBe('sk-ant-secreta');
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

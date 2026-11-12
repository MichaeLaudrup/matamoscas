import { describe, it, expect } from 'vitest';
import { ProtonPassVault, isPassRef, type Exec, type ExecResult } from './protonPassVault';

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(stderr: string, code = 1): ExecResult {
  return { code, stdout: '', stderr };
}

/** Construye un exec que responde según (command,args). */
function scriptedExec(routes: Record<string, ExecResult | Error>): Exec {
  return async (command, args) => {
    const key = [command, ...args].join(' ');
    const match = routes[key];
    if (match === undefined) throw new Error(`sin ruta para: ${key}`);
    if (match instanceof Error) throw match;
    return match;
  };
}

describe('isPassRef', () => {
  it('acepta referencias bien formadas', () => {
    expect(isPassRef('pass://Personal/Gmail/token')).toBe(true);
  });
  it('rechaza referencias mal formadas', () => {
    expect(isPassRef('pass://Personal/Gmail')).toBe(false);
    expect(isPassRef('otra-cosa')).toBe(false);
  });
});

describe('ProtonPassVault.status', () => {
  it('reporta no instalado si el binario no existe', async () => {
    const vault = new ProtonPassVault(scriptedExec({ 'proton-pass --version': new Error('ENOENT') }));
    const status = await vault.status();
    expect(status.installed).toBe(false);
    expect(status.hint).toContain('Instala');
  });

  it('reporta no logueado si whoami falla', async () => {
    const vault = new ProtonPassVault(
      scriptedExec({ 'proton-pass --version': ok('1.0.0'), 'proton-pass whoami': fail('not logged in') }),
    );
    const status = await vault.status();
    expect(status).toMatchObject({ installed: true, loggedIn: false });
    expect(status.hint).toContain('proton-pass login');
  });

  it('reporta OK cuando está instalado y logueado', async () => {
    const vault = new ProtonPassVault(
      scriptedExec({ 'proton-pass --version': ok('1.0.0'), 'proton-pass whoami': ok('user@proton.me') }),
    );
    expect(await vault.status()).toEqual({ installed: true, loggedIn: true });
  });
});

describe('ProtonPassVault.resolve', () => {
  it('devuelve el secreto sin el salto de línea final', async () => {
    const vault = new ProtonPassVault(
      scriptedExec({ 'proton-pass read pass://Personal/Gmail/token': ok('secreto-123\n') }),
    );
    expect(await vault.resolve('pass://Personal/Gmail/token')).toBe('secreto-123');
  });

  it('lanza en referencia inválida sin invocar el CLI', async () => {
    const vault = new ProtonPassVault(scriptedExec({}));
    await expect(vault.resolve('pass://x/y')).rejects.toThrow('inválida');
  });

  it('lanza si el CLI falla', async () => {
    const vault = new ProtonPassVault(
      scriptedExec({ 'proton-pass read pass://A/B/C': fail('item not found') }),
    );
    await expect(vault.resolve('pass://A/B/C')).rejects.toThrow('item not found');
  });

  it('lanza si el valor viene vacío', async () => {
    const vault = new ProtonPassVault(scriptedExec({ 'proton-pass read pass://A/B/C': ok('\n') }));
    await expect(vault.resolve('pass://A/B/C')).rejects.toThrow('vacío');
  });
});

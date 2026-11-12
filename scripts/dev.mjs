// Modo desarrollo: compila al guardar y muestra los cambios sin cerrar la app.
//  - Cambios en la interfaz (src/renderer): la ventana se recarga sola.
//  - Cambios en el proceso principal (src/main, src/connectors…): Electron se reinicia.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import electron from 'electron';

const tsc = join('node_modules', 'typescript', 'bin', 'tsc');

const build = spawnSync('npm run build', { stdio: 'inherit', shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

// Compiladores en modo vigilancia.
const watchers = [
  spawn(process.execPath, [tsc, '-w', '-p', 'tsconfig.main.json', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(process.execPath, [tsc, '-w', '-p', 'tsconfig.renderer.json', '--preserveWatchOutput'], { stdio: 'inherit' }),
];

// HTML y CSS no pasan por el compilador: se copian al guardar.
let copyTimer;
watch('src/renderer', (_event, file) => {
  if (file !== 'index.html' && file !== 'styles.css') return;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    try {
      cpSync(`src/renderer/${file}`, `dist/web/renderer/${file}`);
    } catch (err) {
      console.error(`[dev] no se pudo copiar ${file}:`, err.message);
    }
  }, 100);
});

// Electron, reiniciado cuando cambia el JS del proceso principal.
const env = { ...process.env, MATAMOSCAS_DEV: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let restarting = false;

function startApp() {
  app = spawn(electron, ['.'], { stdio: 'inherit', env });
  app.on('exit', () => {
    if (restarting) {
      restarting = false;
      startApp();
    } else {
      shutdown(); // el usuario cerró la ventana
    }
  });
}

const mainFiles = new Map();
function snapshotMain() {
  const changed = [];
  for (const dir of ['dist/main', 'dist/connectors', 'dist/core', 'dist/shared']) {
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const content = readFileSync(path, 'utf8');
      if (mainFiles.get(path) !== content) changed.push(path);
      mainFiles.set(path, content);
    }
  }
  return changed;
}
snapshotMain();

let restartTimer;
watch('dist', { recursive: true }, (_event, file) => {
  if (!file || !file.endsWith('.js') || file.startsWith('web')) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    const changed = snapshotMain();
    if (changed.length === 0 || !app) return;
    console.log(`[dev] reiniciando Electron (${changed.join(', ')})`);
    restarting = true;
    app.kill();
  }, 300);
});

function shutdown() {
  for (const w of watchers) w.kill();
  process.exit(0);
}
process.on('SIGINT', () => {
  restarting = false;
  app?.kill();
  shutdown();
});

startApp();

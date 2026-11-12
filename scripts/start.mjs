// Arranca Electron. Quitamos ELECTRON_RUN_AS_NODE porque las terminales de
// VS Code lo definen y haría que Electron arrancase como un Node normal.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));

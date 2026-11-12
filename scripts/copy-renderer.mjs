// Copia el HTML y el CSS de la interfaz junto al JS compilado.
import { cpSync } from 'node:fs';

for (const file of ['index.html', 'styles.css']) {
  cpSync(`src/renderer/${file}`, `dist/web/renderer/${file}`);
}

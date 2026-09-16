/**
 * Assembla la cartella pubblicabile della dimostrazione.
 * L'app usa percorsi assoluti (/styles.css, /font/...) perché in esercizio sta
 * alla radice del dominio; qui vive in una sottocartella, quindi vanno resi
 * relativi. Nient'altro viene toccato: il codice è lo stesso della produzione.
 *
 *   node demo/costruisci.js [cartella-di-destinazione]
 */

import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const radice = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destinazione = resolve(process.argv[2] ?? join(radice, 'demo', 'costruito'));
const sqljs = process.env.SQLJS_DIST ?? join(radice, 'node_modules', 'sql.js', 'dist');

await rm(destinazione, { recursive: true, force: true });
await mkdir(join(destinazione, 'demo'), { recursive: true });

await cp(join(radice, 'public'), join(destinazione, 'public'), { recursive: true });
await mkdir(join(destinazione, 'src'), { recursive: true });
// Solo i moduli che il browser esegue davvero: gli adattatori di server restano fuori.
for (const file of ['api.js', 'auth.js', 'util.js']) {
  await cp(join(radice, 'src', file), join(destinazione, 'src', file));
}
for (const file of ['avvio.js', 'db-sqljs.js', 'dati.js', 'stile.css']) {
  await cp(join(radice, 'demo', file), join(destinazione, 'demo', file));
}
for (const file of ['sql-wasm.js', 'sql-wasm.wasm', 'sql-asm.js']) {
  await cp(join(sqljs, file), join(destinazione, 'demo', file));
}
await cp(join(radice, 'demo', 'index.html'), join(destinazione, 'index.html'));

// Lo schema viaggia come modulo: niente fetch, che certe politiche di sicurezza bloccano.
const schema = await readFile(join(radice, 'schema.sql'), 'utf8');
await writeFile(join(destinazione, 'demo', 'schema.js'), `export const SCHEMA = ${JSON.stringify(schema)};\n`);

/** Da percorsi assoluti a relativi, sapendo dove si trova il file che li contiene. */
async function riscrivi(file, sostituzioni) {
  const percorso = join(destinazione, file);
  let testo = await readFile(percorso, 'utf8');
  for (const [da, a] of sostituzioni) testo = testo.split(da).join(a);
  await writeFile(percorso, testo);
}

await riscrivi('public/tema.css', [["url('/font/", "url('font/"]]);
await riscrivi('public/app.js', [["src: '/icona.svg'", "src: 'public/icona.svg'"], ["href: '/privacy.html'", "href: 'public/privacy.html'"]]);
await riscrivi('public/privacy.html', [['href="/styles.css"', 'href="styles.css"'], ['href="/tema.css"', 'href="tema.css"'], ['href="/"', 'href="../index.html"']]);

console.log(`Dimostrazione pronta in ${destinazione}`);

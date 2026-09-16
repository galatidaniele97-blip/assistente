// Recupero del codice del ristorante quando è andato perso.
// Nel database sta solo l'impronta: questo comando ne calcola una nuova e
// stampa l'istruzione SQL da eseguire (in locale con sqlite3, su Cloudflare
// con `wrangler d1 execute mensa --remote --command "..."`).
//
//   npm run codice -- NUOVOCODICE

import { hashCode, normalizeCode } from '../src/auth.js';

const code = normalizeCode(process.argv[2]);
if (code.length < 6) {
  console.error('Uso: npm run codice -- NUOVOCODICE   (almeno 6 caratteri, lettere e cifre)');
  process.exit(1);
}
const hash = await hashCode(code);
console.log(`Codice: ${code}\n`);
console.log(`UPDATE restaurant SET code_hash = '${hash}', token_version = token_version + 1 WHERE id = 1;`);
console.log('\nLe sessioni aperte con il vecchio codice decadono.');

# Mensa — ordini pasto della mensa aziendale

Sostituisce l'Excel settimanale, i fogli stampati e le firme a mano. Il ristorante pubblica il menù,
i dipendenti ordinano dal telefono scegliendo il proprio nome da un elenco, e da lì escono i due
documenti che fanno funzionare il servizio: **cosa cucinare** e **cosa consegnare a chi**.

## I tre ruoli

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Ristorante** | codice del ristorante | crea le aziende, assegna i codici, configura lettere e massimi, compila la griglia del menù (anche diversa per azienda, con "copia a tutte"), consulta i riepiloghi, cancella i dati storici |
| **Referente azienda** | codice referente | gestisce l'elenco dei propri dipendenti (nome + numero di armadietto), vede lo stato degli ordini e la lista di consegna della propria azienda |
| **Dipendente** | codice dipendenti | sceglie il proprio nome da un elenco, ordina per i cinque giorni, può segnare "non pranzo", può correggere quando vuole |

Ogni azienda ha **due codici**: uno per i dipendenti, uno per il referente. Il codice del ristorante è
il terzo. Sono tutti rigenerabili dalla scheda *Aziende* — per esempio quando una persona lascia l'azienda.

## Il menù e le regole

Il menù è la stessa griglia del foglio settimanale: **una riga per lettera, una colonna per giorno**.
Le lettere sono quelle che ristorante e aziende già usano.

| | | |
| --- | --- | --- |
| **A**, **B** | Primi | se ne sceglie uno |
| **E**, **F** | Secondi | se ne sceglie uno: niente doppio secondo |
| **G**, **H** | Contorni | fino a due |
| **L** | Dessert | uno |
| **P** | Frutta | una |
| **T** | Pasto unico | vale da solo un pasto completo |

In tutto **3 piatti al giorno**, oppure un solo piatto unico. Il pasto unico non è solo la T: una
singola casella può essere contrassegnata come piatto unico, ed è il caso della pizza quando compare
fra i secondi.

Tutto questo è configurabile per azienda, perché i contratti sono diversi: cambiano i piatti al
giorno, le portate, le lettere e i massimi. Le regole stanno in un unico file
(`public/shared/regole.js`) usato sia dal client sia dal server, quindi l'interfaccia disattiva le
scelte impossibili e il server le rifiuta comunque.

**Due sostituzioni automatiche**, perché sono scelte "l'una al posto dell'altra": toccare B quando si
ha già A sostituisce il primo invece di sommarsi, e toccare un piatto unico sostituisce tutto il
resto del giorno. Quando i 3 piatti sono presi, le altre caselle si spengono: il limite si impedisce,
non si segnala dopo.

## Le regole che il sistema garantisce

- **Il nome non si digita mai.** Il dipendente lo sceglie da un elenco precaricato dal referente. È la
  causa principale degli errori di oggi (firme sul nome sbagliato) ed è eliminata alla radice: il server
  accetta solo id di persone appartenenti all'azienda della sessione.
- **Vale sempre l'ultimo invio.** Un solo ordine per persona per settimana: ogni invio riscrive l'intera
  settimana in una transazione.
- **Nessuna azienda vede i dati di un'altra.** Il perimetro dati è ricavato dalla sessione firmata, mai da
  un parametro del client. I test lo verificano esplicitamente.
- **Correggere il menù non azzera gli ordini.** Chi ha scelto la A di lunedì continua ad avere la A anche
  se il ristorante ne corregge il piatto, esattamente come sul foglio. Svuotare una casella, invece,
  toglie la scelta a chi l'aveva presa, e l'interfaccia lo dice prima.

## I due output

- **Cucina** — per ogni giorno, le porzioni di ogni piatto sommando tutte le aziende, con la lettera
  accanto. Stampabile ed esportabile in CSV (separatore `;` e BOM: Excel italiano lo apre senza passaggi).
- **Consegne** — per ogni giorno e per ogni azienda, le persone **ordinate per numero di armadietto**
  con lettere e piatti. Ordinamento naturale: `3` viene prima di `12`, e `12A` subito dopo `12`.

## Avvio in locale

Serve solo Node 22.5 o superiore (nessuna dipendenza da installare: il database è `node:sqlite`).

```bash
npm start           # http://localhost:8787
npm test            # 21 test sulle regole di dominio
```

Al primo avvio la pagina chiede nome del ristorante e codice di accesso: da lì si creano le aziende.

## Messa in produzione (Cloudflare Workers + D1)

Il costo di esercizio è praticamente nullo: per una ventina di aziende e qualche centinaio di persone
il traffico e lo spazio rientrano ampiamente nel piano gratuito (100.000 richieste al giorno, 5 GB di D1).

```bash
npx wrangler d1 create mensa            # copia il database_id in wrangler.toml
npm run db:init                          # crea le tabelle
npx wrangler secret put SESSION_SECRET   # una stringa casuale lunga
npm run deploy
```

Il cron notturno (`0 3 * * *`) cancella gli ordini più vecchi di `RETENTION_WEEKS` settimane.

## Come è fatto

```
schema.sql          tabelle SQLite/D1
src/api.js          router e regole di dominio (nessuna dipendenza dal runtime)
src/auth.js         sessioni firmate HMAC, codici di accesso, limitazione tentativi
src/util.js         risposte HTTP, validazione, ordinamento armadietti
src/db-d1.js        adattatore Cloudflare D1
src/db-sqlite.js    adattatore node:sqlite
src/worker.js       entry point Cloudflare (API + file statici + cron)
dev-server.js       entry point locale, stessa API
public/             interfaccia (nessun framework, nessun passo di build)
public/shared/      regole di ordinazione e settimana ISO, condivise tra server e client
test/api.test.js    test end-to-end sull'API
```

L'API è una funzione pura `handleApi(request, env, db)`: gli adattatori D1 e SQLite espongono la stessa
interfaccia (`all`, `first`, `run`, `batch`), quindi lo stesso codice gira in locale e su Cloudflare e i
test girano in memoria senza mock.

Il client non usa `innerHTML` in nessun punto: tutto il DOM è costruito con nodi di testo, e la
Content-Security-Policy vieta script e stili esterni.

## Tema (colori e font)

L'app veste l'identita del **Ristorante Pizzeria Time Out** di Lemignano di Collecchio, con i colori
campionati dal loro sito:

| | |
| --- | --- |
| `#F2A45E` arancio del pannello | pulsante di invio, barra della settimana |
| `#EF885A` arancio delle etichette | bordo della scelta attiva |
| `#A6522E` arancio scurito | testo, link, etichette di portata |
| `#15130F` nero caldo | intestazione, testo |
| `#F8F6F1` crema | schede e sfondi |

Una differenza voluta rispetto al sito: loro scrivono in bianco sull'arancio (contrasto 2,05:1), qui
sopra l'arancio va il nero del marchio (9,05:1). Queste schermate si leggono in piedi in fabbrica, e
tutte le combinazioni di testo dell'app superano WCAG AA.

Il carattere e **Jost**, il geometrico piu vicino a quello del sito, auto-ospitato in `public/font/`
(SIL Open Font License, ~40 KB). Niente Google Fonts: nessun indirizzo IP dei dipendenti finisce a
terzi e la Content-Security-Policy resta limitata alla sola origine dell'app. I titoli usano Jost, i
nomi dei piatti il carattere di sistema, perche quello e il testo che si legge di corsa.

Tutto sta in `public/tema.css`: cambiare quei valori riveste l'intera applicazione. Tre riferimenti
vanno allineati a mano perche non leggono il CSS: `theme-color` in `public/index.html`, `theme_color`
in `public/manifest.webmanifest` e i colori di `public/icona.svg`.

## Privacy

Le scelte alimentari possono rivelare dati sensibili (allergie, convinzioni religiose). Per questo:

- l'informativa è raggiungibile da ogni schermata;
- i dati raccolti sono solo nome, armadietto, azienda, piatti scelti e orario dell'ultimo invio;
- la cancellazione di una persona cancella immediatamente tutti i suoi ordini;
- il dipendente può cancellare da sé i propri ordini;
- il ristorante può cancellare i dati storici precedenti a una settimana scelta;
- la pulizia automatica gira comunque ogni notte.

## Scelte progettuali degne di nota

- **Due codici per azienda.** La traccia ne prevede uno; con uno solo il referente e i dipendenti
  sarebbero indistinguibili e chiunque potrebbe modificare l'anagrafica. I codici sono brevi e senza
  caratteri ambigui (niente `O`/`0`, `I`/`1`) perché vengono letti a voce e trascritti.
- **Codici in chiaro nel database.** Il ristorante deve poterli rileggere per comunicarli. Sono
  credenziali condivise e a bassa sensibilità, rigenerabili in un tocco.
- **Il blocco dei tentativi conta per codice, non per indirizzo IP.** Un'azienda intera esce spesso da
  un solo IP: contare per IP significherebbe che una persona che sbaglia il codice blocca i colleghi.
  Si fermano quindi i tentativi ripetuti sullo stesso codice (10 ogni 15 minuti), con un tetto per IP
  molto più alto (200) che ferma solo un attacco a forza bruta. Nella tabella dei tentativi finisce
  un'impronta del codice, non il codice.
- **"Copia a tutte" allinea per lettera.** Aziende con contratti diversi hanno griglie diverse: i piatti
  delle lettere che l'azienda di destinazione non ha vengono ignorati, e l'operazione dice quali, invece
  di finire nella riga sbagliata.
- **Tre piatti sono un massimo, non un obbligo.** Chi non vuole il dessert ne prende due. Se invece il
  contratto prevede sempre tre portate, si cambia in una riga.
- **Due contorni insieme si possono prendere.** La regola scritta vieta il doppio secondo e tace sui
  contorni, quindi G+H è ammesso; se non lo è, basta portare il massimo dei contorni da 2 a 1 nelle
  regole dell'azienda.
- **Armadietto come testo.** Ammette `12A` o `B3`, ma l'ordinamento resta numerico dove ha senso.

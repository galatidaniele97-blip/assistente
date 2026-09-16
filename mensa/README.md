# Mensa — ordini pasto della mensa aziendale

Sostituisce l'Excel settimanale, i fogli stampati e le firme a mano. Il ristorante pubblica il menù,
i dipendenti ordinano dal telefono scegliendo il proprio nome da un elenco, e da lì escono i due
documenti che fanno funzionare il servizio: **cosa cucinare** e **cosa consegnare a chi**.

## I tre ruoli

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Ristorante** | codice del ristorante | crea le aziende, assegna i codici, configura le portate e i massimi, pubblica il menù (anche diverso per azienda, con "copia a tutte"), consulta i riepiloghi, cancella i dati storici |
| **Referente azienda** | codice referente | gestisce l'elenco dei propri dipendenti (nome + numero di armadietto), vede lo stato degli ordini e la lista di consegna della propria azienda |
| **Dipendente** | codice dipendenti | sceglie il proprio nome da un elenco, ordina per i cinque giorni, può segnare "non pranzo", può correggere quando vuole |

Ogni azienda ha **due codici**: uno per i dipendenti, uno per il referente. Il codice del ristorante è
il terzo. Sono tutti rigenerabili dalla scheda *Aziende* — per esempio quando una persona lascia l'azienda.

## Le regole che il sistema garantisce

- **Il nome non si digita mai.** Il dipendente lo sceglie da un elenco precaricato dal referente. È la
  causa principale degli errori di oggi (firme sul nome sbagliato) ed è eliminata alla radice: il server
  accetta solo id di persone appartenenti all'azienda della sessione.
- **I limiti non si superano.** Ogni azienda ha le sue portate con un massimo giornaliero. L'interfaccia
  disattiva le opzioni quando il limite è raggiunto (e con massimo 1 la nuova scelta sostituisce la
  precedente, senza passaggi intermedi). Il server ricontrolla comunque ogni invio.
- **Vale sempre l'ultimo invio.** Un solo ordine per persona per settimana: ogni invio riscrive l'intera
  settimana in una transazione.
- **Nessuna azienda vede i dati di un'altra.** Il perimetro dati è ricavato dalla sessione firmata, mai da
  un parametro del client. I test lo verificano esplicitamente.
- **Modificare il menù non azzera gli ordini.** Il salvataggio è differenziale: i piatti invariati
  mantengono il proprio id, quindi le scelte già inviate restano valide.

## I due output

- **Cucina** — per ogni giorno, le porzioni di ogni piatto sommando tutte le aziende. Stampabile ed
  esportabile in CSV (separatore `;` e BOM: Excel italiano lo apre senza passaggi).
- **Consegne** — per ogni giorno e per ogni azienda, le persone **ordinate per numero di armadietto**
  con le rispettive scelte. Ordinamento naturale: `3` viene prima di `12`, e `12A` subito dopo `12`.

## Avvio in locale

Serve solo Node 22.5 o superiore (nessuna dipendenza da installare: il database è `node:sqlite`).

```bash
npm start           # http://localhost:8787
npm test            # 14 test sulle regole di dominio
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
public/shared/      utilità settimana ISO, condivise tra server e client
test/api.test.js    test end-to-end sull'API
```

L'API è una funzione pura `handleApi(request, env, db)`: gli adattatori D1 e SQLite espongono la stessa
interfaccia (`all`, `first`, `run`, `batch`), quindi lo stesso codice gira in locale e su Cloudflare e i
test girano in memoria senza mock.

Il client non usa `innerHTML` in nessun punto: tutto il DOM è costruito con nodi di testo, e la
Content-Security-Policy vieta script e stili esterni.

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
  credenziali condivise e a bassa sensibilità, rigenerabili in un tocco; i tentativi di accesso sono
  limitati a 25 ogni 15 minuti per indirizzo IP.
- **"Copia a tutte" allinea per nome di portata.** Aziende con contratti diversi hanno portate diverse:
  i piatti di una portata che l'azienda di destinazione non ha vengono ignorati e conteggiati nel
  riepilogo dell'operazione, invece di finire nella portata sbagliata.
- **Armadietto come testo.** Ammette `12A` o `B3`, ma l'ordinamento resta numerico dove ha senso.

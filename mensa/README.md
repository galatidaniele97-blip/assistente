# Mensa — ordini pasto della mensa aziendale

Sostituisce l'Excel settimanale, i fogli stampati e le firme a mano. Il ristorante pubblica il menù,
i dipendenti ordinano dal telefono scegliendo il proprio nome da un elenco, e da lì escono i due
documenti che fanno funzionare il servizio: **cosa cucinare** e **cosa consegnare a chi**.

## I tre ruoli

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Ristorante** | codice del ristorante | crea le aziende, assegna i codici, configura lettere e massimi, compila la griglia del menù (anche diversa per azienda, con "copia a tutte"), consulta i riepiloghi, cancella i dati storici |
| **Referente azienda** | codice referente | gestisce l'elenco dei propri dipendenti (nome + armadietto), condivide il link, mette le persone in stand-by o le blocca, aggiunge pasti extra, vede stato ordini e consegne della propria azienda |
| **Dipendente** | codice dipendenti + PIN personale | sceglie il proprio nome da un elenco, entra con il suo PIN, ordina la settimana successiva per i cinque giorni, può segnare "non pranzo", può correggere fino alla scadenza |

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

**Il menù si incolla da Excel.** Il ristorante seleziona nel suo foglio le righe delle lettere con i
cinque giorni, copia, e incolla nella finestra *Incolla da Excel*: va bene con o senza la colonna della
portata, con l'intestazione, con le caselle vuote scritte `/////`. Un'anteprima mostra che cosa è stato
riconosciuto, poi si riempie la griglia e si salva. Le celle che contengono "pizza" vengono proposte
come piatto unico. Allo stesso modo il referente incolla l'**elenco dei dipendenti** (nome e armadietto
per riga, in qualunque ordine): chi c'è già viene saltato, un armadietto occupato blocca solo quella riga.

Tutto questo è configurabile per azienda, perché i contratti sono diversi: cambiano i piatti al
giorno, le portate, le lettere e i massimi. Le regole stanno in un unico file
(`public/shared/regole.js`) usato sia dal client sia dal server, quindi l'interfaccia disattiva le
scelte impossibili e il server le rifiuta comunque.

**Due sostituzioni automatiche**, perché sono scelte "l'una al posto dell'altra": toccare B quando si
ha già A sostituisce il primo invece di sommarsi, e toccare un piatto unico sostituisce tutto il
resto del giorno. Quando i 3 piatti sono presi, le altre caselle si spengono: il limite si impedisce,
non si segnala dopo.

## Il PIN personale e il link in chat

Il referente manda nella chat di gruppo un link con il codice dell'azienda già dentro
(`…/?c=CODICE`, pulsante "Copia" nella scheda *Persone*). Chi lo apre sceglie il proprio nome dall'elenco
e inserisce il **PIN che il referente gli ha assegnato**: ogni persona nasce con un PIN a caso, mostrato
al referente una volta sola (anche per l'importazione in blocco, con l'elenco da copiare), e il referente
può riassegnarlo in qualsiasi momento con "Nuovo PIN". La persona lo cambia poi dal proprio ordine con uno
suo. Così nessuno ordina a nome di un collega, e il nome continua a non digitarsi mai. Otto tentativi
sbagliati bloccano quel PIN per un quarto d'ora; nel database sta solo l'impronta.

## Stand-by, blocco, pasti extra

- **Stand-by per giorno.** Valeria ha ordinato venerdì, martedì si mette in malattia: il referente tocca
  i giorni nello *Stato ordini* e quei pasti spariscono da cucina e consegne — nessuno li cuoce, nessuno
  li paga. Vale anche a settimana chiusa, perché toglie soltanto; toccare di nuovo riattiva.
- **Blocco.** *Blocca* toglie una persona dall'elenco e dai pasti finché non la si riattiva (dimissioni,
  lunga assenza); i suoi ordini restano, così *Riattiva* rimette tutto com'era.
- **Pasti extra.** Per chi non è in elenco — un interinale per un giorno, un ospite — il referente
  aggiunge "N pasti con A, E, H" senza registrare nessuno. Stesse regole di un ordine normale, contati in
  cucina, elencati in consegna sotto l'azienda e nel CSV come `EXTRA`.

Una regola tiene insieme tutto: **dopo la scadenza il referente può solo togliere pasti, mai
aggiungerne.** Sospendere o togliere un extra fa cuocere di meno, nessun danno; aggiungere un extra il
lunedì per uno arrivato all'ultimo resta una telefonata, perché la cucina non può cuocere ciò che non
ha pianificato.

## La scadenza: venerdì alle 12

Le aziende ordinano e correggono la **settimana successiva** fino al **venerdì alle 12:00** (ora
italiana) della settimana in corso. Da quel momento la settimana è chiusa: la cucina ci conta, e non si
modifica più nulla. Il dipendente che apre l'app atterra direttamente sulla prima settimana ancora aperta;
può tornare indietro a rileggere quello che aveva scelto, ma le caselle sono spente e il pulsante di
invio dice "Settimana chiusa". Il server rifiuta comunque ogni invio fuori tempo (`423`), qualunque
cosa faccia il client.

Giorno e ora si cambiano dalla scheda *Impostazioni* del ristorante. L'ora è locale al fuso
configurato (`Europe/Rome`): l'ora legale è gestita da `Intl`, sia su Cloudflare sia in Node sia nel
browser, e il test lo verifica su una settimana d'estate e una d'inverno.

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
npm test            # 32 test sulle regole di dominio
```

Al primo avvio la pagina chiede nome del ristorante e codice di accesso: da lì si creano le aziende.

## Dimostrazione senza installare niente

`npm run demo` assembla in `demo/costruito/` una copia dell'app che gira **tutta nel browser**: SQLite
compilato in WebAssembly (sql.js, con ripiego sulla versione in solo JavaScript dove la WebAssembly è
bloccata), l'API vera sopra, e `fetch` dirottato verso di essa. Nessun server, nessun dato che esce dal
telefono, e ricaricando la pagina si riparte da capo. Serve per far provare l'app a qualcuno mandandogli
un link, non per usarla davvero: si può pubblicare su qualsiasi hosting statico.

Dentro ci sono il menù reale della settimana, due aziende con regole diverse, sei persone, qualche
ordine già inviato e una persona in stand-by da mercoledì. Un pannello elenca i codici dei cinque ruoli
da provare.

## Messa in produzione (Cloudflare Workers + D1)

Il costo di esercizio è praticamente nullo: per una ventina di aziende e qualche centinaio di persone
il traffico e lo spazio rientrano ampiamente nel piano gratuito (100.000 richieste al giorno, 5 GB di D1).

```bash
npx wrangler d1 create mensa            # copia il database_id in wrangler.toml
npm run db:init                          # crea le tabelle
npx wrangler secret put SESSION_SECRET   # una stringa casuale lunga
npx wrangler secret put SETUP_CODE       # richiesto dal primo avvio: chiude la finestra fra deploy e configurazione
npm run deploy
```

Se il codice del ristorante va perso: `npm run codice -- NUOVOCODICE` stampa l'istruzione SQL da eseguire
con `wrangler d1 execute mensa --remote --command "..."`. Nel database sta solo l'impronta del codice.

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
public/shared/      regole, scadenza, lettura del testo incollato, settimana ISO: condivisi tra server e client
scripts/            recupero del codice del ristorante
demo/               dimostrazione che gira nel browser (npm run demo)
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

## Sicurezza

- **Perimetro dati dalla sessione, mai dal client.** Ogni token firmato (HMAC-SHA256) porta ruolo e
  azienda; ogni query filtra su quelli. Un referente non vede altre aziende, un dipendente non vede
  altri dipendenti oltre all'elenco dei nomi della propria.
- **Sessioni revocabili.** Rigenerare i codici di un'azienda, o cambiare quello del ristorante, fa
  decadere all'istante le sessioni aperte con i codici vecchi (versione nel token confrontata col
  database a ogni richiesta). Quella del dipendente dura una settimana, non un mese: il telefono in
  reparto può essere condiviso.
- **Il codice del ristorante non sta in chiaro** (PBKDF2, 100.000 iterazioni, confronto a tempo
  costante). I codici delle aziende sì, perché il ristorante deve poterli rileggere per comunicarli:
  sono credenziali condivise, a bassa sensibilità, rigenerabili in un tocco.
- **Tentativi di accesso limitati per codice**, non per IP: 10 ogni 15 minuti sullo stesso codice, 200
  per IP. Una persona che sbaglia non blocca i colleghi che escono dallo stesso indirizzo.
- **Primo avvio protetto** da `SETUP_CODE`: nessuno può configurare il ristorante al posto vostro fra la
  messa in rete e il primo accesso.
- **Corpo delle richieste** con content-type obbligatorio (niente invii "semplici" da pagine estranee)
  e tetto di 256 KB. Ogni campo ha una lunghezza massima; le importazioni un numero massimo di righe.
- **Content-Security-Policy chiusa alla sola origine** (font auto-ospitati), niente `innerHTML` nel
  client, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **CSV a prova di formule.** Un nome che inizia con `=`, `+`, `-` o `@` viene neutralizzato con un
  apostrofo: Excel lo mostra come testo invece di eseguirlo.
- **PIN personale per dipendente** (PBKDF2, 8 tentativi ogni 15 minuti per persona): chi ha il codice
  dell'azienda vede l'elenco dei nomi ma non può ordinare a nome di un collega. Un PIN sbagliato non
  butta fuori dalla sessione: si riprova.
- **Il PIN iniziale lo assegna il referente**, non chi arriva prima all'elenco: nessuno può prendersi
  l'identità di un collega prima che questi entri.

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

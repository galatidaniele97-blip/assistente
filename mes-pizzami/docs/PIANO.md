# MES Pizzami – Modulo 1: Prodotto finito (bancali) e lettura GS1-128

Piano di progetto proposto prima dell'implementazione. Scope: solo bancali di
prodotto finito e scansione GS1. Fuori scope: materie prime, ricette, food cost,
AI, report, DDT in ingresso.

## 1. Ambiente di sviluppo

**Scelta consigliata: SQL Server 2022 Developer in Docker.** Un solo comando,
nessuna installazione su Windows, stesso motore T-SQL della produzione.

```powershell
docker run -d --name mes-sql `
  -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=Pizzami!Demo2026" -e "MSSQL_PID=Developer" `
  -p 1433:1433 -v mes-sql-data:/var/opt/mssql `
  mcr.microsoft.com/mssql/server:2022-latest
```

Stringa di connessione (ADO.NET / pacchetto `mssql`):

```
Server=localhost,1433;Database=MesPizzami;User Id=sa;Password=Pizzami!Demo2026;TrustServerCertificate=True;Encrypt=True
```

Alternativa senza Docker: **SQL Server 2022 Express** locale (installer
"Basic"), istanza `localhost\SQLEXPRESS`, autenticazione Windows. Gli script
SQL sono identici in entrambi i casi.

Vincoli sugli script SQL (portabilità sul server di produzione):

- Solo T-SQL standard, nessuna feature Enterprise (no partizionamento, no
  compressione, no In-Memory OLTP).
- Script idempotenti (`IF OBJECT_ID(...) IS NULL`), numerati ed eseguibili in
  ordine con `sqlcmd` o SSMS.
- Nessun riferimento al database del gestionale Business Cube: database
  separato `MesPizzami` sulla stessa istanza.

## 2. Schema dati

Convenzioni su **ogni** tabella: `TenantId`, `PlantId`, `CreatedAt`,
`CreatedBy`, `UpdatedAt`, `UpdatedBy`, `IsDeleted`, `DeletedAt`. Chiavi
primarie `INT IDENTITY`, chiavi naturali (GTIN, SSCC, codice) con vincolo
`UNIQUE` filtrato su `IsDeleted = 0`. Foreign key esplicite ovunque.

### Tabelle

| Tabella | Contenuto | Note |
|---|---|---|
| `Tenant`, `Plant` | Azienda e stabilimento | Seed: Pizzami / Parma |
| `AppUser` | Operatori (codice, nome, ruolo) | Per la demo login senza password: si sceglie l'operatore da una lista |
| `UnitOfMeasure` | PZ (pezzo), CO (collo), BC (bancale) | |
| `ProductFormat` | pizza, pinsa, pane, focaccia | Lookup: aggiungere un formato non richiede modifiche allo schema |
| `StorageType` | FRESCO, SURGELATO | Lookup |
| `Product` | Articolo finito: GTIN (14 cifre), codice interno, descrizione, formato, conservazione, UdM base, pezzi per collo, colli per bancale, shelf life giorni | GTIN unico per tenant |
| `UomConversion` | Conversione per articolo: da UdM → a UdM, fattore | Es. PZ→CO = 6, CO→BC = 60. Il fattore PZ→BC si ricava per moltiplicazione |
| `ProductionLot` | Lotto: articolo, numero lotto, data produzione, TMC, scadenza | Il lotto è un'entità autonoma: è ciò che si richiama in caso di recall |
| `Pallet` | Bancale: SSCC (18 cifre), articolo, stato corrente, colli attesi/effettivi, peso netto | SSCC unico per tenant |
| `PalletLot` | Contenuto del bancale: bancale, lotto, colli | Vedi "Bancale e lotti" sotto |
| `PalletStatus` | DA_PRODURRE, PRODOTTO, PRENOTATO, SPEDITO | Con ordinamento e flag finale |
| `PalletStatusTransition` | Transizioni ammesse: stato da → stato a, nome azione | **La macchina a stati vive qui** |
| `PalletStatusLog` | Storico: bancale, stato da, stato a, utente, timestamp, note | Una riga per ogni transizione |
| `ScanEvent` | Ogni scansione: stringa grezza + colonne strutturate (SSCC, GTIN, lotto, date, colli, peso), esito parsing, bancale collegato, utente | Traccia anche le scansioni fallite |

### Bancale e lotti: proposta molti-a-molti

Proposta: `Pallet` ↔ `ProductionLot` in relazione **molti-a-molti** tramite
`PalletLot`, con quantità di colli sulla riga di collegamento.

Motivazione:

- Un lotto di produzione genera normalmente decine di bancali: la relazione
  lotto → bancale è già 1-a-molti per natura, quindi il lotto deve esistere
  come entità propria (numero, articolo, date). Le date TMC/scadenza sono
  proprietà del lotto, non del bancale.
- A fine turno o fine lotto capita di dover chiudere un bancale con i colli
  residui di due lotti (lotto "misto"). Con il molti-a-molti questo è un
  secondo record in `PalletLot`, senza eccezioni nel codice.
- Per IFS/BRC il recall parte dal lotto: "quali bancali contengono il lotto X
  e dove sono?" è una singola query su `PalletLot` + `PalletStatusLog`.
- Il caso semplice (un bancale, un lotto) resta semplice: una sola riga.

Regola applicativa: tutti i lotti di un bancale devono essere dello stesso
articolo (vincolo verificato nella stored procedure di inserimento).
L'alternativa 1-a-molti (lotto embedded nel bancale) è stata scartata perché
duplica le date del lotto su ogni bancale e rende il recall una ricerca per
stringa anziché una join.

### Macchina a stati

Ciclo: `DA_PRODURRE → PRODOTTO → PRENOTATO → SPEDITO`.

- Le transizioni ammesse sono righe di `PalletStatusTransition` (seed con le
  tre transizioni del ciclo; aggiungere ad esempio "PRENOTATO → PRODOTTO"
  per annullare una prenotazione è un `INSERT`, non un rilascio).
- Stored procedure `usp_Pallet_ChangeStatus(@PalletId, @ToStatusCode,
  @UserId, @Notes)`: in una transazione verifica che la transizione esista,
  aggiorna `Pallet.StatusId`, scrive `PalletStatusLog`. Transizione non
  ammessa → `THROW` con messaggio in italiano, nessuna modifica.
- La regola sta nel database, quindi vale per qualunque client (tablet, futuri
  import, SSMS).

## 3. Parser GS1-128

Modulo puro, senza dipendenze, testato con unit test. Stesso file usato dal
server (validazione autoritativa prima del salvataggio) e dal browser
(feedback immediato sul tablet).

- Ingresso: stringa così come la manda il lettore in modalità tastiera.
  Gestione del prefisso di simbologia `]C1` (opzionale) e del separatore
  FNC1/GS (ASCII 29) dopo i campi a lunghezza variabile.
- Accetta anche la notazione leggibile con parentesi, es.
  `(01)08012345000015(10)L260917`, utile per prove manuali da tastiera dove
  non si può digitare ASCII 29.
- AI supportati: `00` SSCC (18), `01`/`02` GTIN (14), `10` lotto (var., max
  20), `11` data produzione, `15` TMC, `17` scadenza (AAMMGG, giorno `00` =
  fine mese), `37` colli (var., max 8), `310n` peso netto kg con `n`
  decimali. AI sconosciuti → errore esplicito, non ignorati in silenzio.
- Validazione check digit modulo 10 per GTIN e SSCC; date non valide
  rifiutate.
- Uscita: oggetto con i campi tipizzati + lista errori. Salvato in `ScanEvent`
  in colonne strutturate, con la stringa grezza a fianco solo come
  riferimento.

Si forniranno 4-5 barcode di esempio realistici (con check digit corretti)
sia in forma grezza sia con parentesi, coerenti con i dati di seed.

## 4. Struttura del progetto e framework UI

### Scelta consigliata: applicazione web locale (Node.js) + Edge in modalità kiosk

- Backend: Node.js 22 + Express + pacchetto `mssql`. Gira sul server on-premise
  (Windows, lo stesso di SQL Server) come servizio; il tablet apre l'indirizzo
  in Microsoft Edge in modalità kiosk a schermo intero.
- Frontend: HTML/CSS/JavaScript senza framework né build step. Una sola
  schermata operativa, pulsanti grandi, campo di scansione sempre a fuoco.
- Il lettore keyboard wedge funziona nativamente in un `<input>` del browser.

Perché:

- Zero compilazione, zero dipendenze pesanti: chiunque può leggere e
  modificare il codice.
- Il parser GS1 è un unico file JavaScript usato sia dal server sia dal
  browser.
- Aggiornare l'app = sostituire i file sul server, senza toccare i tablet.
- Unit test con il test runner integrato di Node (`node --test`), nessuna
  libreria aggiuntiva.

Alternativa: .NET 8 (minimal API + stesso frontend web, oppure WPF nativa).
Ha senso se il reparto IT è già orientato a .NET / Business Cube e preferisce
un servizio Windows in C#. Costo: build step, parser da duplicare o
compilare, e in questa sessione di sviluppo non è disponibile il .NET SDK,
quindi non potrei eseguire i test qui.

### Struttura

```
mes-pizzami/
  README.md                 setup in 5 minuti, comandi, barcode di prova
  docs/PIANO.md             questo documento
  db/
    docker-compose.yml      SQL Server 2022 in Docker
    01_schema.sql           tabelle, FK, indici
    02_procedures.sql       usp_Pallet_ChangeStatus, usp_Pallet_Register, ...
    03_seed.sql             tenant, stabilimento, utenti, UdM, articoli, lotti, bancali
    run-scripts.ps1         esegue gli script in ordine con sqlcmd
  src/
    gs1/parser.js           parser GS1 puro (server + browser)
    server/
      index.js              avvio Express, file statici
      db.js                 pool di connessione
      routes/pallets.js     API: scan, dettaglio bancale, cambio stato, log
      routes/products.js    API: anagrafica articoli
    web/
      index.html            schermata operatore (tablet)
      app.js                logica UI
      style.css
  test/
    gs1.test.js             unit test parser (node --test)
    state-machine.test.sql  script di verifica transizioni ammesse/rifiutate
  package.json
```

Il file `index.html` già presente nella radice del repository non viene
toccato: il MES vive nella cartella `mes-pizzami/`.

### Interfaccia operatore (una schermata)

1. Selezione operatore (lista grande, nessuna password nella demo).
2. Campo "Scansiona" sempre a fuoco (il focus torna lì dopo ogni azione e
   ogni tocco fuori dai pulsanti).
3. Dopo la scansione: banner verde (bancale trovato / registrato) o rosso
   (barcode non valido, con il motivo), scheda del bancale con articolo,
   lotti, TMC, colli, stato corrente.
4. Pulsanti grandi con **solo** le transizioni ammesse dallo stato corrente
   (es. in stato PRODOTTO compare solo "Prenota"). Campo note opzionale.
5. Storico transizioni del bancale in fondo alla scheda.
6. Se l'SSCC non esiste ancora: pulsante "Registra bancale" che lo crea in
   stato DA_PRODURRE (o PRODOTTO, a scelta) usando GTIN e lotto letti dallo
   stesso barcode.

## 5. Ordine di implementazione

1. Setup database (Docker compose, script di avvio, README).
2. Schema SQL + procedure + dati di esempio.
3. Parser GS1 con unit test.
4. Logica macchina a stati (stored procedure + test SQL + API).
5. Interfaccia tablet.

## 6. Punti da confermare

1. Framework: applicazione web Node.js (consigliata) oppure .NET 8?
2. Modello bancale-lotti: molti-a-molti con `ProductionLot` entità propria?
3. Il progetto in `mes-pizzami/` nel repository, senza toccare `index.html`?
4. Login demo senza password (selezione operatore da lista): va bene?
5. Stato iniziale di un bancale registrato da scansione: DA_PRODURRE o
   direttamente PRODOTTO?

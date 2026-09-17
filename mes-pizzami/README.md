# MES Pizzami – Modulo 1: bancali di prodotto finito e lettura GS1-128

Demo del primo modulo del MES: anagrafica prodotto finito, ciclo di vita del
bancale (Da produrre → Prodotto → Prenotato → Spedito) e lettura di codici a
barre GS1-128 da tablet Windows con lettore in modalità tastiera.

Documenti:

- `docs/PIANO.md` – piano di progetto e motivazioni delle scelte
- `docs/BARCODE_ESEMPIO.md` – barcode di prova coerenti con i dati di esempio

## 1. Database in 5 minuti

### Opzione A (consigliata): SQL Server 2022 in Docker

Richiede Docker Desktop. Dalla cartella `mes-pizzami/db`:

```powershell
cd mes-pizzami\db
docker compose up -d          # scarica l'immagine ufficiale Microsoft e avvia SQL Server
.\run-scripts.ps1             # Windows: crea database, schema, procedure e dati di esempio
```

Su Linux/macOS al posto dello script PowerShell: `./run-scripts.sh`.
Lo script PowerShell usa `sqlcmd` (installato con SSMS o con i "Microsoft
Command Line Utilities for SQL Server"); quello bash usa lo `sqlcmd` già
presente dentro il container, quindi non richiede nulla sul PC.

Stringa di connessione:

```
Server=localhost,1433;Database=MesPizzami;User Id=sa;Password=Pizzami!Demo2026;TrustServerCertificate=True;Encrypt=True
```

Per cambiare la password: modificare `MSSQL_SA_PASSWORD` in
`docker-compose.yml` e passarla agli script (`-Password` oppure variabile
d'ambiente `MSSQL_SA_PASSWORD`).

### Opzione B: SQL Server 2022 Express locale

Installare SQL Server 2022 Express (installazione "Basic"), poi:

```powershell
cd mes-pizzami\db
.\run-scripts.ps1 -Server "localhost\SQLEXPRESS" -WindowsAuth
```

Stringa di connessione:

```
Server=localhost\SQLEXPRESS;Database=MesPizzami;Integrated Security=True;TrustServerCertificate=True
```

### Verifica

```powershell
.\run-scripts.ps1 -Test        # oppure ./run-scripts.sh --test
```

Esegue `test/state-machine.test.sql`: 14 controlli su macchina a stati,
vincoli e soft delete, dentro una transazione annullata alla fine (il
database resta intatto). Con SSMS si può aprire ed eseguire lo stesso file.

## 2. Script SQL

| File | Contenuto |
|------|-----------|
| `db/00_database.sql` | Crea il database `MesPizzami` |
| `db/01_schema.sql` | Schema `mes`: tabelle, chiavi esterne, indici, viste, trigger di soft delete, funzione check digit GS1 |
| `db/02_procedures.sql` | Macchina a stati (`usp_Pallet_ChangeStatus`), registrazione bancale (`usp_Pallet_Register`), bancali misti (`usp_Pallet_AddLot`), log scansioni (`usp_ScanEvent_Insert`), conversione UdM (`fn_ConvertQuantity`) |
| `db/03_seed.sql` | Tenant, stabilimento, 3 operatori, unità di misura, formati, 5 articoli, lotti e 6 bancali nei vari stati |

Tutti gli script sono idempotenti (si possono rieseguire) e usano solo T-SQL
standard: si portano sul server di produzione senza modifiche. Non toccano il
database del gestionale Business Cube: il MES ha un database separato sulla
stessa istanza.

### Regole implementate nel database

- **Audit e soft delete su ogni tabella**: `CreatedAt/By`, `UpdatedAt/By`,
  `IsDeleted`, `DeletedAt`. Un `DELETE` su qualsiasi tabella dello schema
  `mes` viene intercettato da un trigger e trasformato in soft delete.
- **TenantId e PlantId ovunque**, con chiave esterna composta verso `mes.Plant`
  (uno stabilimento non può essere associato al tenant sbagliato). Unica
  eccezione: `mes.Tenant`, che non ha `PlantId` perché lo stabilimento è suo
  figlio.
- **Check digit GS1 verificato dal database**: `CHECK` constraint su
  `Product.Gtin` e `Pallet.Sscc` tramite `mes.fn_IsGs1CheckDigitValid`.
- **Macchina a stati in tabella**: `mes.PalletStatusTransition` elenca le
  transizioni ammesse; `usp_Pallet_ChangeStatus` rifiuta le altre con errore
  50011 e scrive `mes.PalletStatusLog` nella stessa transazione. Per aggiungere
  ad esempio "Annulla prenotazione" (PRENOTATO → PRODOTTO) basta un `INSERT`.
- **Bancale ↔ lotto molti-a-molti** (`mes.PalletLot` con quantità colli):
  il lotto è un'entità propria (`mes.ProductionLot`) con le sue date TMC/
  scadenza; un bancale misto di fine produzione è una seconda riga. I lotti di
  un bancale devono essere dello stesso articolo (controllo in
  `usp_Pallet_AddLot`).
- **Unità di misura**: i fattori pezzo → collo → bancale stanno solo in
  `mes.UomConversion`; la vista `mes.vw_Product` li espone come
  `PiecesPerCase`, `CasesPerPallet`, `PiecesPerPallet` e
  `mes.fn_ConvertQuantity` converte una quantità tra due unità.

### Viste per l'applicazione

| Vista | Uso |
|-------|-----|
| `mes.vw_Product` | Anagrafica articoli con formato, conservazione e fattori risolti |
| `mes.vw_Pallet` | Scheda bancale: articolo, stato, colli totali, numero lotti |
| `mes.vw_PalletLot` | Lotti presenti sul bancale con date |
| `mes.vw_PalletAllowedTransition` | Pulsanti da mostrare: transizioni ammesse dallo stato corrente |
| `mes.vw_PalletStatusLog` | Storico transizioni leggibile (stato da/a, operatore, data, note) |

## 3. Parser GS1-128, API e interfaccia tablet

In arrivo nelle fasi successive (vedi `docs/PIANO.md`, sezione 5).

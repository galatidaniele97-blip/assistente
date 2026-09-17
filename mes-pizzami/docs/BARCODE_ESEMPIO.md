# Barcode GS1-128 di esempio

Codici fittizi con **check digit corretti**, coerenti con i dati di `db/03_seed.sql`
(prefisso aziendale 8099999).

Il lettore in modalità tastiera invia i caratteri come se fossero digitati.
Dopo i campi a lunghezza variabile, se seguiti da un altro AI, invia il
carattere **GS (ASCII 29)**, qui scritto `<GS>`. Molti lettori aggiungono in
testa il prefisso di simbologia `]C1`. Il parser accetta entrambe le forme e
anche la notazione leggibile con parentesi, comoda per le prove da tastiera.

| # | Caso | Forma leggibile (digitabile) |
|---|------|------------------------------|
| 1 | Bancale esistente, Margherita surgelata, stato PRODOTTO | `(00)380999990000000019(01)18099999000015(15)270915(3103)126000(10)L260915A(37)60` |
| 2 | Bancale misto (2 lotti), stato PRODOTTO | `(00)380999990000000026(01)18099999000015(15)270915(10)L260915A` |
| 3 | Bancale PRENOTATO, 4 Formaggi | `(00)380999990000000033(01)18099999000022(15)270915(10)L260915B(37)60` |
| 4 | Bancale PRODOTTO, Pinsa fresca con scadenza (17) e data produzione (11) | `(00)380999990000000040(01)18099999000039(11)260916(17)261016(10)L260916A(37)80` |
| 5 | Bancale SPEDITO (nessuna transizione possibile) | `(00)380999990000000057(01)18099999000046(11)260914(17)261005(10)L260914A(37)72` |
| 6 | Bancale DA_PRODURRE, Focaccia | `(00)380999990000000064(01)18099999000053(15)270917(10)L260917A(37)48` |
| 7 | **SSCC nuovo**: propone "Registra bancale" | `(00)380999990000000071(01)18099999000053(15)270914(3103)153600(10)L260914A(37)48` |
| 8 | **SSCC nuovo**, Pinsa fresca | `(00)380999990000000088(01)18099999000039(11)260917(17)261017(10)L260917B(37)80` |
| 9 | Errore: check digit SSCC sbagliato | `(00)380999990000000018(01)18099999000015(10)L260915A` |
| 10 | Errore: GTIN valido ma non in anagrafica | `(00)380999990000000071(01)18099999000060(10)L260917X` |
| 11 | Etichetta di collo senza SSCC (non è un bancale) | `(01)18099999000015(15)270915(10)L260915A` |
| 12 | Errore: AI sconosciuto | `(00)380999990000000019(99)ABC` |

Forma grezza (come la invia il lettore) di tre casi, con spazi aggiunti solo
per leggibilità (la stringa reale è continua) e `<GS>` = carattere ASCII 29:

```
]C1 00 380999990000000019 01 18099999000015 15 270915 3103 126000 10 L260915A <GS> 37 60
]C1 00 380999990000000040 01 18099999000039 11 260916 17 261016 10 L260916A <GS> 37 80
]C1 00 380999990000000071 01 18099999000053 15 270914 3103 153600 10 L260914A <GS> 37 48
```

## Come sono composti

- **SSCC (00)**: 18 cifre = cifra di estensione (3) + prefisso aziendale
  (8099999) + seriale (9 cifre) + check digit.
- **GTIN-14 (01)**: indicatore (1 = collo) + 12 cifre del GTIN-13 del pezzo +
  check digit. Es. pezzo `8099999000018` → collo `18099999000015`.
- **Date (11)(15)(17)**: `AAMMGG`. Il giorno `00` significa "fine mese".
- **Peso (3103)**: 6 cifre, ultima cifra dell'AI = decimali → `126000` = 126,000 kg.
- **Colli (37)**: lunghezza variabile (max 8 cifre), quindi seguito da `<GS>`
  se non è l'ultimo campo.
- **Lotto (10)**: lunghezza variabile (max 20), seguito da `<GS>` se non è
  l'ultimo campo.

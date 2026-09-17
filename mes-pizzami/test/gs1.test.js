import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGs1, computeCheckDigit, isGs1CheckDigitValid, parseGs1Date, GS, toStorableRaw,
} from '../src/gs1/parser.js';

const TODAY = new Date('2026-09-17T10:00:00Z');
const parse = (s) => parseGs1(s, { today: TODAY });

// Stringa grezza del bancale 1 del seed, come la invia il lettore
const RAW_PALLET_1 = ']C1' + '00380999990000000019' + '0118099999000015' + '15270915' + '3103126000' + '10L260915A' + GS + '3760';

describe('check digit GS1', () => {
  test('calcola il check digit di GTIN e SSCC del seed', () => {
    assert.equal(computeCheckDigit('1809999900001'), 5);      // 18099999000015
    assert.equal(computeCheckDigit('38099999000000001'), 9);  // 380999990000000019
    assert.equal(computeCheckDigit('809999900001'), 8);       // GTIN-13 8099999000018
  });
  test('valida codici corretti e rifiuta quelli errati', () => {
    assert.equal(isGs1CheckDigitValid('18099999000015'), true);
    assert.equal(isGs1CheckDigitValid('380999990000000019'), true);
    assert.equal(isGs1CheckDigitValid('380999990000000018'), false);
    assert.equal(isGs1CheckDigitValid('18099999000016'), false);
    assert.equal(isGs1CheckDigitValid('1809999900001'), false);   // 13 cifre ma check digit sbagliato
    assert.equal(isGs1CheckDigitValid('ABC'), false);
    assert.equal(isGs1CheckDigitValid(''), false);
    assert.equal(isGs1CheckDigitValid(null), false);
  });
  test('esempio GS1 ufficiale: GTIN-13 4006381333931', () => {
    assert.equal(isGs1CheckDigitValid('4006381333931'), true);
  });
});

describe('date GS1 (AAMMGG)', () => {
  test('converte in ISO', () => {
    assert.equal(parseGs1Date('270915', TODAY).iso, '2027-09-15');
  });
  test('giorno 00 = fine mese (anche bisestile)', () => {
    assert.equal(parseGs1Date('280200', TODAY).iso, '2028-02-29');
    assert.equal(parseGs1Date('270200', TODAY).iso, '2027-02-28');
    assert.equal(parseGs1Date('261100', TODAY).iso, '2026-11-30');
  });
  test('regola del secolo (+/- 50 anni)', () => {
    assert.equal(parseGs1Date('990101', TODAY).iso, '1999-01-01');
    assert.equal(parseGs1Date('700101', TODAY).iso, '2070-01-01');
    assert.equal(parseGs1Date('800101', TODAY).iso, '1980-01-01');
  });
  test('rifiuta mese o giorno non validi', () => {
    assert.ok(parseGs1Date('261301', TODAY).error);
    assert.ok(parseGs1Date('260431', TODAY).error);
    assert.ok(parseGs1Date('26041', TODAY).error);
  });
});

describe('parsing stringa grezza del lettore', () => {
  test('scompone tutti gli AI con prefisso ]C1 e separatore GS', () => {
    const r = parse(RAW_PALLET_1);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.fields, {
      sscc: '380999990000000019',
      gtin: '18099999000015',
      gtinContained: null,
      lot: 'L260915A',
      productionDate: null,
      bestBeforeDate: '2027-09-15',
      expiryDate: null,
      caseCount: 60,
      netWeightKg: 126,
    });
    assert.equal(r.humanReadable, '(00)380999990000000019(01)18099999000015(15)270915(3103)126000(10)L260915A(37)60');
  });

  test('accetta CR/LF finali (Invio del lettore) e il GS in forma letterale <GS>', () => {
    const r = parse('00380999990000000019' + '10L260915A<GS>3760\r\n');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.fields.lot, 'L260915A');
    assert.equal(r.fields.caseCount, 60);
  });

  test('campo variabile in ultima posizione senza GS', () => {
    const r = parse('0038099999000000001910L260915A');
    assert.equal(r.ok, true);
    assert.equal(r.fields.lot, 'L260915A');
  });

  test('peso con decimali diversi (3101, 3102)', () => {
    assert.equal(parse('3101001255').fields.netWeightKg, 125.5);
    assert.equal(parse('3102012550').fields.netWeightKg, 125.5);
  });

  test('data di produzione (11) e scadenza (17)', () => {
    const r = parse('00380999990000000040' + '0118099999000039' + '11260916' + '17261016' + '10L260916A' + GS + '3780');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.fields.productionDate, '2026-09-16');
    assert.equal(r.fields.expiryDate, '2026-10-16');
    assert.equal(r.fields.caseCount, 80);
  });

  test('senza GS il lotto inghiotte il campo successivo: errore di lunghezza, non dati sbagliati', () => {
    const r = parse('0038099999000000001910L260915A3760' + 'XXXXXXXXXXXXXXXXX');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /massimo 20 caratteri/);
  });

  test('GTIN contenuto (02) e colli (37) di un pallet omogeneo', () => {
    const r = parse('00380999990000000019' + '0218099999000015' + '3760');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.fields.gtinContained, '18099999000015');
    assert.equal(r.fields.gtin, null);
  });
});

describe('parsing notazione con parentesi', () => {
  test('equivale alla stringa grezza', () => {
    const a = parse('(00)380999990000000019(01)18099999000015(15)270915(3103)126000(10)L260915A(37)60');
    const b = parse(RAW_PALLET_1);
    assert.equal(a.ok, true, JSON.stringify(a.errors));
    assert.deepEqual(a.fields, b.fields);
  });
  test('testo fuori dalle parentesi = errore', () => {
    const r = parse('(00)380999990000000019 pippo');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /non riconosciuto/);
  });
});

describe('errori', () => {
  test('stringa vuota', () => {
    const r = parse('   ');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].message, 'Nessun codice letto');
  });
  test('check digit SSCC errato', () => {
    const r = parse('(00)380999990000000018(01)18099999000015(10)L260915A');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /SSCC: check digit errato/);
    assert.equal(r.fields.gtin, '18099999000015', 'gli altri campi vengono comunque estratti');
  });
  test('check digit GTIN errato', () => {
    const r = parse('(01)18099999000016');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /GTIN: check digit errato/);
  });
  test('AI sconosciuto', () => {
    const r = parse('(00)380999990000000019(99)ABC');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /\(99\) non supportato/);
  });
  test('AI sconosciuto in forma grezza', () => {
    const r = parse('0038099999000000001999ABC');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /AI sconosciuto/);
  });
  test('campo a lunghezza fissa troncato', () => {
    const r = parse('0038099999000000');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /attesi 18 caratteri, trovati 14/);
  });
  test('campo ripetuto', () => {
    const r = parse('(10)AAA(10)BBB');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /campo ripetuto/);
  });
  test('lotto con caratteri non ammessi', () => {
    const r = parse('(10)L260915A#');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /caratteri non ammessi/);
  });
  test('colli non numerici', () => {
    const r = parse('(37)6A');
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /solo cifre/);
  });
});

describe('barcode di esempio della documentazione', () => {
  const ok = [
    '(00)380999990000000019(01)18099999000015(15)270915(3103)126000(10)L260915A(37)60',
    '(00)380999990000000026(01)18099999000015(15)270915(10)L260915A',
    '(00)380999990000000033(01)18099999000022(15)270915(10)L260915B(37)60',
    '(00)380999990000000040(01)18099999000039(11)260916(17)261016(10)L260916A(37)80',
    '(00)380999990000000057(01)18099999000046(11)260914(17)261005(10)L260914A(37)72',
    '(00)380999990000000064(01)18099999000053(15)270917(10)L260917A(37)48',
    '(00)380999990000000071(01)18099999000053(15)270914(3103)153600(10)L260914A(37)48',
    '(00)380999990000000088(01)18099999000039(11)260917(17)261017(10)L260917B(37)80',
    '(00)380999990000000071(01)18099999000060(10)L260917X',       // GTIN valido ma non in anagrafica: il parser lo accetta
    '(01)18099999000015(15)270915(10)L260915A',                   // etichetta di collo senza SSCC
  ];
  for (const code of ok) {
    test(`valido: ${code}`, () => {
      const r = parse(code);
      assert.equal(r.ok, true, JSON.stringify(r.errors));
    });
  }
  test('non validi: check digit e AI sconosciuto', () => {
    assert.equal(parse('(00)380999990000000018(01)18099999000015(10)L260915A').ok, false);
    assert.equal(parse('(00)380999990000000019(99)ABC').ok, false);
  });
});

describe('stringa salvabile', () => {
  test('sostituisce GS con <GS> e toglie Invio finale', () => {
    assert.equal(toStorableRaw('10ABC' + GS + '3760\r\n'), '10ABC<GS>3760');
  });
});

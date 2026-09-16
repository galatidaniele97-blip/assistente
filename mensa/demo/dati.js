/**
 * I dati della dimostrazione: il menù reale del foglio settimanale, due aziende
 * con regole diverse, qualche persona e qualche ordine già inviato.
 * Tutto passa dall'API vera, quindi è esattamente ciò che succederebbe davvero.
 */

import { currentWeek, shiftWeek, weekLabel } from '../public/shared/week.js';
import { firstOpenWeek } from '../public/shared/scadenza.js';

export const CODICI = { ristorante: 'RISTO1', pin: '1234' };

const GRIGLIA = {
  A: ['Pasta e ceci', 'Pasta alla carbonara', 'Pasta alla puttanesca', 'Pasta e lenticchie', 'Pasta al ragù di polpo'],
  B: ['Pasta al pomodoro', 'Pasta al pomodoro', 'Riso in bianco', 'Pasta al pomodoro', 'Riso in bianco'],
  E: ['Salsiccia al vino bianco', 'Scaloppina al burro e salvia', 'Trancio di pizza alta', 'Bistecca di lonza', 'Trancio di pesce alle olive'],
  F: ['Stracchino', 'Mortadella', 'Frittata con cipolle', 'Bresaola', 'Tomino al forno'],
  G: ['Piselli al burro', 'Fagiolini lessi', '', 'Carote prezzemolate', 'Patate lesse'],
  H: ['Insalata verde', 'Insalata di carote', 'Insalata di pomodori', 'Insalata verde', 'Insalata mista'],
  L: ['Yogurt alla frutta', 'Dolce della casa', 'Yogurt alla frutta', 'Dolce della casa', 'Yogurt alla frutta'],
  P: ['Macedonia', 'Frutto', 'Macedonia', 'Frutto', 'Macedonia'],
  T: ['Rotolo farcito', 'Gran piatto buffet', 'Formaggi misti', 'Puccia con pancetta', 'Insalata di legumi e verdure'],
};

const ALFA = [
  ['Mario Rossi', '12'],
  ['Anna Bianchi', '3'],
  ['Giulia Conti', '7'],
  ['Paolo Neri', '21'],
  ['Sara Gallo', '5'],
  ['Valeria Fontana', '18'],
];
const BETA = [['Luca Verdi', '2'], ['Elena Ricci', '9']];

/** Ordini già inviati, per far vedere subito i due riepiloghi pieni. */
const ORDINI = {
  'Mario Rossi': ['A', 'E', 'H'],
  'Anna Bianchi': ['B', 'F', 'G'],
  'Giulia Conti': ['T'],
  'Valeria Fontana': ['A', 'F', 'P'],
};

export async function seminaDimostrazione(chiama) {
  const settimana = firstOpenWeek(currentWeek(), { day: 5, time: '12:00', timezone: 'Europe/Rome' }, shiftWeek);

  await chiama('POST', '/api/setup', { name: 'Time Out', code: CODICI.ristorante });
  const admin = (await chiama('POST', '/api/login', { code: CODICI.ristorante })).token;

  const alfa = await chiama('POST', '/api/admin/companies', { name: 'Meccanica Alfa SpA' }, admin);
  const beta = await chiama('POST', '/api/admin/companies', {
    name: 'Beta Logistica Srl',
    maxDishes: 2,
    courses: [
      { name: 'Primi', max: 1, slots: ['A', 'B'] },
      { name: 'Secondi', max: 1, slots: ['E', 'F'] },
      { name: 'Pasto unico', max: 1, single: true, slots: ['T'] },
    ],
  }, admin);

  const persone = {};
  for (const [azienda, elenco] of [[alfa, ALFA], [beta, BETA]]) {
    const referente = (await chiama('POST', '/api/login', { code: azienda.codeManager })).token;
    for (const [name, locker] of elenco) {
      const persona = await chiama('POST', '/api/manager/employees', { name, locker }, referente);
      await chiama('POST', `/api/manager/employees/${persona.id}/pin`, { pin: CODICI.pin }, referente);
      persone[name] = { ...persona, azienda };
    }
  }

  const griglia = {};
  for (const portata of alfa.courses) for (const slot of portata.slots) griglia[slot.code] = slot.id;
  const piatti = [];
  for (const [codice, elenco] of Object.entries(GRIGLIA)) {
    elenco.forEach((nome, i) => {
      if (!nome) return;
      piatti.push({ day: i + 1, slotId: griglia[codice], name: nome, single: /pizza/i.test(nome) });
    });
  }
  await chiama('PUT', '/api/admin/menu', { companyId: alfa.id, week: settimana, items: piatti }, admin);
  await chiama('POST', '/api/admin/menu/copy', { fromCompanyId: alfa.id, week: settimana, toCompanyIds: 'all' }, admin);

  for (const [nome, codici] of Object.entries(ORDINI)) {
    const persona = persone[nome];
    const accesso = (await chiama('POST', '/api/login', { code: persona.azienda.codeStaff })).token;
    const suo = (await chiama('POST', '/api/staff/identify', { employeeId: persona.id, pin: CODICI.pin }, accesso)).token;
    const settimanaDati = await chiama('GET', `/api/staff/week?week=${settimana}`, null, suo);
    const giorni = [1, 2, 3, 4, 5].map((giorno) => {
      if (giorno === 3 && nome === 'Anna Bianchi') return { day: giorno, skip: true };
      const delGiorno = settimanaDati.menu.filter((m) => m.day === giorno);
      let scelte = codici.map((c) => delGiorno.find((m) => m.code === c)).filter(Boolean);
      const unico = scelte.find((s) => s.single);
      return { day: giorno, items: (unico ? [unico] : scelte).map((s) => s.id) };
    });
    await chiama('POST', '/api/staff/order', { week: settimana, days: giorni }, suo);
  }

  // Valeria è in malattia da mercoledì: il referente l'ha messa in stand-by.
  const referenteAlfa = (await chiama('POST', '/api/login', { code: alfa.codeStaff === undefined ? '' : alfa.codeManager })).token;
  for (const giorno of [3, 4, 5]) {
    await chiama('PUT', '/api/manager/suspensions', { employeeId: persone['Valeria Fontana'].id, week: settimana, day: giorno, suspended: true }, referenteAlfa);
  }

  return {
    settimana: weekLabel(settimana),
    aziende: [
      { nome: alfa.name, dipendenti: alfa.codeStaff, referente: alfa.codeManager },
      { nome: beta.name, dipendenti: beta.codeStaff, referente: beta.codeManager },
    ],
  };
}

/**
 * Scadenza di ordinazione — condivisa fra server (che la fa rispettare) e client
 * (che la mostra e disattiva i pulsanti in anticipo).
 *
 * La regola: per la settimana W si ordina e si corregge fino a un giorno e
 * un'ora della settimana precedente (in via predefinita venerdì alle 12:00,
 * ora italiana). Da quel momento la settimana W è chiusa e non cambia più.
 *
 * Le impostazioni sono { day: 1..7, time: 'HH:MM', timezone: 'Europe/Rome' }.
 * L'ora è locale al fuso indicato: l'ora legale è gestita da Intl, che sia su
 * Cloudflare, in Node o nel browser.
 */

import { mondayOf } from './week.js';

const MS_DAY = 86400000;
const GIORNI_LUNGHI = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];

/** Di quanto il fuso è avanti rispetto all'UTC in un dato istante (ms). */
function offsetMs(utcMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** L'istante UTC in cui, nel fuso dato, il calendario segna quella data e quell'ora. */
function zonedToUtc(year, month, day, hour, minute, timezone) {
  const guess = Date.UTC(year, month, day, hour, minute);
  // Un solo passaggio basta: l'orario di scadenza non cade mai nell'ora del cambio di ora legale.
  return guess - offsetMs(guess, timezone);
}

export function normalizeSettings(raw = {}) {
  const day = Number(raw.day);
  const time = typeof raw.time === 'string' && /^\d{1,2}:\d{2}$/.test(raw.time) ? raw.time : '12:00';
  return {
    day: Number.isInteger(day) && day >= 1 && day <= 7 ? day : 5,
    time,
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'Europe/Rome',
  };
}

/** L'istante (ms UTC) oltre il quale la settimana indicata non si modifica più. */
export function deadlineFor(week, settings) {
  const s = normalizeSettings(settings);
  const previousMonday = new Date(mondayOf(week).getTime() - 7 * MS_DAY);
  const date = new Date(previousMonday.getTime() + (s.day - 1) * MS_DAY);
  const [hour, minute] = s.time.split(':').map(Number);
  return zonedToUtc(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, s.timezone);
}

export function isLocked(week, settings, now = Date.now()) {
  return now >= deadlineFor(week, settings);
}

/** "venerdì 19 set alle 12:00" nel fuso indicato. */
export function deadlineLabel(week, settings) {
  const s = normalizeSettings(settings);
  const at = new Date(deadlineFor(week, s));
  const data = at.toLocaleString('it-IT', { timeZone: s.timezone, day: 'numeric', month: 'short' });
  const ora = at.toLocaleString('it-IT', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit' });
  return `${GIORNI_LUNGHI[s.day - 1]} ${data} alle ${ora}`;
}

/** La prima settimana, a partire da quella indicata, che si può ancora modificare. */
export function firstOpenWeek(fromWeek, settings, shiftWeek, now = Date.now()) {
  let week = fromWeek;
  for (let i = 0; i < 8; i++) {
    if (!isLocked(week, settings, now)) return week;
    week = shiftWeek(week, 1);
  }
  return week;
}

export const GIORNI_SETTIMANA = GIORNI_LUNGHI;

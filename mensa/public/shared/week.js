// Utilità settimana ISO — usate sia dal server sia dal client (unica fonte di verità).
// Formato settimana: "AAAA-Www" (es. "2026-W38"). Ordinabile lessicograficamente.

const MS_DAY = 86400000;

export const GIORNI = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'];
export const GIORNI_BREVI = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven'];
export const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

export function isValidWeek(s) {
  if (typeof s !== 'string' || !/^\d{4}-W\d{2}$/.test(s)) return false;
  const w = Number(s.slice(6));
  return w >= 1 && w <= 53;
}

/** Settimana ISO di una data (componenti UTC). */
export function isoWeekOf(date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;           // lunedì = 0
  t.setUTCDate(t.getUTCDate() - dayNum + 3);         // giovedì della settimana
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t - firstThu) / (7 * MS_DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Settimana corrente secondo il calendario locale di chi guarda. */
export function currentWeek(now = new Date()) {
  return isoWeekOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

/** Lunedì (UTC) della settimana indicata. */
export function mondayOf(week) {
  const year = Number(week.slice(0, 4));
  const w = Number(week.slice(6));
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  return new Date(week1Monday.getTime() + (w - 1) * 7 * MS_DAY);
}

/** Sposta di n settimane (n può essere negativo). */
export function shiftWeek(week, n) {
  return isoWeekOf(new Date(mondayOf(week).getTime() + n * 7 * MS_DAY));
}

/** Data del giorno (1..5) nella settimana indicata. */
export function dayDate(week, day) {
  return new Date(mondayOf(week).getTime() + (day - 1) * MS_DAY);
}

/** "15 – 19 set 2026" */
export function weekLabel(week) {
  const a = dayDate(week, 1);
  const b = dayDate(week, 5);
  const ma = MESI_BREVI[a.getUTCMonth()];
  const mb = MESI_BREVI[b.getUTCMonth()];
  const left = ma === mb ? `${a.getUTCDate()}` : `${a.getUTCDate()} ${ma}`;
  return `${left} – ${b.getUTCDate()} ${mb} ${b.getUTCFullYear()}`;
}

/** "Lun 15 set" */
export function dayLabel(week, day) {
  const d = dayDate(week, day);
  return `${GIORNI_BREVI[day - 1]} ${d.getUTCDate()} ${MESI_BREVI[d.getUTCMonth()]}`;
}

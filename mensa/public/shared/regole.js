/**
 * Regole di ordinazione — unico punto di verità, usato sia dal client (per
 * impedire la scelta non valida) sia dal server (per rifiutarla comunque).
 *
 * Una scelta è: { id, name, courseId, courseName, single }
 *   single = piatto unico: da solo vale il pasto completo (il pasto unico "T"
 *   e, alcuni giorni, la pizza fra i secondi).
 *
 * Le regole sono: { maxDishes, courses: [{ id, name, max }] }
 *   maxDishes = quanti piatti spettano in un giorno (da contratto, es. 3)
 *   max       = quante scelte per quella portata (es. 1 primo, 1 secondo, 2 contorni)
 */

function maxDiPortata(regole, courseId) {
  const course = regole.courses.find((c) => c.id === courseId);
  return course ? course.max : 0;
}

function nomeDiPortata(regole, courseId) {
  const course = regole.courses.find((c) => c.id === courseId);
  return course ? course.name : 'portata';
}

/** Verifica le scelte di un giorno. Ritorna null se vanno bene, altrimenti il motivo. */
export function verificaGiorno(scelte, regole) {
  if (!scelte.length) return null;

  const unico = scelte.find((s) => s.single);
  if (unico && scelte.length > 1) {
    return `"${unico.name}" è un piatto unico: vale da solo un pasto completo.`;
  }
  if (scelte.length > regole.maxDishes) {
    return `Massimo ${regole.maxDishes} piatti al giorno.`;
  }
  const perPortata = new Map();
  for (const scelta of scelte) {
    perPortata.set(scelta.courseId, (perPortata.get(scelta.courseId) ?? 0) + 1);
  }
  for (const [courseId, quante] of perPortata) {
    const max = maxDiPortata(regole, courseId);
    if (quante > max) {
      const nome = nomeDiPortata(regole, courseId);
      return max === 1
        ? `Si sceglie un solo piatto fra i ${nome.toLowerCase()}.`
        : `Massimo ${max} per "${nome}".`;
    }
  }
  return null;
}

/**
 * Che cosa succede se si aggiunge un piatto alle scelte correnti.
 * Ritorna il nuovo elenco di id, oppure null se la scelta non è possibile
 * (è il caso in cui il pulsante va disattivato invece che segnalato dopo).
 *
 * Due sostituzioni automatiche, perché sono "l'uno al posto dell'altro":
 *   - un piatto unico sostituisce tutto il resto del giorno;
 *   - in una portata da un solo piatto, il nuovo sostituisce il precedente.
 */
export function simulaAggiunta(correnti, piatto, regole, infoDi) {
  if (correnti.includes(piatto.id)) return correnti.filter((id) => id !== piatto.id);
  if (piatto.single) return [piatto.id];

  let prossime = correnti.filter((id) => !infoDi(id).single);
  const max = maxDiPortata(regole, piatto.courseId);
  if (max === 0) return null;

  const stessaPortata = prossime.filter((id) => infoDi(id).courseId === piatto.courseId);
  if (stessaPortata.length >= max) {
    if (max !== 1) return null;
    prossime = prossime.filter((id) => id !== stessaPortata[0]);
  }
  if (prossime.length >= regole.maxDishes) return null;
  return [...prossime, piatto.id];
}

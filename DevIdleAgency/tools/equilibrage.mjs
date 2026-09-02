/**
 * Mesure l'équilibre de l'arbre de compétences sur l'économie réelle.
 *
 *   npm run equilibrage
 *
 * Toutes les valeurs sont LUES dans public/game.js : ce simulateur ne doit
 * jamais avoir sa propre copie des chiffres, sinon il mesure un jeu qui
 * n'existe pas. C'est lui qui a montré, sur la première version de l'arbre :
 *   - trois nœuds dont l'effet n'était consommé par personne (13 points morts) ;
 *   - une voie Clic dont les « +X% par clic » ne valaient rien passé cinq
 *     minutes, un clic rapportant 1 crédit quand l'agence en fait des millions ;
 *   - un nœud « stages 15% plus courts » qui était un MALUS déguisé ;
 *   - zéro embauche de stagiaire en trois heures, le coût valant 240 s de
 *     production alors qu'un joueur réinvestit tout au fur et à mesure.
 *
 * Ce qu'il ne sait PAS faire, et qu'il faut garder en tête en lisant sa sortie :
 * la valeur de la voie Stagiaires bascule sur un seuil (les embauches ont lieu,
 * ou pas). Un écart de quelques pour cent sur le coût peut faire passer la voie
 * de ×2 à ×9. Les ordres de grandeur sont fiables, la troisième décimale non.
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const src = fs.readFileSync(ROOT + '/public/game.js', 'utf8');

/** Extrait un littéral en comptant les accolades : les regex butent sur les
    objets écrits sur une seule ligne comme sur ceux qui en font cinquante. */
const bloc = (nom) => {
  const debut = src.indexOf('const ' + nom + ' = ');
  if (debut < 0) throw new Error(nom + ' introuvable');
  let i = src.indexOf('=', debut) + 1;
  while (' \n\t'.includes(src[i])) i++;
  const ouvrant = src[i], fermant = ouvrant === '[' ? ']' : '}';
  let profondeur = 0, j = i, dansTexte = null;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (dansTexte) { if (ch === '\\') j++; else if (ch === dansTexte) dansTexte = null; continue; }
    if (ch === "'" || ch === '"') { dansTexte = ch; continue; }
    if (ch === ouvrant) profondeur++;
    else if (ch === fermant && --profondeur === 0) { j++; break; }
  }
  return eval('(' + src.slice(i, j) + ')');
};
const nombre = (re) => Number(src.match(re)[1]);

const SKILL_TREE = bloc('SKILL_TREE');
const TIER_COST = bloc('SKILL_TIER_COST');
const RARITIES = bloc('INTERN_RARITIES');
const SCALE = nombre(/GLOBAL_PRODUCTION_SCALE = ([\d.]+)/);
const STEP = nombre(/PRODUCER_MILESTONE_STEP = (\d+)/);
const STAGE_MS = eval(src.match(/INTERN_STAGE_MS = ([^;]+);/)[1]);
const COOLDOWN_MS = eval(src.match(/INTERN_COOLDOWN_MS = ([^;]+);/)[1]);
const EUREKA_ROLL_MS = eval(src.match(/INTERN_EUREKA_ROLL_MS = ([^;]+);/)[1]);
const OFFLINE_RATE = nombre(/OFFLINE_RATE = ([\d.]+)/);
const HIRE_SECONDS = nombre(/INTERN_HIRE_COST_SECONDS = (\d+)/);
const OFFLINE_MAX_H = eval(src.match(/OFFLINE_MAX_MS = ([^;]+);/)[1]) / 3600000;

const defs = [...src.matchAll(/\{ id: '(stagiaire|dev|devSenior)', name: '[^']*', desc: '[^']*', basePrice: ([\d.]+), priceGrowth: ([\d.]+), production: ([\d.]+)/g)]
  .map(m => ({ id: m[1], base: +m[2], growth: +m[3], prod: +m[4] }));
const sv = src.match(/\{ id: 'serveur'.*?basePrice: ([\d.]+), priceGrowth: ([\d.]+), multiplier: ([\d.]+)/);
const SRV = { base: +sv[1], growth: +sv[2], mult: +sv[3] };
const prix = (d, q) => Math.ceil(d.base * Math.pow(d.growth, q));

/** Les buts de chapitre, tels que getChapterProgress() les évalue. */
const BUTS = {
  'ch3  prod 10/s':        e => e.perSec >= 10,
  'ch4  1 embauche':       e => e.embauches >= 1,
  'ch5  pic 200 K':        e => e.pic >= 2e5,
  'ch6  pic 1 M':          e => e.pic >= 1e6,
  'ch8  pic 5 M':          e => e.pic >= 5e6,
  'ch10 cumul 2 G':        e => e.total >= 2e9,
};

/** Additionne les effets d'une liste de compétences, comme getSkillEffects(). */
function effets(ids) {
  const e = {};
  ids.forEach(id => {
    const n = SKILL_TREE.find(s => s.id === id);
    if (n) Object.keys(n.effect).forEach(k => e[k] = (e[k] || 0) + n.effect[k]);
  });
  return new Proxy(e, { get: (o, k) => o[k] || 0 });
}
const cout = (ids) => ids.reduce((s, id) => s + TIER_COST[SKILL_TREE.find(n => n.id === id).tier], 0);

/** Le bonus moyen d'un stagiaire en régime établi, Eurêka compris. */
function bonusStagiaire(sk) {
  const rs = Object.values(RARITIES);
  // Le boost de rareté repondère le tirage vers les profils à Eurêka : sans le
  // modéliser, « Chasseur de têtes » mesure zéro et on croirait le nœud mort.
  const boost = 1 + sk.internRarityBoost;
  const poids = rs.map(r => (r.weight || 1) * ((r.eurekaChance || 0) > 0 ? boost : 1));
  const totalPoids = poids.reduce((a, b) => a + b, 0);
  let prodMoy = 0, eurekaMoy = 0;
  rs.forEach((r, i) => {
    const p = poids[i] / totalPoids;
    prodMoy += p * (r.prodPercent || 0);
    const chance = (r.eurekaChance || 0) * (1 + sk.internEurekaChancePercent / 100);
    const duree = (r.eurekaMs || 0) * (1 + sk.internEurekaMsPercent / 100);
    // Part du temps sous Eurêka : une chance par tirage, pour une durée donnée.
    const part = Math.min(1, chance * duree / EUREKA_ROLL_MS);
    eurekaMoy += p * part * ((r.eurekaMultiplier || 1) - 1);
  });
  const stage = STAGE_MS * (1 + sk.internStagePercent / 100);
  const cycle = stage + COOLDOWN_MS * (1 + sk.internCooldownPercent / 100);
  const partStage = stage / cycle;
  // Un tirage plus large laisse choisir un meilleur profil : approximé par un
  // gain de 12% sur le bonus retenu par candidat supplémentaire.
  const choix = 1 + 0.12 * sk.internDraftSize;
  return {
    // Le tutorat majore le bonus du stagiaire en poste.
    pendantStage: partStage * (prodMoy / 100) * choix * (1 + sk.internProdPercent / 100),
    eureka: partStage * eurekaMoy,
    cycleMin: cycle / 60000,
  };
}

/**
 * Profil « mobile » : on joue par sessions courtes séparées par de longues
 * absences. C'est le seul régime où la voie Absence veut dire quelque chose —
 * en session continue elle vaut rigoureusement zéro, ce qui ne prouve rien.
 */
function simulerHache(ids, { sessions = 4, minutesParSession = 25, heuresAbsence = 9 } = {}) {
  const sk = effets(ids);
  let acquis = 0;
  for (let i = 0; i < sessions; i++) {
    const r = simuler(ids, { minutes: minutesParSession, clicsToutDuLong: false, depart: acquis });
    acquis = r.total + acquis;
    if (i < sessions - 1) {
      // Gains hors-ligne : rendement réduit, plafonné, tous deux modulés par l'arbre.
      const plafond = OFFLINE_MAX_H + sk.offlineCapHours;
      const heures = Math.min(heuresAbsence, plafond);
      const taux = OFFLINE_RATE * (1 + sk.offlinePercent / 100);
      acquis += r.perSecFinal * heures * 3600 * taux;
    }
  }
  return { total: acquis };
}

function simuler(ids, { minutes = 180, clicsParSec = 2, clicsToutDuLong = false, depart = 0 } = {}) {
  const sk = effets(ids);
  const pas = Math.max(5, STEP - sk.milestoneStepReduction);
  const base2 = 2 + sk.milestoneBase;
  const palier = (q) => Math.pow(base2, Math.floor(q / pas));
  const st = bonusStagiaire(sk);

  const q = { stagiaire: 0, dev: 0, devSenior: 0, serveur: 0 };
  let credits = depart, total = 0, embauches = 0, prochaineEmbauche = st.cycleMin, perSecFinal = 0, pic = 0;
  const dates = {};
  const jalonner = (t, e) => {
    for (const [nom, atteint] of Object.entries(BUTS)) {
      if (dates[nom] === undefined && atteint(e)) dates[nom] = t / 60;
    }
  };
  const DT = 0.1;
  const finClics = 10 * 60;

  for (let t = 0; t < minutes * 60; t += DT) {
    const brut = defs.reduce((a, d) => a + d.prod * q[d.id] * palier(q[d.id]), 0);
    let perSec = brut * (1 + SRV.mult * q.serveur) * SCALE;
    perSec *= 1 + sk.prodPercent / 100;
    perSec *= 1 + sk.prodMultiplier;
    perSec *= 1 + st.pendantStage + st.eureka;
    // Bonus définitif des embauchés, majoré par la voie Stagiaires.
    perSec *= 1 + embauches * 0.06 * (1 + sk.internHireBonusPercent / 100);

    perSecFinal = perSec;
    credits += perSec * DT; total += perSec * DT;
    if (credits > pic) pic = credits;
    jalonner(t, { total, pic, perSec, embauches, q });
    // Salves de 20 s toutes les 100 s : personne ne tape 21 600 fois d'affilée.
    const enSalve = clicsToutDuLong ? (t % 100) < 20 : t < finClics;
    if (enSalve) {
      const parClic = 1 * (1 + sk.clickPercent / 100) + sk.clickProdSeconds * perSec;
      credits += parClic * clicsParSec * DT;
      total += parClic * clicsParSec * DT;
    }
    if (t / 60 >= prochaineEmbauche) {
      const cout = perSec * HIRE_SECONDS * 1.6 * (1 + sk.internHirePercent / 100);
      if (credits >= cout) { credits -= cout; embauches++; }
      prochaineEmbauche += st.cycleMin;
    }

    // Un vrai joueur met de côté pour l'embauche de fin de stage, au lieu de
    // tout convertir en producteurs. Sans cette réserve le glouton n'embauche
    // jamais, et la voie Stagiaires mesure zéro — aussi faux que de supposer
    // les embauches gratuites, ce que faisait la version précédente.
    const coutEmbauche = perSec * HIRE_SECONDS * 1.6 * (1 + sk.internHirePercent / 100);
    // Le joueur épargne pendant tout le stage : il voit le compte à rebours dès
    // qu'il choisit son candidat. Réserver seulement la dernière minute rendait
    // l'embauche impossible — elle coûte plus de 2 min de production.
    const minutesAvant = prochaineEmbauche - t / 60;
    const reserve = minutesAvant <= STAGE_MS / 60000 ? coutEmbauche : 0;

    for (let g = 0; g < 40; g++) {
      // Recalculée à chaque achat : la réserve doit rester intacte, sans pour
      // autant brider le nombre d'achats par pas de temps.
      const dispo = Math.max(0, credits - reserve);
      let best = null, bestR = 0;
      for (const d of defs) {
        const p = prix(d, q[d.id]);
        if (p > dispo) continue;
        const gain = d.prod * ((q[d.id] + 1) * palier(q[d.id] + 1) - q[d.id] * palier(q[d.id]));
        const r = gain / p;
        if (r > bestR) { bestR = r; best = d; }
      }
      const ps = prix(SRV, q.serveur);
      if (ps <= dispo && brut > 0 && (brut * SRV.mult) / ps > bestR) { credits -= ps; q.serveur++; continue; }
      if (!best) break;
      credits -= prix(best, q[best.id]); q[best.id]++;
    }
  }
  return { total, embauches, perSecFinal, dates, pic };
}

/** Prend les nœuds d'une voie dans l'ordre des étages, tant que le budget suit. */
function voie(branche, budget) {
  const pris = [];
  for (const n of SKILL_TREE.filter(s => s.branch === branche).sort((a, b) => a.tier - b.tier)) {
    if (n.requires && !pris.includes(n.requires)) continue;
    if (cout([...pris, n.id]) > budget) continue;
    pris.push(n.id);
  }
  return pris;
}

const fmt = (n) => n >= 1e9 ? (n/1e9).toFixed(1)+'G' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : (n/1e3).toFixed(0)+'K';
const profils = [
  ['joueur passif  (clics 10 min)', { clicsToutDuLong: false }, simuler],
  ['joueur actif   (salves)      ', { clicsToutDuLong: true }, simuler],
  ['mobile 4×25 min + absences  ', {}, simulerHache],
];

// --- Valeur de chaque nœud pris seul, rapportée à son coût ---
// C'est le seul moyen de repérer celui qui casse l'équilibre : une voie entière
// masque le nœud qui porte tout le gain.
console.log('\n════ valeur de chaque nœud, seul ' + '═'.repeat(34));
console.log('    (× sur les crédits gagnés en 3 h, joueur actif par salves, et par point)');
const refActif = simuler([], { clicsToutDuLong: true }).total;
const mesures = SKILL_TREE.map(n => {
  const g = simuler([n.id], { clicsToutDuLong: true }).total / refActif;
  const c = TIER_COST[n.tier];
  return { id: n.id, br: n.branch, nom: n.name, cout: c, gain: g, parPoint: (g - 1) / c };
}).sort((a, b) => b.parPoint - a.parPoint);
mesures.forEach(m => {
  const alerte = m.parPoint > 0.6 ? '  <<< hors barème' : m.parPoint < 0.02 ? '  <<< sans effet mesurable' : '';
  console.log('    ' + m.br.padEnd(7) + m.nom.padEnd(22) + String(m.cout) + ' pt  ×' +
    m.gain.toFixed(2).padStart(6) + '  ' + m.parPoint.toFixed(2).padStart(5) + '/pt' + alerte);
});


for (const budget of [12, 24, 44]) {
  console.log('\n════ budget ' + budget + ' points ' + '═'.repeat(40));
  for (const [nomProfil, opts, fn] of profils) {
    const ref = fn([], opts).total;
    const lignes = [];
    for (const br of ['prod', 'click', 'intern', 'meta']) {
      const ids = voie(br, budget);
      const r = fn(ids, opts).total;
      lignes.push({ br, n: ids.length, pts: cout(ids), gain: r / ref });
    }
    const max = Math.max(...lignes.map(l => l.gain));
    console.log('  ' + nomProfil + '  (référence sans arbre : ' + fmt(ref) + ')');
    lignes.forEach(l => {
      const barre = '█'.repeat(Math.round((l.gain / max) * 22));
      console.log('    ' + l.br.padEnd(7) + ' ' + String(l.pts).padStart(2) + ' pt / ' +
        String(l.n).padStart(2) + ' nœuds  ×' + l.gain.toFixed(2).padStart(5) + '  ' + barre);
    });
  }
}

// Diagnostic : combien d'embauches ont réellement lieu, avec et sans la voie ?
console.log('\n════ embauches réalisées en 3 h ' + '═'.repeat(30));
for (const [nom, ids] of [['sans arbre', []], ['voie Stagiaires', voie('intern', 24)]]) {
  const r = simuler(ids, { clicsToutDuLong: false });
  console.log('  ' + nom.padEnd(18) + r.embauches + ' embauches');
}

// --- Quand chaque but de chapitre tombe-t-il ? ---
console.log('\n════ dates des buts de chapitre ' + '═'.repeat(30));
console.log('    (joueur passif, 6 h, arbre réparti : 3 nœuds par voie)');
const arbreReparti = ['p1','p2','p3','c1','c2','c3','s1','s2','s3','m1','m2','m3'];
for (const [nom, ids] of [['sans arbre', []], ['arbre réparti', arbreReparti]]) {
  const r = simuler(ids, { minutes: 360, clicsToutDuLong: false });
  console.log('  ' + nom + ' :');
  Object.keys(BUTS).forEach(b => {
    const d = r.dates[b];
    console.log('    ' + b.padEnd(20) + (d === undefined ? 'JAMAIS en 6 h' :
      d < 60 ? d.toFixed(1) + ' min' : (d / 60).toFixed(1) + ' h'));
  });
  console.log('    pic de crédits atteint : ' + fmt(r.pic));
}

// --- Courbe : où en est-on à un instant donné ? ---
console.log('\n════ courbe de progression (arbre réparti) ' + '═'.repeat(20));
console.log('    temps     cumul gagné    pic détenu    prod/s');
{
  const jalons = [5, 10, 20, 35, 50, 90, 120, 180, 240, 360, 480];
  const arbre = ['p1','p2','p3','c1','c2','c3','s1','s2','s3','m1','m2','m3'];
  jalons.forEach(min => {
    const r = simuler(arbre, { minutes: min, clicsToutDuLong: false });
    const t = min < 60 ? min + ' min' : (min / 60) + ' h';
    console.log('    ' + t.padEnd(9) + fmt(r.total).padStart(11) + fmt(r.pic).padStart(14) +
      fmt(r.perSecFinal).padStart(10));
  });
}

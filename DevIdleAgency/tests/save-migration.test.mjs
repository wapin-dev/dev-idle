/**
 * Tests du mécanisme de migration de sauvegarde (public/game.js).
 *
 *   npm test
 *
 * Il n'y a pas de framework : le fichier s'exécute avec Node, affiche chaque
 * vérification et sort en code 1 au premier échec.
 *
 * game.js est une IIFE chargée par une balise <script> et n'exporte rien. On la
 * recompile ici en lui ajoutant une ligne d'export sur window, et — pour les
 * tests qui doivent parcourir la boucle de migration — en réécrivant la
 * constante SAVE_VERSION. C'est le seul moyen d'exercer un enchaînement
 * d'étapes tant que la version courante vaut 1.
 *
 * jsdom est nécessaire parce que game.js touche au DOM dès son évaluation.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// fileURLToPath, pas URL.pathname : le chemin du projet contient une espace,
// que pathname renverrait encodée en %20.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const src = fs.readFileSync(ROOT + '/public/game.js', 'utf8');
const KEY = 'agence-dev-idle-save-v4';
// Lu dans la source : une sauvegarde « déjà à jour » doit suivre les refontes.
const VERSION_COURANTE = Number(src.match(/const SAVE_VERSION = (\d+);/)[1]);
const BACKUP = KEY + '-backup';

// Expose l'intérieur de l'IIFE pour pouvoir interroger le mécanisme.
const instrumented = src.replace(/\}\)\(\);\s*$/,
  "  window.__t = { readAndMigrateSave, load, save, state, SAVE_MIGRATIONS,\n" +
  "    getVersion: () => SAVE_VERSION, isBlocked: () => saveBlocked,\n" +
  "    setVersion: null };\n})();");

function instrument(version) {
  let out = src;
  if (version !== undefined) {
    const re = /const SAVE_VERSION = \d+;/;
    if (!re.test(out)) throw new Error('SAVE_VERSION introuvable');
    out = out.replace(re, 'const SAVE_VERSION = ' + version + ';');
  }
  return out.replace(/\}\)\(\);\s*$/,
    "  window.__t = { readAndMigrateSave, load, save, state, SAVE_MIGRATIONS,\n" +
    "    getVersion: () => SAVE_VERSION, isBlocked: () => saveBlocked,\n" +
    "    isFeatureUnlocked, catchUpChapters, getChapterProgress, CHAPTERS,\n" +
    "    getProductionPerSecond };\n})();");
}

function boot(seed, { migrations = null, version = undefined } = {}) {
  const logs = [];
  const vc = new VirtualConsole();
  ['error', 'warn'].forEach(l => vc.on(l, (...a) => logs.push(a.map(String).join(' '))));
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'http://localhost:5173/', virtualConsole: vc });
  const { window } = dom;
  window.getIconUrl = window.getIconPath = n => '/assets/icons/' + n + '.svg';
  window.getFallbackIconPath = () => '/assets/icons/placeholder.svg';
  window.document.body.classList.add('game-active');
  if (seed !== undefined) window.localStorage.setItem(KEY, seed);
  window.eval(instrument(version));
  if (migrations) Object.assign(window.__t.SAVE_MIGRATIONS, migrations);
  return { window, logs, t: window.__t };
}

const results = [];
const check = (nom, attendu, obtenu) => {
  const ok = JSON.stringify(attendu) === JSON.stringify(obtenu);
  results.push({ ok, nom, attendu, obtenu });
};

// 1. Aucune sauvegarde
{
  const { t } = boot(undefined);
  check('aucune sauvegarde -> vide', 'vide', t.readAndMigrateSave().status);
}

// 2. Sauvegarde déjà à la version courante : rien à migrer
{
  const seed = JSON.stringify({ credits: 1234, playerLevel: 7, agencyName: 'Studio', save_version: VERSION_COURANTE });
  const { window, t } = boot(seed);
  const statut = t.load();
  check('version courante -> ok', 'ok', statut);
  check('version courante -> crédits restaurés', 1234, t.state.credits);
  check('version courante -> niveau restauré', 7, t.state.playerLevel);
  check('version courante -> aucune copie de secours', null, window.localStorage.getItem(BACKUP));
}

// 3. Sauvegarde sans save_version (antérieure au champ)
{
  const seed = JSON.stringify({ credits: 50, playerLevel: 2 });
  const { t } = boot(seed);
  const r = t.readAndMigrateSave();
  check('sans numéro -> traitée comme v1', ['ok', 1], [r.status, r.from]);
}

// 4. JSON cassé
{
  const seed = '{ceci n est pas du json';
  const { window, t } = boot(seed);
  check('JSON cassé -> illisible', 'illisible', t.readAndMigrateSave().status);
  const bak = JSON.parse(window.localStorage.getItem(BACKUP));
  check('JSON cassé -> original conservé intact', seed, bak.raw);
  check('JSON cassé -> motif enregistré', 'illisible', bak.reason);
  check('JSON cassé -> sauvegarde laissée en place', seed, window.localStorage.getItem(KEY));
}

// 5. JSON valide mais pas un objet
{
  const { t } = boot('[1,2,3]');
  check('tableau JSON -> illisible', 'illisible', t.readAndMigrateSave().status);
}

// 6. Sauvegarde d'une version postérieure
{
  const seed = JSON.stringify({ credits: 999999, playerLevel: 42, save_version: 99 });
  const { window, t } = boot(seed);
  const statut = t.load();
  check('version future -> trop-recente', 'trop-recente', statut);
  check('version future -> écriture coupée', true, t.isBlocked());
  check('version future -> état non écrasé', 0, t.state.credits);
  t.save();  // l'autosave ne doit rien pouvoir faire
  check('version future -> sauvegarde intacte après save()', seed, window.localStorage.getItem(KEY));
  check('version future -> pas de copie de secours', null, window.localStorage.getItem(BACKUP));
}

// 7. Boucle de migration réelle : deux étapes enchaînées
{
  const seed = JSON.stringify({ credits: 10, playerLevel: 3, save_version: 1 });
  const { window, t } = boot(seed, {
    version: 3,
    migrations: {
      1: d => { d.credits = d.credits * 2; return d; },          // 1 -> 2
      2: d => { d.playerLevel = d.playerLevel + 5; return d; },  // 2 -> 3
    },
  });
  const r = t.readAndMigrateSave();
  check('v1 -> v3 : statut ok', 'ok', r.status);
  check('v1 -> v3 : version d\'origine rapportée', 1, r.from);
  check('v1 -> v3 : première étape appliquée', 20, r.data.credits);
  check('v1 -> v3 : seconde étape appliquée', 8, r.data.playerLevel);
  check('v1 -> v3 : numéro de version mis à jour', 3, r.data.save_version);
  const bak = JSON.parse(window.localStorage.getItem(BACKUP));
  check('v1 -> v3 : copie posée avant migration', seed, bak.raw);
  check('v1 -> v3 : motif de la copie', 'migration-v1', bak.reason);
}

// 8. Migration partant d'une version intermédiaire : seule l'étape utile tourne
{
  const seed = JSON.stringify({ credits: 10, playerLevel: 3, save_version: 2 });
  const { t } = boot(seed, {
    version: 3,
    migrations: {
      1: d => { d.credits = -1; return d; },                     // ne doit PAS tourner
      2: d => { d.playerLevel = d.playerLevel + 5; return d; },
    },
  });
  const r = t.readAndMigrateSave();
}

// 9. Étape manquante dans la table (l'étape 1 existe, la 2 non)
{
  const seed = JSON.stringify({ credits: 10, save_version: 1 });
  const { window, t } = boot(seed, { version: 4, migrations: null });
  check('étape absente -> echec', 'echec', t.readAndMigrateSave().status);
  const bak = JSON.parse(window.localStorage.getItem(BACKUP));
  check('étape absente -> original conservé', seed, bak.raw);
}

// 10. Étape qui lève
{
  const seed = JSON.stringify({ credits: 10, save_version: 1 });
  const { t } = boot(seed, { version: 2, migrations: { 1: () => { throw new Error('boum'); } } });
  check('étape qui lève -> echec', 'echec', t.readAndMigrateSave().status);
}

// 11. Étape qui ne renvoie pas un objet
{
  const seed = JSON.stringify({ credits: 10, save_version: 1 });
  const { t } = boot(seed, { version: 2, migrations: { 1: () => 'pas un objet' } });
  check('étape au retour invalide -> echec', 'echec', t.readAndMigrateSave().status);
}

// 12. Une sauvegarde illisible ne doit pas passer pour une absence de sauvegarde
{
  const { t } = boot('{cassé');
  check('illisible != vide', true, t.load() !== 'vide');
}

// 13. Migration 1 -> version courante : refonte de la progression
{
  // Une partie avancée d'avant la refonte : chapitre 3 atteint par l'ancien
  // seuil de crédits, un prestige déjà fait, un bonus Réputation acheté.
  const seed = JSON.stringify({
    credits: 250000, playerLevel: 22, chapter: 3, completedChapters: [],
    chapterBonuses: { ch1: { prodPercent: 5 } }, bestRunCredits: 800000,
    reputation: 4, purchasedPrestigeBonuses: ['prod10', 'click5'],
    // Une partie à 250 000 crédits a forcément des producteurs : sans eux, le
    // rattrapage buterait sur le but « 3 stagiaires » et ne testerait rien.
    upgrades: [
      { id: 'stagiaire', quantity: 60 }, { id: 'dev', quantity: 35 },
      { id: 'devSenior', quantity: 20 }, { id: 'serveur', quantity: 12 },
    ],
    save_version: 1,
  });
  const { t } = boot(seed);
  const r = t.readAndMigrateSave();
  check('v1 -> v2 : statut ok', 'ok', r.status);
  check('v1 -> v2 : ancien chapitre remis à 1', 1, r.data.chapter);
  check('v1 -> v2 : anciens bonus de chapitre effacés', {}, r.data.chapterBonuses);
  check('v1 -> v2 : crédits cumulés estimés sur le meilleur run', 800000, r.data.totalCreditsEarned);
  check('v1 -> v2 : pic de la partie en cours', 250000, r.data.runPeakCredits);
  check('v1 -> v2 : un prestige déduit de la réputation', 1, r.data.prestigeCount);
  check('v1 -> v2 : bonus uniques convertis en niveaux', { prod10: 1, click5: 1 },
    r.data.prestigeBonusLevels);

  // Après chargement, le rattrapage doit replacer le joueur au bon chapitre :
  // 250 000 crédits passent les buts 1 (50 créd.), 4 (10 000) et 5 (100 000).
  const statut = t.load();
  t.catchUpChapters();
  check('v1 -> v2 : chargement ok', 'ok', statut);
  check('v1 -> v2 : rattrapage jusqu\'au chapitre atteint', true, t.state.chapter >= 5);
  check('v1 -> v2 : Boutique ouverte par le rattrapage', true,
    t.state.unlockedFeatures.includes('boutique'));
}

// 14. Partie neuve : rien n'est ouvert avant d'avoir joué
{
  const { t } = boot(undefined);
  check('partie neuve : chapitre 1', 1, t.state.chapter);
  check('partie neuve : aucune fonctionnalité ouverte', [], t.state.unlockedFeatures);
  check('partie neuve : Boutique fermée', false, t.isFeatureUnlocked('boutique'));
  check('partie neuve : Rebranding fermé', false, t.isFeatureUnlocked('prestige'));
}

// 15. L'escalier de chapitres monte et s'arrête sur le dernier
{
  const { t } = boot(undefined);
  t.state.credits = 1e9;
  t.state.totalCreditsEarned = 1e9;
  t.state.runPeakCredits = 1e9;
  t.state.prestigeCount = 5;
  t.state.upgrades.find(u => u.id === 'stagiaire').quantity = 20;
  t.state.upgrades.find(u => u.id === 'devSenior').quantity = 50;
  t.catchUpChapters();
  check('escalier : tous les chapitres franchis', t.CHAPTERS.length,
    t.state.completedChapters.length);
  check('escalier : partie marquée terminée', true, t.state.gameCompleted);
  check('escalier : toutes les fonctionnalités ouvertes', true,
    ['boutique', 'events', 'promotions', 'bureaux', 'branding', 'prestige', 'reputation', 'campus']
      .every(f => t.isFeatureUnlocked(f)));
}

const echecs = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  OK  ' : ' ÉCHEC') + '  ' + r.nom +
  (r.ok ? '' : `\n         attendu ${JSON.stringify(r.attendu)}, obtenu ${JSON.stringify(r.obtenu)}`)));
console.log(`\n${results.length - echecs.length}/${results.length} vérifications passées`);
process.exit(echecs.length ? 1 : 0);

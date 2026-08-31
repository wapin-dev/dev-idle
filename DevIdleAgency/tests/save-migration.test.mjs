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
const BACKUP = KEY + '-backup';

// Expose l'intérieur de l'IIFE pour pouvoir interroger le mécanisme.
const instrumented = src.replace(/\}\)\(\);\s*$/,
  "  window.__t = { readAndMigrateSave, load, save, state, SAVE_MIGRATIONS,\n" +
  "    getVersion: () => SAVE_VERSION, isBlocked: () => saveBlocked,\n" +
  "    setVersion: null };\n})();");

function instrument(version) {
  let out = src;
  if (version !== undefined) {
    const avant = 'const SAVE_VERSION = 1;';
    if (!out.includes(avant)) throw new Error('SAVE_VERSION introuvable');
    out = out.replace(avant, 'const SAVE_VERSION = ' + version + ';');
  }
  return out.replace(/\}\)\(\);\s*$/,
    "  window.__t = { readAndMigrateSave, load, save, state, SAVE_MIGRATIONS,\n" +
    "    getVersion: () => SAVE_VERSION, isBlocked: () => saveBlocked };\n})();");
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

// 2. Sauvegarde v1 valide
{
  const seed = JSON.stringify({ credits: 1234, playerLevel: 7, agencyName: 'Studio', save_version: 1 });
  const { window, t } = boot(seed);
  const statut = t.load();
  check('v1 valide -> ok', 'ok', statut);
  check('v1 valide -> crédits restaurés', 1234, t.state.credits);
  check('v1 valide -> niveau restauré', 7, t.state.playerLevel);
  check('v1 valide -> aucune copie de secours', null, window.localStorage.getItem(BACKUP));
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

// 7. Boucle de migration réelle : v1 -> v3, deux étapes enchaînées
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
  check('v2 -> v3 : étape v1 non rejouée', 10, r.data.credits);
  check('v2 -> v3 : étape v2 appliquée', 8, r.data.playerLevel);
}

// 9. Étape manquante dans la table
{
  const seed = JSON.stringify({ credits: 10, save_version: 1 });
  const { window, t } = boot(seed, { version: 2, migrations: null });
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

const echecs = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  OK  ' : ' ÉCHEC') + '  ' + r.nom +
  (r.ok ? '' : `\n         attendu ${JSON.stringify(r.attendu)}, obtenu ${JSON.stringify(r.obtenu)}`)));
console.log(`\n${results.length - echecs.length}/${results.length} vérifications passées`);
process.exit(echecs.length ? 1 : 0);

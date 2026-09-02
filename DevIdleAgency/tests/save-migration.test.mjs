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
    "    openInternDraft, chooseInternCandidate, hireIntern, releaseIntern,\n" +
    "    getProductionPerSecond, getInternProdPercent, isEurekaActive, isInternStageOver,\n" +
    "    tickInterns, INTERN_RARITIES, INTERN_TRAITS, INTERN_DRAFT_SIZE,\n" +
    "    producerMilestoneLevel, producerMilestoneMult, producerMilestoneRemaining,\n" +
    "    PRODUCER_MILESTONE_STEP, INTERN_COOLDOWN_MS, INTERN_STAGE_MS,\n" +
    "    buyUpgrade, getUpgradeState, ensureUpgrade,\n" +
    "    SKILL_TREE, SKILL_BRANCHES, skillCost, canUnlockSkill, unlockSkill,\n" +
    "    isSkillUnlocked, getSkillEffects, getClickPower, addXP, getXpToNextLevel,\n" +
    "    doPrestige, checkLevelUp };\n})();");
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
  // Une version au-delà de la dernière étape écrite : le numéro exact n'a pas
  // à être maintenu à la main, sinon ce test retombe à chaque migration ajoutée.
  const seed = JSON.stringify({ credits: 10, save_version: 1 });
  const { window, t } = boot(seed, { version: VERSION_COURANTE + 1, migrations: null });
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

// 13. Migration 1 -> version courante : refonte de la progression, puis stagiaires
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
  check('v2 -> v3 : partie déjà avancée créditée d\'une embauche', 1, r.data.internsHired);
  check('v2 -> v3 : aucun stagiaire en stage', null, r.data.intern);
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
  t.state.internsHired = 1;
  t.state.upgrades.find(u => u.id === 'stagiaire').quantity = 20;
  t.state.upgrades.find(u => u.id === 'devSenior').quantity = 50;
  t.catchUpChapters();
  check('escalier : tous les chapitres franchis', t.CHAPTERS.length,
    t.state.completedChapters.length);
  check('escalier : partie marquée terminée', true, t.state.gameCompleted);
  check('escalier : toutes les fonctionnalités ouvertes', true,
    ['boutique', 'stagiaires', 'events', 'promotions', 'bureaux', 'branding', 'prestige', 'reputation', 'campus']
      .every(f => t.isFeatureUnlocked(f)));
}

// 16. Les promos sont fermées tant que le chapitre 2 n'est pas terminé
{
  const { t } = boot(undefined);
  check('stagiaires : fermés au chapitre 1', false, t.isFeatureUnlocked('stagiaires'));
  t.openInternDraft();
  check('stagiaires : aucune promo tant que c\'est fermé', null, t.state.internDraft);
  t.tickInterns();
  check('stagiaires : la boucle ne force rien non plus', null, t.state.internDraft);
}

/** Ouvre le système et pose une promo. */
function bootAvecPromo() {
  const { t, window } = boot(undefined);
  t.state.unlockedFeatures = ['boutique', 'stagiaires'];
  t.openInternDraft();
  return { t, window };
}

// 17. Un tirage propose 3 candidats complets
{
  const { t } = bootAvecPromo();
  const c = t.state.internDraft.candidates;
  check('tirage : 3 candidats', t.INTERN_DRAFT_SIZE, c.length);
  check('tirage : chaque candidat a une rareté connue', true,
    c.every(x => !!t.INTERN_RARITIES[x.rarity]));
  check('tirage : chaque candidat a un trait connu', true,
    c.every(x => t.INTERN_TRAITS.some(tr => tr.id === x.traitId)));
  check('tirage : stats figées sur le candidat', true,
    c.every(x => x.prodPercent > 0 && x.hireBonusPercent > 0 && x.stageMs > 0));
  check('tirage : identifiants distincts', 3, new Set(c.map(x => x.id)).size);
}

// 18. Choisir un candidat fait partir les deux autres
{
  const { t } = bootAvecPromo();
  const choisi = t.state.internDraft.candidates[1];
  t.chooseInternCandidate(choisi.id);
  check('choix : le stagiaire est en stage', choisi.id, t.state.intern.id);
  check('choix : la promo est close', null, t.state.internDraft);
  check('choix : coût d\'embauche figé', true, t.state.intern.hireCost >= 250);
  check('choix : stage en cours', false, t.isInternStageOver());
}

// 19. Le stagiaire en stage produit, et son bonus s'arrête à la fin du stage
{
  const { t } = bootAvecPromo();
  t.state.upgrades.find(u => u.id === 'stagiaire').quantity = 100;
  const avant = t.getProductionPerSecond();
  const choisi = t.state.internDraft.candidates[0];
  t.chooseInternCandidate(choisi.id);
  const pendant = t.getProductionPerSecond();
  check('stage : la production augmente', true, pendant > avant);
  check('stage : du bon pourcentage', choisi.prodPercent,
    Math.round((pendant / avant - 1) * 1000) / 10);
  // Fin du stage : le bonus s'arrête, mais le stagiaire reste à décider.
  t.state.intern.endsAt = Date.now() - 1;
  check('fin de stage : bonus retiré', 0, t.getInternProdPercent());
  check('fin de stage : production revenue au niveau d\'avant', true,
    Math.abs(t.getProductionPerSecond() - avant) < 1e-9);
  check('fin de stage : le stagiaire attend une décision', true, !!t.state.intern);
}

// 20. L'Eurêka multiplie toute la production de l'agence
{
  const { t } = bootAvecPromo();
  t.state.upgrades.find(u => u.id === 'stagiaire').quantity = 100;
  const choisi = t.state.internDraft.candidates[0];
  t.chooseInternCandidate(choisi.id);
  const normal = t.getProductionPerSecond();
  t.state.intern.eurekaMultiplier = 6;
  t.state.eurekaUntil = Date.now() + 20000;
  check('eurêka : actif', true, t.isEurekaActive());
  check('eurêka : production x6', 6, Math.round(t.getProductionPerSecond() / normal));
  t.state.eurekaUntil = Date.now() - 1;
  check('eurêka : terminé, production revenue', normal, t.getProductionPerSecond());
}

// 21. Embaucher coûte, et laisse un bonus définitif
{
  const { t } = bootAvecPromo();
  const choisi = t.state.internDraft.candidates[0];
  t.chooseInternCandidate(choisi.id);
  t.state.intern.endsAt = Date.now() - 1;
  const cout = t.state.intern.hireCost;
  const bonus = t.state.intern.hireBonusPercent;

  t.state.credits = cout - 1;
  t.hireIntern();
  check('embauche : refusée sans les crédits', 0, t.state.internsHired);

  t.state.credits = cout + 500;
  t.hireIntern();
  check('embauche : crédits débités', 500, Math.floor(t.state.credits));
  check('embauche : comptée', 1, t.state.internsHired);
  check('embauche : bonus définitif acquis', bonus, t.state.internHireBonusPercent);
  check('embauche : ajouté à l\'équipe', choisi.name, t.state.hiredInterns[0].name);
  check('embauche : le stage est clos', null, t.state.intern);
  check('embauche : prochaine promo programmée', true, t.state.nextInternDraftAt > Date.now());
}

// 22. Laisser partir ne rapporte rien et ne coûte rien
{
  const { t } = bootAvecPromo();
  t.chooseInternCandidate(t.state.internDraft.candidates[0].id);
  t.state.intern.endsAt = Date.now() - 1;
  t.state.credits = 9999;
  t.releaseIntern();
  check('départ : rien débité', 9999, Math.floor(t.state.credits));
  check('départ : aucune embauche', 0, t.state.internsHired);
  check('départ : aucun bonus', 0, t.state.internHireBonusPercent);
  check('départ : le stage est clos', null, t.state.intern);
}

// 23. Une décision non prise attend le retour du joueur
{
  const { t } = bootAvecPromo();
  t.chooseInternCandidate(t.state.internDraft.candidates[0].id);
  t.state.intern.endsAt = Date.now() - 60 * 60 * 1000;  // stage fini il y a une heure
  t.tickInterns();
  check('absence : le stagiaire attend toujours', true, !!t.state.intern);
  check('absence : aucune promo ne le remplace', null, t.state.internDraft);
}

// 24. L'état des stagiaires fait l'aller-retour par la sauvegarde
{
  const { t, window } = bootAvecPromo();
  const choisi = t.state.internDraft.candidates[0];
  t.chooseInternCandidate(choisi.id);
  t.state.internsHired = 2;
  t.state.internHireBonusPercent = 13;
  t.state.eurekaUntil = Date.now() + 30000;
  t.save();
  const brut = JSON.parse(window.localStorage.getItem(KEY));
  check('sauvegarde : le stagiaire est écrit', choisi.id, brut.intern.id);
  check('sauvegarde : bonus définitif écrit', 13, brut.internHireBonusPercent);
  t.state.intern = null; t.state.internsHired = 0; t.state.internHireBonusPercent = 0;
  t.load();
  check('rechargement : stagiaire restauré', choisi.id, t.state.intern.id);
  check('rechargement : embauches restaurées', 2, t.state.internsHired);
  check('rechargement : Eurêka non repris', false, t.isEurekaActive());
}

// 25. Paliers de producteur : x2 tous les 25, et la production suit
{
  const { t } = boot(undefined);
  const PAS = t.PRODUCER_MILESTONE_STEP;
  check('palier : pas de 25', 25, PAS);
  check('palier : 0 possédé -> x1', 1, t.producerMilestoneMult(0));
  check('palier : 24 possédés -> x1', 1, t.producerMilestoneMult(24));
  check('palier : 25 possédés -> x2', 2, t.producerMilestoneMult(25));
  check('palier : 110 possédés -> x16', 16, t.producerMilestoneMult(110));
  check('palier : reste 1 à 24 possédés', 1, t.producerMilestoneRemaining(24));
  // Juste après un palier, il faut de nouveau le pas complet.
  check('palier : reste 25 à 25 possédés', 25, t.producerMilestoneRemaining(25));

  // La production doit réellement doubler au passage du palier, pas seulement
  // s'afficher : c'est tout l'intérêt du système.
  t.ensureUpgrade('stagiaire');
  t.getUpgradeState('stagiaire').quantity = 24;
  const avant = t.getProductionPerSecond();
  t.getUpgradeState('stagiaire').quantity = 25;
  const apres = t.getProductionPerSecond();
  // 24 -> 25 : +1 unité (x25/24) ET le palier (x2), donc ~x2,08.
  check('palier : la production double au franchissement', true,
    Math.abs(apres / avant - (25 / 24) * 2) < 0.001);
}

// 26. Une fin de stage n'ouvre plus de modale d'elle-même
{
  const { t, window } = bootAvecPromo();
  t.chooseInternCandidate(t.state.internDraft.candidates[0].id);
  t.state.intern.endsAt = Date.now() - 1;
  t.tickInterns();
  const modale = window.document.getElementById('intern-end-modal');
  check('fin de stage : la modale reste fermée', true, modale.hidden);
  check('fin de stage : la carte passe en décision', 'decision',
    window.document.getElementById('intern-card').getAttribute('data-mode'));
  check('fin de stage : le stagiaire attend toujours', true, !!t.state.intern);
}

// 27. Le battement entre deux promos laisse respirer
{
  const { t } = boot(undefined);
  // Un cycle complet = stage + battement. En dessous de 5 min, le jeu réclame
  // l'attention du joueur trop souvent pour ce que le stagiaire rapporte.
  const cycleMin = (t.INTERN_STAGE_MS + t.INTERN_COOLDOWN_MS) / 60000;
  check('promos : cycle d\'au moins 5 min', true, cycleMin >= 5);
}

// 28. L'arbre est plus grand que ce qu'on peut s'offrir
{
  const { t } = boot(undefined);
  const total = t.SKILL_TREE.reduce((s, n) => s + t.skillCost(n), 0);
  // ~44 points sont gagnés en trois heures de jeu. Si l'arbre coûtait moins,
  // on le remplirait en une session et il n'y aurait aucun choix à faire.
  check('arbre : coûte plus que ce qu\'on gagne en 3 h', true, total > 60);
  check('arbre : quatre voies', 4, t.SKILL_BRANCHES.length);
  check('arbre : chaque nœud est dans une voie connue', true,
    t.SKILL_TREE.every(n => t.SKILL_BRANCHES.some(b => b.id === n.branch)));
  check('arbre : chaque prérequis existe', true,
    t.SKILL_TREE.every(n => !n.requires || t.SKILL_TREE.some(o => o.id === n.requires)));
  check('arbre : aucun identifiant en double', t.SKILL_TREE.length,
    new Set(t.SKILL_TREE.map(n => n.id)).size);
}

// 29. Dépenser un point : prérequis, coût, effet
{
  const { t } = boot(undefined);
  check('compétence : rien sans point', false, t.canUnlockSkill('p1'));
  t.state.skillPoints = 3;
  check('compétence : ouvrable avec les points', true, t.canUnlockSkill('p1'));
  // p3 demande p1 : les points seuls ne suffisent pas.
  check('compétence : prérequis manquant bloque', false, t.canUnlockSkill('p3'));

  const prodAvant = t.getProductionPerSecond();
  t.ensureUpgrade('stagiaire');
  t.getUpgradeState('stagiaire').quantity = 10;
  const base = t.getProductionPerSecond();
  t.unlockSkill('p1');
  check('compétence : point débité', 2, t.state.skillPoints);
  check('compétence : acquise', true, t.isSkillUnlocked('p1'));
  check('compétence : +5% de production appliqué', true,
    Math.abs(t.getProductionPerSecond() / base - 1.05) < 0.0001);
  check('compétence : prérequis maintenant satisfait', true, t.canUnlockSkill('p3'));
  check('compétence : pas deux fois la même', false, t.canUnlockSkill('p1'));
}

// 30. Une montée de niveau donne un point, sans modale
{
  const { t, window } = boot(undefined);
  const avant = t.state.skillPoints || 0;
  t.state.playerXP = t.getXpToNextLevel();
  t.checkLevelUp();
  check('niveau : un point de plus', avant + 1, t.state.skillPoints);
  // L'ancienne modale de choix de bonus a été retirée du DOM avec son système :
  // vérifier qu'elle ne s'ouvre pas ne suffirait pas, on vérifie qu'elle n'est
  // plus là du tout — sinon un jour on la rebranche sans s'en apercevoir.
  check('niveau : plus de modale de niveau dans la page', null,
    window.document.getElementById('levelup-modal'));
  check('niveau : rien ne reste en attente', false, t.state.pendingLevelUp);

  // Plusieurs niveaux d'un coup (retour hors-ligne, gros achat) doivent tous
  // être crédités : l'ancienne garde `pendingLevelUp` n'en passait qu'un.
  const p2 = t.state.skillPoints;
  t.state.playerXP = t.getXpToNextLevel() * 4;
  t.checkLevelUp();
  check('niveau : plusieurs niveaux d\'un coup crédités', true, t.state.skillPoints >= p2 + 2);
}

// 31. L'arbre survit au Rebranding
{
  const { t } = boot(undefined);
  t.state.skillPoints = 5;
  t.unlockSkill('p1');
  t.state.credits = 1e9;
  t.state.unlockedFeatures = ['prestige'];
  t.state.playerLevel = 30;
  t.doPrestige();
  check('rebranding : niveau remis à 1', 1, t.state.playerLevel);
  check('rebranding : la compétence est gardée', true, t.isSkillUnlocked('p1'));
  check('rebranding : les points non dépensés sont gardés', 4, t.state.skillPoints);
}

// 32. Migration 3 -> 4 : une partie en cours ne perd pas ses niveaux
{
  const seed = JSON.stringify({
    credits: 5000, playerLevel: 18, playerXP: 40, pendingLevelUp: true,
    levelBonuses: { prodPercent: 12 }, save_version: 3,
  });
  const { t } = boot(seed);
  const r = t.readAndMigrateSave();
  check('v3 -> v4 : statut ok', 'ok', r.status);
  // 17 niveaux acquis au-delà du premier, + 1 pour le level-up en attente.
  check('v3 -> v4 : niveaux convertis en points', 18, r.data.skillPoints);
  check('v3 -> v4 : anciens bonus effacés', {}, r.data.levelBonuses);
  check('v3 -> v4 : plus rien en attente', false, r.data.pendingLevelUp);
}

const echecs = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  OK  ' : ' ÉCHEC') + '  ' + r.nom +
  (r.ok ? '' : `\n         attendu ${JSON.stringify(r.attendu)}, obtenu ${JSON.stringify(r.obtenu)}`)));
console.log(`\n${results.length - echecs.length}/${results.length} vérifications passées`);
process.exit(echecs.length ? 1 : 0);

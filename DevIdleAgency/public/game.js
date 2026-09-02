(function () {
  'use strict';

  const SAVE_KEY = 'agence-dev-idle-save-v4';
  /**
   * Copie de la sauvegarde d'origine, posée avant toute opération qui pourrait
   * la perdre : migration, ou sauvegarde illisible. On n'écrase jamais la
   * progression de quelqu'un sans en garder une trace récupérable.
   */
  const SAVE_BACKUP_KEY = SAVE_KEY + '-backup';
  const SAVE_VERSION = 3;

  /**
   * Migrations de sauvegarde.
   *
   * `SAVE_MIGRATIONS[n]` transforme une sauvegarde de la version n vers n+1 et
   * renvoie les données migrées. Les étapes sont appliquées à la suite jusqu'à
   * SAVE_VERSION : une partie de n'importe quelle version passée remonte en une
   * seule passe, sans avoir à prévoir chaque couple de versions.
   *
   * Pour ajouter une migration :
   *   1. incrémenter SAVE_VERSION ;
   *   2. ajouter l'entrée portant le numéro de l'*ancienne* version.
   *
   * Une étape ne doit jamais supposer qu'un champ existe : les sauvegardes
   * anciennes sont incomplètes par nature, et `load()` ne fait confiance à
   * aucune valeur de toute façon.
   *
   * Exemple, pour passer de 1 à 2 :
   *   SAVE_VERSION = 2;
   *   SAVE_MIGRATIONS = {
   *     1: function (data) { data.nouveauChamp = data.ancienChamp || 0; return data; },
   *   };
   */
  const SAVE_MIGRATIONS = {
    /**
     * 1 → 2 : refonte de la progression (chapitres devenus le seul escalier,
     * boutique Réputation répétable).
     *
     * L'ancien `chapter` ne veut plus rien dire : il avançait sur un seuil de
     * crédits sans que rien ne soit accompli, et le prestige le remettait à 1.
     * On le remet à zéro et on laisse `catchUpChapters()` recalculer le vrai
     * chapitre à partir de l'état de la partie, ce qui réapplique au passage
     * les récompenses et les déblocages.
     */
    1: function (data) {
      data.chapter = 1;
      data.completedChapters = [];
      data.chapterBonuses = {};
      data.unlockedFeatures = [];
      data.gameCompleted = false;
      // Aucun compteur de crédits cumulés n'existait : le meilleur run connu
      // est la seule approximation honnête dont on dispose.
      if (typeof data.totalCreditsEarned !== 'number') {
        data.totalCreditsEarned = Math.max(data.bestRunCredits || 0, data.credits || 0);
      }
      if (typeof data.runPeakCredits !== 'number') data.runPeakCredits = data.credits || 0;
      // Le nombre de Rebrandings n'était pas suivi non plus. Avoir de la
      // réputation ou un bonus acheté prouve au moins un prestige.
      if (typeof data.prestigeCount !== 'number') {
        var hadPrestige = (data.reputation || 0) > 0 || (Array.isArray(data.purchasedPrestigeBonuses) && data.purchasedPrestigeBonuses.length > 0);
        data.prestigeCount = hadPrestige ? 1 : 0;
      }
      // Les bonus à usage unique deviennent des niveaux : un achat = niveau 1.
      if (!data.prestigeBonusLevels) {
        data.prestigeBonusLevels = {};
        (Array.isArray(data.purchasedPrestigeBonuses) ? data.purchasedPrestigeBonuses : []).forEach(function (id) {
          data.prestigeBonusLevels[id] = 1;
        });
      }
      return data;
    },
    /**
     * 2 → 3 : arrivée des stagiaires. L'échelle passe de 9 à 10 chapitres — un
     * nouveau chapitre 4 (« La première embauche ») s'intercale — donc les
     * anciens numéros ne désignent plus les mêmes buts. Même méthode qu'en
     * 1 → 2 : on remet le compteur à zéro et `catchUpChapters()` recalcule.
     */
    2: function (data) {
      data.chapter = 1;
      data.completedChapters = [];
      data.chapterBonuses = {};
      data.unlockedFeatures = [];
      data.gameCompleted = false;
      data.intern = null;
      data.internDraft = null;
      data.nextInternDraftAt = 0;
      data.nextEurekaRollAt = 0;
      data.eurekaUntil = 0;
      if (typeof data.internHireBonusPercent !== 'number') data.internHireBonusPercent = 0;
      if (!Array.isArray(data.hiredInterns)) data.hiredInterns = [];
      // Le but du nouveau chapitre 4 est d'embaucher un stagiaire — impossible
      // pour une partie qui n'a jamais vu le système. Sans ce crédit, une partie
      // déjà avancée serait renvoyée au chapitre 4 et perdrait les récompenses
      // des chapitres suivants jusqu'à ce qu'elle refasse un stage complet.
      // On se base sur la richesse atteinte, seul repère qui survive aux deux
      // renumérotations de chapitres.
      if (typeof data.internsHired !== 'number') {
        var dejaAvance = Math.max(data.bestRunCredits || 0, data.runPeakCredits || 0, data.credits || 0) >= 10000;
        data.internsHired = dejaAvance ? 1 : 0;
      }
      return data;
    },
  };
  const TICK_MS = 100;
  // La boucle tourne à 100 ms pour la production, mais l'interface n'a pas besoin
  // de suivre cette cadence : les listes et les boutons sont rafraîchis 4 fois par
  // seconde, la logique périodique (quêtes, chapitres, tirages) 2 fois par seconde.
  const UI_REFRESH_MS = 250;
  const LOGIC_REFRESH_MS = 500;
  const EVENT_MIN_INTERVAL_MS = 60 * 1000;
  const EVENT_MAX_INTERVAL_MS = 3 * 60 * 1000;
  const XP_PER_CLICK = 1;
  const XP_PER_CREDIT = 0.001;
  const PRESTIGE_THRESHOLD = 100000;
  const RECRUITMENT_POOL_SIZE = 5;
  const RECRUITMENT_REFRESH_MIN_COST = 25;
  const RECRUITMENT_REFRESH_PERCENT = 0.001;
  const ERROR_ROLL_INTERVAL_MS = 45 * 1000;
  const ERROR_BLOCK_DURATION_MS = 30 * 1000;
  const MENTOR_PENALTY_DURATION_MS = 25 * 1000;
  const MENTOR_SLOTS_JUNIOR = 2;
  const MENTOR_SLOTS_SENIOR = 3;
  const MENTOR_PROD_BONUS = 0.2;
  const MENTOR_ERROR_REDUCTION = 0.3;

  // Ralentit légèrement la production passive globale pour un rythme plus confortable
  const GLOBAL_PRODUCTION_SCALE = 0.15;

  // Production hors-ligne : rendement réduit, plafonné, et ignoré sous une minute d'absence
  const OFFLINE_RATE = 0.5;
  const OFFLINE_MAX_MS = 8 * 60 * 60 * 1000;
  const OFFLINE_MIN_MS = 60 * 1000;

  /**
   * Périmètre v1 : le recrutement (Candidats), la gestion d'équipe (Équipe, donc
   * aussi l'arbre de compétences, les Cadres et les Formations) et les sections
   * International / Contrats / R&D de l'onglet Plus sont annoncés « Bientôt ».
   *
   * Le code de ces systèmes reste en place : il n'est neutralisé qu'ici. Repasser
   * V1_LOCKS_ENABLED à false rallume l'ensemble sans autre modification.
   *
   * Motif : les employés recrutés font doublon avec les upgrades producteurs, et
   * le contenu tardif est verrouillé par niveau mais tarifé pour le début de
   * partie — il se débloque déjà payé, donc sans décision de jeu à prendre.
   */
  const V1_LOCKS_ENABLED = true;
  const LOCKED_TABS = ['candidats', 'equipe'];
  const LOCKED_PLUS_SECTIONS = ['intl', 'contrats', 'rnd'];
  /** Objectifs dont la cible n'est plus atteignable une fois le verrou posé. */
  const LOCKED_QUEST_IDS = [
    'recruit3', 'recruit8', 'recruit15',
    'managers1', 'managers3', 'training1',
    'intl1', 'contrat1', 'rnd1',
  ];
  /** @param {'candidats'|'equipe'|'intl'|'contrats'|'rnd'} feature */
  function isFeatureLocked(feature) {
    if (!V1_LOCKS_ENABLED) return false;
    return LOCKED_TABS.indexOf(feature) >= 0 || LOCKED_PLUS_SECTIONS.indexOf(feature) >= 0;
  }

  const EMPLOYEE_TYPE_LABELS = { stagiaire: 'Stagiaire', junior: 'Dev junior', senior: 'Dev senior' };
  const EMPLOYEE_TYPE_ICONS = { stagiaire: 'student', junior: 'developer', senior: 'conference-call' };
  const FALLBACK_ICON = '/assets/icons/placeholder.svg';
  function getIconImg(name, size) {
    size = size || 28;
    var url = (typeof window.getIconUrl === 'function') ? window.getIconUrl(name, size) : FALLBACK_ICON;
    var fallback = (typeof window.getFallbackIconPath === 'function') ? window.getFallbackIconPath() : FALLBACK_ICON;
    return '<img class="game-icon" src="' + url + '" data-fallback="' + fallback + '" alt="" aria-hidden="true" width="' + size + '" height="' + size + '">';
  }
  const EMPLOYEE_TYPE_PROD_RANGES = {
    stagiaire: { min: 0.2, max: 0.5 },
    junior: { min: 0.6, max: 1.2 },
    senior: { min: 1.5, max: 2.5 },
  };
  const EMPLOYEE_TYPE_ERROR_RANGES = {
    stagiaire: { min: 0.03, max: 0.12 },
    junior: { min: 0.01, max: 0.06 },
    senior: { min: 0.002, max: 0.012 },
  };
  function clampErrorChance(emp) {
    var range = EMPLOYEE_TYPE_ERROR_RANGES[emp.type];
    if (!range) return;
    var v = emp.errorChance;
    if (typeof v !== 'number' || isNaN(v)) return;
    emp.errorChance = Math.max(range.min, Math.min(range.max, v));
  }
  function evolveErrorChance(emp, impact) {
    if (!emp) return;
    var range = EMPLOYEE_TYPE_ERROR_RANGES[emp.type] || { min: 0.001, max: 0.15 };
    var current = typeof emp.errorChance === 'number' && !isNaN(emp.errorChance) ? emp.errorChance : (range.min + range.max) / 2;
    var delta = 0;
    if (impact === 'made_error') {
      if (Math.random() < 0.6) delta = 0.0008 + Math.random() * 0.0022;
      else delta = -(0.0004 + Math.random() * 0.0008);
    } else if (impact === 'pardoned') {
      delta = -(0.0012 + Math.random() * 0.0018);
    } else if (impact === 'mentee_pardoned') {
      delta = 0.0004 + Math.random() * 0.0012;
    }
    emp.errorChance = Math.max(range.min, Math.min(range.max, current + delta));
  }
  const ERROR_IMPACT_DURATION_MS = 30 * 1000;
  const ERROR_IMPACT_TYPES = [
    { id: 'production', name: 'Production', desc: 'Réduit la production de l\'agence pendant %d s.', penaltyPercent: 10, durationMs: 30000 },
    { id: 'profit', name: 'Profit', desc: 'A causé une perte de crédits (déjà déduite).', creditPercent: 2 },
    { id: 'reputation', name: 'Réputation', desc: 'A nui à la réputation client : production réduite pendant %d s.', penaltyPercent: 20, durationMs: 60000 },
    { id: 'delivery', name: 'Livraison', desc: 'Retard sur une livraison : production réduite pendant %d s.', penaltyPercent: 15, durationMs: 45000 },
  ];
  const EMPLOYEE_TYPE_COST_BASE = { stagiaire: 20, junior: 80, senior: 200 };
  const EMPLOYEE_UPGRADES = [
    { id: 'linter', name: 'Linter strict', desc: 'Réduit les erreurs de typo et de style. Moins de bugs en prod.', reputationCost: 5, requires: null, errorAdd: -0.008 },
    { id: 'repoDoc', name: 'Doc du repo à jour', desc: 'Le dev consulte la doc avant de coder. Moins de mauvaises surprises.', reputationCost: 5, requires: null, errorAdd: -0.009 },
    { id: 'meditation', name: 'Séance de méditation', desc: 'Gestion du stress, moins d\'erreurs sous pression.', reputationCost: 6, requires: null, errorAdd: -0.006 },
    { id: 'cafeIllimite', name: 'Café illimité', desc: 'Boost de productivité… et de nervosité. Risque d\'erreur +.', reputationCost: 3, requires: null, prodPercent: 10, errorAdd: 0.005 },
    { id: 'secondEcran', name: 'Second écran', desc: 'Moins de context switch, plus de focus. Productivité +.', reputationCost: 8, requires: null, prodPercent: 5 },
    { id: 'tests', name: 'Tests unitaires', desc: 'Le dev écrit des tests avant de merger. Qualité en hausse.', reputationCost: 10, requires: 'linter', errorAdd: -0.012 },
    { id: 'clavierErgo', name: 'Clavier ergonomique', desc: 'Confort et moins de fatigue en fin de journée.', reputationCost: 10, requires: 'secondEcran', prodPercent: 3, errorAdd: -0.004 },
    { id: 'formationQualite', name: 'Formation qualité', desc: 'Une semaine de formation aux bonnes pratiques.', reputationCost: 15, requires: 'tests', errorAdd: -0.015 },
    { id: 'pairProg', name: 'Pair programming', desc: 'Code review en continu. Moins d\'erreurs, un peu moins de vélocité.', reputationCost: 18, requires: 'formationQualite', errorAdd: -0.018, prodPercent: -6 },
    { id: 'certif', name: 'Certification reconnue', desc: 'Passage d\'une cert (AWS, Google…). Prestige et compétences.', reputationCost: 25, requires: 'formationQualite', prodPercent: 8, errorAdd: -0.008 },
  ];
  function getEmployeeUpgradeDef(id) { return EMPLOYEE_UPGRADES.find(function (u) { return u.id === id; }); }
  function isEmployeeUpgradeUnlocked(upgradeId) { return (state.unlockedEmployeeUpgrades || []).indexOf(upgradeId) >= 0; }
  function canUnlockEmployeeUpgrade(upgradeId) {
    if (isEmployeeUpgradeUnlocked(upgradeId)) return false;
    var def = getEmployeeUpgradeDef(upgradeId);
    if (!def || typeof def.reputationCost !== 'number') return false;
    if ((state.reputation || 0) < def.reputationCost) return false;
    if (def.requires && !isEmployeeUpgradeUnlocked(def.requires)) return false;
    return true;
  }
  function unlockEmployeeUpgrade(upgradeId) {
    if (!canUnlockEmployeeUpgrade(upgradeId)) return;
    var def = getEmployeeUpgradeDef(upgradeId);
    if (!def) return;
    state.reputation = Math.max(0, (state.reputation || 0) - def.reputationCost);
    (state.unlockedEmployeeUpgrades = state.unlockedEmployeeUpgrades || []).push(upgradeId);
    renderSkillTree();
    renderEmployeesList();
    renderReputation();
  }
  function getEmployeeEffectiveErrorChance(emp) {
    if (!emp) return 0;
    var range = EMPLOYEE_TYPE_ERROR_RANGES[emp.type] || { min: 0.001, max: 0.2 };
    var base = typeof emp.errorChance === 'number' && !isNaN(emp.errorChance) ? emp.errorChance : range.min;
    var add = (emp.upgrades || []).reduce(function (sum, uid) {
      var d = getEmployeeUpgradeDef(uid);
      return sum + (d && typeof d.errorAdd === 'number' ? d.errorAdd : 0);
    }, 0);
    return Math.max(0, Math.min(range.max, base + add));
  }
  function getEmployeeProdBonusPercent(emp) {
    if (!emp) return 0;
    return (emp.upgrades || []).reduce(function (sum, uid) {
      var d = getEmployeeUpgradeDef(uid);
      return sum + (d && typeof d.prodPercent === 'number' ? d.prodPercent : 0);
    }, 0);
  }
  const TRAITS = [
    'Consciencieux', 'Distrait', 'Génie du dimanche', 'Pédagogue', 'Stressé',
    'Zen', 'Perfectionniste', 'Bricoleur', 'Pragmatique', 'Rêveur',
  ];
  const FIRST_NAMES = ['Marie', 'Thomas', 'Léa', 'Hugo', 'Emma', 'Lucas', 'Chloé', 'Nathan', 'Julie', 'Alexandre', 'Camille', 'Antoine'];
  const LAST_NAMES = ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau'];

  const ERROR_MESSAGES = [
    'Tout le monde peut se tromper, même les meilleures agences.',
    'L\'erreur est humaine, le refactor est divin.',
    'On ne progresse pas sans bug, seulement sans logs.',
    'Un junior sans erreur, ça s\'appelle une légende.',
    'Tout le monde peut se tromper, laisse-lui une chance.',
    'Ce stagiaire a planté la prod. Il débute encore, ne sois pas trop dur.',
    'Ton dev junior a fait une boulette. Tout le monde peut se tromper.',
    'Un bug, une leçon. Garde ton calme.',
  ];

  /**
   * Colonne vertébrale du jeu. Un chapitre = un but unique, lisible en une
   * phrase, une récompense, et une fonctionnalité qui s'ouvre. C'est le seul
   * escalier de progression : on n'avance QUE en remplissant le but courant.
   *
   * L'ancienne version en avait deux, désynchronisés — un `creditsReq` qui
   * faisait avancer le badge tout seul, et un `objective` qui ne servait à
   * rien parce qu'il demandait 1e9 crédits (~29 jours de jeu mesurés) alors
   * que le prestige, qui remet le chapitre à 1, s'ouvre à 1e5 (~49 min).
   * Aucun chapitre n'était donc terminable. Les buts ci-dessous sont calibrés
   * sur la courbe réelle simulée, et les chapitres ne sont plus remis à zéro
   * par le prestige : c'est la progression permanente du joueur.
   *
   * `goal.kind` :
   *   credits      crédits en poche maintenant
   *   runCredits   meilleur total atteint depuis le dernier Rebranding
   *   totalCredits crédits gagnés depuis le début de la partie, tous runs confondus
   *   prodPerSec   production passive par seconde
   *   level        niveau du joueur
   *   upgradeQty   quantité d'un producteur (`goal.upgradeId`)
   *   prestiges    nombre de Rebrandings effectués
   *   internsHired nombre de stagiaires embauchés en fin de stage
   */
  const CHAPTERS = [
    {
      id: 1,
      name: 'Premier commit',
      tagline: 'Une idée, un clavier, zéro client.',
      goal: { kind: 'credits', target: 50, label: 'Gagner 50 crédits en codant' },
      reward: { clickPower: 1 },
      rewardLabel: '+1 crédit par clic',
      unlocks: ['boutique'],
      unlockLabel: 'la Boutique — tu peux embaucher',
      unlockShort: 'la Boutique',
    },
    {
      id: 2,
      name: 'Le premier stagiaire',
      tagline: 'Il ne sait pas encore ce qu\'il fait. Toi non plus.',
      goal: { kind: 'upgradeQty', upgradeId: 'stagiaire', target: 3, label: 'Avoir 3 stagiaires' },
      reward: { prodPercent: 5 },
      rewardLabel: '+5% production',
      unlocks: ['stagiaires'],
      unlockLabel: 'les promos de stagiaires — 3 candidats, tu en gardes un',
      unlockShort: 'les promos de stagiaires',
    },
    {
      id: 3,
      name: 'Ça tourne tout seul',
      tagline: 'L\'agence produit même quand tu ne regardes pas.',
      goal: { kind: 'prodPerSec', target: 10, label: 'Atteindre 10 crédits/s de production' },
      reward: { prodPercent: 5 },
      rewardLabel: '+5% production',
      unlocks: ['events'],
      unlockLabel: 'les événements — hackathons et clients toxiques',
      unlockShort: 'les événements',
    },
    {
      id: 4,
      name: 'La première embauche',
      tagline: 'Un stage, ça se termine. À toi de dire comment.',
      goal: { kind: 'internsHired', target: 1, label: 'Embaucher un stagiaire à la fin de son stage' },
      reward: { prodPercent: 10 },
      rewardLabel: '+10% production',
      unlocks: ['promotions'],
      unlockLabel: 'les promotions — fais monter tes devs en grade',
      unlockShort: 'les promotions',
    },
    {
      id: 5,
      name: 'Le garage',
      tagline: 'Deux bureaux, une machine à café, beaucoup d\'espoir.',
      goal: { kind: 'runCredits', target: 10000, label: 'Atteindre 10 000 crédits' },
      reward: { prodPercent: 10 },
      rewardLabel: '+10% production',
      unlocks: ['bureaux'],
      unlockLabel: 'les Bureaux — des locaux qui boostent toute l\'agence',
      unlockShort: 'les Bureaux',
    },
    {
      id: 6,
      name: 'Petite agence locale',
      tagline: 'On te connaît dans le quartier.',
      goal: { kind: 'runCredits', target: 100000, label: 'Atteindre 100 000 crédits' },
      reward: { prodPercent: 10 },
      rewardLabel: '+10% production',
      unlocks: ['branding', 'prestige'],
      unlockLabel: 'l\'Image de marque et le Rebranding',
      unlockShort: 'l\'Image et le Rebranding',
    },
    {
      id: 7,
      name: 'Rebranding',
      tagline: 'Tout recommencer, mais avec un nom qui pèse.',
      goal: { kind: 'prestiges', target: 1, label: 'Faire ton premier Rebranding' },
      reward: { prodPercent: 10 },
      rewardLabel: '+10% production',
      unlocks: ['reputation'],
      unlockLabel: 'la boutique Réputation',
      unlockShort: 'la boutique Réputation',
    },
    {
      id: 8,
      name: 'Agence reconnue',
      tagline: 'Les clients viennent à toi.',
      goal: { kind: 'runCredits', target: 1e6, label: 'Atteindre 1 M de crédits sur une partie' },
      reward: { prodPercent: 15 },
      rewardLabel: '+15% production',
      unlocks: ['campus'],
      unlockLabel: 'le Campus high-tech — et le CTO qui va avec',
      unlockShort: 'le Campus',
    },
    {
      id: 9,
      name: 'Agence qui compte',
      tagline: 'Trois vies, trois logos, une réputation.',
      goal: { kind: 'prestiges', target: 3, label: 'Avoir fait 3 Rebrandings' },
      reward: { prodPercent: 20 },
      rewardLabel: '+20% production',
      unlocks: [],
      unlockLabel: null,
    },
    {
      id: 10,
      name: 'Studio légendaire',
      tagline: 'On raconte ton agence dans les écoles.',
      goal: { kind: 'totalCredits', target: 1e8, label: 'Gagner 100 M de crédits en tout' },
      reward: { prodPercent: 25 },
      rewardLabel: '+25% production',
      unlocks: [],
      unlockLabel: null,
      isFinal: true,
    },
  ];

  /**
   * Fonctionnalités ouvertes par les chapitres. Tant qu'un chapitre n'est pas
   * terminé, ce qu'il ouvre reste hors de portée : c'est ce qui donne une
   * raison de viser le but courant plutôt que de regarder un compteur monter.
   */
  const CHAPTER_FEATURES = ['boutique', 'stagiaires', 'events', 'promotions', 'bureaux', 'branding', 'prestige', 'reputation', 'campus'];

  const LEVEL_BONUSES = [
    { id: 'prod2', name: '+2% production', desc: 'Bonus permanent sur la prod passive', effect: { prodPercent: 2 } },
    { id: 'click1', name: '+1% clics', desc: 'Chaque clic rapporte plus', effect: { clickPercent: 1 } },
    { id: 'event5', name: '+5% chance event bonus', desc: 'Plus de Hackathons, moins de clients toxiques', effect: { eventBonusChance: 5 } },
    { id: 'prod3', name: '+3% production', desc: 'Bonus permanent sur la prod passive', effect: { prodPercent: 3 } },
    { id: 'click2', name: '+2% clics', desc: 'Chaque clic rapporte plus', effect: { clickPercent: 2 } },
    { id: 'xp10', name: '+10% XP', desc: 'Tu gagnes de l\'XP plus vite', effect: { xpPercent: 10 } },
  ];

  const EVENTS = {
    clientToxique: {
      id: 'clientToxique',
      name: 'Client toxique',
      duration: 30 * 1000,
      productionMultiplier: 0.5,
      type: 'bad',
    },
    hackathon: {
      id: 'hackathon',
      name: 'Hackathon',
      duration: 60 * 1000,
      productionMultiplier: 2,
      type: 'good',
    },
    bugCritique: {
      id: 'bugCritique',
      name: 'Bug critique en prod !',
      duration: 30 * 1000,
      productionMultiplier: 0.5,
      type: 'bad',
      hasAction: true,
      actionRecovery: 0.5,
    },
    clientVIP: {
      id: 'clientVIP',
      name: 'Client VIP',
      duration: 20 * 1000,
      clickMultiplier: 10,
      type: 'good',
    },
  };

  const UPGRADE_DEFS = [
    { id: 'stagiaire', name: 'Stagiaire', desc: 'Code des trucs. Parfois.', basePrice: 15, priceGrowth: 1.12, production: 0.5, type: 'producer', promoteFrom: null, promoteTo: 'dev', promoteCost: 10 },
    { id: 'dev', name: 'Développeur', desc: 'Fait des merges. Parfois des bons.', basePrice: 50, priceGrowth: 1.18, production: 3, type: 'producer', promoteFrom: 'stagiaire', promoteTo: 'devSenior', promoteCost: 10 },
    { id: 'devSenior', name: 'Développeur senior', desc: 'Sait où est le bug sans lire le code.', basePrice: 100, priceGrowth: 1.24, production: 20, type: 'producer', promoteFrom: 'dev', promoteTo: null, promoteCost: 10 },
    { id: 'serveur', name: 'Serveur', desc: 'Ça tourne. Enfin normalement.', basePrice: 500, priceGrowth: 1.2, multiplier: 0.5, type: 'multiplier' },
  ];

  const MANAGER_DEFS = [
    { id: 'chefProjet', name: 'Chef de projet', desc: '+2% prod par chef sur tous les employés. Gère les specs.', levelReq: 20, basePrice: 50000, priceGrowth: 1.25, prodBonusPerUnit: 0.02, maxQty: 10 },
    { id: 'directeurTech', name: 'Directeur technique (CTO)', desc: 'x1.1 multiplicateur global sur la prod. Vision stratégique.', levelReq: 40, basePrice: 500000, priceGrowth: 1.3, globalMultiplier: 0.1, maxQty: 5 },
    { id: 'coach', name: 'Coach / Formateur', desc: '+15% XP gagnée. Monte plus vite de niveau.', levelReq: 60, basePrice: 2e6, priceGrowth: 1.35, xpBonus: 0.15, maxQty: 5 },
  ];

  const INTERNATIONAL_OFFICES = [
    { id: 'europe', name: 'Bureau Europe', desc: '+8% prod passive. Les congés payés ça motive.', basePrice: 50000, priceGrowth: 1, prodBonus: 0.08, maxQty: 1, levelReq: 10 },
    { id: 'usa', name: 'Bureau USA', desc: '+15% chance gros client. Le marché américain.', basePrice: 100000, priceGrowth: 1, bigClientBonus: 0.15, maxQty: 1, levelReq: 12 },
    { id: 'asia', name: 'Bureau Asie', desc: '+10% clics. Décalage horaire = clients 24/7.', basePrice: 80000, priceGrowth: 1, clickBonus: 0.1, maxQty: 1, levelReq: 15 },
  ];

  const TRAINING_DEFS = [
    { id: 'formationAgile', name: 'Formation Agile', desc: '+20% prod pour tous les développeurs.', basePrice: 25000, priceGrowth: 1, devProdBonus: 0.2, maxQty: 1 },
    { id: 'programmeMentorat', name: 'Programme mentorat', desc: 'Chaque senior +10% prod des stagiaires.', basePrice: 40000, priceGrowth: 1, mentorBonus: 0.1, maxQty: 1 },
  ];

  const CONTRAT_DEFS = [
    { id: 'contrat1', name: 'Site vitrine PME', invest: 10000, duration: 120, rewardMult: 1.5, levelReq: 25 },
    { id: 'contrat2', name: 'App mobile startup', invest: 50000, duration: 300, rewardMult: 2, levelReq: 28 },
    { id: 'contrat3', name: 'SaaS entreprise', invest: 200000, duration: 600, rewardMult: 2.5, levelReq: 30 },
  ];

  const RND_DEFS = [
    { id: 'rnd1', name: 'CI/CD optimisé', desc: '+5% prod globale', cost: 100000, effect: { prodPercent: 5 }, levelReq: 50 },
    { id: 'rnd2', name: 'Architecture microservices', desc: '+10% prod', cost: 300000, effect: { prodPercent: 10 }, levelReq: 52 },
    { id: 'rnd3', name: 'IA assistée', desc: '+15% XP', cost: 500000, effect: { xpPercent: 15 }, levelReq: 55 },
  ];

  const AGENCY_EVENTS = [
    { id: 'teamBuilding', name: 'Team building', options: [
      { name: 'Escape game', prod: 1.2, duration: 60 },
      { name: 'Resto équipe', xp: 1.3, duration: 45 },
    ]},
    { id: 'audit', name: 'Audit client', options: [
      { name: 'Accepter', credits: 1.5, prod: 0.8, duration: 90 },
      { name: 'Refuser', prod: 1, duration: 30 },
    ]},
  ];

  const OFFICE_DEFS = [
    { id: 'openSpace', name: 'Open space basique', desc: '+5% prod de tous les employés. Le bruit des claviers, c\'est la vie.', basePrice: 500, priceGrowth: 1.3, prodBonus: 0.05, maxQty: 1 },
    { id: 'centreVille', name: 'Locaux centre-ville', desc: '+10% sur les clics. Les clients adorent l\'adresse.', basePrice: 2000, priceGrowth: 1.4, clickBonus: 0.1, maxQty: 1 },
    { id: 'campusTech', name: 'Campus high-tech', desc: 'Débloque le CTO. Ping-pong et code.', basePrice: 10000, priceGrowth: 1, unlocks: 'cto', maxQty: 1 },
  ];

  const BRANDING_DEFS = [
    { id: 'logo', name: 'Logo pro', desc: 'x1.5 revenus contrats haut de gamme. Parce que le design ça compte.', basePrice: 3000, priceGrowth: 1, revenueMultiplier: 1.5, maxQty: 1 },
    { id: 'linkedin', name: 'Campagne LinkedIn Ads', desc: '5% chance de gros client (x50 crédits). Le réseau qui paie.', basePrice: 8000, priceGrowth: 1, bigClientChance: 0.05, bigClientMultiplier: 50, maxQty: 1 },
    { id: 'cafe', name: 'Machine à café', desc: '+5% prod quand tu es en ligne. Le carburant du dev.', basePrice: 1500, priceGrowth: 1, activeBonus: 0.05, maxQty: 1 },
  ];

  function countStagiaires() {
    return (getUpgradeState('stagiaire')?.quantity || 0)
      + (state.employees || []).filter((e) => e.type === 'stagiaire').length;
  }

  /** Objectif chiffré sur une valeur qui monte : barre + « x / y » dans la liste. */
  function numericQuest(id, name, read, target, xp) {
    return {
      id: id, name: name, reward: { xp: xp },
      target: function () { return read() >= target; },
      progress: function () { return { current: read(), target: target }; },
    };
  }

  const QUEST_DEFS = [
    /* Crédits – paliers plus exigeants */
    numericQuest('credits5k', 'Premier pactole (5K crédits)', () => state.credits, 5000, 30),
    numericQuest('credits25k', 'En croissance (25K crédits)', () => state.credits, 25000, 80),
    numericQuest('credits100k', '100K au compteur', () => state.credits, 1e5, 150),
    numericQuest('credits500k', 'Demi-million', () => state.credits, 5e5, 300),
    numericQuest('credits1M', 'Millionnaire', () => state.credits, 1e6, 500),
    numericQuest('credits5M', '5 millions', () => state.credits, 5e6, 800),
    numericQuest('credits25M', '25 millions', () => state.credits, 25e6, 1200),
    numericQuest('credits100M', '100 millions', () => state.credits, 1e8, 2000),
    numericQuest('credits500M', 'Demi-milliard', () => state.credits, 5e8, 3500),
    numericQuest('credits1B', 'Milliardaire', () => state.credits, 1e9, 5000),
    /* Niveau */
    numericQuest('level5', 'Niveau 5', () => state.playerLevel, 5, 100),
    numericQuest('level10', 'Niveau 10', () => state.playerLevel, 10, 200),
    numericQuest('level15', 'Niveau 15', () => state.playerLevel, 15, 350),
    numericQuest('level20', 'Niveau 20', () => state.playerLevel, 20, 500),
    numericQuest('level30', 'Niveau 30', () => state.playerLevel, 30, 800),
    numericQuest('level40', 'Niveau 40', () => state.playerLevel, 40, 1200),
    numericQuest('level50', 'Niveau 50', () => state.playerLevel, 50, 1800),
    numericQuest('level60', 'Niveau 60', () => state.playerLevel, 60, 2500),
    /* Recrutement & équipe */
    { id: 'recruit3', name: '3 employés recrutés', target: () => (state.employees || []).length >= 3, reward: { xp: 60 } },
    { id: 'recruit8', name: '8 employés recrutés', target: () => (state.employees || []).length >= 8, reward: { xp: 200 } },
    { id: 'recruit15', name: '15 employés recrutés', target: () => (state.employees || []).length >= 15, reward: { xp: 500 } },
    numericQuest('stagiaires5', '5 stagiaires', countStagiaires, 5, 80),
    numericQuest('stagiaires15', '15 stagiaires', countStagiaires, 15, 250),
    { id: 'managers1', name: 'Premier cadre (manager)', target: () => (state.managers || []).some((m) => m.quantity > 0), reward: { xp: 300 } },
    { id: 'managers3', name: '3 cadres différents', target: () => (state.managers || []).filter((m) => m.quantity > 0).length >= 3, reward: { xp: 800 } },
    { id: 'training1', name: 'Une formation achetée', target: () => (state.training || []).some((t) => t.quantity > 0), reward: { xp: 400 } },
    /* Bureaux & image */
    numericQuest('office1', 'Premier bureau', getOwnedOfficesCount, 1, 100),
    numericQuest('bureaux3', '3 bureaux différents', getOwnedOfficesCount, 3, 400),
    { id: 'branding1', name: 'Premier achat image (branding)', target: () => (state.branding || []).some((b) => b.quantity > 0), reward: { xp: 150 } },
    { id: 'brandingAll', name: 'Toute l\'image (3 brandings)', target: () => (state.branding || []).filter((b) => b.quantity > 0).length >= 3, reward: { xp: 600 } },
    /* International & contrats */
    { id: 'intl1', name: 'Un bureau international', target: () => (state.intlOffices || []).some((o) => o.quantity > 0), reward: { xp: 350 } },
    { id: 'contrat1', name: 'Premier contrat livré', target: () => (state.contratsClaimedCount || 0) >= 1, reward: { xp: 200 } },
    { id: 'rnd1', name: 'Une R&D achetée', target: () => (state.rnd || []).some((r) => r.purchased), reward: { xp: 500 } },
    /* Chapitres */
    numericQuest('chapters3', 'Terminer 3 chapitres', () => (state.completedChapters || []).length, 3, 600),
    numericQuest('chapters6', 'Terminer 6 chapitres', () => (state.completedChapters || []).length, 6, 1500),
    numericQuest('chaptersAll', 'Terminer tous les chapitres', () => (state.completedChapters || []).length, CHAPTERS.length, 5000),
    /* Prestige */
    numericQuest('prestige1', 'Premier Rebranding', () => state.prestigeCount || 0, 1, 1500),
    numericQuest('prestige5', '5 Rebrandings', () => state.prestigeCount || 0, 5, 4000),
  ];
  /**
   * Les objectifs portant sur du contenu verrouillé sont retirés du jeu : ils
   * resteraient sinon affichés en permanence, impossibles à valider.
   */
  const QUESTS = V1_LOCKS_ENABLED
    ? QUEST_DEFS.filter(function (q) { return LOCKED_QUEST_IDS.indexOf(q.id) < 0; })
    : QUEST_DEFS;
  const QUEST_DISPLAY_LIMIT = 5;

  /**
   * Boutique Réputation. Chaque bonus est RÉPÉTABLE, son coût monte à chaque
   * palier — sinon la couche méta se bouche : l'ancienne version comptait
   * 3 bonus à usage unique pour 4 points de réputation en tout, et un seul
   * Rebranding à 1 M en rapportait déjà 3. Passé le deuxième, la réputation
   * ne servait plus à rien et le prestige n'avait plus d'intérêt.
   */
  const PRESTIGE_BONUSES = [
    { id: 'prod10', name: 'Production +10%', desc: 'Bonus permanent sur la prod passive, cumulable.', baseCost: 1, costGrowth: 1.6, effect: { prodPercent: 10 } },
    { id: 'click5', name: 'Clics +5%', desc: 'Chaque clic rapporte plus, cumulable.', baseCost: 1, costGrowth: 1.6, effect: { clickPercent: 5 } },
    { id: 'xp20', name: 'XP +20%', desc: 'Tu montes de niveau plus vite, cumulable.', baseCost: 2, costGrowth: 1.6, effect: { xpPercent: 20 } },
    { id: 'offline15', name: 'Hors-ligne +15%', desc: 'Tu récupères plus de production pendant ton absence.', baseCost: 2, costGrowth: 1.8, effect: { offlinePercent: 15 } },
    { id: 'headstart', name: 'Reprise +2%', desc: 'Tu gardes 2% de tes crédits en faisant un Rebranding.', baseCost: 3, costGrowth: 2, effect: { headstartPercent: 2 } },
  ];

  function getPrestigeBonusLevel(id) { return (state.prestigeBonusLevels && state.prestigeBonusLevels[id]) || 0; }

  function getPrestigeBonusCost(def) {
    return Math.ceil(def.baseCost * Math.pow(def.costGrowth, getPrestigeBonusLevel(def.id)));
  }

  /* ==========================================================================
     Les stagiaires — cœur du jeu

     Une promo de 3 candidats arrive régulièrement. Le joueur en garde UN SEUL,
     les deux autres partent chez la concurrence : c'est la décision qui rythme
     la partie. Le stagiaire choisi travaille pendant un stage à durée limitée,
     puis il faut trancher — l'embaucher (cher, bonus définitif) ou le laisser
     filer.

     Les raretés ne sont volontairement pas ordonnées de la pire à la meilleure :
     une Pépite produit MOINS qu'un Commun au quotidien, mais déclenche des
     « Eurêka » qui multiplient toute la production de l'agence. Prendre la
     Pépite, c'est parier sur la variance ; prendre le Commun, c'est du solide.
     Sans ce compromis, le tirage n'est pas un choix mais une lecture de chiffre.
     ========================================================================== */
  const INTERN_DRAFT_SIZE = 3;
  const INTERN_STAGE_MS = 3 * 60 * 1000;
  /** Délai avant la promo suivante, une fois la décision de fin de stage prise. */
  const INTERN_COOLDOWN_MS = 30 * 1000;
  const INTERN_EUREKA_ROLL_MS = 20 * 1000;
  /** Plancher du coût d'embauche, pour que le tout début de partie reste jouable. */
  const INTERN_HIRE_COST_MIN = 250;
  /** Le coût d'embauche vaut ~4 min de production, multiplié par la rareté. */
  const INTERN_HIRE_COST_SECONDS = 240;
  /** Un stagiaire embauché laisse son bonus à l'agence : on garde la liste courte. */
  const INTERN_ROSTER_MAX = 12;

  const INTERN_RARITIES = {
    commun: {
      id: 'commun', label: 'Commun', weight: 58, symbol: '○',
      prodPercent: 20, hireBonusPercent: 2, costFactor: 1,
      eurekaChance: 0, eurekaMultiplier: 1, eurekaMs: 0,
      blurb: 'Régulier, sérieux, sans surprise.',
    },
    prometteur: {
      id: 'prometteur', label: 'Prometteur', weight: 30, symbol: '◆',
      prodPercent: 15, hireBonusPercent: 4, costFactor: 2,
      eurekaChance: 0.12, eurekaMultiplier: 3, eurekaMs: 12 * 1000,
      blurb: 'Produit bien, et trouve régulièrement quelque chose.',
    },
    pepite: {
      id: 'pepite', label: 'Pépite', weight: 12, symbol: '★',
      prodPercent: 5, hireBonusPercent: 9, costFactor: 4,
      eurekaChance: 0.18, eurekaMultiplier: 6, eurekaMs: 8 * 1000,
      blurb: 'Produit peu — mais quand ça part, ça part fort.',
    },
  };

  /*
   * Équilibrage des raretés, mesuré en simulant un stage de 3 minutes :
   * Commun x1,20 · Prometteur x1,30 · Pépite x1,39 de production moyenne.
   *
   * L'écart est volontairement resserré (16%, contre 78% dans un premier jet).
   * Une Pépite nettement supérieure en moyenne ferait du tirage une fausse
   * décision : on prendrait toujours la plus rare, sans lire les cartes. Ici la
   * Pépite gagne peu en moyenne mais varie énormément — 20% des stages sans
   * aucun Eurêka, 44% avec au moins deux — et coûte 4x plus cher à embaucher.
   *
   * Surtout, le TRAIT pèse autant que la rareté : un Prometteur stressé (x1,40)
   * vaut une Pépite ordinaire (x1,39). C'est ce qui oblige à comparer les trois
   * candidats au lieu de repérer le symbole.
   */

  /**
   * Chaque candidat porte un trait, et chaque trait a un effet réel. C'est ce
   * qui empêche le tirage de se résumer à « prends la meilleure rareté » : un
   * Commun consciencieux peut battre un Prometteur stressé.
   */
  const INTERN_TRAITS = [
    { id: 'consciencieux', name: 'Consciencieux', desc: '+30% de sa production', prodMult: 1.3 },
    { id: 'genie', name: 'Génie du dimanche', desc: '+60% de chance d\'Eurêka', eurekaChanceMult: 1.6 },
    { id: 'zen', name: 'Zen', desc: 'Stage 50% plus long', stageMult: 1.5 },
    { id: 'stresse', name: 'Stressé', desc: '-25% de production, Eurêka 2x plus fréquents', prodMult: 0.75, eurekaChanceMult: 2 },
    { id: 'perfectionniste', name: 'Perfectionniste', desc: 'Eurêka 50% plus longs', eurekaMsMult: 1.5 },
    { id: 'bricoleur', name: 'Bricoleur', desc: 'Embauche 40% moins chère', costMult: 0.6 },
    { id: 'reveur', name: 'Rêveur', desc: 'Bonus d\'embauche x1,5', hireBonusMult: 1.5 },
    { id: 'pragmatique', name: 'Pragmatique', desc: '+15% de production, embauche 20% moins chère', prodMult: 1.15, costMult: 0.8 },
  ];

  let state = {
    credits: 0,
    clickPower: 1,
    playerLevel: 1,
    playerXP: 0,
    pendingLevelUp: false,
    levelUpChoices: null,
    levelBonuses: {},
    lastSave: 0,
    nextEventAt: 0,
    activeEvent: null,
    eventEndsAt: 0,
    eventActionUsed: false,
    upgrades: UPGRADE_DEFS.map((u) => ({ id: u.id, quantity: 0 })),
    offices: OFFICE_DEFS.map((o) => ({ id: o.id, quantity: 0 })),
    branding: BRANDING_DEFS.map((b) => ({ id: b.id, quantity: 0 })),
    managers: MANAGER_DEFS.map((m) => ({ id: m.id, quantity: 0 })),
    intlOffices: INTERNATIONAL_OFFICES.map((o) => ({ id: o.id, quantity: 0 })),
    training: TRAINING_DEFS.map((t) => ({ id: t.id, quantity: 0 })),
    contrats: [],
    contratsClaimedCount: 0,
    rnd: RND_DEFS.map((r) => ({ id: r.id, purchased: false })),
    chapterBonuses: {},
    completedQuests: [],
    chapter: 1,
    completedChapters: [],
    /** Fonctionnalités ouvertes par les chapitres terminés. Survit au prestige. */
    unlockedFeatures: [],
    /** Crédits gagnés depuis le début de la partie, prestiges compris. */
    totalCreditsEarned: 0,
    /** Pic de crédits de la partie en cours, remis à zéro par le Rebranding. */
    runPeakCredits: 0,
    /** Nombre de Rebrandings effectués. Sert de but à deux chapitres. */
    prestigeCount: 0,
    /** Passe à vrai une fois le dernier chapitre terminé. */
    gameCompleted: false,
    /** Le stagiaire en stage, ou null. Voir le bloc « Les stagiaires ». */
    intern: null,
    /** Les 3 candidats d'une promo en attente de choix, ou null. */
    internDraft: null,
    /** Quand la prochaine promo devient disponible. */
    nextInternDraftAt: 0,
    /** Prochain tirage d'Eurêka pour le stagiaire en cours. */
    nextEurekaRollAt: 0,
    /** Fin de l'Eurêka en cours (0 si aucun). */
    eurekaUntil: 0,
    /** Bonus de production définitif laissé par les stagiaires embauchés, en %. */
    internHireBonusPercent: 0,
    /** Nombre de stagiaires embauchés. Sert de but au chapitre 4. */
    internsHired: 0,
    /** Les derniers embauchés, pour l'affichage. */
    hiredInterns: [],
    reputation: 0,
    unlockedEmployeeUpgrades: [],
    prestigeBonuses: {},
    /** Nombre d'achats par bonus de la boutique Réputation (ils sont répétables). */
    prestigeBonusLevels: {},
    agencyName: 'Mon Agence',
    themeColor: 'default',
    bestRunCredits: 0,
    agencyEventChoice: null,
    agencyEventEndsAt: 0,
    recruitmentContracts: [],
    employees: [],
    nextErrorRollAt: 0,
    errorModalEmployeeId: null,
    pendingErrors: [],
    activeErrorImpacts: [],
    currentErrorRecord: null,
    errorModalFromPending: false,
    lastContractRefreshAt: 0,
  };

  let lastTick = 0;
  var lastMentorPenaltyRender = 0;
  var lastUiRefresh = 0;
  var lastLogicRefresh = 0;
  var activeTab = 'accueil';
  /**
   * Coupe toute écriture pour la session. Posé quand la sauvegarde trouvée vient
   * d'une version postérieure du jeu : mieux vaut une session sans progression
   * enregistrée qu'une partie plus avancée détruite.
   */
  var saveBlocked = false;
  // Dernières valeurs réellement écrites dans le DOM. La boucle repeignait dix
  // fois par seconde des textes identiques ; on ne touche plus au DOM que quand
  // la valeur affichée change.
  var rendered = {};
  function resetRenderCache() { rendered = {}; }

  /**
   * Ce que le joueur a effectivement *vu* dans la scène de l'agence, par métier.
   * Volontairement hors de `rendered` : cette cache-là est vidée à chaque
   * changement d'onglet et par `renderAll()`, or c'est précisément en revenant
   * de la Boutique qu'il faut savoir ce qui est nouveau. `null` = jamais rendu,
   * auquel cas rien n'est animé — sinon toute la pièce rejouerait son entrée au
   * premier affichage.
   */
  var sceneSeenCounts = null;
  function isTabActive(name) { return activeTab === name; }

  function randomId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function randomInRange(range) {
    return range.min + Math.random() * (range.max - range.min);
  }

  function generateOneContract() {
    const types = ['stagiaire', 'junior', 'senior'];
    const type = pickRandom(types);
    const prodRange = EMPLOYEE_TYPE_PROD_RANGES[type];
    const errorRange = EMPLOYEE_TYPE_ERROR_RANGES[type];
    const prodPerSec = Math.round(randomInRange(prodRange) * 100) / 100;
    const errorChance = Math.round(randomInRange(errorRange) * 1000) / 1000;
    const name = pickRandom(FIRST_NAMES) + ' ' + pickRandom(LAST_NAMES);
    const trait = pickRandom(TRAITS);
    const baseCost = EMPLOYEE_TYPE_COST_BASE[type];
    const cost = Math.floor(baseCost * (0.8 + prodPerSec / (type === 'stagiaire' ? 0.4 : type === 'junior' ? 1 : 2)) * (1.5 - errorChance * 5));
    return { type, name, prodPerSec, errorChance, trait, cost };
  }

  function generateRecruitmentContracts() {
    if (!Array.isArray(state.recruitmentContracts)) state.recruitmentContracts = [];
    while (state.recruitmentContracts.length < RECRUITMENT_POOL_SIZE) {
      state.recruitmentContracts.push(generateOneContract());
    }
    state.lastContractRefreshAt = Date.now();
  }

  function createEmployeeFromContract(contract) {
    const mentorSlots = contract.type === 'senior' ? MENTOR_SLOTS_SENIOR : 0;
    return {
      id: randomId(),
      type: contract.type,
      name: contract.name,
      prodPerSec: contract.prodPerSec,
      errorChance: contract.errorChance,
      trait: contract.trait,
      level: 1,
      xp: 0,
      isActive: true,
      hasError: false,
      errorUntil: 0,
      mentorPenaltyUntil: 0,
      menteesIds: [],
      mentorId: null,
      mentorSlots,
      upgrades: [],
    };
  }

  function getMentorPenaltyRemainingSec(emp) {
    if (!emp || !emp.mentorPenaltyUntil) return 0;
    var r = Math.ceil((emp.mentorPenaltyUntil - Date.now()) / 1000);
    return r > 0 ? r : 0;
  }

  function getEmployee(id) {
    return state.employees.find((e) => e.id === id);
  }

  function getMaxRecruitedCandidates() {
    return getUpgradeState('devSenior')?.quantity || 0;
  }

  function canRecruitMore() {
    return (state.employees || []).length < getMaxRecruitedCandidates();
  }

  function signRecruitmentContract(index) {
    const contract = state.recruitmentContracts[index];
    if (!contract || !canAfford(contract.cost)) return;
    if (!canRecruitMore()) return;
    state.credits -= contract.cost;
    const employee = createEmployeeFromContract(contract);
    state.employees.push(employee);
    state.recruitmentContracts.splice(index, 1);
    generateRecruitmentContracts();
    addXP(contract.cost * XP_PER_CREDIT);
    renderRecruitmentContracts();
    renderEmployeesList();
    renderCredits();
  }

  function getRecruitmentRefreshCost() {
    var wealth = Math.max(state.bestRunCredits || 0, state.credits || 0);
    if (wealth <= 0) return RECRUITMENT_REFRESH_MIN_COST;
    var cost = Math.floor(wealth * RECRUITMENT_REFRESH_PERCENT);
    return Math.max(RECRUITMENT_REFRESH_MIN_COST, cost);
  }

  function refreshRecruitmentContracts() {
    const cost = getRecruitmentRefreshCost();
    if (!canAfford(cost)) return;
    state.credits -= cost;
    state.recruitmentContracts = [];
    generateRecruitmentContracts();
    addXP(cost * 0.002);
    renderRecruitmentContracts();
    renderCredits();
  }

  function employeeEffectiveProd(emp) {
    if (!emp || !emp.isActive) return 0;
    const now = Date.now();
    if (emp.hasError && now < (emp.errorUntil || 0)) return 0;
    if ((emp.mentorPenaltyUntil || 0) > now) return 0;
    if (emp.mentorId) {
      const mentor = getEmployee(emp.mentorId);
      if (mentor && mentor.hasError && now < (mentor.errorUntil || 0)) return 0;
    }
    var menteesIds = emp.menteesIds || [];
    if (menteesIds.length > 0) {
      for (var i = 0; i < menteesIds.length; i++) {
        var m = getEmployee(menteesIds[i]);
        if (m && m.hasError && now < (m.errorUntil || 0)) return 0;
      }
    }
    let prod = Number(emp.prodPerSec) || 0;
    var prodBonus = getEmployeeProdBonusPercent(emp);
    prod *= 1 + prodBonus / 100;
    if (emp.mentorId) prod *= 1 + MENTOR_PROD_BONUS;
    return prod;
  }

  function employeeProduction() {
    if (isFeatureLocked('equipe')) return 0;
    return (state.employees || []).reduce((sum, e) => sum + employeeEffectiveProd(e), 0);
  }

  function rollEmployeeErrors() {
    if (isFeatureLocked('equipe')) return;
    const now = Date.now();
    var errorEmps = [];
    (state.employees || []).forEach((emp) => {
      if (!emp.isActive || emp.hasError) return;
      if (Math.random() < getEmployeeEffectiveErrorChance(emp)) {
        emp.hasError = true;
        emp.errorUntil = now + ERROR_BLOCK_DURATION_MS;
        evolveErrorChance(emp, 'made_error');
        errorEmps.push(emp);
      }
    });
    if (errorEmps.length === 0) return;
    var first = errorEmps[0];
    var firstRecord = createErrorRecord(first);
    state.currentErrorRecord = firstRecord;
    state.errorModalEmployeeId = first.id;
    showErrorModal(first, firstRecord);
    for (var i = 1; i < errorEmps.length; i++) {
      var rec = createErrorRecord(errorEmps[i]);
      (state.pendingErrors = state.pendingErrors || []).push(rec);
    }
    renderPendingErrorsBadge();
    renderSettingsPendingErrors();
  }

  function getRandomErrorMessage() {
    return pickRandom(ERROR_MESSAGES);
  }

  function createErrorRecord(emp) {
    var impactDef = pickRandom(ERROR_IMPACT_TYPES);
    var id = 'err_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var message = getRandomErrorMessage();
    var now = Date.now();
    var record = {
      id: id,
      employeeId: emp.id,
      employeeName: emp.name,
      employeeType: emp.type,
      message: message,
      impactType: impactDef.id,
      impactName: impactDef.name,
      impactDescription: impactDef.desc,
      impactDetail: '',
      happenedAt: now,
    };
    if (impactDef.penaltyPercent && impactDef.durationMs) {
      var until = now + impactDef.durationMs;
      record.productionPenaltyPercent = impactDef.penaltyPercent;
      record.productionPenaltyUntil = until;
      record.impactDetail = '-' + impactDef.penaltyPercent + '% production pendant ' + Math.round(impactDef.durationMs / 1000) + ' s';
      (state.activeErrorImpacts = state.activeErrorImpacts || []).push({ percent: impactDef.penaltyPercent, until: until });
    }
    if (impactDef.creditPercent) {
      var wealth = Math.max(state.credits || 0, 100);
      var penalty = Math.max(10, Math.floor(wealth * (impactDef.creditPercent / 100)));
      state.credits = Math.max(0, (state.credits || 0) - penalty);
      record.creditPenalty = penalty;
      record.impactDetail = 'Perte de ' + formatNumber(penalty) + ' crédits';
    }
    return record;
  }

  function removeErrorFromPending(employeeId) {
    state.pendingErrors = (state.pendingErrors || []).filter(function (e) { return e.employeeId !== employeeId; });
  }

  function pardonnerEmployee(empId) {
    const emp = getEmployee(empId);
    if (!emp) return;
    emp.hasError = false;
    emp.errorUntil = 0;
    evolveErrorChance(emp, 'pardoned');
    if (emp.mentorId) {
      var mentor = getEmployee(emp.mentorId);
      if (mentor) {
        mentor.mentorPenaltyUntil = Date.now() + MENTOR_PENALTY_DURATION_MS;
        mentor.mentorPenaltyCausedBy = empId;
        evolveErrorChance(mentor, 'mentee_pardoned');
      }
    }
    state.errorModalEmployeeId = null;
    state.currentErrorRecord = null;
    state.errorModalFromPending = false;
    removeErrorFromPending(empId);
    hideErrorModal();
    renderEmployeesList();
    renderCredits();
    renderPendingErrorsBadge();
    renderSettingsPendingErrors();
  }

  function licencierEmployee(empId) {
    const emp = getEmployee(empId);
    if (!emp) return;
    (emp.menteesIds || []).forEach((mid) => {
      const m = getEmployee(mid);
      if (m) m.mentorId = null;
    });
    if (emp.mentorId) {
      const mentor = getEmployee(emp.mentorId);
      if (mentor) mentor.menteesIds = (mentor.menteesIds || []).filter((id) => id !== empId);
    }
    state.employees = state.employees.filter((e) => e.id !== empId);
    if (state.errorModalEmployeeId === empId) {
      state.errorModalEmployeeId = null;
      state.currentErrorRecord = null;
      state.errorModalFromPending = false;
      hideErrorModal();
    }
    removeErrorFromPending(empId);
    if (state.reputation > 0) state.reputation = Math.max(0, state.reputation - 1);
    renderEmployeesList();
    renderCredits();
    renderPendingErrorsBadge();
    renderSettingsPendingErrors();
  }

  function assignMentee(mentorId, menteeId) {
    if (mentorId === menteeId) return;
    const mentor = getEmployee(mentorId);
    const mentee = getEmployee(menteeId);
    if (!mentor || !mentee || mentor.type !== 'senior') return;
    if ((mentor.mentorSlots || 0) <= (mentor.menteesIds || []).length) return;
    if (mentee.type !== 'stagiaire' && mentee.type !== 'junior') return;
    if (mentee.mentorId) {
      const old = getEmployee(mentee.mentorId);
      if (old) old.menteesIds = old.menteesIds.filter((id) => id !== menteeId);
    }
    mentor.menteesIds = mentor.menteesIds || [];
    if (!mentor.menteesIds.includes(menteeId)) mentor.menteesIds.push(menteeId);
    mentee.mentorId = mentorId;
    renderEmployeesList();
  }

  function unassignMentee(menteeId) {
    const mentee = getEmployee(menteeId);
    if (!mentee || !mentee.mentorId) return;
    const mentor = getEmployee(mentee.mentorId);
    if (mentor) mentor.menteesIds = (mentor.menteesIds || []).filter((id) => id !== menteeId);
    mentee.mentorId = null;
    renderEmployeesList();
  }

  function assignEmployeeUpgrade(empId, upgradeId) {
    var emp = getEmployee(empId);
    var def = getEmployeeUpgradeDef(upgradeId);
    if (!emp || !def) return;
    if ((emp.upgrades || []).indexOf(upgradeId) >= 0) return;
    if (!isEmployeeUpgradeUnlocked(upgradeId)) return;
    (emp.upgrades = emp.upgrades || []).push(upgradeId);
    renderEmployeesList();
  }

  function sanitizeEmployeesMentorship() {
    (state.employees || []).forEach(function (emp) {
      if (emp.mentorId === emp.id) emp.mentorId = null;
      if (Array.isArray(emp.menteesIds)) emp.menteesIds = emp.menteesIds.filter(function (id) { return id !== emp.id; });
    });
  }

  function getXpToNextLevel() {
    return Math.floor(100 * state.playerLevel);
  }

  function addXP(amount) {
    try {
    let mult = 1 + ((state.levelBonuses && state.levelBonuses.xpPercent) || 0) / 100 + ((state.prestigeBonuses && state.prestigeBonuses.xpPercent) || 0) / 100;
    (state.managers || []).forEach((ms) => {
      const def = getManagerDef(ms.id);
      if (def && def.xpBonus && ms.quantity > 0) mult += def.xpBonus * ms.quantity;
    });
    const rndXp = (state.rnd || []).filter((r) => r.purchased).reduce((s, r) => {
      const d = getRndDef(r.id);
      return s + (d && d.effect.xpPercent ? d.effect.xpPercent / 100 : 0);
    }, 0);
    mult += rndXp;
    if (state.agencyEventChoice && state.agencyEventChoice.xp) mult *= state.agencyEventChoice.xp;
    state.playerXP += amount * mult;
    checkLevelUp();
    } catch (e) { console.warn('addXP error', e); }
  }

  function checkLevelUp() {
    const needed = getXpToNextLevel();
    if (state.playerXP < needed || state.pendingLevelUp) return;
    state.playerXP -= needed;
    state.playerLevel += 1;
    state.pendingLevelUp = true;
    // Tant que le rapport hors-ligne est ouvert, on garde le level-up en file :
    // hideOfflineModal l'ouvrira. pendingLevelUp reste vrai entre-temps.
    if (!isOfflineModalOpen()) showLevelUpModal();
    save();
  }

  function applyLevelBonus(bonusId) {
    const bonus = LEVEL_BONUSES.find((b) => b.id === bonusId);
    if (!bonus || !bonus.effect) return;
    Object.keys(bonus.effect).forEach((key) => {
      const val = bonus.effect[key];
      state.levelBonuses[key] = (state.levelBonuses[key] || 0) + val;
    });
    state.pendingLevelUp = false;
    state.levelUpChoices = null;
    hideLevelUpModal();
    save();
    renderAll();
  }

  function getUpgradeDef(id) {
    if (id === 'cto') {
      return { id: 'cto', name: 'CTO', desc: '20 crédits/s. Débloqué par le Campus.', basePrice: 50000, priceGrowth: 1.18, production: 20, type: 'producer' };
    }
    return UPGRADE_DEFS.find((u) => u.id === id);
  }

  function getUpgradeState(id) {
    return state.upgrades.find((u) => u.id === id);
  }

  function getOfficeDef(id) {
    return OFFICE_DEFS.find((o) => o.id === id);
  }

  function getOfficeState(id) {
    return state.offices.find((o) => o.id === id);
  }

  function getBrandingDef(id) {
    return BRANDING_DEFS.find((b) => b.id === id);
  }

  function getBrandingState(id) {
    return state.branding.find((b) => b.id === id);
  }

  function getOwnedOfficesCount() {
    return state.offices.filter((o) => o.quantity > 0).length;
  }

  function getManagerDef(id) { return MANAGER_DEFS.find((m) => m.id === id); }
  function getManagerState(id) { return state.managers.find((m) => m.id === id); }
  function getIntlOfficeDef(id) { return INTERNATIONAL_OFFICES.find((o) => o.id === id); }
  function getIntlOfficeState(id) { return state.intlOffices.find((o) => o.id === id); }
  function getTrainingDef(id) { return TRAINING_DEFS.find((t) => t.id === id); }
  function getTrainingState(id) { return state.training.find((t) => t.id === id); }
  function getRndDef(id) { return RND_DEFS.find((r) => r.id === id); }
  function getRndState(id) { return state.rnd.find((r) => r.id === id); }
  function isLevelUnlocked(levelReq) { return state.playerLevel >= levelReq; }

  function getPrice(def, quantity) {
    return Math.floor(def.basePrice * Math.pow(def.priceGrowth || 1.15, quantity));
  }

  function canAfford(price) {
    return state.credits >= price;
  }

  function getProductionPerSecond() {
    let total = employeeProduction();

    let multiplier = 1;
    const stagiaireQty = getUpgradeState('stagiaire')?.quantity || 0;
    const seniorQty = getUpgradeState('devSenior')?.quantity || 0;
    const mentorBonus = getTrainingState('programmeMentorat')?.quantity > 0 ? (getTrainingDef('programmeMentorat')?.mentorBonus || 0) * seniorQty : 0;
    const agileBonus = getTrainingState('formationAgile')?.quantity > 0 ? (getTrainingDef('formationAgile')?.devProdBonus || 0) : 0;

    UPGRADE_DEFS.forEach((def) => {
      const us = getUpgradeState(def.id);
      if (!us) return;
      if (def.type === 'producer') {
        let prod = (def.production || 0) * us.quantity;
        if (def.id === 'stagiaire' && mentorBonus > 0) prod *= 1 + mentorBonus;
        if ((def.id === 'dev' || def.id === 'devSenior') && agileBonus > 0) prod *= 1 + agileBonus;
        total += prod;
      }
      if (def.type === 'multiplier' && def.multiplier) multiplier += def.multiplier * us.quantity;
    });

    const ctoUs = getUpgradeState('cto');
    if (ctoUs) total += 20 * ctoUs.quantity;

    total *= multiplier;

    (state.offices || []).forEach((os) => {
      const def = getOfficeDef(os.id);
      if (def && def.prodBonus && os.quantity > 0) total *= 1 + def.prodBonus;
    });

    (state.managers || []).forEach((ms) => {
      const def = getManagerDef(ms.id);
      if (def && def.prodBonusPerUnit && ms.quantity > 0) total *= 1 + def.prodBonusPerUnit * ms.quantity;
      if (def && def.globalMultiplier && ms.quantity > 0) total *= 1 + def.globalMultiplier * ms.quantity;
    });

    (state.intlOffices || []).forEach((os) => {
      const def = getIntlOfficeDef(os.id);
      if (def && def.prodBonus && os.quantity > 0) total *= 1 + def.prodBonus;
    });

    const levelProd = ((state.levelBonuses && state.levelBonuses.prodPercent) || 0) + ((state.prestigeBonuses && state.prestigeBonuses.prodPercent) || 0);
    total *= 1 + levelProd / 100;

    Object.values(state.chapterBonuses || {}).forEach((b) => { if (b && b.prodPercent) total *= 1 + b.prodPercent / 100; });
    (state.rnd || []).filter((r) => r.purchased).forEach((r) => {
      const d = getRndDef(r.id);
      if (d && d.effect.prodPercent) total *= 1 + d.effect.prodPercent / 100;
    });

    if (state.activeEvent && state.activeEvent.productionMultiplier) total *= state.activeEvent.productionMultiplier;
    if (state.agencyEventChoice && state.agencyEventChoice.prod) total *= state.agencyEventChoice.prod;

    var nowErr = Date.now();
    var impactSum = (state.activeErrorImpacts || []).filter(function (a) { return a.until > nowErr; }).reduce(function (s, a) { return s + (a.percent || 0); }, 0);
    if (impactSum > 0) total *= Math.max(0, 1 - impactSum / 100);

    const cafe = getBrandingState('cafe');
    const cafeDef = getBrandingDef('cafe');
    if (cafe && cafe.quantity > 0 && cafeDef && cafeDef.activeBonus) total *= 1 + cafeDef.activeBonus;

    // Stagiaires : le bonus du stage en cours, celui laissé par les embauchés,
    // puis l'Eurêka. L'Eurêka vient en dernier et multiplie tout le reste —
    // c'est ce qui en fait un « gros progrès » et pas un bonus de plus.
    total *= 1 + getInternProdPercent() / 100;
    total *= 1 + (state.internHireBonusPercent || 0) / 100;
    total *= getEurekaMultiplier();

    return total * GLOBAL_PRODUCTION_SCALE;
  }

  function getClickPower() {
    let mult = 1;
    const levelClick = (state.levelBonuses.clickPercent || 0) + (state.prestigeBonuses.clickPercent || 0);
    mult *= 1 + levelClick / 100;

    (state.offices || []).forEach((os) => {
      const def = getOfficeDef(os.id);
      if (def && def.clickBonus && os.quantity > 0) mult += def.clickBonus;
    });
    (state.intlOffices || []).forEach((os) => {
      const def = getIntlOfficeDef(os.id);
      if (def && def.clickBonus && os.quantity > 0) mult += def.clickBonus;
    });

    if (state.activeEvent && state.activeEvent.clickMultiplier) mult *= state.activeEvent.clickMultiplier;
    if (state.agencyEventChoice && state.agencyEventChoice.credits) mult *= state.agencyEventChoice.credits;

    const logo = getBrandingState('logo');
    const logoDef = getBrandingDef('logo');
    if (logo && logo.quantity > 0 && logoDef && logoDef.revenueMultiplier) mult *= logoDef.revenueMultiplier;
    return Math.floor(state.clickPower * mult);
  }

  function isUnlocked(id) {
    if (id === 'cto') {
      const campus = getOfficeState('campusTech');
      return campus && campus.quantity > 0;
    }
    return true;
  }

  function ensureUpgrade(id) {
    if (!getUpgradeState(id)) state.upgrades.push({ id: id, quantity: 0 });
  }

  function buyUpgrade(id) {
    const def = getUpgradeDef(id);
    let us = getUpgradeState(id);
    if (!def) return;
    ensureUpgrade(id);
    us = getUpgradeState(id);
    const price = getPrice(def, us.quantity);
    if (!canAfford(price)) return;
    state.credits -= price;
    us.quantity += 1;
    addXP(price * XP_PER_CREDIT);
    renderUpgrades();
    if (id === 'devSenior') renderRecruitmentContracts();
    renderCredits();
  }

  function promote(fromId, toId) {
    const fromDef = getUpgradeDef(fromId);
    const toDef = getUpgradeDef(toId);
    const fromUs = getUpgradeState(fromId);
    const toUs = getUpgradeState(toId);
    if (!fromDef || !toDef || !fromUs || !toUs) return;
    const cost = fromDef.promoteCost || 10;
    if (fromUs.quantity < cost) return;
    fromUs.quantity -= cost;
    toUs.quantity += 1;
    addXP(cost * 5);
    renderUpgrades();
    renderCredits();
  }

  function buyManager(id) {
    const def = getManagerDef(id);
    const ms = getManagerState(id);
    if (!def || !ms || !isLevelUnlocked(def.levelReq)) return;
    if (def.maxQty && ms.quantity >= def.maxQty) return;
    const price = getPrice(def, ms.quantity);
    if (!canAfford(price)) return;
    state.credits -= price;
    ms.quantity += 1;
    addXP(price * XP_PER_CREDIT);
    renderManagers();
    renderCredits();
  }

  function buyIntlOffice(id) {
    const def = getIntlOfficeDef(id);
    const os = getIntlOfficeState(id);
    if (!def || !os || !isLevelUnlocked(def.levelReq)) return;
    if (def.maxQty && os.quantity >= def.maxQty) return;
    const price = getPrice(def, os.quantity);
    if (!canAfford(price)) return;
    state.credits -= price;
    os.quantity += 1;
    addXP(price * XP_PER_CREDIT);
    renderIntlOffices();
    renderCredits();
  }

  function buyTraining(id) {
    const def = getTrainingDef(id);
    const ts = getTrainingState(id);
    if (!def || !ts || (def.maxQty && ts.quantity >= def.maxQty)) return;
    const price = getPrice(def, ts.quantity);
    if (!canAfford(price)) return;
    state.credits -= price;
    ts.quantity += 1;
    addXP(price * XP_PER_CREDIT);
    renderTraining();
    renderCredits();
  }

  function startContrat(id) {
    const def = CONTRAT_DEFS.find((c) => c.id === id);
    if (!def || !isLevelUnlocked(def.levelReq) || !canAfford(def.invest)) return;
    if (state.contrats.some((c) => c.id === id && !c.done)) return;
    state.credits -= def.invest;
    state.contrats.push({ id: id, endsAt: Date.now() + def.duration * 1000, done: false });
    renderContrats();
    renderCredits();
  }

  function claimContrat(contrat) {
    const def = CONTRAT_DEFS.find((c) => c.id === contrat.id);
    if (!def || contrat.done || Date.now() < contrat.endsAt) return;
    state.credits += def.invest * def.rewardMult;
    contrat.done = true;
    state.contratsClaimedCount = (state.contratsClaimedCount || 0) + 1;
    addXP(def.invest * 0.01);
    renderContrats();
    renderCredits();
  }

  function buyRnd(id) {
    const def = getRndDef(id);
    const rs = getRndState(id);
    if (!def || !rs || !isLevelUnlocked(def.levelReq) || rs.purchased) return;
    if (!canAfford(def.cost)) return;
    state.credits -= def.cost;
    rs.purchased = true;
    addXP(def.cost * 0.005);
    renderRnd();
    renderCredits();
  }

  function buyOffice(id) {
    const def = getOfficeDef(id);
    const os = getOfficeState(id);
    if (!def || !os) return;
    if (def.maxQty && os.quantity >= def.maxQty) return;
    const price = getPrice(def, os.quantity);
    if (!canAfford(price)) return;
    state.credits -= price;
    os.quantity += 1;
    addXP(price * XP_PER_CREDIT);
    renderOffices();
    renderCredits();
  }

  function buyBranding(id) {
    const def = getBrandingDef(id);
    const bs = getBrandingState(id);
    if (!def || !bs) return;
    if (def.maxQty && bs.quantity >= def.maxQty) return;
    const price = getPrice(def, bs.quantity);
    if (!canAfford(price)) return;
    state.credits -= price;
    bs.quantity += 1;
    addXP(price * XP_PER_CREDIT);
    renderBranding();
    renderCredits();
  }

  function addCredits() {
    // Toujours basé sur le pouvoir de clic effectif (multiplicateurs inclus)
    const finalAmount = Math.max(1, Math.floor(getClickPower()) || 1);
    state.credits = (state.credits || 0) + finalAmount;
    state.totalCreditsEarned = (state.totalCreditsEarned || 0) + finalAmount;
    addXP(XP_PER_CLICK);
    maybeBigClient();
    renderCredits();
  }

  function maybeBigClient() {
    let chance = 0;
    const linkedin = getBrandingState('linkedin');
    const linkedinDef = getBrandingDef('linkedin');
    if (linkedin && linkedin.quantity > 0 && linkedinDef) chance += linkedinDef.bigClientChance || 0;
    state.intlOffices.forEach((os) => {
      const def = getIntlOfficeDef(os.id);
      if (def && def.bigClientBonus && os.quantity > 0) chance += def.bigClientBonus;
    });
    if (chance > 0 && Math.random() < chance) {
      const mult = linkedinDef?.bigClientMultiplier || 50;
      const bigGain = mult * getClickPower();
      state.credits += bigGain;
      state.totalCreditsEarned = (state.totalCreditsEarned || 0) + bigGain;
    }
  }

  function getChapterDef(id) { return CHAPTERS.find((c) => c.id === id); }

  function getCurrentChapter() { return getChapterDef(state.chapter); }

  /**
   * Où en est le joueur sur le but du chapitre en cours.
   * Renvoie de quoi remplir une barre ET l'écrire en chiffres : un but qu'on
   * ne peut pas mesurer à l'œil n'est pas un but, c'est une surprise.
   */
  function getChapterProgress(ch) {
    if (!ch || !ch.goal) return null;
    const goal = ch.goal;
    let current = 0;
    let unit = '';
    switch (goal.kind) {
      case 'credits': current = state.credits || 0; unit = ' crédits'; break;
      case 'runCredits': current = Math.max(state.credits || 0, state.runPeakCredits || 0); unit = ' crédits'; break;
      case 'totalCredits': current = state.totalCreditsEarned || 0; unit = ' crédits'; break;
      case 'prodPerSec': current = getProductionPerSecond(); unit = '/s'; break;
      case 'level': current = state.playerLevel || 1; break;
      case 'upgradeQty': current = (getUpgradeState(goal.upgradeId)?.quantity || 0); break;
      case 'prestiges': current = state.prestigeCount || 0; break;
      case 'internsHired': current = state.internsHired || 0; break;
      default: return null;
    }
    const target = goal.target;
    const capped = Math.min(current, target);
    return {
      current: capped,
      target: target,
      unit: unit,
      ratio: target > 0 ? Math.min(1, current / target) : 1,
      done: current >= target,
      text: formatNumber(capped) + ' / ' + formatNumber(target) + unit,
    };
  }

  /** Une fonctionnalité est ouverte quand le chapitre qui la porte est terminé. */
  function isFeatureUnlocked(feature) {
    if (CHAPTER_FEATURES.indexOf(feature) < 0) return true;
    return (state.unlockedFeatures || []).indexOf(feature) >= 0;
  }

  function applyChapterReward(ch) {
    if (!ch) return;
    if (ch.reward && ch.reward.prodPercent) state.chapterBonuses['ch' + ch.id] = { prodPercent: ch.reward.prodPercent };
    if (ch.reward && ch.reward.clickPower) state.clickPower = (state.clickPower || 1) + ch.reward.clickPower;
    state.unlockedFeatures = state.unlockedFeatures || [];
    (ch.unlocks || []).forEach(function (f) {
      if (state.unlockedFeatures.indexOf(f) < 0) state.unlockedFeatures.push(f);
    });
  }

  /**
   * Termine le chapitre courant et passe au suivant.
   * `silent` sert au rattrapage au chargement : une sauvegarde qui remplit
   * déjà trois buts d'affilée ne doit pas empiler trois modales au démarrage.
   */
  function completeCurrentChapter(silent) {
    const ch = getCurrentChapter();
    if (!ch) return false;
    state.completedChapters = state.completedChapters || [];
    if (state.completedChapters.indexOf(ch.id) < 0) state.completedChapters.push(ch.id);
    applyChapterReward(ch);
    const next = getChapterDef(ch.id + 1);
    if (next) state.chapter = next.id;
    else state.gameCompleted = true;
    document.body.setAttribute('data-chapter', state.chapter);
    if (!silent) {
      if (ch.isFinal || !next) showGameCompleteModal(ch);
      else showChapterCompleteModal(ch);
    }
    return true;
  }

  function checkChapterObjective() {
    if (state.gameCompleted) return;
    const ch = getCurrentChapter();
    if (!ch) return;
    const p = getChapterProgress(ch);
    if (!p || !p.done) return;
    completeCurrentChapter(false);
    applyChapterUnlocks();
    renderChapter();
    renderChapterGoal();
    renderActiveTab();
  }

  /**
   * Au chargement, avance sans bruit sur tous les chapitres dont le but est
   * déjà rempli. C'est ce qui rattrape une sauvegarde d'avant la refonte : le
   * joueur retrouve le chapitre qui correspond vraiment à sa partie, avec les
   * récompenses et les déblocages appliqués, sans cascade de modales.
   */
  function catchUpChapters() {
    let done = 0;
    for (let guard = 0; guard < CHAPTERS.length + 1; guard++) {
      if (state.gameCompleted) break;
      const ch = getCurrentChapter();
      if (!ch) break;
      const p = getChapterProgress(ch);
      if (!p || !p.done) break;
      completeCurrentChapter(true);
      done++;
    }
    return done;
  }

  function completeChapterAndContinue() {
    hideChapterCompleteModal();
    applyChapterUnlocks();
    renderAll();
  }

  /* ==========================================================================
     Les stagiaires — logique
     ========================================================================== */

  function getInternRarity(id) { return INTERN_RARITIES[id] || INTERN_RARITIES.commun; }
  function getInternTrait(id) { return INTERN_TRAITS.find((t) => t.id === id) || null; }

  function pickInternRarityId() {
    const ids = Object.keys(INTERN_RARITIES);
    const total = ids.reduce((sum, id) => sum + INTERN_RARITIES[id].weight, 0);
    let roll = Math.random() * total;
    for (const id of ids) {
      roll -= INTERN_RARITIES[id].weight;
      if (roll <= 0) return id;
    }
    return ids[0];
  }

  /**
   * Fabrique un candidat complet. Les effets du trait sont appliqués ICI et le
   * résultat est figé sur l'objet : ce que le joueur lit sur la carte est
   * exactement ce qu'il obtiendra, et la sauvegarde n'a pas à rejouer le calcul.
   */
  /**
   * Les traits qui portent sur l'Eurêka n'ont aucun sens sur un profil qui n'en
   * déclenchera jamais : « +60% de chance d'Eurêka » sur un Commun, c'est 60%
   * de zéro. Pire, « Stressé » deviendrait un malus pur (-25% de production
   * contre une contrepartie morte). On les retire du tirage pour ces profils.
   */
  function internTraitPool(rarity) {
    if (rarity.eurekaChance > 0) return INTERN_TRAITS;
    return INTERN_TRAITS.filter((t) => !t.eurekaChanceMult && !t.eurekaMsMult);
  }

  function generateInternCandidate() {
    const rarityId = pickInternRarityId();
    const rarity = getInternRarity(rarityId);
    const trait = pickRandom(internTraitPool(rarity));
    const prodPercent = Math.round(rarity.prodPercent * (trait.prodMult || 1) * 10) / 10;
    const hireBonusPercent = Math.round(rarity.hireBonusPercent * (trait.hireBonusMult || 1) * 10) / 10;
    return {
      id: randomId(),
      name: pickRandom(FIRST_NAMES) + ' ' + pickRandom(LAST_NAMES),
      rarity: rarityId,
      traitId: trait.id,
      prodPercent: prodPercent,
      hireBonusPercent: hireBonusPercent,
      eurekaChance: rarity.eurekaChance * (trait.eurekaChanceMult || 1),
      eurekaMultiplier: rarity.eurekaMultiplier,
      eurekaMs: Math.round(rarity.eurekaMs * (trait.eurekaMsMult || 1)),
      stageMs: Math.round(INTERN_STAGE_MS * (trait.stageMult || 1)),
      costFactor: rarity.costFactor * (trait.costMult || 1),
    };
  }

  /**
   * Le coût d'embauche est calculé au moment du choix, puis figé pour tout le
   * stage. Le recalculer en continu le ferait exploser pendant un Eurêka (la
   * production est multipliée par 6) et le joueur ne pourrait rien anticiper.
   */
  function computeInternHireCost(candidate) {
    const perSec = getProductionPerSecond();
    const cost = Math.floor(perSec * INTERN_HIRE_COST_SECONDS * candidate.costFactor);
    return Math.max(INTERN_HIRE_COST_MIN, cost);
  }

  function openInternDraft() {
    if (!isFeatureUnlocked('stagiaires')) return;
    if (state.intern || state.internDraft) return;
    const candidates = [];
    for (let i = 0; i < INTERN_DRAFT_SIZE; i++) candidates.push(generateInternCandidate());
    state.internDraft = { candidates: candidates, createdAt: Date.now() };
    save();
  }

  /** Le joueur garde un candidat : les deux autres sont perdus, c'est le sel du choix. */
  function chooseInternCandidate(candidateId) {
    if (!state.internDraft) return;
    const candidate = (state.internDraft.candidates || []).find((c) => c.id === candidateId);
    if (!candidate) return;
    const now = Date.now();
    state.intern = Object.assign({}, candidate, {
      startedAt: now,
      endsAt: now + candidate.stageMs,
      hireCost: computeInternHireCost(candidate),
      eurekaCount: 0,
      decided: false,
    });
    state.internDraft = null;
    state.nextEurekaRollAt = now + INTERN_EUREKA_ROLL_MS;
    state.eurekaUntil = 0;
    closeInternDraftModal();
    save();
    renderIntern();
    renderAll();
  }

  function isInternStageOver() {
    return !!state.intern && Date.now() >= state.intern.endsAt;
  }

  function isEurekaActive() {
    return !!state.intern && (state.eurekaUntil || 0) > Date.now();
  }

  /** Bonus de production du stagiaire en stage. Nul une fois le stage terminé. */
  function getInternProdPercent() {
    if (!state.intern || isInternStageOver()) return 0;
    return state.intern.prodPercent || 0;
  }

  function getEurekaMultiplier() {
    return isEurekaActive() ? (state.intern.eurekaMultiplier || 1) : 1;
  }

  /**
   * Tire un Eurêka. C'est le « gros progrès » ponctuel : toute la production de
   * l'agence est multipliée pendant quelques dizaines de secondes. On ne tire
   * pas pendant un Eurêka en cours, sinon les Pépites les enchaîneraient.
   */
  function rollEureka() {
    if (!state.intern || isInternStageOver()) return;
    const now = Date.now();
    if (now < (state.nextEurekaRollAt || 0)) return;
    state.nextEurekaRollAt = now + INTERN_EUREKA_ROLL_MS;
    if (isEurekaActive()) return;
    if (!(state.intern.eurekaChance > 0)) return;
    if (Math.random() >= state.intern.eurekaChance) return;
    state.eurekaUntil = now + (state.intern.eurekaMs || 20000);
    state.intern.eurekaCount = (state.intern.eurekaCount || 0) + 1;
    showEurekaBurst();
  }

  function hireIntern() {
    if (!state.intern || !isInternStageOver()) return;
    const cost = state.intern.hireCost || INTERN_HIRE_COST_MIN;
    if (!canAfford(cost)) return;
    state.credits -= cost;
    state.internHireBonusPercent = Math.round(((state.internHireBonusPercent || 0) + (state.intern.hireBonusPercent || 0)) * 10) / 10;
    state.internsHired = (state.internsHired || 0) + 1;
    state.hiredInterns = state.hiredInterns || [];
    state.hiredInterns.unshift({
      name: state.intern.name,
      rarity: state.intern.rarity,
      bonusPercent: state.intern.hireBonusPercent,
    });
    if (state.hiredInterns.length > INTERN_ROSTER_MAX) state.hiredInterns.length = INTERN_ROSTER_MAX;
    const nom = state.intern.name;
    const bonus = state.intern.hireBonusPercent;
    endInternStage();
    showToast(nom + ' rejoint l\'agence. +' + bonus + '% de production, définitivement.', 4000);
  }

  function releaseIntern() {
    if (!state.intern || !isInternStageOver()) return;
    const nom = state.intern.name;
    endInternStage();
    showToast(nom + ' part chez la concurrence.', 3000);
  }

  function endInternStage() {
    state.intern = null;
    state.eurekaUntil = 0;
    state.nextEurekaRollAt = 0;
    state.nextInternDraftAt = Date.now() + INTERN_COOLDOWN_MS;
    hideInternEndModal();
    save();
    renderIntern();
    renderAll();
  }

  /**
   * Appelée par la boucle. Fait avancer le stage, tire les Eurêka, et fait
   * arriver la promo suivante. Rien n'expire jamais tout seul : une promo en
   * attente et une fin de stage non tranchée patientent aussi longtemps qu'il
   * faut — le joueur ne doit pas être puni d'avoir fermé l'application.
   */
  function tickInterns() {
    if (!isFeatureUnlocked('stagiaires')) return;
    const now = Date.now();
    if (state.intern) {
      rollEureka();
      if (isInternStageOver() && !state.intern.endAnnounced) {
        state.intern.endAnnounced = true;
        save();
        renderIntern();
        showInternEndModal();
      }
      return;
    }
    if (state.internDraft) return;
    if (!state.nextInternDraftAt) state.nextInternDraftAt = now;
    if (now >= state.nextInternDraftAt) {
      openInternDraft();
      renderIntern();
      showToast('Une promo de ' + INTERN_DRAFT_SIZE + ' stagiaires t\'attend.', 3500);
    }
  }

  /**
   * Cache ce que les chapitres n'ont pas encore ouvert, et le fait réapparaître
   * dès que le chapitre tombe.
   *
   * Les boutons d'onglet ne peuvent pas être masqués par `hidden` seul : la
   * règle `.tapstorm-nav .tab-btn { display: flex }` de style.css la bat en
   * spécificité. Une règle explicite `[hidden]` a été ajoutée à côté d'elle,
   * c'est elle qui fait le travail ici — voir game.css.
   */
  function applyChapterUnlocks() {
    document.querySelectorAll('[data-chapter-feature]').forEach(function (el) {
      el.hidden = !isFeatureUnlocked(el.getAttribute('data-chapter-feature'));
    });
    var navGates = { boutique: 'boutique', plus: 'prestige' };
    Object.keys(navGates).forEach(function (tab) {
      var btn = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
      if (!btn) return;
      var open = isFeatureUnlocked(navGates[tab]);
      btn.hidden = !open;
      // Rester sur un onglet qu'on vient de fermer laisserait un écran vide.
      if (!open && activeTab === tab) showTabByName('accueil');
    });
    centerClickButton();
  }

  function processContrats() {
    state.contrats = state.contrats.filter((c) => !c.done);
  }

  function chooseAgencyEventOption(ev, option) {
    state.agencyEventChoice = option;
    state.agencyEventEndsAt = Date.now() + (option.duration || 60) * 1000;
    hideAgencyEventModal();
  }

  function maybeAgencyEvent(elapsedMs) {
    if (state.agencyEventChoice && state.agencyEventEndsAt > Date.now()) return;
    if (state.playerLevel < 15) return;
    // Tirage exprimé pour 100 ms (la cadence historique), afin que la fréquence
    // des événements ne change pas quand la boucle appelle moins souvent.
    const chance = 0.002 * (Math.max(0, Number(elapsedMs) || 0) / 100);
    if (Math.random() > chance) return;
    const ev = AGENCY_EVENTS[Math.floor(Math.random() * AGENCY_EVENTS.length)];
    showAgencyEventModal(ev);
  }

  function startEvent(eventId) {
    const ev = EVENTS[eventId];
    if (!ev || state.activeEvent) return;
    state.activeEvent = ev;
    state.eventEndsAt = Date.now() + ev.duration;
    state.eventActionUsed = false;
    const banner = document.getElementById('event-banner');
    const textEl = document.getElementById('event-text');
    const timerEl = document.getElementById('event-timer');
    const actionBtn = document.getElementById('event-action-btn');
    if (banner && textEl) {
      banner.hidden = false;
      banner.setAttribute('data-type', ev.type);
      textEl.textContent = ev.name + (ev.hasAction ? ' — Clique Hotfix pour limiter les dégâts !' : ' !');
      if (timerEl) timerEl.textContent = formatDuration(ev.duration / 1000);
      if (actionBtn) {
        actionBtn.hidden = !ev.hasAction;
      }
    }
  }

  function onEventAction() {
    if (!state.activeEvent || !state.activeEvent.hasAction || state.eventActionUsed) return;
    state.eventActionUsed = true;
    state.activeEvent.productionMultiplier = 0.5 + (state.activeEvent.actionRecovery || 0.5);
    const actionBtn = document.getElementById('event-action-btn');
    if (actionBtn) actionBtn.hidden = true;
  }

  function endEvent() {
    state.activeEvent = null;
    const banner = document.getElementById('event-banner');
    const actionBtn = document.getElementById('event-action-btn');
    if (banner) banner.hidden = true;
    if (actionBtn) actionBtn.hidden = true;
  }

  function scheduleNextEvent() {
    const range = EVENT_MAX_INTERVAL_MS - EVENT_MIN_INTERVAL_MS;
    const delay = EVENT_MIN_INTERVAL_MS + Math.random() * range;
    state.nextEventAt = Date.now() + delay;
  }

  function getEventBonusChance() {
    return (state.levelBonuses.eventBonusChance || 0) / 100;
  }

  function maybeTriggerEvent() {
    if (!isFeatureUnlocked('events')) return;
    if (state.activeEvent) return;
    if (Date.now() < state.nextEventAt) return;
    const bonusChance = getEventBonusChance();
    const roll = Math.random();
    let eventId;
    if (roll < bonusChance) {
      eventId = Math.random() < 0.5 ? 'hackathon' : 'clientVIP';
    } else if (roll < bonusChance + 0.5) {
      eventId = Math.random() < 0.5 ? 'clientToxique' : 'bugCritique';
    } else {
      const keys = Object.keys(EVENTS);
      eventId = keys[Math.floor(Math.random() * keys.length)];
    }
    startEvent(eventId);
    scheduleNextEvent();
  }

  function checkQuests() {
    let completed = false;
    QUESTS.forEach((q) => {
      if (state.completedQuests.includes(q.id)) return;
      if (q.target()) {
        state.completedQuests.push(q.id);
        completed = true;
        if (q.reward && q.reward.xp) addXP(q.reward.xp);
      }
    });
    // La liste n'est plus reconstruite à chaque tick : il faut la redessiner au
    // moment où elle change, sinon l'onglet ouvert reste sur l'ancien affichage.
    if (completed && isTabActive('accueil')) renderQuests();
  }

  function doPrestige() {
    if (!canPrestige() || !isFeatureUnlocked('prestige')) return;
    const repGain = Math.floor(Math.sqrt(state.credits / PRESTIGE_THRESHOLD));
    state.reputation += repGain;
    const headstart = ((state.prestigeBonuses && state.prestigeBonuses.headstartPercent) || 0) / 100;
    state.credits = Math.floor(state.credits * headstart);
    state.upgrades.forEach((u) => (u.quantity = 0));
    state.offices.forEach((o) => (o.quantity = 0));
    state.branding.forEach((b) => (b.quantity = 0));
    state.managers.forEach((m) => (m.quantity = 0));
    state.intlOffices.forEach((o) => (o.quantity = 0));
    state.training.forEach((t) => (t.quantity = 0));
    state.contrats = [];
    state.contratsClaimedCount = 0;
    state.rnd.forEach((r) => (r.purchased = false));
    state.playerLevel = 1;
    state.playerXP = 0;
    state.levelBonuses = {};
    state.completedQuests = [];
    state.prestigeCount = (state.prestigeCount || 0) + 1;
    // Les chapitres ne sont PAS remis à zéro : c'est la progression permanente
    // du joueur, et deux chapitres ont justement le Rebranding pour but. Les
    // remettre à 1 rendait tout l'escalier interminable.
    state.runPeakCredits = 0;
    document.body.setAttribute('data-chapter', state.chapter);
    state.activeEvent = null;
    state.agencyEventChoice = null;
    state.employees = [];
    state.recruitmentContracts = [];
    state.errorModalEmployeeId = null;
    state.nextErrorRollAt = 0;
    generateRecruitmentContracts();
    endEvent();
    scheduleNextEvent();
    // Le prestige remet playerLevel à 1 : sans push immédiat, chooseBestProgress
    // ferait gagner le serveur (niveau supérieur) et annulerait le prestige entier.
    save();
    renderAll();
  }

  function canPrestige() {
    return state.credits >= PRESTIGE_THRESHOLD;
  }

  function formatNumber(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return Math.floor(n).toLocaleString('fr-FR');
  }

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + ' h ' + m + ' min';
    return (m > 0 ? m + ' min ' : '') + s + ' s';
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function save() {
    if (saveBlocked) return;
    try {
      const savedAt = Date.now();
      const payload = {
        credits: state.credits,
        clickPower: state.clickPower,
        playerLevel: state.playerLevel,
        playerXP: state.playerXP,
        pendingLevelUp: state.pendingLevelUp,
        levelUpChoices: state.levelUpChoices,
        levelBonuses: state.levelBonuses,
        upgrades: state.upgrades,
        offices: state.offices,
        branding: state.branding,
        managers: state.managers,
        intlOffices: state.intlOffices,
        training: state.training,
        contrats: state.contrats,
        contratsClaimedCount: state.contratsClaimedCount,
        rnd: state.rnd,
        chapterBonuses: state.chapterBonuses,
        completedQuests: state.completedQuests,
        chapter: state.chapter,
        completedChapters: state.completedChapters,
        unlockedFeatures: state.unlockedFeatures,
        totalCreditsEarned: state.totalCreditsEarned,
        runPeakCredits: state.runPeakCredits,
        prestigeCount: state.prestigeCount,
        gameCompleted: state.gameCompleted,
        prestigeBonusLevels: state.prestigeBonusLevels,
        intern: state.intern,
        internDraft: state.internDraft,
        nextInternDraftAt: state.nextInternDraftAt,
        nextEurekaRollAt: state.nextEurekaRollAt,
        eurekaUntil: state.eurekaUntil,
        internHireBonusPercent: state.internHireBonusPercent,
        internsHired: state.internsHired,
        hiredInterns: state.hiredInterns,
        reputation: state.reputation,
        unlockedEmployeeUpgrades: state.unlockedEmployeeUpgrades,
        prestigeBonuses: state.prestigeBonuses,
        agencyName: state.agencyName,
        bestRunCredits: state.bestRunCredits,
        agencyEventChoice: state.agencyEventChoice,
        agencyEventEndsAt: state.agencyEventEndsAt,
        nextEventAt: state.nextEventAt,
        activeEvent: state.activeEvent ? state.activeEvent.id : null,
        eventEndsAt: state.eventEndsAt,
        recruitmentContracts: state.recruitmentContracts,
        employees: state.employees,
        nextErrorRollAt: state.nextErrorRollAt,
        lastContractRefreshAt: state.lastContractRefreshAt,
        pendingErrors: state.pendingErrors,
        activeErrorImpacts: state.activeErrorImpacts,
        themeColor: state.themeColor,
        lastSave: savedAt,
        save_version: SAVE_VERSION,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      state.lastSave = savedAt;
    } catch (e) {
      console.warn('Save failed', e);
    }
  }

  // Détachable : la réinitialisation de la partie doit pouvoir empêcher cette
  // dernière sauvegarde, sinon elle réécrit la partie qu'on vient d'effacer.
  function saveOnUnload() { save(); }

  /** Met la sauvegarde brute de côté avant une opération qui pourrait la perdre. */
  function backupRawSave(raw, reason) {
    try {
      localStorage.setItem(SAVE_BACKUP_KEY, JSON.stringify({ raw: raw, reason: reason, at: Date.now() }));
    } catch (e) {
      console.warn('Save backup failed', e);
    }
  }

  /**
   * Lit la sauvegarde et la remonte jusqu'à SAVE_VERSION.
   *
   * @returns {{status: string, data: object|null, from: number|null}}
   *   status vaut :
   *   - 'ok'            : données exploitables dans `data` ;
   *   - 'vide'          : aucune partie enregistrée ;
   *   - 'illisible'     : JSON cassé ou forme inattendue, copie mise de côté ;
   *   - 'echec'         : une étape de migration a levé, copie mise de côté ;
   *   - 'trop-recente'  : écrite par une version postérieure du jeu.
   */
  function readAndMigrateSave() {
    var raw = null;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (e) {
      // localStorage inaccessible (mode privé, quota, WebView verrouillée).
      console.warn('Save read failed', e);
      return { status: 'illisible', data: null, from: null };
    }
    if (!raw) return { status: 'vide', data: null, from: null };

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      backupRawSave(raw, 'illisible');
      return { status: 'illisible', data: null, from: null };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      backupRawSave(raw, 'illisible');
      return { status: 'illisible', data: null, from: null };
    }

    // Une sauvegarde sans numéro de version est antérieure à l'introduction du
    // champ : c'est la version 1 par convention.
    var version = (typeof data.save_version === 'number' && data.save_version >= 1)
      ? Math.floor(data.save_version)
      : 1;
    var from = version;

    // Sauvegarde écrite par une version postérieure du jeu — typiquement une
    // réinstallation d'un APK plus ancien. On ne sait pas la lire, et surtout on
    // ne doit pas l'écraser : elle reste intacte sur le disque et l'écriture est
    // coupée le temps de la session.
    if (version > SAVE_VERSION) {
      return { status: 'trop-recente', data: null, from: from };
    }

    if (version < SAVE_VERSION) {
      backupRawSave(raw, 'migration-v' + from);
      try {
        while (version < SAVE_VERSION) {
          var step = SAVE_MIGRATIONS[version];
          if (typeof step !== 'function') {
            throw new Error('Migration manquante de la version ' + version + ' vers ' + (version + 1));
          }
          data = step(data) || data;
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('La migration depuis la version ' + version + ' n\'a pas renvoyé d\'objet');
          }
          version += 1;
        }
      } catch (e) {
        console.warn('Migration failed', e);
        return { status: 'echec', data: null, from: from };
      }
      data.save_version = SAVE_VERSION;
    }

    return { status: 'ok', data: data, from: from };
  }

  /**
   * Charge la partie. Renvoie le statut de lecture pour qu'`init()` décide quoi
   * montrer au joueur : une sauvegarde illisible ne doit pas passer pour une
   * absence de sauvegarde.
   */
  function load() {
    var read = readAndMigrateSave();
    if (read.status !== 'ok') {
      // Une sauvegarde qu'on ne sait pas lire ne doit pas être écrasée par
      // l'autosave cinq secondes plus tard.
      if (read.status === 'trop-recente') saveBlocked = true;
      return read.status;
    }
    try {
      const data = read.data;
      if (typeof data.credits === 'number') state.credits = data.credits;
      if (typeof data.clickPower === 'number') state.clickPower = data.clickPower;
      if (typeof data.playerLevel === 'number') state.playerLevel = data.playerLevel;
      if (typeof data.playerXP === 'number') state.playerXP = data.playerXP;
      if (typeof data.pendingLevelUp === 'boolean') state.pendingLevelUp = data.pendingLevelUp;
      if (Array.isArray(data.levelUpChoices)) state.levelUpChoices = data.levelUpChoices;
      if (data.levelBonuses) state.levelBonuses = data.levelBonuses;
      if (data.prestigeBonuses) state.prestigeBonuses = data.prestigeBonuses;
      if (Array.isArray(data.upgrades)) {
        data.upgrades.forEach((s) => {
          let us = getUpgradeState(s.id);
          if (!us && (s.id === 'cto' || s.id === 'dev' || UPGRADE_DEFS.some((u) => u.id === s.id))) {
            state.upgrades.push({ id: s.id, quantity: s.quantity || 0 });
            us = getUpgradeState(s.id);
          }
          if (us && typeof s.quantity === 'number') us.quantity = s.quantity;
        });
      }
      if (getOfficeState('campusTech')?.quantity > 0 && !getUpgradeState('cto')) state.upgrades.push({ id: 'cto', quantity: 0 });
      if (!getUpgradeState('dev')) state.upgrades.push({ id: 'dev', quantity: 0 });
      if (Array.isArray(data.offices)) {
        data.offices.forEach((s) => {
          const os = getOfficeState(s.id);
          if (os && typeof s.quantity === 'number') os.quantity = s.quantity;
        });
      }
      if (Array.isArray(data.branding)) {
        data.branding.forEach((s) => {
          const bs = getBrandingState(s.id);
          if (bs && typeof s.quantity === 'number') bs.quantity = s.quantity;
        });
      }
      if (Array.isArray(data.completedQuests)) state.completedQuests = data.completedQuests;
      if (typeof data.chapter === 'number') state.chapter = data.chapter;
      if (Array.isArray(data.completedChapters)) state.completedChapters = data.completedChapters;
      if (Array.isArray(data.unlockedFeatures)) state.unlockedFeatures = data.unlockedFeatures;
      if (typeof data.totalCreditsEarned === 'number') state.totalCreditsEarned = data.totalCreditsEarned;
      if (typeof data.runPeakCredits === 'number') state.runPeakCredits = data.runPeakCredits;
      if (typeof data.prestigeCount === 'number') state.prestigeCount = data.prestigeCount;
      if (typeof data.gameCompleted === 'boolean') state.gameCompleted = data.gameCompleted;
      if (data.prestigeBonusLevels) state.prestigeBonusLevels = data.prestigeBonusLevels;
      if (data.intern && typeof data.intern === 'object') state.intern = data.intern;
      if (data.internDraft && Array.isArray(data.internDraft.candidates)) state.internDraft = data.internDraft;
      if (typeof data.nextInternDraftAt === 'number') state.nextInternDraftAt = data.nextInternDraftAt;
      if (typeof data.nextEurekaRollAt === 'number') state.nextEurekaRollAt = data.nextEurekaRollAt;
      if (typeof data.eurekaUntil === 'number') state.eurekaUntil = data.eurekaUntil;
      if (typeof data.internHireBonusPercent === 'number') state.internHireBonusPercent = data.internHireBonusPercent;
      if (typeof data.internsHired === 'number') state.internsHired = data.internsHired;
      if (Array.isArray(data.hiredInterns)) state.hiredInterns = data.hiredInterns;
      // Un Eurêka ne court pas pendant l'absence : il durerait des heures.
      if ((state.eurekaUntil || 0) > Date.now()) state.eurekaUntil = 0;
      if (data.chapterBonuses) state.chapterBonuses = data.chapterBonuses;
      if (typeof data.reputation === 'number') state.reputation = data.reputation;
      if (Array.isArray(data.unlockedEmployeeUpgrades)) state.unlockedEmployeeUpgrades = data.unlockedEmployeeUpgrades;
      else state.unlockedEmployeeUpgrades = state.unlockedEmployeeUpgrades || [];
      if (Array.isArray(data.managers)) data.managers.forEach((s) => { const ms = getManagerState(s.id); if (ms && typeof s.quantity === 'number') ms.quantity = s.quantity; });
      if (Array.isArray(data.intlOffices)) data.intlOffices.forEach((s) => { const os = getIntlOfficeState(s.id); if (os && typeof s.quantity === 'number') os.quantity = s.quantity; });
      if (Array.isArray(data.training)) data.training.forEach((s) => { const ts = getTrainingState(s.id); if (ts && typeof s.quantity === 'number') ts.quantity = s.quantity; });
      if (Array.isArray(data.contrats)) state.contrats = data.contrats;
      if (typeof data.contratsClaimedCount === 'number') state.contratsClaimedCount = data.contratsClaimedCount;
      if (Array.isArray(data.rnd)) data.rnd.forEach((s) => { const rs = getRndState(s.id); if (rs && typeof s.purchased === 'boolean') rs.purchased = s.purchased; });
      if (typeof data.bestRunCredits === 'number') state.bestRunCredits = data.bestRunCredits;
      if (typeof data.nextEventAt === 'number') state.nextEventAt = data.nextEventAt;
      if (data.activeEvent && EVENTS[data.activeEvent]) {
        state.activeEvent = EVENTS[data.activeEvent];
        state.eventEndsAt = data.eventEndsAt || Date.now() + state.activeEvent.duration;
      }
      if (Array.isArray(data.recruitmentContracts)) state.recruitmentContracts = data.recruitmentContracts;
      else state.recruitmentContracts = state.recruitmentContracts || [];
      if (Array.isArray(data.employees)) state.employees = data.employees;
      else state.employees = state.employees || [];
      (state.employees || []).forEach((emp) => {
        if (emp.mentorId === emp.id) emp.mentorId = null;
        if (Array.isArray(emp.menteesIds)) emp.menteesIds = emp.menteesIds.filter((id) => id !== emp.id);
      });
      if (typeof data.nextErrorRollAt === 'number') state.nextErrorRollAt = data.nextErrorRollAt;
      else state.nextErrorRollAt = Date.now() + ERROR_ROLL_INTERVAL_MS;
      if (typeof data.lastContractRefreshAt === 'number') state.lastContractRefreshAt = data.lastContractRefreshAt;
      if (Array.isArray(data.pendingErrors)) state.pendingErrors = data.pendingErrors;
      else state.pendingErrors = state.pendingErrors || [];
      if (Array.isArray(data.activeErrorImpacts)) state.activeErrorImpacts = data.activeErrorImpacts.filter(function (a) { return a.until > Date.now(); });
      else state.activeErrorImpacts = state.activeErrorImpacts || [];
      // Même normalisation qu'à la saisie (écran de départ et réglages) : trim + 40 car.
      if (typeof data.agencyName === 'string' && data.agencyName.trim()) {
        state.agencyName = data.agencyName.trim().slice(0, 40);
      }
      if (data.themeColor) state.themeColor = data.themeColor;
      // Borné à maintenant : un lastSave venu d'un appareil à l'horloge en avance
      // rendrait (Date.now() - lastSave) négatif et gèlerait l'autosave de la boucle.
      if (typeof data.lastSave === 'number') state.lastSave = Math.min(data.lastSave, Date.now());
    } catch (e) {
      console.warn('Load failed', e);
      return 'echec';
    }
    return 'ok';
  }

  var levelUpSelectedId = null;

  function showLevelUpModal() {
    const modal = document.getElementById('levelup-modal');
    const levelEl = document.getElementById('levelup-level');
    const choicesEl = document.getElementById('levelup-choices');
    const validateBtn = document.getElementById('levelup-validate-btn');
    if (!modal || !levelEl || !choicesEl) return;
    levelUpSelectedId = null;
    if (validateBtn) validateBtn.disabled = true;
    levelEl.textContent = state.playerLevel;
    let pool = (state.levelUpChoices || [])
      .map((id) => LEVEL_BONUSES.find((b) => b.id === id))
      .filter(Boolean);
    if (pool.length < 3) {
      pool = [...LEVEL_BONUSES].sort(() => Math.random() - 0.5).slice(0, 3);
      state.levelUpChoices = pool.map((b) => b.id);
    }
    choicesEl.innerHTML = '';
    pool.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'levelup-choice';
      btn.setAttribute('data-bonus-id', b.id);
      btn.innerHTML = '<span class="choice-name">' + escapeHtml(b.name) + '</span><span class="choice-desc">' + escapeHtml(b.desc) + '</span>';
      btn.addEventListener('click', function () {
        levelUpSelectedId = b.id;
        choicesEl.querySelectorAll('.levelup-choice').forEach((x) => x.classList.remove('selected'));
        btn.classList.add('selected');
        if (validateBtn) {
          validateBtn.disabled = false;
        }
      });
      choicesEl.appendChild(btn);
    });
    modal.hidden = false;
  }

  function hideLevelUpModal() {
    const modal = document.getElementById('levelup-modal');
    if (modal) modal.hidden = true;
  }

  /**
   * Fin de chapitre. On annonce trois choses, dans cet ordre : ce qui vient
   * d'être accompli, ce que ça rapporte, et surtout ce qu'il faut viser
   * maintenant — le joueur ne doit jamais refermer cette modale sans savoir
   * quel est son prochain but.
   * @param {object} ch chapitre qui vient d'être terminé
   */
  function showChapterCompleteModal(ch) {
    const modal = document.getElementById('chapter-complete-modal');
    if (!modal || !ch) return;
    setText('chapter-complete-title', 'Chapitre ' + ch.id + ' terminé');
    setText('chapter-complete-name', ch.name);
    setText('chapter-complete-bonus', ch.rewardLabel ? 'Récompense : ' + ch.rewardLabel : '');
    const unlockEl = document.getElementById('chapter-complete-unlock');
    if (unlockEl) {
      unlockEl.textContent = ch.unlockLabel ? 'Débloqué : ' + ch.unlockLabel : '';
      unlockEl.hidden = !ch.unlockLabel;
    }
    const next = getChapterDef(ch.id + 1);
    const nextEl = document.getElementById('chapter-complete-next');
    if (nextEl) {
      nextEl.textContent = next ? 'Chapitre ' + next.id + ' · ' + next.name + ' — ' + next.goal.label : '';
      nextEl.hidden = !next;
    }
    modal.hidden = false;
  }

  /** Écran de fin : le dernier chapitre est terminé, la partie a une conclusion. */
  function showGameCompleteModal(ch) {
    const modal = document.getElementById('game-complete-modal');
    if (!modal) {
      // Pas de modale de fin dans le DOM : on ne perd pas l'information pour autant.
      showToast('Tu as terminé DevIdle Agency. Bravo.', 6000);
      return;
    }
    const name = (state.agencyName && state.agencyName.trim()) ? state.agencyName.trim() : 'Ton agence';
    setText('game-complete-agency', name);
    setText('game-complete-stats',
      formatNumber(state.totalCreditsEarned || 0) + ' crédits gagnés · niveau ' +
      (state.playerLevel || 1) + ' · ' + (state.prestigeCount || 0) + ' Rebranding' +
      ((state.prestigeCount || 0) > 1 ? 's' : ''));
    modal.hidden = false;
  }

  function hideGameCompleteModal() {
    const modal = document.getElementById('game-complete-modal');
    if (modal) modal.hidden = true;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function hideChapterCompleteModal() {
    const modal = document.getElementById('chapter-complete-modal');
    if (modal) modal.hidden = true;
  }

  function showAgencyEventModal(ev) {
    const modal = document.getElementById('agency-event-modal');
    if (!modal || !ev) return;
    document.getElementById('agency-event-title').textContent = ev.name;
    const container = document.getElementById('agency-event-options');
    container.innerHTML = '';
    ev.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'levelup-choice';
      let desc = opt.name;
      if (opt.prod) desc += ' — Prod x' + opt.prod + ' pendant ' + (opt.duration || 60) + 's';
      if (opt.xp) desc += ' — XP x' + opt.xp + ' pendant ' + (opt.duration || 60) + 's';
      if (opt.credits) desc += ' — Crédits x' + opt.credits + ', prod x' + opt.prod + ' pendant ' + (opt.duration || 60) + 's';
      btn.textContent = desc;
      btn.addEventListener('click', () => chooseAgencyEventOption(ev, opt));
      container.appendChild(btn);
    });
    modal.hidden = false;
  }

  function hideAgencyEventModal() {
    const modal = document.getElementById('agency-event-modal');
    if (modal) modal.hidden = true;
  }

  function showErrorModal(emp, errorRecord) {
    const modal = document.getElementById('error-modal');
    if (!modal || !emp) return;
    var rec = errorRecord || state.currentErrorRecord;
    var msg = rec && rec.message ? rec.message : getRandomErrorMessage();
    var impactDetail = rec && rec.impactDetail ? rec.impactDetail : '';
    document.getElementById('error-modal-message').textContent = msg;
    document.getElementById('error-modal-name').textContent = emp.name + ' (' + (EMPLOYEE_TYPE_LABELS[emp.type] || emp.type) + ')';
    var impactEl = document.getElementById('error-modal-impact');
    if (impactEl) {
      impactEl.textContent = impactDetail ? 'Impact : ' + impactDetail : '';
      impactEl.hidden = !impactDetail;
    }
    var iconEl = document.getElementById('error-modal-icon');
    if (iconEl) {
      iconEl.src = (typeof window.getIconUrl === 'function') ? window.getIconUrl('error', 48) : FALLBACK_ICON;
      iconEl.dataset.fallback = (typeof window.getFallbackIconPath === 'function') ? window.getFallbackIconPath() : FALLBACK_ICON;
    }
    modal.setAttribute('data-employee-id', emp.id);
    state.currentErrorRecord = rec || null;
    modal.hidden = false;
  }

  function hideErrorModal() {
    const modal = document.getElementById('error-modal');
    if (modal) modal.hidden = true;
  }

  function renderPendingErrorsBadge() {
    var count = isFeatureLocked('equipe') ? 0 : (state.pendingErrors || []).length;
    var btn = document.getElementById('header-errors-btn');
    var badge = document.getElementById('header-errors-badge');
    var tabBadge = document.getElementById('tab-equipe-errors-badge');
    if (btn) btn.hidden = count === 0;
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
    }
    if (tabBadge) {
      tabBadge.hidden = count === 0;
      tabBadge.textContent = count > 99 ? '99+' : String(count);
    }
  }

  function openErrorModalForPending(record) {
    var emp = getEmployee(record.employeeId);
    if (!emp) return;
    state.errorModalFromPending = true;
    state.currentErrorRecord = record;
    state.errorModalEmployeeId = emp.id;
    showErrorModal(emp, record);
  }

  function renderSettingsPendingErrors() {
    if (isFeatureLocked('equipe')) return;
    var list = document.getElementById('settings-pending-errors-list');
    var emptyEl = document.getElementById('settings-pending-errors-empty');
    var block = document.getElementById('settings-pending-errors-block');
    if (!list) return;
    list.innerHTML = '';
    var pending = state.pendingErrors || [];
    if (block) block.hidden = pending.length === 0;
    if (emptyEl) emptyEl.hidden = pending.length > 0;
    pending.forEach(function (rec) {
      var emp = getEmployee(rec.employeeId);
      var div = document.createElement('div');
      div.className = 'settings-pending-error-item';
      var name = rec.employeeName + ' (' + (EMPLOYEE_TYPE_LABELS[rec.employeeType] || rec.employeeType) + ')';
      var detail = rec.impactDetail ? ' — ' + rec.impactDetail : '';
      div.innerHTML =
        '<div class="settings-pending-error-head">' +
        '<span class="settings-pending-error-name">' + escapeHtml(name) + '</span>' +
        '<span class="settings-pending-error-impact">' + escapeHtml(rec.impactDetail || '') + '</span>' +
        '</div>' +
        '<div class="settings-pending-error-actions">' +
        (emp ? '<button type="button" class="tapstorm-btn tapstorm-btn-secondary btn-traiter-error" data-record-id="' + escapeHtml(rec.id) + '">Traiter</button>' : '') +
        '<button type="button" class="tapstorm-btn tapstorm-btn-secondary btn-detail-error" data-record-id="' + escapeHtml(rec.id) + '">Détails</button>' +
        '</div>';
      list.appendChild(div);
      if (emp) {
        div.querySelector('.btn-traiter-error')?.addEventListener('click', function () {
          openErrorModalForPending(rec);
        });
      }
      div.querySelector('.btn-detail-error')?.addEventListener('click', function () {
        openErrorDetailModal(rec);
      });
    });
  }

  function openErrorDetailModal(record) {
    var modal = document.getElementById('error-detail-modal');
    if (!modal) return;
    document.getElementById('error-detail-message').textContent = record.message || '';
    document.getElementById('error-detail-name').textContent = record.employeeName + ' (' + (EMPLOYEE_TYPE_LABELS[record.employeeType] || record.employeeType) + ')';
    document.getElementById('error-detail-impact').textContent = record.impactDetail || record.impactName || '—';
    var emp = getEmployee(record.employeeId);
    var treatBtn = document.getElementById('error-detail-traiter');
    if (treatBtn) {
      treatBtn.hidden = !emp;
      if (emp) treatBtn.onclick = function () { closeErrorDetailModal(); openErrorModalForPending(record); };
    }
    modal.hidden = false;
  }

  function closeErrorDetailModal() {
    var modal = document.getElementById('error-detail-modal');
    if (modal) modal.hidden = true;
  }

  function renderRecruitmentContracts() {
    if (isFeatureLocked('candidats')) return;
    const container = document.getElementById('recruitment-contracts-list');
    const capEl = document.getElementById('recruitment-cap');
    if (!container) return;
    const maxCand = getMaxRecruitedCandidates();
    const currentCand = (state.employees || []).length;
    const atCap = !canRecruitMore();
    if (capEl) {
      if (maxCand === 0) {
        capEl.textContent = 'Achète au moins un Dev senior (onglet Employés) pour pouvoir recruter des candidats.';
        capEl.className = 'recruitment-cap recruitment-cap-none';
      } else {
        capEl.textContent = 'Places candidats : ' + currentCand + ' / ' + maxCand + ' (1 Dev senior = 1 candidat). Leur prod/s est ajoutée au total.';
        capEl.className = 'recruitment-cap' + (atCap ? ' recruitment-cap-full' : '');
      }
    }
    container.innerHTML = '';
    container.classList.add('candidates-list');
    (state.recruitmentContracts || []).forEach((c, i) => {
      const canSign = canAfford(c.cost) && canRecruitMore();
      const row = document.createElement('div');
      row.className = 'candidate-row';
      row.setAttribute('data-index', i);
      row.innerHTML =
        '<div class="candidate-row-head" role="button" tabindex="0" aria-expanded="false">' +
        getIconImg(EMPLOYEE_TYPE_ICONS[c.type] || 'user', 28) +
        '<span class="candidate-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="candidate-type-badge">' + (EMPLOYEE_TYPE_LABELS[c.type] || c.type) + '</span>' +
        '<span class="candidate-prod">' + c.prodPerSec + ' créd/s</span>' +
        '<span class="candidate-err">' + (c.errorChance * 100).toFixed(1) + '% err</span>' +
        '<span class="candidate-cost' + (canSign ? '' : ' too-expensive') + '">' + formatNumber(c.cost) + '</span>' +
        '<button type="button" class="candidate-sign">Recruter</button>' +
        '<span class="candidate-toggle" aria-hidden="true">▼</span>' +
        '</div>' +
        '<div class="candidate-row-details">' +
        '<span class="candidate-trait">Trait : ' + escapeHtml(c.trait || '—') + '</span>' +
        '<button type="button" class="candidate-sign-detail">Recruter · ' + formatNumber(c.cost) + ' crédits</button>' +
        '</div>';
      container.appendChild(row);
      var idx = i;
      var head = row.querySelector('.candidate-row-head');
      head.addEventListener('click', function (e) {
        if (e.target.closest('.candidate-sign, .candidate-sign-detail')) return;
        row.classList.toggle('expanded');
        head.setAttribute('aria-expanded', row.classList.contains('expanded'));
      });
      head.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.classList.toggle('expanded'); head.setAttribute('aria-expanded', row.classList.contains('expanded')); }
      });
      row.querySelector('.candidate-sign')?.addEventListener('click', function (e) { e.stopPropagation(); signRecruitmentContract(idx); });
      row.querySelector('.candidate-sign-detail')?.addEventListener('click', function (e) { e.stopPropagation(); signRecruitmentContract(idx); });
      var signBtn = row.querySelector('.candidate-sign');
      if (signBtn) signBtn.disabled = !canSign;
      var costEl = row.querySelector('.candidate-cost');
      if (costEl) costEl.classList.toggle('too-expensive', !canSign);
    });
    updateRecruitmentRefreshButton();
  }

  function updateRecruitmentRefreshButton() {
    if (isFeatureLocked('candidats')) return;
    const btn = document.getElementById('recruitment-refresh-btn');
    if (!btn) return;
    const cost = getRecruitmentRefreshCost();
    const affordable = canAfford(cost);
    const label = 'Nouveaux candidats (' + formatNumber(cost) + ' crédits)';
    if (label === rendered.refreshLabel && affordable === rendered.refreshAffordable) return;
    rendered.refreshLabel = label;
    rendered.refreshAffordable = affordable;
    var textEl = document.getElementById('recruitment-refresh-text');
    if (textEl) textEl.textContent = label;
    else btn.textContent = label;
    btn.disabled = !affordable;
    btn.classList.toggle('too-expensive', !affordable);
  }

  function openSkillTreeModal() {
    renderSkillTree();
    var modal = document.getElementById('skill-tree-modal');
    if (modal) modal.hidden = false;
  }
  function closeSkillTreeModal() {
    var modal = document.getElementById('skill-tree-modal');
    if (modal) modal.hidden = true;
  }
  function renderSkillTree() {
    if (isFeatureLocked('equipe')) return;
    var container = document.getElementById('skill-tree-list');
    if (!container) return;
    container.innerHTML = '';
    EMPLOYEE_UPGRADES.forEach(function (u) {
      var unlocked = isEmployeeUpgradeUnlocked(u.id);
      var canUnlock = canUnlockEmployeeUpgrade(u.id);
      var reqLabel = u.requires ? (getEmployeeUpgradeDef(u.requires) ? 'Requiert: ' + getEmployeeUpgradeDef(u.requires).name : '') : '';
      var card = document.createElement('div');
      card.className = 'skill-tree-card tapstorm-card' + (unlocked ? ' skill-tree-card-unlocked' : '');
      card.innerHTML =
        '<div class="skill-tree-card-head">' +
        '<span class="skill-tree-name">' + escapeHtml(u.name) + '</span>' +
        (unlocked ? '<span class="skill-tree-badge">Débloqué</span>' : '<span class="skill-tree-cost">' + u.reputationCost + ' réputation</span>') +
        '</div>' +
        '<p class="skill-tree-desc">' + escapeHtml(u.desc) + '</p>' +
        (reqLabel ? '<p class="skill-tree-requires">' + escapeHtml(reqLabel) + '</p>' : '') +
        (unlocked ? '' : '<button type="button" class="tapstorm-btn tapstorm-btn-secondary btn-unlock-skill' + (canUnlock ? '' : ' too-expensive') + '" data-upgrade-id="' + escapeHtml(u.id) + '"' + (canUnlock ? '' : ' disabled') + '>Débloquer</button>');
      container.appendChild(card);
      if (!unlocked) {
        card.querySelector('.btn-unlock-skill')?.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = this.getAttribute('data-upgrade-id');
          if (id) unlockEmployeeUpgrade(id);
        });
      }
    });
  }

  function renderEmployeesList() {
    if (isFeatureLocked('equipe')) return;
    var containerSeniors = document.getElementById('employees-list-seniors');
    var containerTeam = document.getElementById('employees-list-team');
    if (!containerSeniors || !containerTeam) return;
    var expandedIds = [];
    containerSeniors.querySelectorAll('.employee-row.expanded').forEach(function (r) { var id = r.getAttribute('data-employee-id'); if (id) expandedIds.push(id); });
    containerTeam.querySelectorAll('.employee-row.expanded').forEach(function (r) { var id = r.getAttribute('data-employee-id'); if (id) expandedIds.push(id); });
    containerSeniors.innerHTML = '';
    containerTeam.innerHTML = '';
    var mentorsWithSlots = (state.employees || []).filter(function (m) { return m.type === 'senior' && (m.mentorSlots || 0) > (m.menteesIds || []).length; });
    var employees = state.employees || [];
    var seniors = employees.filter(function (e) { return e.type === 'senior'; });
    var team = employees.filter(function (e) { return e.type === 'junior' || e.type === 'stagiaire'; });
    function appendEmployeeRow(container, emp) {
      var now = Date.now();
      var mentorPenaltySec = getMentorPenaltyRemainingSec(emp);
      var hasMentorPenalty = mentorPenaltySec > 0;
      var row = document.createElement('div');
      row.setAttribute('data-employee-id', emp.id);
      row.className = 'employee-row' + (emp.hasError ? ' has-error' : '') + (hasMentorPenalty ? ' has-mentor-penalty' : '');
      var mentor = emp.mentorId ? getEmployee(emp.mentorId) : null;
      var mentorLabel = mentor ? mentor.name : '—';
      var assignHtml = '';
      if (emp.type === 'stagiaire' || emp.type === 'junior') {
        if (mentorsWithSlots.length > 0 && !emp.mentorId) {
          var availableMentors = mentorsWithSlots.filter(function (m) { return m.id !== emp.id; });
          assignHtml = availableMentors.length > 0 ? '<select class="assign-mentor-select" data-mentee-id="' + emp.id + '"><option value="">Assigner à un senior...</option>' +
            availableMentors.map(function (m) { return '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>'; }).join('') + '</select>' : '';
        } else if (emp.mentorId) {
          assignHtml = '<button type="button" class="btn-unassign" data-id="' + emp.id + '">Retirer du mentor</button>';
        }
      }
      var statusHtml = emp.hasError ? '<span class="employee-status error">Erreur</span>' : hasMentorPenalty ? '<span class="employee-status mentor-penalty">Pénalité ' + mentorPenaltySec + ' s</span>' : '<span class="employee-status ok">OK</span>';
      var causedByEmp = (emp.mentorPenaltyCausedBy && hasMentorPenalty) ? getEmployee(emp.mentorPenaltyCausedBy) : null;
      var causedByName = causedByEmp ? causedByEmp.name + ' (' + (EMPLOYEE_TYPE_LABELS[causedByEmp.type] || causedByEmp.type) + ')' : '';
      var effectiveErr = (getEmployeeEffectiveErrorChance(emp) * 100).toFixed(1);
      var prodBonusPct = getEmployeeProdBonusPercent(emp);
      var upgradesHave = (emp.upgrades || []).map(function (uid) { var d = getEmployeeUpgradeDef(uid); return d ? d.name : null; }).filter(Boolean);
      var upgradesBlock = '<div class="employee-detail-line"><span class="employee-detail-label">Err (effective):</span> ' + effectiveErr + '%' + (prodBonusPct !== 0 ? ' · Prod: ' + (prodBonusPct > 0 ? '+' : '') + prodBonusPct + '%' : '') + '</div>' +
        (upgradesHave.length > 0 ? '<div class="employee-detail-line employee-detail-upgrades"><span class="employee-detail-label">Améliorations:</span> ' + upgradesHave.map(function (n) { return escapeHtml(n); }).join(', ') + '</div>' : '');
      var availableUpgrades = EMPLOYEE_UPGRADES.filter(function (u) {
        return (emp.upgrades || []).indexOf(u.id) < 0 && isEmployeeUpgradeUnlocked(u.id);
      });
      var buyUpgradesHtml = availableUpgrades.length > 0 ? '<div class="employee-detail-line employee-detail-buy-upgrades"><span class="employee-detail-label">Attribuer une compétence:</span><div class="employee-upgrade-buttons">' +
        availableUpgrades.map(function (u) {
          return '<button type="button" class="tapstorm-btn tapstorm-btn-secondary btn-employee-upgrade" data-emp-id="' + escapeHtml(emp.id) + '" data-upgrade-id="' + escapeHtml(u.id) + '" title="' + escapeHtml(u.desc) + '">' + escapeHtml(u.name) + ' — Attribuer</button>';
        }).join('') + '</div></div>' : '';
      var mentorPenaltyDetail = hasMentorPenalty ? '<div class="employee-detail-line employee-detail-mentor-penalty"><span class="employee-detail-label">Pénalité:</span> ' + (causedByName ? escapeHtml(causedByName) + ' a fait une erreur pardonnée — ' : 'Un mentoré a été pardonné — ') + mentorPenaltySec + ' s restantes</div>' : '';
      var menteesList = (emp.menteesIds || []).map(function (mid) {
        var m = getEmployee(mid);
        if (!m) return null;
        var label = escapeHtml(m.name) + ' (' + (EMPLOYEE_TYPE_LABELS[m.type] || m.type) + ')';
        if (hasMentorPenalty && mid === emp.mentorPenaltyCausedBy) label += ' <span class="mentee-caused-penalty">← a fait l\'erreur pardonnée</span>';
        return label;
      }).filter(Boolean);
      var menteesBlock = menteesList.length > 0 ? '<div class="employee-detail-line employee-detail-mentees"><span class="employee-detail-label">Mentorés:</span> <ul class="mentees-list">' + menteesList.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul></div>' : '';
      row.innerHTML =
        '<div class="employee-row-head" role="button" tabindex="0" aria-expanded="false">' +
        '<span class="employee-name">' + escapeHtml(emp.name) + '</span>' +
        '<span class="employee-type-badge">' + (EMPLOYEE_TYPE_LABELS[emp.type] || emp.type) + '</span>' +
        '<span class="employee-prod">' + emp.prodPerSec + ' créd/s</span>' +
        statusHtml +
        '<span class="employee-toggle" aria-hidden="true">▼</span>' +
        '</div>' +
        '<div class="employee-row-details">' +
        '<div class="employee-detail-line"><span class="employee-detail-label">Trait:</span> ' + escapeHtml(emp.trait || '—') + ' · base err ' + (emp.errorChance * 100).toFixed(1) + '%</div>' +
        upgradesBlock +
        buyUpgradesHtml +
        (emp.menteesIds && emp.menteesIds.length > 0 ? '<div class="employee-detail-line"><span class="employee-detail-label">Équipe:</span> ' + emp.menteesIds.length + '/' + (emp.mentorSlots || 0) + '</div>' : '') +
        menteesBlock +
        mentorPenaltyDetail +
        '<div class="employee-detail-line"><span class="employee-detail-label">Mentor:</span> ' + escapeHtml(mentorLabel) + '</div>' +
        (assignHtml ? '<div class="employee-detail-actions">' + assignHtml + '</div>' : '') +
        '<div class="employee-detail-actions"><button type="button" class="btn-licencier" data-id="' + emp.id + '">Licencier</button></div>' +
        '</div>';
      container.appendChild(row);
      var head = row.querySelector('.employee-row-head');
      if (expandedIds.indexOf(emp.id) >= 0) {
        row.classList.add('expanded');
        head.setAttribute('aria-expanded', 'true');
      }
      var toggleExpand = function (e) {
        if (e.target.closest('.btn-licencier, .btn-unassign, .assign-mentor-select, .btn-employee-upgrade')) return;
        row.classList.toggle('expanded');
        head.setAttribute('aria-expanded', row.classList.contains('expanded'));
      };
      head.addEventListener('click', toggleExpand);
      head.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(e); } });
      row.querySelector('.btn-licencier')?.addEventListener('click', function (e) { e.stopPropagation(); licencierEmployee(this.getAttribute('data-id')); });
      row.querySelector('.btn-unassign')?.addEventListener('click', function (e) { e.stopPropagation(); unassignMentee(this.getAttribute('data-id')); });
      row.querySelector('.assign-mentor-select')?.addEventListener('change', function (e) {
        e.stopPropagation();
        var mentorId = this.value;
        var menteeId = this.getAttribute('data-mentee-id');
        if (mentorId && menteeId) assignMentee(mentorId, menteeId);
      });
      row.querySelectorAll('.btn-employee-upgrade').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var empId = this.getAttribute('data-emp-id');
          var upgradeId = this.getAttribute('data-upgrade-id');
          if (empId && upgradeId) assignEmployeeUpgrade(empId, upgradeId);
        });
      });
    }
    seniors.forEach(function (emp) { appendEmployeeRow(containerSeniors, emp); });
    team.forEach(function (emp) { appendEmployeeRow(containerTeam, emp); });
  }

  /**
   * `prodHint` évite de recalculer getProductionPerSecond() : la boucle de jeu
   * l'a déjà fait pour créditer la production du tick.
   */
  function renderCredits(prodHint) {
    try {
      const el = document.getElementById('credits');
      const incomeEl = document.getElementById('income');
      if (!el && !incomeEl) return;
      const credits = (typeof state.credits === 'number' && !isNaN(state.credits)) ? state.credits : 0;
      let prod = (typeof prodHint === 'number' && !isNaN(prodHint)) ? prodHint : null;
      if (prod === null) {
        prod = 0;
        try {
          prod = getProductionPerSecond();
        } catch (e) {
          console.warn('getProductionPerSecond error', e);
        }
      }
      if (el) {
        const txt = formatNumber(credits);
        if (txt !== rendered.credits) {
          rendered.credits = txt;
          el.textContent = txt;
        }
      }
      if (incomeEl) {
        const txt = formatNumber((typeof prod === 'number' && !isNaN(prod) ? prod : 0) * 3600);
        if (txt !== rendered.income) {
          rendered.income = txt;
          incomeEl.textContent = txt;
        }
      }
      if (isTabActive('candidats')) updateRecruitmentRefreshButton();
    } catch (err) {
      console.error('renderCredits error', err);
    }
  }

  function renderLevel() {
    const levelEl = document.getElementById('level');
    const xpFill = document.getElementById('xp-fill');
    if (levelEl && state.playerLevel !== rendered.level) {
      rendered.level = state.playerLevel;
      levelEl.textContent = state.playerLevel;
    }
    if (xpFill) {
      const raw = (state.playerXP / getXpToNextLevel()) * 100;
      // Arrondi au dixième de pourcent : en dessous, la barre ne bouge pas d'un
      // pixel et l'écriture ne sert qu'à invalider le style.
      const pct = isFinite(raw) ? Math.min(100, Math.round(raw * 10) / 10) : 0;
      if (pct !== rendered.xpPct) {
        rendered.xpPct = pct;
        xpFill.style.width = pct + '%';
      }
    }
  }

  function renderReputation() {
    const stat = document.getElementById('reputation-stat');
    if (!stat) return;
    if (state.reputation > 0) {
      stat.hidden = false;
      stat.textContent = formatNumber(state.reputation);
    } else {
      stat.hidden = true;
      stat.textContent = '0';
    }
  }

  function renderClickValue() {
    const el = document.getElementById('click-value');
    if (el) el.textContent = '+' + formatNumber(getClickPower());
  }

  function renderEventTimer() {
    if (!state.activeEvent || !state.eventEndsAt) return;
    const left = Math.max(0, (state.eventEndsAt - Date.now()) / 1000);
    const timerEl = document.getElementById('event-timer');
    if (timerEl) {
      const txt = 'Fin dans ' + formatDuration(left);
      if (txt !== rendered.eventTimer) {
        rendered.eventTimer = txt;
        timerEl.textContent = txt;
      }
    }
    if (left <= 0) endEvent();
  }

  function renderChapter() {
    const ch = getCurrentChapter();
    const el = document.getElementById('chapter-badge');
    if (el) el.textContent = state.gameCompleted ? 'Partie terminée' : 'Chapitre ' + state.chapter + '/' + CHAPTERS.length;
    document.body.setAttribute('data-chapter', state.chapter);
    if (ch) document.body.setAttribute('data-chapter-name', ch.name);
  }

  /* ==========================================================================
     La scène de l'agence — le retour visuel des achats

     Le joueur voyait ses achats comme des lignes de texte dans une liste. La
     scène montre l'agence : un poste de plus par embauche, un décor qui change
     quand on achète un bureau. C'est le seul endroit du jeu où un achat produit
     autre chose qu'un chiffre qui monte.

     Tout est dessiné en SVG plutôt qu'en images : aucun fichier à charger, net
     sur toutes les densités d'écran, et les couleurs restent celles du thème.

     La hauteur suit le contenu — une agence à un stagiaire tient en une rangée.
     Sans ça, l'écran d'accueil serait occupé dès le départ par une pièce vide.
     ========================================================================== */

  /** Postes dessinés au maximum par métier ; au-delà, une pastille « ×N ». */
  const SCENE_MAX_SLOTS = 8;
  const SCENE_W = 400;
  const SCENE_WALL_H = 68;
  const SCENE_ROW_H = 46;
  const SCENE_PITCH = 34;

  /**
   * Le CTO, la baie de serveurs et la machine à café vivent dans les marges,
   * pas au milieu des bureaux : posés en coordonnées fixes, ils passaient
   * par-dessus les postes dès que l'agence se remplissait. Chaque marge n'est
   * réservée que si quelque chose l'occupe — sinon les rangées prennent toute
   * la largeur.
   */
  const SCENE_GUTTER_L = 56;
  const SCENE_GUTTER_R = 52;

  /**
   * Les rangées, du fond vers l'avant. Les stagiaires sont au fond : ce sont
   * les plus nombreux, ils font la masse. Les seniors sont au premier plan,
   * là où le regard tombe — ce sont eux que le joueur a payé le plus cher.
   */
  const SCENE_ROWS = [
    { id: 'stagiaire', color: '#a5b4fc', screen: '#6366f1', depth: 0.82 },
    { id: 'dev', color: '#c4b5fd', screen: '#8b5cf6', depth: 0.92 },
    { id: 'devSenior', color: '#fcd34d', screen: '#f59e0b', depth: 1 },
  ];

  /** Le décor de fond, du garage au campus. Le dernier bureau possédé gagne. */
  const SCENE_BACKDROPS = ['garage', 'openSpace', 'centreVille', 'campusTech'];

  function sceneQty(id) {
    return getUpgradeState(id)?.quantity || 0;
  }

  function sceneBackdropId() {
    if ((getOfficeState('campusTech')?.quantity || 0) > 0) return 'campusTech';
    if ((getOfficeState('centreVille')?.quantity || 0) > 0) return 'centreVille';
    if ((getOfficeState('openSpace')?.quantity || 0) > 0) return 'openSpace';
    return 'garage';
  }

  /**
   * Un poste de travail complet : personnage, écran, bureau.
   *
   * Trois groupes imbriqués, et ce n'est pas de la décoration. En SVG, une
   * propriété `transform` en CSS **remplace** l'attribut `transform` — animer
   * l'arrivée sur le groupe qui porte le `translate(x,y)` faisait donc entrer
   * le poste depuis le coin haut-gauche avant qu'il ne resurgisse à sa place.
   * Chaque couche a donc sa transformation à elle :
   *   .agency-unit   position dans la scène (attribut, jamais animé)
   *   .agency-desk   entrée en scène à l'achat
   *   .agency-react  réaction au clic du joueur
   * et, à l'intérieur, le buste qui pianote et l'écran qui scintille.
   */
  function sceneDesk(x, y, row, nouveau, delai, tempo) {
    const pop = nouveau ? ' agency-pop' : '';
    const popStyle = nouveau ? ' style="animation-delay:' + delai + 'ms"' : '';
    return '<g class="agency-unit" transform="translate(' + x + ',' + y + ')">' +
      '<g class="agency-desk' + pop + '"' + popStyle + '>' +
      '<g class="agency-react">' +
      // Le personnage est derrière l'écran : la tête dépasse, le buste est masqué
      // par le moniteur, ce qui suffit à donner la profondeur sans perspective.
      '<g class="agency-typing" style="animation-delay:' + tempo + 'ms">' +
      '<circle cx="15" cy="-27" r="5" fill="' + row.color + '"/>' +
      '<rect x="9" y="-21" width="12" height="11" rx="4.5" fill="' + row.color + '" opacity="0.85"/>' +
      '</g>' +
      '<rect x="6" y="-17" width="18" height="12" rx="2" fill="#0f0c1c"/>' +
      '<rect class="agency-screen" style="animation-delay:' + (tempo * 2 % 1700) + 'ms" ' +
        'x="7.5" y="-15.5" width="15" height="9" rx="1" fill="' + row.screen + '"/>' +
      '<rect x="14" y="-5" width="2" height="2.5" fill="#0f0c1c"/>' +
      '<rect x="2" y="-3" width="26" height="3.5" rx="1.75" fill="#2d2545"/>' +
      '<rect x="4.5" y="0.5" width="2" height="7" rx="1" fill="#221c38"/>' +
      '<rect x="23.5" y="0.5" width="2" height="7" rx="1" fill="#221c38"/>' +
      '</g></g></g>';
  }

  /** La pastille qui remplace les postes non dessinés. */
  function sceneOverflow(x, y, n, color) {
    return '<g transform="translate(' + x + ',' + y + ')">' +
      '<rect x="1" y="-24" width="28" height="16" rx="8" fill="#0f0c1c" stroke="' + color + '" stroke-width="1"/>' +
      '<text x="15" y="-13" text-anchor="middle" class="agency-count" fill="' + color + '">×' + n + '</text>' +
      '</g>';
  }

  /** La baie de serveurs, calée dans la marge droite. Ses diodes clignotent. */
  function sceneServers(n) {
    const x = SCENE_W - SCENE_GUTTER_R + 8;
    const y = SCENE_WALL_H + 10;
    let leds = '';
    for (let i = 0; i < Math.min(n, 8); i++) {
      leds += '<rect class="agency-led" style="animation-delay:' + (i * 200) + 'ms" ' +
        'x="' + (x + 6 + (i % 2) * 10) + '" y="' + (y + 9 + Math.floor(i / 2) * 9) + '" ' +
        'width="5" height="4" rx="1" fill="#22d3ee"/>';
    }
    return '<g class="agency-unit">' +
      '<rect x="' + x + '" y="' + y + '" width="30" height="48" rx="3" fill="#1b1730" stroke="#2d2545"/>' +
      leds +
      '<text x="' + (x + 15) + '" y="' + (y + 60) + '" text-anchor="middle" class="agency-count" fill="#22d3ee">×' + n + '</text>' +
      '</g>';
  }

  /** Le bureau du CTO : une silhouette seule dans son coin, ouverte par le campus. */
  function sceneCto() {
    const y = SCENE_WALL_H + 10;
    return '<g class="agency-unit">' +
      '<rect x="8" y="' + y + '" width="42" height="46" rx="4" fill="#1b1730" opacity="0.75" stroke="#3b2f63"/>' +
      '<circle cx="29" cy="' + (y + 15) + '" r="6" fill="#f472b6"/>' +
      '<rect x="21" y="' + (y + 23) + '" width="16" height="13" rx="5.5" fill="#f472b6" opacity="0.85"/>' +
      '<text x="29" y="' + (y + 44) + '" text-anchor="middle" class="agency-tag" fill="#f472b6">CTO</text>' +
      '</g>';
  }

  /**
   * Le fond : c'est lui qui dit où en est l'agence avant même de compter les
   * têtes. Le garage n'a qu'une ampoule ; le campus a des baies vitrées.
   */
  function sceneBackdrop(id) {
    const sol = '<rect x="0" y="' + SCENE_WALL_H + '" width="' + SCENE_W + '" height="400" fill="url(#agSol)"/>' +
      '<rect x="0" y="' + SCENE_WALL_H + '" width="' + SCENE_W + '" height="1.5" fill="#3b2f63" opacity="0.8"/>';
    let mur = '<rect x="0" y="0" width="' + SCENE_W + '" height="' + SCENE_WALL_H + '" fill="url(#agMur)"/>';

    if (id === 'garage') {
      mur += '<line x1="200" y1="0" x2="200" y2="14" stroke="#3b2f63" stroke-width="1"/>' +
        '<circle cx="200" cy="20" r="6" fill="#fbbf24" opacity="0.85"/>' +
        '<circle cx="200" cy="20" r="16" fill="#fbbf24" opacity="0.12"/>' +
        '<path d="M64 10 l8 16 l-5 10" stroke="#3b2f63" stroke-width="1.2" fill="none" opacity="0.6"/>' +
        // Une étagère et deux cartons : sans eux le garage est un rectangle vide,
        // et la scène a l'air cassée tant qu'on n'a que deux ou trois postes.
        '<rect x="286" y="30" width="76" height="3" rx="1.5" fill="#2d2545"/>' +
        '<rect x="294" y="18" width="14" height="12" rx="1" fill="#3b2f63"/>' +
        '<rect x="312" y="21" width="10" height="9" rx="1" fill="#2d2545"/>' +
        '<rect x="330" y="16" width="12" height="14" rx="1" fill="#332a55"/>' +
        '<rect x="42" y="44" width="22" height="20" rx="2" fill="#2d2545"/>' +
        '<rect x="42" y="52" width="22" height="1.5" fill="#3b2f63"/>' +
        '<rect x="66" y="50" width="16" height="14" rx="2" fill="#241f3d"/>';
    } else if (id === 'openSpace') {
      mur += '<rect x="70" y="14" width="90" height="5" rx="2.5" fill="#e0e7ff" opacity="0.5"/>' +
        '<rect x="240" y="14" width="90" height="5" rx="2.5" fill="#e0e7ff" opacity="0.5"/>' +
        '<rect x="60" y="34" width="110" height="22" rx="3" fill="#1b1730" stroke="#3b2f63"/>' +
        '<rect x="230" y="34" width="110" height="22" rx="3" fill="#1b1730" stroke="#3b2f63"/>';
    } else {
      // Centre-ville et campus partagent la baie vitrée : c'est le saut visuel
      // qui marque le passage du garage aux vrais locaux.
      mur += '<rect x="30" y="10" width="340" height="48" rx="4" fill="#0b1020"/>' +
        '<g opacity="0.9">' +
        '<rect x="46" y="30" width="18" height="28" fill="#1e2a4a"/><rect x="50" y="34" width="4" height="4" fill="#fbbf24" opacity="0.8"/>' +
        '<rect x="72" y="20" width="14" height="38" fill="#243357"/><rect x="76" y="26" width="3" height="3" fill="#a5b4fc" opacity="0.8"/>' +
        '<rect x="96" y="36" width="22" height="22" fill="#1e2a4a"/><rect x="102" y="41" width="4" height="4" fill="#fbbf24" opacity="0.6"/>' +
        '<rect x="128" y="24" width="16" height="34" fill="#243357"/><rect x="133" y="30" width="3" height="3" fill="#a5b4fc" opacity="0.7"/>' +
        '<rect x="156" y="34" width="20" height="24" fill="#1e2a4a"/>' +
        '<rect x="188" y="18" width="15" height="40" fill="#243357"/><rect x="192" y="24" width="3" height="3" fill="#fbbf24" opacity="0.8"/>' +
        '<rect x="214" y="32" width="24" height="26" fill="#1e2a4a"/><rect x="220" y="38" width="4" height="4" fill="#a5b4fc" opacity="0.6"/>' +
        '<rect x="250" y="26" width="16" height="32" fill="#243357"/>' +
        '<rect x="278" y="36" width="20" height="22" fill="#1e2a4a"/><rect x="284" y="41" width="4" height="4" fill="#fbbf24" opacity="0.7"/>' +
        '<rect x="308" y="22" width="14" height="36" fill="#243357"/><rect x="312" y="28" width="3" height="3" fill="#a5b4fc" opacity="0.8"/>' +
        '<rect x="334" y="34" width="20" height="24" fill="#1e2a4a"/>' +
        '</g>' +
        '<rect x="30" y="10" width="340" height="48" rx="4" fill="none" stroke="#3b2f63" stroke-width="1.5"/>' +
        '<line x1="200" y1="10" x2="200" y2="58" stroke="#3b2f63" stroke-width="1.5"/>';
      if (id === 'campusTech') {
        // La plante et le néon : le campus doit se voir au premier coup d'œil.
        mur += '<path d="M14 58 q-6 -16 4 -22 q10 6 4 22 z" fill="#34d399" opacity="0.8"/>' +
          '<path d="M18 58 q8 -14 16 -10 q-4 12 -14 10 z" fill="#34d399" opacity="0.55"/>' +
          '<rect x="12" y="57" width="14" height="8" rx="2" fill="#2d2545"/>' +
          '<rect x="356" y="16" width="30" height="4" rx="2" fill="#22d3ee" opacity="0.8"/>' +
          '<rect x="356" y="16" width="30" height="4" rx="2" fill="#22d3ee" opacity="0.3" class="agency-neon"/>';
      }
    }
    return mur + sol;
  }

  /** Les achats d'image accrochés au mur : logo, machine à café, campagne. */
  function sceneBranding() {
    let out = '';
    if ((getBrandingState('logo')?.quantity || 0) > 0) {
      out += '<g class="agency-unit"><rect x="180" y="24" width="26" height="26" rx="3" fill="#1b1730" stroke="#a78bfa"/>' +
        '<path d="M187 43 l6 -12 l6 12 z" fill="#a78bfa"/></g>';
    }
    if ((getBrandingState('linkedin')?.quantity || 0) > 0) {
      out += '<g class="agency-unit"><rect x="216" y="26" width="22" height="22" rx="3" fill="#1b1730" stroke="#60a5fa"/>' +
        '<rect x="221" y="36" width="3" height="8" fill="#60a5fa"/><rect x="221" y="31" width="3" height="3" fill="#60a5fa"/>' +
        '<path d="M228 44 v-8 q4 -2 5 3 v5" stroke="#60a5fa" stroke-width="2" fill="none"/></g>';
    }
    return out;
  }

  /** La machine à café, en bas de la marge gauche, sous le bureau du CTO. */
  function sceneCafe(hauteur) {
    if (!((getBrandingState('cafe')?.quantity || 0) > 0)) return '';
    const y = hauteur - 34;
    return '<g class="agency-unit">' +
      '<rect x="16" y="' + y + '" width="20" height="28" rx="3" fill="#2d2545" stroke="#3b2f63"/>' +
      '<rect x="20" y="' + (y + 5) + '" width="12" height="8" rx="1" fill="#fbbf24" opacity="0.7"/>' +
      '<rect x="21" y="' + (y + 18) + '" width="10" height="5" rx="1" fill="#a5b4fc"/>' +
      '</g>';
  }

  /**
   * Redessine la scène. Comme le reste de l'interface, elle ne reconstruit son
   * DOM que si quelque chose a changé : au repos, la boucle ne fait rien ici.
   *
   * Les postes qui viennent d'apparaître reçoivent la classe d'animation, les
   * autres non — sans ça, toute la pièce rejouerait son entrée à chaque achat.
   */
  function renderAgencyScene() {
    const el = document.getElementById('agency-scene');
    if (!el) return;
    // On achète depuis la Boutique, où la scène n'est pas visible. Si on la
    // redessinait là, le poste serait déjà en place au retour sur l'accueil et
    // l'achat ne se verrait jamais. On laisse donc la scène en retard tant que
    // l'onglet n'est pas affiché : elle rattrape, animation comprise, au retour.
    if (!isTabActive('accueil')) return;

    const counts = {};
    SCENE_ROWS.forEach((r) => { counts[r.id] = sceneQty(r.id); });
    const serveurs = sceneQty('serveur');
    const cto = sceneQty('cto');
    const backdrop = sceneBackdropId();
    const brand = ['logo', 'linkedin', 'cafe'].map((b) => (getBrandingState(b)?.quantity || 0) > 0 ? 1 : 0).join('');
    const sig = [backdrop, brand, serveurs, cto, SCENE_ROWS.map((r) => counts[r.id]).join(',')].join('|');
    if (rendered.sceneSig === sig) return;
    const avant = sceneSeenCounts;
    rendered.sceneSig = sig;
    sceneSeenCounts = Object.assign({}, counts);

    const actives = SCENE_ROWS.filter((r) => counts[r.id] > 0);
    const hauteur = SCENE_WALL_H + Math.max(actives.length, 1) * SCENE_ROW_H + 8;

    const cafe = (getBrandingState('cafe')?.quantity || 0) > 0;
    const xMin = (cto > 0 || cafe) ? SCENE_GUTTER_L : 10;
    const xMax = serveurs > 0 ? SCENE_W - SCENE_GUTTER_R : SCENE_W - 10;

    let corps = sceneBackdrop(backdrop) + sceneBranding() + sceneCafe(hauteur);
    if (serveurs > 0) corps += sceneServers(serveurs);
    if (cto > 0) corps += sceneCto();

    if (!actives.length) {
      // Une agence vide reste une agence : un bureau inoccupé vaut mieux qu'un
      // trou, et il donne envie de le remplir.
      corps += '<g opacity="0.45">' +
        '<rect x="180" y="' + (hauteur - 24) + '" width="42" height="4" rx="2" fill="#2d2545"/>' +
        '<rect x="184" y="' + (hauteur - 20) + '" width="2.5" height="9" rx="1" fill="#221c38"/>' +
        '<rect x="217" y="' + (hauteur - 20) + '" width="2.5" height="9" rx="1" fill="#221c38"/>' +
        '</g>' +
        '<text x="200" y="' + (hauteur - 32) + '" text-anchor="middle" class="agency-empty">Personne, pour l\'instant.</text>';
    }

    actives.forEach((row, i) => {
      const y = SCENE_WALL_H + i * SCENE_ROW_H + 42;
      const n = counts[row.id];
      const deja = avant ? (avant[row.id] || 0) : 0;
      const dessines = Math.min(n, n > SCENE_MAX_SLOTS ? SCENE_MAX_SLOTS - 1 : SCENE_MAX_SLOTS);
      // La rangée est centrée entre les marges : alignée à gauche, trois postes
      // se tassaient dans un coin avec une pièce vide à côté.
      const cases = dessines + (n > SCENE_MAX_SLOTS ? 1 : 0);
      const x0 = xMin + Math.max(0, ((xMax - xMin) - cases * SCENE_PITCH) / 2);
      let g = '';
      for (let k = 0; k < dessines; k++) {
        // Nouveau = ce poste n'était pas là la dernière fois que le joueur a
        // regardé. Le décalage fait entrer les postes l'un après l'autre quand
        // on en achète plusieurs d'affilée.
        const nouveau = avant !== null && k >= deja;
        // Tempo propre à chaque poste : sans décalage, toute la pièce pianote
        // en cadence et la scène a l'air mécanique.
        const tempo = (i * 313 + k * 137) % 900;
        g += sceneDesk(x0 + k * SCENE_PITCH, y, row, nouveau, (k - deja) * 70, tempo);
      }
      if (n > SCENE_MAX_SLOTS) {
        g += sceneOverflow(x0 + dessines * SCENE_PITCH, y, n - dessines, row.color);
      }
      corps += '<g opacity="' + row.depth + '">' + g + '</g>';
    });

    el.innerHTML =
      '<svg class="agency-svg" viewBox="0 0 ' + SCENE_W + ' ' + hauteur + '" ' +
      'preserveAspectRatio="xMidYMax meet" role="img" aria-label="' +
      'Ton agence : ' + SCENE_ROWS.map((r) => counts[r.id] + ' ' + getUpgradeDef(r.id).name).join(', ') + '">' +
      '<defs>' +
      '<linearGradient id="agMur" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#241f3d"/><stop offset="100%" stop-color="#1a1630"/></linearGradient>' +
      '<linearGradient id="agSol" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#151126"/><stop offset="100%" stop-color="#0d0a1a"/></linearGradient>' +
      '</defs>' + corps + '</svg>';
  }

  /* ==========================================================================
     Les stagiaires — affichage
     ========================================================================== */

  function internRarityBadge(rarityId) {
    const r = getInternRarity(rarityId);
    return '<span class="intern-rarity" data-rarity="' + r.id + '">' + r.symbol + ' ' + r.label + '</span>';
  }

  function formatMs(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /** Les lignes de stats d'un candidat, réutilisées par le tirage et par la carte. */
  function internStatsHtml(c) {
    const trait = getInternTrait(c.traitId);
    const eureka = c.eurekaChance > 0
      ? 'Eurêka x' + c.eurekaMultiplier + ' pendant ' + Math.round(c.eurekaMs / 1000) + ' s'
      : 'Jamais d\'Eurêka';
    return '<div class="intern-stats">' +
      '<span class="intern-stat"><b>+' + c.prodPercent + '%</b> production</span>' +
      '<span class="intern-stat' + (c.eurekaChance > 0 ? ' intern-stat-eureka' : '') + '">' + eureka + '</span>' +
      '<span class="intern-stat"><b>+' + c.hireBonusPercent + '%</b> définitif si embauché</span>' +
      (trait ? '<span class="intern-trait">' + escapeHtml(trait.name) + ' — ' + escapeHtml(trait.desc) + '</span>' : '') +
      '</div>';
  }

  /**
   * La carte stagiaire de l'accueil. Elle a quatre états : promo à venir, promo
   * disponible, stage en cours, décision en attente. On ne reconstruit le HTML
   * que quand l'état change de forme ; le compte à rebours est mis à jour à
   * part par updateInternTimer(), pour ne pas recréer de DOM 4 fois par seconde.
   */
  function renderIntern() {
    const card = document.getElementById('intern-card');
    if (!card) return;
    if (!isFeatureUnlocked('stagiaires')) {
      card.hidden = true;
      rendered.internSig = null;
      return;
    }
    card.hidden = false;

    let mode;
    if (state.intern && isInternStageOver()) mode = 'decision';
    else if (state.intern) mode = 'stage';
    else if (state.internDraft) mode = 'promo';
    else mode = 'attente';

    const sig = [mode, state.intern ? state.intern.id : '', isEurekaActive() ? 'e' : '',
      state.intern ? state.intern.eurekaCount : ''].join('|');
    card.setAttribute('data-mode', mode);
    card.setAttribute('data-eureka', isEurekaActive() ? 'true' : 'false');
    if (rendered.internSig === sig) { updateInternTimer(); return; }
    rendered.internSig = sig;

    if (mode === 'promo') {
      card.innerHTML =
        '<div class="intern-head"><span class="intern-kicker">Promo de stagiaires</span></div>' +
        '<p class="intern-line">' + INTERN_DRAFT_SIZE + ' candidats se présentent. Tu ne peux en garder qu\'un.</p>' +
        '<button type="button" class="intern-cta" id="intern-open-draft">Voir les candidats</button>';
      document.getElementById('intern-open-draft').addEventListener('click', openInternDraftModal);
      return;
    }

    if (mode === 'attente') {
      card.innerHTML =
        '<div class="intern-head"><span class="intern-kicker">Stagiaires</span></div>' +
        '<p class="intern-line">Prochaine promo dans <b id="intern-countdown">--</b></p>' +
        '<div class="intern-bar"><span class="intern-bar-fill" id="intern-bar-fill"></span></div>' +
        (state.internsHired > 0
          ? '<p class="intern-roster">' + state.internsHired + ' embauché' + (state.internsHired > 1 ? 's' : '') +
            ' · <b>+' + state.internHireBonusPercent + '%</b> de production définitive</p>'
          : '<p class="intern-roster">Personne n\'a encore été embauché.</p>');
      updateInternTimer();
      return;
    }

    const c = state.intern;
    if (mode === 'stage') {
      card.innerHTML =
        '<div class="intern-head">' +
          '<span class="intern-name">' + escapeHtml(c.name) + '</span>' +
          internRarityBadge(c.rarity) +
        '</div>' +
        internStatsHtml(c) +
        '<div class="intern-bar"><span class="intern-bar-fill" id="intern-bar-fill"></span></div>' +
        '<p class="intern-foot">Fin du stage dans <b id="intern-countdown">--</b>' +
          (c.eurekaCount > 0 ? ' · <b>' + c.eurekaCount + '</b> Eurêka' + (c.eurekaCount > 1 ? 's' : '') : '') +
        '</p>' +
        // Pas de bannière pour un profil qui ne déclenchera jamais d'Eurêka :
        // elle afficherait « production x1 ».
        (c.eurekaChance > 0
          ? '<div class="intern-eureka-banner" id="intern-eureka-banner" hidden>⚡ EURÊKA — production x' + c.eurekaMultiplier + '</div>'
          : '');
      updateInternTimer();
      return;
    }

    // decision
    card.innerHTML =
      '<div class="intern-head">' +
        '<span class="intern-name">' + escapeHtml(c.name) + '</span>' +
        internRarityBadge(c.rarity) +
      '</div>' +
      '<p class="intern-line">Stage terminé. À toi de décider.</p>' +
      '<button type="button" class="intern-cta" id="intern-open-end">Voir le bilan</button>';
    document.getElementById('intern-open-end').addEventListener('click', showInternEndModal);
  }

  /** Compte à rebours et barre : mis à jour seul, sans reconstruire la carte. */
  function updateInternTimer() {
    const countdown = document.getElementById('intern-countdown');
    const fill = document.getElementById('intern-bar-fill');
    const now = Date.now();
    let remaining = 0;
    let ratio = 0;
    if (state.intern && !isInternStageOver()) {
      remaining = state.intern.endsAt - now;
      const total = state.intern.endsAt - state.intern.startedAt;
      ratio = total > 0 ? 1 - remaining / total : 1;
    } else if (!state.intern && !state.internDraft) {
      remaining = (state.nextInternDraftAt || now) - now;
      ratio = INTERN_COOLDOWN_MS > 0 ? 1 - remaining / INTERN_COOLDOWN_MS : 1;
    }
    if (countdown) countdown.textContent = formatMs(remaining);
    if (fill) fill.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
    const banner = document.getElementById('intern-eureka-banner');
    if (banner) banner.hidden = !isEurekaActive();
  }

  /* --- Modale de tirage --- */

  function openInternDraftModal() {
    const modal = document.getElementById('intern-draft-modal');
    const list = document.getElementById('intern-draft-list');
    if (!modal || !list || !state.internDraft) return;
    list.innerHTML = '';
    (state.internDraft.candidates || []).forEach((c, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'intern-candidate';
      card.setAttribute('data-rarity', c.rarity);
      card.style.animationDelay = (i * 90) + 'ms';
      card.innerHTML =
        '<div class="intern-head">' +
          '<span class="intern-name">' + escapeHtml(c.name) + '</span>' +
          internRarityBadge(c.rarity) +
        '</div>' +
        '<p class="intern-blurb">' + escapeHtml(getInternRarity(c.rarity).blurb) + '</p>' +
        internStatsHtml(c) +
        '<span class="intern-pick">Le prendre</span>';
      card.addEventListener('click', () => chooseInternCandidate(c.id));
      list.appendChild(card);
    });
    modal.hidden = false;
    // Après l'affichage seulement : tant que la modale est masquée, la liste
    // n'a pas de hauteur et se croirait déjà défilée jusqu'en bas.
    markDraftListEnd(list);
  }

  /**
   * Dit au CSS si la liste des candidats est arrivée en bas. Le dégradé qui
   * signale « il y a une suite » doit disparaître à ce moment-là, sinon il
   * efface le bouton du dernier candidat.
   */
  function markDraftListEnd(list) {
    const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    list.setAttribute('data-at-end', atEnd ? 'true' : 'false');
  }

  function closeInternDraftModal() {
    const modal = document.getElementById('intern-draft-modal');
    if (modal) modal.hidden = true;
  }

  /* --- Modale de fin de stage --- */

  function showInternEndModal() {
    const modal = document.getElementById('intern-end-modal');
    const c = state.intern;
    if (!modal || !c) return;
    setText('intern-end-name', c.name);
    const rarityEl = document.getElementById('intern-end-rarity');
    if (rarityEl) rarityEl.innerHTML = internRarityBadge(c.rarity);
    setText('intern-end-report', c.eurekaCount > 0
      ? 'Bilan du stage : ' + c.eurekaCount + ' Eurêka' + (c.eurekaCount > 1 ? 's' : '') + ' déclenché' + (c.eurekaCount > 1 ? 's' : '') + '.'
      : 'Bilan du stage : aucun Eurêka.');
    const cost = c.hireCost || INTERN_HIRE_COST_MIN;
    const affordable = canAfford(cost);
    const hireBtn = document.getElementById('intern-end-hire');
    if (hireBtn) {
      hireBtn.innerHTML = 'Embaucher · ' + formatNumber(cost) + ' crédits' +
        '<span class="intern-end-gain">+' + c.hireBonusPercent + '% de production, définitivement</span>';
      hireBtn.disabled = !affordable;
      hireBtn.classList.toggle('too-expensive', !affordable);
    }
    setText('intern-end-hint', affordable
      ? 'Le laisser partir ne coûte rien — mais tout ce qu\'il apportait s\'en va avec lui.'
      : 'Il te manque ' + formatNumber(cost - Math.floor(state.credits)) + ' crédits. Tu peux continuer à jouer : la décision t\'attend.');
    modal.hidden = false;
  }

  function hideInternEndModal() {
    const modal = document.getElementById('intern-end-modal');
    if (modal) modal.hidden = true;
  }

  /** L'Eurêka est le moment spectaculaire du jeu : il doit se voir. */
  function showEurekaBurst() {
    renderIntern();
    const layer = document.getElementById('eureka-layer');
    if (layer) {
      const el = document.createElement('div');
      el.className = 'eureka-burst';
      el.textContent = '⚡ EURÊKA';
      layer.appendChild(el);
      setTimeout(function () { el.remove(); }, 2200);
    }
    document.body.classList.add('eureka-active');
    showToast((state.intern ? state.intern.name : 'Ton stagiaire') + ' a trouvé quelque chose. Production x' +
      (state.intern ? state.intern.eurekaMultiplier : 1) + ' !', 4000);
  }

  /**
   * Le but courant, affiché en permanence sur l'accueil. C'est la réponse à
   * « je joue pour quoi, là, maintenant » : un titre, une phrase, une barre et
   * des chiffres. Sans ça le joueur ne voit qu'un compteur qui monte.
   */
  function renderChapterGoal() {
    const card = document.getElementById('chapter-goal');
    if (!card) return;
    if (state.gameCompleted) {
      const sig = 'done';
      if (rendered.goalSig === sig) return;
      rendered.goalSig = sig;
      setText('chapter-goal-step', 'Fin');
      setText('chapter-goal-name', 'Studio légendaire');
      setText('chapter-goal-label', 'Tu as terminé la partie. Continue à faire grandir l\'agence si le cœur t\'en dit.');
      setText('chapter-goal-value', '');
      setText('chapter-goal-reward', '');
      const barDone = document.getElementById('chapter-goal-fill');
      if (barDone) barDone.style.width = '100%';
      card.setAttribute('data-complete', 'true');
      return;
    }
    const ch = getCurrentChapter();
    if (!ch) return;
    const p = getChapterProgress(ch);
    if (!p) return;
    // La barre bouge en continu : on ne redessine que si le texte change.
    const sig = ch.id + '|' + p.text;
    const pct = Math.round(p.ratio * 1000) / 10;
    const fill = document.getElementById('chapter-goal-fill');
    if (fill) fill.style.width = pct + '%';
    if (rendered.goalSig === sig) return;
    rendered.goalSig = sig;
    card.setAttribute('data-complete', 'false');
    setText('chapter-goal-step', 'Chapitre ' + ch.id + '/' + CHAPTERS.length);
    setText('chapter-goal-name', ch.name);
    setText('chapter-goal-label', ch.goal.label);
    setText('chapter-goal-value', p.text);
    const reward = [];
    if (ch.rewardLabel) reward.push(ch.rewardLabel);
    if (ch.unlockShort) reward.push('débloque ' + ch.unlockShort);
    setText('chapter-goal-reward', reward.join(' · '));
  }

  /**
   * Une ligne d'objectif. Quand l'objectif sait dire où il en est, on affiche
   * « 3 200 / 5 000 » et une barre plutôt qu'un « En cours » qui n'apprend rien.
   */
  function buildQuestItem(q) {
    var done = state.completedQuests.includes(q.id);
    var div = document.createElement('div');
    div.className = 'quest-item' + (done ? ' done' : '');
    var p = (!done && typeof q.progress === 'function') ? q.progress() : null;
    var label = done ? '✓ Fait' : 'En cours';
    if (p && p.target > 0) {
      label = formatNumber(Math.min(p.current, p.target)) + ' / ' + formatNumber(p.target);
    }
    var html = '<div class="quest-item-row"><span class="quest-name">' + escapeHtml(q.name) + '</span>'
      + '<span class="quest-progress">' + label + '</span></div>';
    if (p && p.target > 0) {
      var pct = Math.round(Math.min(1, p.current / p.target) * 1000) / 10;
      html += '<div class="quest-bar"><span class="quest-bar-fill" style="width:' + pct + '%"></span></div>';
    }
    div.innerHTML = html;
    div.setAttribute('data-quest', q.id);
    return div;
  }

  /**
   * Rafraîchit les chiffres des objectifs sans reconstruire la liste.
   * Les lignes sont créées une fois par renderQuests ; ici on ne touche qu'au
   * texte et à la largeur de barre — la boucle a été optimisée pour ne plus
   * créer d'éléments au repos, une reconstruction 4 fois par seconde la
   * ferait régresser.
   */
  function updateQuestsProgress() {
    var container = document.getElementById('quests-list');
    if (!container) return;
    container.querySelectorAll('.quest-item[data-quest]').forEach(function (node) {
      var q = QUESTS.find(function (d) { return d.id === node.getAttribute('data-quest'); });
      if (!q || typeof q.progress !== 'function') return;
      if (state.completedQuests.includes(q.id)) return;
      var p = q.progress();
      if (!p || !(p.target > 0)) return;
      var label = formatNumber(Math.min(p.current, p.target)) + ' / ' + formatNumber(p.target);
      var labelEl = node.querySelector('.quest-progress');
      if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
      var fill = node.querySelector('.quest-bar-fill');
      if (fill) fill.style.width = (Math.round(Math.min(1, p.current / p.target) * 1000) / 10) + '%';
    });
  }

  function renderQuests() {
    const container = document.getElementById('quests-list');
    if (!container) return;
    container.innerHTML = '';
    var incomplete = QUESTS.filter(function (q) { return !state.completedQuests.includes(q.id); });
    var toShow = incomplete.slice(0, QUEST_DISPLAY_LIMIT);
    if (toShow.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'quests-empty';
      empty.textContent = 'Tous les objectifs affichés ici sont accomplis. Clique sur « Voir tous les objectifs » pour la liste complète.';
      container.appendChild(empty);
    } else {
      toShow.forEach(function (q) { container.appendChild(buildQuestItem(q)); });
    }
  }

  function renderAllQuestsModal() {
    var list = document.getElementById('all-quests-modal-list');
    if (!list) return;
    list.innerHTML = '';
    QUESTS.forEach(function (q) { list.appendChild(buildQuestItem(q)); });
  }

  function openAllQuestsModal() {
    renderAllQuestsModal();
    var modal = document.getElementById('all-quests-modal');
    if (modal) modal.hidden = false;
  }

  function closeAllQuestsModal() {
    var modal = document.getElementById('all-quests-modal');
    if (modal) modal.hidden = true;
  }

  function renderUpgrades() {
    const container = document.getElementById('upgrades-list');
    if (!container) return;
    container.innerHTML = '';
    const defs = [...UPGRADE_DEFS];
    const ctoDef = { id: 'cto', name: 'CTO', desc: '20 crédits/s. Débloqué par le Campus.', basePrice: 50000, priceGrowth: 1.18, production: 20, type: 'producer' };
    if (isUnlocked('cto')) { defs.push(ctoDef); ensureUpgrade('cto'); }
    ensureUpgrade('dev');
    defs.forEach((def) => {
      const us = getUpgradeState(def.id) || { quantity: 0 };
      const quantity = us.quantity;
      const price = getPrice(def, quantity);
      const affordable = canAfford(price);
      const card = document.createElement('div');
      card.className = 'upgrade-card-wrapper';
      let html = '<button type="button" class="upgrade-card" data-upgrade="' + def.id + '"' + (affordable ? '' : ' disabled') + '>';
      let desc = def.desc;
      if (def.type === 'producer') desc += ' (' + formatNumber(def.production) + '/s chacun)';
      if (def.type === 'multiplier') desc += ' (+' + ((def.multiplier || 0) * 100) + '% par unité)';
      html += '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">' + escapeHtml(desc) + '</span><div class="row"><span class="count">Possédés : ' + quantity + '</span><span class="price' + (affordable ? '' : ' too-expensive') + '">' + formatNumber(price) + ' crédits</span></div></button>';
      if (def.promoteTo && isFeatureUnlocked('promotions') && us.quantity >= (def.promoteCost || 10)) {
        const toDef = getUpgradeDef(def.promoteTo);
        html += '<button type="button" class="promote-btn" data-from="' + def.id + '" data-to="' + def.promoteTo + '">Promouvoir 10 → 1 ' + (toDef ? toDef.name : '') + '</button>';
      }
      card.innerHTML = html;
      card.querySelector('.upgrade-card')?.addEventListener('click', () => buyUpgrade(def.id));
      card.querySelector('.promote-btn')?.addEventListener('click', function () {
        promote(this.getAttribute('data-from'), this.getAttribute('data-to'));
      });
      container.appendChild(card);
    });
  }

  function renderManagers() {
    if (isFeatureLocked('equipe')) return;
    const container = document.getElementById('managers-list');
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('compact-list');
    MANAGER_DEFS.forEach((def) => {
      const ms = getManagerState(def.id) || { quantity: 0 };
      const unlocked = isLevelUnlocked(def.levelReq);
      const maxed = def.maxQty && ms.quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, ms.quantity);
      const affordable = maxed || canAfford(price);
      const row = document.createElement('div');
      row.className = 'compact-row' + (!unlocked ? ' locked' : '');
      row.setAttribute('data-manager', def.id);
      row.innerHTML =
        '<div class="compact-row-head" role="button" tabindex="0" aria-expanded="false">' +
        '<span class="compact-row-name">' + escapeHtml(def.name) + '</span>' +
        '<span class="compact-row-count">' + (maxed ? '✓ Max' : ms.quantity + '/' + (def.maxQty || '∞')) + '</span>' +
        '<span class="compact-row-price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price)) + '</span>' +
        (!unlocked || maxed ? '' : '<button type="button" class="compact-row-buy">Acheter</button>') +
        '<span class="compact-row-toggle" aria-hidden="true">▼</span>' +
        '</div>' +
        '<div class="compact-row-details">' +
        '<span class="compact-row-desc">' + escapeHtml(def.desc) + '</span>' +
        (def.levelReq ? '<span class="compact-row-req">Débloqué au niveau ' + def.levelReq + '</span>' : '') +
        '</div>';
      container.appendChild(row);
      const head = row.querySelector('.compact-row-head');
      head.addEventListener('click', function (e) {
        if (e.target.closest('.compact-row-buy')) return;
        row.classList.toggle('expanded');
        head.setAttribute('aria-expanded', row.classList.contains('expanded'));
      });
      head.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.classList.toggle('expanded'); head.setAttribute('aria-expanded', row.classList.contains('expanded')); }
      });
      const buyBtn = row.querySelector('.compact-row-buy');
      if (buyBtn && unlocked && !maxed) buyBtn.addEventListener('click', function (e) { e.stopPropagation(); buyManager(def.id); });
    });
  }

  function renderIntlOffices() {
    if (isFeatureLocked('intl')) return;
    const container = document.getElementById('intl-offices-list');
    if (!container) return;
    container.innerHTML = '';
    INTERNATIONAL_OFFICES.forEach((def) => {
      const os = getIntlOfficeState(def.id) || { quantity: 0 };
      const unlocked = isLevelUnlocked(def.levelReq);
      const maxed = def.maxQty && os.quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, os.quantity);
      const affordable = maxed || canAfford(price);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card' + (!unlocked ? ' locked' : '');
      card.setAttribute('data-intl', def.id);
      card.disabled = !unlocked || maxed || !affordable;
      card.innerHTML = '<span class="name">' + escapeHtml(def.name) + (unlocked ? '' : ' (Niv.' + def.levelReq + ')') + '</span><span class="desc">' + escapeHtml(def.desc) + '</span><div class="row"><span class="count">' + (maxed ? '✓ Acheté' : '') + '</span><span class="price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price) + ' crédits') + '</span></div>';
      if (unlocked && !maxed) card.addEventListener('click', () => buyIntlOffice(def.id));
      container.appendChild(card);
    });
  }

  function renderTraining() {
    if (isFeatureLocked('equipe')) return;
    const container = document.getElementById('training-list');
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('compact-list');
    TRAINING_DEFS.forEach((def) => {
      const ts = getTrainingState(def.id) || { quantity: 0 };
      const maxed = def.maxQty && ts.quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, ts.quantity);
      const affordable = maxed || canAfford(price);
      const row = document.createElement('div');
      row.className = 'compact-row';
      row.setAttribute('data-training', def.id);
      row.innerHTML =
        '<div class="compact-row-head" role="button" tabindex="0" aria-expanded="false">' +
        '<span class="compact-row-name">' + escapeHtml(def.name) + '</span>' +
        '<span class="compact-row-count">' + (maxed ? '✓ Acheté' : '') + '</span>' +
        '<span class="compact-row-price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price)) + '</span>' +
        (maxed ? '' : '<button type="button" class="compact-row-buy">Acheter</button>') +
        '<span class="compact-row-toggle" aria-hidden="true">▼</span>' +
        '</div>' +
        '<div class="compact-row-details">' +
        '<span class="compact-row-desc">' + escapeHtml(def.desc) + '</span>' +
        '</div>';
      container.appendChild(row);
      const head = row.querySelector('.compact-row-head');
      head.addEventListener('click', function (e) {
        if (e.target.closest('.compact-row-buy')) return;
        row.classList.toggle('expanded');
        head.setAttribute('aria-expanded', row.classList.contains('expanded'));
      });
      head.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.classList.toggle('expanded'); head.setAttribute('aria-expanded', row.classList.contains('expanded')); }
      });
      const buyBtn = row.querySelector('.compact-row-buy');
      if (buyBtn) buyBtn.addEventListener('click', function (e) { e.stopPropagation(); buyTraining(def.id); });
    });
  }

  function renderContrats() {
    if (isFeatureLocked('contrats')) return;
    const container = document.getElementById('contrats-list');
    if (!container) return;
    container.innerHTML = '';
    CONTRAT_DEFS.forEach((def) => {
      if (!isLevelUnlocked(def.levelReq)) return;
      const active = state.contrats.find((c) => c.id === def.id && !c.done);
      const card = document.createElement('div');
      card.className = 'contrat-card';
      card.setAttribute('data-contrat', def.id);
      if (active) {
        const left = Math.max(0, (active.endsAt - Date.now()) / 1000);
        const canClaim = left <= 0;
        card.innerHTML = getIconImg('document', 32) + '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">' + (canClaim ? 'Terminé !' : 'En cours : ' + formatDuration(left)) + '</span><button type="button" class="contrat-claim" ' + (canClaim ? '' : 'disabled') + '>' + (canClaim ? 'Récupérer ' + formatNumber(def.invest * def.rewardMult) + ' crédits' : 'En attente') + '</button>';
        card.querySelector('.contrat-claim')?.addEventListener('click', () => claimContrat(active));
      } else {
        const affordable = canAfford(def.invest);
        card.innerHTML = getIconImg('document', 32) + '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">Investis ' + formatNumber(def.invest) + ', récupère ' + formatNumber(def.invest * def.rewardMult) + ' après ' + def.duration + 's</span><button type="button" class="contrat-start" ' + (affordable ? '' : 'disabled') + '>Démarrer</button>';
        card.querySelector('.contrat-start')?.addEventListener('click', () => startContrat(def.id));
      }
      container.appendChild(card);
    });
    rendered.contrats = contratsSignature();
  }

  /**
   * Décrit ce que les cartes de contrats affichent, hors compte à rebours. Tant
   * que cette signature ne bouge pas, les cartes sont bonnes : il suffit de
   * réécrire le minuteur, au lieu de tout reconstruire (et de réattacher tous
   * les listeners) dix fois par seconde.
   */
  function contratsSignature() {
    const now = Date.now();
    return CONTRAT_DEFS.map((def) => {
      if (!isLevelUnlocked(def.levelReq)) return '';
      const active = state.contrats.find((c) => c.id === def.id && !c.done);
      if (active) return def.id + ':' + (active.endsAt - now <= 0 ? 'claim' : 'run');
      return def.id + ':' + (canAfford(def.invest) ? 'buy' : 'poor');
    }).join('|');
  }

  function updateContratsUI() {
    if (isFeatureLocked('contrats')) return;
    const container = document.getElementById('contrats-list');
    if (!container) return;
    if (contratsSignature() !== rendered.contrats) {
      renderContrats();
      return;
    }
    const now = Date.now();
    state.contrats.forEach((c) => {
      if (c.done) return;
      const desc = container.querySelector('.contrat-card[data-contrat="' + c.id + '"] .desc');
      if (!desc) return;
      const txt = 'En cours : ' + formatDuration(Math.max(0, (c.endsAt - now) / 1000));
      if (desc.textContent !== txt) desc.textContent = txt;
    });
  }

  function renderRnd() {
    if (isFeatureLocked('rnd')) return;
    const container = document.getElementById('rnd-list');
    if (!container) return;
    container.innerHTML = '';
    RND_DEFS.forEach((def) => {
      const rs = getRndState(def.id) || { purchased: false };
      const unlocked = isLevelUnlocked(def.levelReq);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card' + (!unlocked ? ' locked' : '') + (rs.purchased ? ' purchased' : '');
      card.disabled = !unlocked || rs.purchased || !canAfford(def.cost);
      card.innerHTML = '<span class="name">' + escapeHtml(def.name) + (unlocked ? '' : ' (Niv.' + def.levelReq + ')') + '</span><span class="desc">' + escapeHtml(def.desc) + '</span><div class="row"><span class="count">' + (rs.purchased ? '✓ Recherché' : '') + '</span><span class="price">' + (rs.purchased ? '—' : formatNumber(def.cost) + ' crédits') + '</span></div>';
      if (unlocked && !rs.purchased) card.addEventListener('click', () => buyRnd(def.id));
      container.appendChild(card);
    });
  }

  function renderOffices() {
    const container = document.getElementById('offices-list');
    if (!container) return;
    container.innerHTML = '';
    OFFICE_DEFS.forEach((def) => {
      if (def.unlocks === 'cto' && !isFeatureUnlocked('campus')) return;
      const os = getOfficeState(def.id);
      const quantity = os ? os.quantity : 0;
      const maxed = def.maxQty && quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, quantity);
      const affordable = maxed || canAfford(price);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card';
      card.setAttribute('data-office', def.id);
      card.disabled = maxed || !affordable;
      card.innerHTML = '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">' + escapeHtml(def.desc) + '</span><div class="row"><span class="count">' + (maxed ? '✓ Acheté' : 'Possédés : ' + quantity) + '</span><span class="price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price) + ' crédits') + '</span></div>';
      if (!maxed) card.addEventListener('click', () => buyOffice(def.id));
      container.appendChild(card);
    });
  }

  function renderBranding() {
    const container = document.getElementById('branding-list');
    if (!container) return;
    container.innerHTML = '';
    BRANDING_DEFS.forEach((def) => {
      const bs = getBrandingState(def.id);
      const quantity = bs ? bs.quantity : 0;
      const maxed = def.maxQty && quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, quantity);
      const affordable = maxed || canAfford(price);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card';
      card.setAttribute('data-branding', def.id);
      card.disabled = maxed || !affordable;
      card.innerHTML = '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">' + escapeHtml(def.desc) + '</span><div class="row"><span class="count">' + (maxed ? '✓ Acheté' : 'Possédés : ' + quantity) + '</span><span class="price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price) + ' crédits') + '</span></div>';
      if (!maxed) card.addEventListener('click', () => buyBranding(def.id));
      container.appendChild(card);
    });
  }

  function updateUpgradesAffordability() {
    const lists = [
      { id: 'upgrades-list', type: 'upgrade', getState: getUpgradeState, getDef: getUpgradeDef },
      { id: 'offices-list', type: 'office', getState: getOfficeState, getDef: getOfficeDef },
      { id: 'branding-list', type: 'branding', getState: getBrandingState, getDef: getBrandingDef },
      { id: 'managers-list', type: 'manager', getState: getManagerState, getDef: getManagerDef },
      { id: 'intl-offices-list', type: 'intl', getState: getIntlOfficeState, getDef: getIntlOfficeDef },
      { id: 'training-list', type: 'training', getState: getTrainingState, getDef: getTrainingDef },
    ];
    const levelOkCheck = (def) => !def || !def.levelReq || isLevelUnlocked(def.levelReq);
    lists.forEach(({ id, type, getState, getDef }) => {
      const container = document.getElementById(id);
      if (!container) return;
      // Un onglet masqué sera redessiné à son ouverture par renderActiveTab().
      const panel = container.closest('.tab-panel');
      if (panel && panel.hidden) return;
      const attr = type === 'upgrade' ? 'data-upgrade' : type === 'office' ? 'data-office' : type === 'branding' ? 'data-branding' : type === 'manager' ? 'data-manager' : type === 'intl' ? 'data-intl' : type === 'training' ? 'data-training' : null;
      if (!attr) return;
      container.querySelectorAll('.upgrade-card[' + attr + '], .compact-row[' + attr + ']').forEach((card) => {
        const cardId = attr ? card.getAttribute(attr) : null;
        if (!cardId) return;
        const def = getDef(cardId);
        const st = getState(cardId) || { quantity: 0 };
        const quantity = st.quantity;
        const maxed = def && def.maxQty && quantity >= def.maxQty;
        const price = maxed ? 0 : getPrice(def, quantity);
        const affordable = maxed || canAfford(price);
        const levelOk = levelOkCheck(def);
        if (card.classList.contains('compact-row')) {
          const priceEl = card.querySelector('.compact-row-price');
          const countEl = card.querySelector('.compact-row-count');
          const buyBtn = card.querySelector('.compact-row-buy');
          if (priceEl) {
            const priceTxt = maxed ? '—' : formatNumber(price);
            if (priceEl.textContent !== priceTxt) priceEl.textContent = priceTxt;
            priceEl.classList.toggle('too-expensive', !affordable && !maxed);
          }
          if (countEl) {
            const countTxt = maxed ? (attr === 'data-manager' ? '✓ Max' : '✓ Acheté') : (attr === 'data-manager' ? quantity + '/' + (def.maxQty || '∞') : '');
            if (countEl.textContent !== countTxt) countEl.textContent = countTxt;
          }
          if (buyBtn) buyBtn.disabled = !levelOk || (!maxed && !affordable);
        } else {
          card.disabled = !levelOk || (!maxed && !affordable);
          const priceEl = card.querySelector('.price');
          if (priceEl) priceEl.classList.toggle('too-expensive', !affordable && !maxed);
        }
      });
    });
  }

  function buyPrestigeBonus(id) {
    const def = PRESTIGE_BONUSES.find((b) => b.id === id);
    if (!def) return;
    const cost = getPrestigeBonusCost(def);
    if (state.reputation < cost) return;
    state.reputation -= cost;
    state.prestigeBonusLevels = state.prestigeBonusLevels || {};
    state.prestigeBonusLevels[id] = getPrestigeBonusLevel(id) + 1;
    Object.keys(def.effect).forEach((key) => {
      state.prestigeBonuses[key] = (state.prestigeBonuses[key] || 0) + def.effect[key];
    });
    save();
    renderReputationShop();
    renderReputation();
  }

  function renderReputationShop() {
    const container = document.getElementById('reputation-list');
    if (!container) return;
    container.innerHTML = '';
    PRESTIGE_BONUSES.forEach((def) => {
      const level = getPrestigeBonusLevel(def.id);
      const cost = getPrestigeBonusCost(def);
      const affordable = state.reputation >= cost;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card';
      card.disabled = !affordable;
      card.innerHTML =
        '<span class="name">' + escapeHtml(def.name) + (level > 0 ? ' <span class="prestige-level">Niv. ' + level + '</span>' : '') + '</span>' +
        '<span class="desc">' + escapeHtml(def.desc || '') + '</span>' +
        '<div class="row">' +
        '<span class="count">' + cost + ' Réputation</span>' +
        '<span class="price' + (affordable ? '' : ' too-expensive') + '">Acheter</span>' +
        '</div>';
      card.addEventListener('click', () => buyPrestigeBonus(def.id));
      container.appendChild(card);
    });
  }

  function renderBestRun() {
    const el = document.getElementById('best-run-value');
    if (el) el.textContent = formatNumber(state.bestRunCredits || 0);
  }

  function renderPrestige() {
    const btn = document.getElementById('btn-prestige');
    const desc = document.getElementById('prestige-desc');
    if (!btn || !desc) return;
    const can = canPrestige();
    const headstartPct = (state.prestigeBonuses && state.prestigeBonuses.headstartPercent) || 0;
    const txt = can
      ? 'Repars de zéro et gagne ' + formatNumber(Math.floor(Math.sqrt(state.credits / PRESTIGE_THRESHOLD))) + ' Réputation. '
        + 'Tu perds tes crédits, tes achats, ton niveau et ton XP' + (headstartPct > 0 ? ' — tu gardes ' + headstartPct + '% de tes crédits' : '')
        + '. Tu gardes ta Réputation, ses bonus et tes chapitres.'
      : 'Atteins ' + formatNumber(PRESTIGE_THRESHOLD) + ' crédits pour débloquer le Rebranding.';
    if (can === rendered.prestigeCan && txt === rendered.prestigeDesc) return;
    rendered.prestigeCan = can;
    rendered.prestigeDesc = txt;
    btn.disabled = !can;
    desc.textContent = txt;
  }

  /**
   * Redessine le contenu de l'onglet visible. La boucle ne rafraîchit plus que
   * cet onglet : celui qu'on vient d'ouvrir peut afficher des données périmées.
   */
  function renderActiveTab() {
    switch (activeTab) {
      case 'accueil':
        renderClickValue();
        renderAgencyScene();
        renderChapterGoal();
        renderIntern();
        renderQuests();
        break;
      case 'candidats':
        renderRecruitmentContracts();
        updateRecruitmentRefreshButton();
        break;
      case 'equipe':
        renderEmployeesList();
        renderManagers();
        renderTraining();
        renderSettingsPendingErrors();
        break;
      case 'boutique':
        renderUpgrades();
        renderOffices();
        renderBranding();
        break;
      case 'plus':
        renderIntlOffices();
        renderContrats();
        renderRnd();
        renderReputationShop();
        renderBestRun();
        renderPrestige();
        break;
      case 'reglages':
        renderSettingsPendingErrors();
        break;
    }
    updateUpgradesAffordability();
  }

  function renderAll() {
    resetRenderCache();
    var headerName = document.getElementById('header-agency-name');
    if (headerName) headerName.textContent = (state.agencyName && state.agencyName.trim()) ? state.agencyName.trim() : 'DevIdle Agency';
    renderCredits();
    renderLevel();
    renderClickValue();
    renderReputation();
    renderChapter();
    renderAgencyScene();
    renderChapterGoal();
    renderIntern();
    renderQuests();
    renderRecruitmentContracts();
    renderSkillTree();
    renderEmployeesList();
    renderUpgrades();
    renderOffices();
    renderBranding();
    renderManagers();
    renderIntlOffices();
    renderTraining();
    renderContrats();
    renderRnd();
    renderReputationShop();
    renderBestRun();
    renderPrestige();
    renderPendingErrorsBadge();
    renderSettingsPendingErrors();
  }

  /**
   * Crédite la production accumulée pendant l'absence du joueur, à partir du
   * lastSave de la sauvegarde. Volontairement sans XP : accorder de l'XP ici
   * enchaînerait des montées de niveau et leurs modales dès le démarrage.
   * Retourne un rapport à afficher, ou null si rien n'est dû.
   */
  function grantOfflineEarnings() {
    const last = typeof state.lastSave === 'number' ? state.lastSave : 0;
    if (!last) return null;
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed < OFFLINE_MIN_MS) return null;

    // Purge ce qui a expiré pendant l'absence, sinon la prod serait sous-estimée
    (state.employees || []).forEach(function (emp) {
      if (emp.hasError && now >= (emp.errorUntil || 0)) {
        emp.hasError = false;
        emp.errorUntil = 0;
      }
      if ((emp.mentorPenaltyUntil || 0) > 0 && now >= emp.mentorPenaltyUntil) {
        emp.mentorPenaltyUntil = 0;
        emp.mentorPenaltyCausedBy = null;
      }
    });
    state.activeErrorImpacts = (state.activeErrorImpacts || []).filter(function (a) { return a.until > now; });

    const prod = getProductionPerSecond();
    if (!(prod > 0)) return null;
    const creditedMs = Math.min(elapsed, OFFLINE_MAX_MS);
    const offlineRate = OFFLINE_RATE * (1 + ((state.prestigeBonuses && state.prestigeBonuses.offlinePercent) || 0) / 100);
    const gain = Math.floor(prod * (creditedMs / 1000) * offlineRate);
    if (gain <= 0) return null;

    state.credits = (state.credits || 0) + gain;
    state.totalCreditsEarned = (state.totalCreditsEarned || 0) + gain;
    if (state.credits > state.bestRunCredits) state.bestRunCredits = state.credits;
    if (state.credits > (state.runPeakCredits || 0)) state.runPeakCredits = state.credits;
    // Sauvegarde immédiate : un crash avant le prochain autosave recréditerait le gain
    save();
    return { gain: gain, elapsedMs: elapsed, capped: elapsed > OFFLINE_MAX_MS };
  }

  function showOfflineModal(report) {
    const modal = document.getElementById('offline-modal');
    if (!modal || !report) return;
    const amountEl = document.getElementById('offline-amount');
    const detailEl = document.getElementById('offline-detail');
    if (amountEl) amountEl.textContent = '+' + formatNumber(report.gain) + ' crédits';
    if (detailEl) {
      let txt = 'Absence de ' + formatDuration(report.elapsedMs / 1000) + ' — ton agence a tourné à ' + Math.round(OFFLINE_RATE * 100) + ' % de son rendement';
      if (report.capped) txt += ', plafonné à ' + Math.round(OFFLINE_MAX_MS / 3600000) + ' h';
      detailEl.textContent = txt + '.';
    }
    modal.hidden = false;
  }

  function isOfflineModalOpen() {
    const modal = document.getElementById('offline-modal');
    return !!modal && modal.hidden === false;
  }

  function hideOfflineModal() {
    const modal = document.getElementById('offline-modal');
    if (modal) modal.hidden = true;
    // Ouverture différée d'un tick : ouvrir la modale de niveau en plein clic de
    // fermeture ferait retomber le mouseup sur le bonus situé sous le curseur,
    // qui se retrouverait sélectionné sans que le joueur l'ait choisi.
    if (state.pendingLevelUp) setTimeout(showLevelUpModal, 0);
  }

  function gameLoop(now) {
    var loopProd = 0;
    try {
    const dt = Math.min((now - lastTick) / 1000, 1);
    lastTick = now;

    const prod = getProductionPerSecond();
    loopProd = (typeof prod === 'number' && !isNaN(prod)) ? prod : 0;
    state.credits = (typeof state.credits === 'number' && !isNaN(state.credits) ? state.credits : 0) + loopProd * dt;
    state.totalCreditsEarned = (state.totalCreditsEarned || 0) + loopProd * dt;
    addXP(loopProd * dt * XP_PER_CREDIT);

    if (state.activeEvent && state.eventEndsAt && Date.now() >= state.eventEndsAt) endEvent();
    if (state.agencyEventChoice && state.agencyEventEndsAt <= Date.now()) {
      state.agencyEventChoice = null;
      state.agencyEventEndsAt = 0;
    }
    const nowMs = Date.now();
    (state.employees || []).forEach((emp) => {
      if (emp.hasError && nowMs >= emp.errorUntil) {
        emp.hasError = false;
        emp.errorUntil = 0;
        if (!state.errorModalFromPending && state.errorModalEmployeeId === emp.id) {
          state.errorModalEmployeeId = null;
          hideErrorModal();
        }
      }
      if ((emp.mentorPenaltyUntil || 0) > 0 && nowMs >= emp.mentorPenaltyUntil) {
        emp.mentorPenaltyUntil = 0;
        emp.mentorPenaltyCausedBy = null;
      }
    });
    if (!state.errorModalFromPending && state.errorModalEmployeeId && !getEmployee(state.errorModalEmployeeId)?.hasError) {
      state.errorModalEmployeeId = null;
      hideErrorModal();
    }
    state.activeErrorImpacts = (state.activeErrorImpacts || []).filter(function (a) { return a.until > nowMs; });
    if (nowMs >= state.nextErrorRollAt && (state.employees || []).length > 0) {
      state.nextErrorRollAt = nowMs + ERROR_ROLL_INTERVAL_MS;
      rollEmployeeErrors();
    }
    if (nowMs - lastLogicRefresh >= LOGIC_REFRESH_MS) {
      const logicDt = lastLogicRefresh ? nowMs - lastLogicRefresh : LOGIC_REFRESH_MS;
      lastLogicRefresh = nowMs;
      maybeTriggerEvent();
      maybeAgencyEvent(logicDt);
      tickInterns();
      checkQuests();
      checkChapterObjective();
      processContrats();
    }

    if (state.credits > state.bestRunCredits) state.bestRunCredits = state.credits;
    if (state.credits > (state.runPeakCredits || 0)) state.runPeakCredits = state.credits;

    renderLevel();

    if (nowMs - lastUiRefresh >= UI_REFRESH_MS) {
      lastUiRefresh = nowMs;
      renderEventTimer();
      if (isTabActive('accueil')) {
        renderAgencyScene();
        renderChapterGoal();
        updateQuestsProgress();
        renderIntern();
      }
      document.body.classList.toggle('eureka-active', isEurekaActive());
      updateUpgradesAffordability();
      if (isTabActive('plus')) {
        updateContratsUI();
        renderPrestige();
      }
    }

    var hasMentorPenalty = isTabActive('equipe') && (state.employees || []).some(function (e) { return (e.mentorPenaltyUntil || 0) > nowMs; });
    if (hasMentorPenalty && nowMs - lastMentorPenaltyRender > 1000) {
      lastMentorPenaltyRender = nowMs;
      renderEmployeesList();
    }

    if (Date.now() - state.lastSave > 5000) save();
    } catch (err) {
      console.error('Game loop error:', err);
    }
    renderCredits(loopProd);
  }

  /** Nombre de particules encore à l'écran, pour ne pas en empiler à l'infini. */
  var clickParticlesEnVol = 0;

  /**
   * Quelques éclats partent du point de contact. Plafonnés : en tapotant vite on
   * en créerait des dizaines par seconde, et ce jeu a déjà payé une fois le prix
   * du DOM créé en boucle.
   */
  function showClickParticles(clientX, clientY) {
    if (clickParticlesEnVol > 18) return;
    const n = 5;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'click-particle';
      // Éventail vers le haut, avec assez d'aléatoire pour que deux clics de
      // suite ne dessinent pas la même figure.
      const angle = (-90 + (i - (n - 1) / 2) * 26 + (Math.random() * 16 - 8)) * Math.PI / 180;
      const dist = 26 + Math.random() * 20;
      p.style.left = clientX + 'px';
      p.style.top = clientY + 'px';
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
      document.body.appendChild(p);
      clickParticlesEnVol++;
      setTimeout(function () { p.remove(); clickParticlesEnVol--; }, 620);
    }
  }

  function showClickProfitAnimation(clientX, clientY) {
    var amount = Math.max(1, Math.floor(getClickPower()) || 1);
    var el = document.createElement('div');
    el.className = 'click-profit-popup';
    el.textContent = '+' + formatNumber(amount);
    el.style.left = clientX + 'px';
    el.style.top = clientY + 'px';
    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.classList.add('click-profit-popup-visible');
    });
    showClickParticles(clientX, clientY);
    setTimeout(function () {
      el.remove();
    }, 700);
  }

  /**
   * Un poste choisi au hasard s'active à chaque clic. C'est le lien qui manquait
   * entre l'action la plus répétée du jeu et la scène : sans lui, le joueur
   * clique dans le vide pendant que son agence reste immobile.
   */
  function pulseAgencyDesk() {
    if (!isTabActive('accueil')) return;
    const postes = document.querySelectorAll('#agency-scene .agency-react');
    if (!postes.length) return;
    const el = postes[Math.floor(Math.random() * postes.length)];
    // Retirer puis relire une propriété de mise en page relance l'animation même
    // si le même poste est retiré au sort deux fois de suite.
    el.classList.remove('agency-hit');
    void el.getBoundingClientRect();
    el.classList.add('agency-hit');
    setTimeout(function () { el.classList.remove('agency-hit'); }, 420);
  }

  /** Le compteur de crédits tressaute quand le clic le fait monter. */
  function bumpCredits() {
    const el = document.getElementById('credits');
    if (!el) return;
    el.classList.remove('credits-bump');
    void el.getBoundingClientRect();
    el.classList.add('credits-bump');
  }

  function onCodeClick(e) {
    addCredits();
    pulseAgencyDesk();
    bumpCredits();
    if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number') {
      showClickProfitAnimation(e.clientX, e.clientY);
    } else {
      var btn = document.getElementById('btn-code') || document.getElementById('btn-code-nav');
      if (btn) {
        var r = btn.getBoundingClientRect();
        showClickProfitAnimation(r.left + r.width / 2, r.top + r.height / 2);
      }
    }
  }

  var toastTimer = null;

  /** Message transitoire en bas de l'écran. */
  function showToast(message, durationMs) {
    var el = document.getElementById('coming-soon-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'coming-soon-toast';
      el.className = 'coming-soon-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, durationMs || 2200);
  }

  /**
   * Retire de la barre l'onglet d'une fonctionnalité verrouillée.
   *
   * Ces onglets étaient d'abord affichés grisés avec un cadenas. À sept
   * emplacements dont deux inertes, la barre était encombrée et les libellés se
   * coupaient en deux lignes faute de largeur : on préfère quatre destinations
   * lisibles à six dont un tiers ne mène nulle part.
   *
   * On retire l'élément du DOM plutôt que de poser `hidden` : la règle
   * `.tapstorm-nav .tab-btn` fixe `display: flex` avec une spécificité qui bat
   * l'attribut `[hidden]`, le bouton resterait visible. Repasser
   * V1_LOCKS_ENABLED à false le fait revenir, il vient de index.html.
   */
  function removeLockedTabButton(btn) {
    btn.remove();
  }

  /**
   * Replace le bouton de clic au milieu de la barre.
   *
   * Sa position dans index.html suppose six onglets ; en retirer deux devant lui
   * le décale sur la gauche. On le recalcule à partir des onglets réellement
   * présents, ce qui reste juste quel que soit l'état des verrous.
   */
  function centerClickButton() {
    var nav = document.querySelector('.tapstorm-nav');
    var clickBtn = document.getElementById('btn-code-nav');
    if (!nav || !clickBtn) return;
    var tabs = [].slice.call(nav.querySelectorAll('.tab-btn'));
    if (!tabs.length) return;
    var milieu = Math.ceil(tabs.length / 2);
    if (milieu >= tabs.length) nav.appendChild(clickBtn);
    else nav.insertBefore(clickBtn, tabs[milieu]);
  }

  /**
   * Remplace les sections verrouillées de l'onglet Plus par une seule carte
   * d'annonce, plutôt que par trois blocs vides.
   */
  function lockPlusSections() {
    var panel = document.getElementById('tab-plus');
    if (!panel) return;
    var lockedNames = [];
    LOCKED_PLUS_SECTIONS.forEach(function (name) {
      var section = panel.querySelector('.plus-section[data-section="' + name + '"]');
      if (!section) return;
      var title = section.querySelector('.panel-title');
      if (title) lockedNames.push(title.textContent.trim());
      section.hidden = true;
    });
    if (!lockedNames.length || document.getElementById('plus-locked-card')) return;
    var card = document.createElement('section');
    card.id = 'plus-locked-card';
    card.className = 'tapstorm-card plus-locked-card';
    var h = document.createElement('h2');
    h.className = 'panel-title';
    h.textContent = 'Bientôt';
    var p = document.createElement('p');
    p.className = 'tab-desc';
    p.textContent = lockedNames.join(', ') + ' arrivent dans une prochaine mise à jour.';
    card.appendChild(h);
    card.appendChild(p);
    panel.appendChild(card);
  }

  function showTabByName(tabName) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tabName));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + tabName));
    activeTab = tabName;
    resetRenderCache();
    renderActiveTab();
  }

  function initTabs() {
    const showTab = showTabByName;
    lockPlusSections();
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const tabName = btn.getAttribute('data-tab');
      if (isFeatureLocked(tabName)) {
        removeLockedTabButton(btn);
        return;
      }
      btn.addEventListener('click', () => showTab(tabName));
    });
    centerClickButton();
    showTab('accueil');
  }

  function startGameLogic() {
    lastTick = performance.now();
    document.body.setAttribute('data-chapter', state.chapter);
    if (!state.nextEventAt || state.nextEventAt < Date.now()) scheduleNextEvent();
    if (state.activeEvent && state.eventEndsAt && state.eventEndsAt < Date.now()) endEvent();
    else if (state.activeEvent) {
      const ev = state.activeEvent;
      const banner = document.getElementById('event-banner');
      const textEl = document.getElementById('event-text');
      const timerEl = document.getElementById('event-timer');
      const actionBtn = document.getElementById('event-action-btn');
      if (banner && textEl) {
        banner.hidden = false;
        banner.setAttribute('data-type', ev.type);
        textEl.textContent = ev.name + (ev.hasAction ? ' — Clique Hotfix !' : ' !');
        if (timerEl) timerEl.textContent = formatDuration((state.eventEndsAt - Date.now()) / 1000);
        if (actionBtn) actionBtn.hidden = !ev.hasAction;
      }
    }

    if (!state.recruitmentContracts || state.recruitmentContracts.length === 0) generateRecruitmentContracts();
    if (!state.nextErrorRollAt) state.nextErrorRollAt = Date.now() + ERROR_ROLL_INTERVAL_MS;

    // Avant tout affichage : replacer le joueur au bon chapitre. Une partie
    // d'avant la refonte, ou simplement les gains hors-ligne, peuvent remplir
    // plusieurs buts d'un coup — on les applique en silence.
    catchUpChapters();
    initTabs();
    applyChapterUnlocks();
    sanitizeEmployeesMentorship();
    const offlineReport = grantOfflineEarnings();
    const chapitresHorsLigne = catchUpChapters();
    applyChapterUnlocks();
    if (chapitresHorsLigne > 0) {
      setTimeout(function () {
        showToast(chapitresHorsLigne === 1
          ? 'Un chapitre a été terminé pendant ton absence.'
          : chapitresHorsLigne + ' chapitres ont été terminés pendant ton absence.', 5000);
      }, 1500);
    }
    renderAll();
    renderCredits();

    requestAnimationFrame(() => {
      renderCredits();
      gameLoop(performance.now());
    });
    document.getElementById('chapter-complete-ok')?.addEventListener('click', completeChapterAndContinue);
    document.getElementById('game-complete-ok')?.addEventListener('click', hideGameCompleteModal);
    document.getElementById('intern-draft-modal-close')?.addEventListener('click', closeInternDraftModal);
    const draftList = document.getElementById('intern-draft-list');
    draftList?.addEventListener('scroll', function () { markDraftListEnd(draftList); }, { passive: true });
    document.getElementById('intern-draft-modal')?.addEventListener('click', function (e) {
      if (e.target === this) closeInternDraftModal();
    });
    document.getElementById('intern-end-modal-close')?.addEventListener('click', hideInternEndModal);
    document.getElementById('intern-end-modal')?.addEventListener('click', function (e) {
      if (e.target === this) hideInternEndModal();
    });
    document.getElementById('intern-end-hire')?.addEventListener('click', hireIntern);
    document.getElementById('intern-end-release')?.addEventListener('click', releaseIntern);
    document.getElementById('game-complete-modal-close')?.addEventListener('click', hideGameCompleteModal);
    document.getElementById('levelup-validate-btn')?.addEventListener('click', function () {
      if (levelUpSelectedId) {
        applyLevelBonus(levelUpSelectedId);
        levelUpSelectedId = null;
      }
    });
    document.getElementById('offline-modal-close')?.addEventListener('click', hideOfflineModal);
    document.getElementById('offline-ok')?.addEventListener('click', hideOfflineModal);
    // Une seule modale à la fois : le level-up en attente s'ouvre à la fermeture du rapport hors-ligne
    if (offlineReport) showOfflineModal(offlineReport);
    else if (state.pendingLevelUp) showLevelUpModal();
    document.getElementById('chapter-complete-modal-close')?.addEventListener('click', function () {
      document.getElementById('chapter-complete-ok')?.click();
    });
    document.getElementById('error-modal-close')?.addEventListener('click', function () {
      var rec = state.currentErrorRecord;
      if (rec && !(state.pendingErrors || []).some(function (e) { return e.employeeId === rec.employeeId; })) {
        (state.pendingErrors = state.pendingErrors || []).push(rec);
      }
      state.currentErrorRecord = null;
      state.errorModalEmployeeId = null;
      state.errorModalFromPending = false;
      hideErrorModal();
      renderPendingErrorsBadge();
      renderSettingsPendingErrors();
      renderEmployeesList();
    });
    document.getElementById('error-modal-pardonner')?.addEventListener('click', function () {
      const id = document.getElementById('error-modal')?.getAttribute('data-employee-id');
      if (id) pardonnerEmployee(id);
    });
    document.getElementById('error-modal-licencier')?.addEventListener('click', function () {
      const id = document.getElementById('error-modal')?.getAttribute('data-employee-id');
      if (id) { licencierEmployee(id); hideErrorModal(); }
    });
    document.getElementById('recruitment-refresh-btn')?.addEventListener('click', refreshRecruitmentContracts);
    document.getElementById('btn-show-all-quests')?.addEventListener('click', openAllQuestsModal);
    document.getElementById('all-quests-modal-close')?.addEventListener('click', closeAllQuestsModal);
    document.getElementById('header-errors-btn')?.addEventListener('click', function () {
      var tab = document.querySelector('.tab-btn[data-tab="equipe"]');
      if (tab) tab.click();
    });
    document.getElementById('error-detail-modal-close')?.addEventListener('click', closeErrorDetailModal);
    document.getElementById('btn-open-skill-tree')?.addEventListener('click', openSkillTreeModal);
    document.getElementById('skill-tree-modal-close')?.addEventListener('click', closeSkillTreeModal);
    document.getElementById('skill-tree-modal')?.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'skill-tree-modal') closeSkillTreeModal();
    });

    // Réinitialisation de la partie : destructive et irréversible, donc jamais
    // en un seul geste — la modale de confirmation est obligatoire.
    var resetModal = document.getElementById('reset-modal');
    var closeResetModal = function () { if (resetModal) resetModal.hidden = true; };
    document.getElementById('btn-reset-partie')?.addEventListener('click', function () {
      if (resetModal) resetModal.hidden = false;
    });
    document.getElementById('reset-cancel')?.addEventListener('click', closeResetModal);
    document.getElementById('reset-modal-close')?.addEventListener('click', closeResetModal);
    resetModal?.addEventListener('click', function (e) {
      if (e.target === resetModal) closeResetModal();
    });
    document.getElementById('reset-confirm')?.addEventListener('click', function () {
      try {
        localStorage.removeItem(SAVE_KEY);
        localStorage.removeItem(SAVE_BACKUP_KEY);
      } catch (e) {}
      // La sauvegarde du beforeunload réécrirait la partie qu'on vient d'effacer.
      window.removeEventListener('beforeunload', saveOnUnload);
      window.location.reload();
    });

    var agencyNameInput = document.getElementById('settings-agency-name');
    if (agencyNameInput) {
      agencyNameInput.value = (state.agencyName && state.agencyName.trim()) ? state.agencyName.trim() : 'Mon Agence';
      agencyNameInput.addEventListener('change', function () {
        var val = (this.value && this.value.trim()) ? this.value.trim().slice(0, 40) : 'Mon Agence';
        state.agencyName = val;
        this.value = val;
        save();
        renderAll();
      });
    }

    const btnCode = document.getElementById('btn-code');
    if (btnCode) btnCode.addEventListener('click', onCodeClick);
    const btnCodeNav = document.getElementById('btn-code-nav');
    if (btnCodeNav) btnCodeNav.addEventListener('click', onCodeClick);

    const actionBtn = document.getElementById('event-action-btn');
    if (actionBtn) actionBtn.addEventListener('click', onEventAction);

    const btnPrestige = document.getElementById('btn-prestige');
    if (btnPrestige) btnPrestige.addEventListener('click', doPrestige);

    // La boucle rafraîchit déjà l'affichage des crédits à chaque tick : le
    // setInterval de 150 ms qui doublonnait ici a été supprimé.
    setInterval(() => gameLoop(performance.now()), TICK_MS);
    window.addEventListener('beforeunload', saveOnUnload);
  }

  function init() {
    var loadStatus = 'echec';
    try {
      loadStatus = load();
    } catch (e) {
      console.warn('Load failed', e);
    }

    // `hasSave` décide d'afficher ou non l'écran « nom de l'agence ». Il vaut
    // désormais « une partie a bien été chargée », et non « une clé existe dans
    // localStorage » : une sauvegarde illisible menait sinon à une partie neuve
    // et sans nom, que l'autosave écrasait par-dessus l'ancienne.
    var hasSave = loadStatus === 'ok';

    if (loadStatus === 'illisible' || loadStatus === 'echec') {
      // La copie de secours a été posée par readAndMigrateSave().
      setTimeout(function () {
        showToast('Ta sauvegarde n\'a pas pu être lue. Une copie a été conservée, une nouvelle partie commence.', 8000);
      }, 1200);
    } else if (loadStatus === 'trop-recente') {
      setTimeout(function () {
        showToast('Cette partie vient d\'une version plus récente du jeu. Elle est conservée intacte : mets l\'application à jour pour la reprendre.', 10000);
      }, 1200);
    }
    var agencyScreen = document.getElementById('agency-name-screen');
    var gameScreen = document.getElementById('game-screen');

    function showGameAndStart() {
      if (gameScreen) {
        gameScreen.hidden = false;
        gameScreen.classList.add('active');
      }
      if (agencyScreen) {
        agencyScreen.hidden = true;
        agencyScreen.classList.remove('active');
      }
      startGameLogic();
    }

    if (agencyScreen && gameScreen && !hasSave) {
      gameScreen.hidden = true;
      gameScreen.classList.remove('active');
      agencyScreen.hidden = false;
      agencyScreen.classList.add('active');
      var form = document.getElementById('agency-name-form');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var input = document.getElementById('agency-name-input');
          state.agencyName = (input && input.value && input.value.trim()) ? input.value.trim().slice(0, 40) : 'Mon Agence';
          try { save(); } catch (err) { console.warn(err); }
          showGameAndStart();
        });
      } else {
        showGameAndStart();
      }
      (state.employees || []).forEach(function (emp) {
        if (emp.mentorId === emp.id) emp.mentorId = null;
        if (Array.isArray(emp.menteesIds)) emp.menteesIds = emp.menteesIds.filter(function (id) { return id !== emp.id; });
      });
      return;
    }

    showGameAndStart();
    (state.employees || []).forEach(function (emp) {
      if (emp.mentorId === emp.id) emp.mentorId = null;
      if (Array.isArray(emp.menteesIds)) emp.menteesIds = emp.menteesIds.filter(function (id) { return id !== emp.id; });
    });
  }

  function runInit() {
    try {
      init();
    } catch (e) {
      console.error('Init error', e);
      var gameScreen = document.getElementById('game-screen');
      if (gameScreen) {
        gameScreen.hidden = false;
        gameScreen.classList.add('active');
      }
      try { startGameLogic(); } catch (e2) { console.error('startGameLogic failed', e2); }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runInit);
  } else {
    setTimeout(runInit, 0);
  }
})();

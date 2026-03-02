(function () {
  'use strict';

  const SAVE_KEY = 'agence-dev-idle-save-v4';
  const TICK_MS = 100;
  const EVENT_MIN_INTERVAL_MS = 60 * 1000;
  const EVENT_MAX_INTERVAL_MS = 3 * 60 * 1000;
  const XP_PER_CLICK = 1;
  const XP_PER_CREDIT = 0.001;
  const PRESTIGE_THRESHOLD = 100000;
  const RECRUITMENT_POOL_SIZE = 5;
  const ERROR_ROLL_INTERVAL_MS = 45 * 1000;
  const ERROR_BLOCK_DURATION_MS = 30 * 1000;
  const MENTOR_SLOTS_JUNIOR = 2;
  const MENTOR_SLOTS_SENIOR = 3;
  const MENTOR_PROD_BONUS = 0.2;
  const MENTOR_ERROR_REDUCTION = 0.3;

  const EMPLOYEE_TYPE_LABELS = { stagiaire: 'Stagiaire', junior: 'Dev junior', senior: 'Dev senior' };
  const EMPLOYEE_TYPE_PROD_RANGES = {
    stagiaire: { min: 0.2, max: 0.5 },
    junior: { min: 0.6, max: 1.2 },
    senior: { min: 1.5, max: 2.5 },
  };
  const EMPLOYEE_TYPE_ERROR_RANGES = {
    stagiaire: { min: 0.03, max: 0.12 },
    junior: { min: 0.01, max: 0.06 },
    senior: { min: 0.005, max: 0.03 },
  };
  const EMPLOYEE_TYPE_COST_BASE = { stagiaire: 20, junior: 80, senior: 200 };
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

  const CHAPTERS = [
    { id: 1, name: 'Freelance', creditsReq: 0, levelReq: 0, objective: { credits: 1e9, level: 30 }, bonus: { prodPercent: 5 } },
    { id: 2, name: 'Petite agence locale', creditsReq: 1e6, levelReq: 5, objective: { credits: 1e12, level: 60 }, bonus: { prodPercent: 10 } },
    { id: 3, name: 'Agence internationale', creditsReq: 1e9, levelReq: 15, objective: null, bonus: null },
  ];

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

  const QUEST_DEFS = [
    { id: 'credits1k', name: 'Premier millier', target: () => state.credits >= 1000, reward: { xp: 50 } },
    { id: 'credits1M', name: 'Millionnaire', target: () => state.credits >= 1e6, reward: { xp: 500 } },
    { id: 'stagiaires10', name: '10 stagiaires', target: () => (getUpgradeState('stagiaire')?.quantity || 0) + (state.employees || []).filter((e) => e.type === 'stagiaire').length >= 10, reward: { xp: 100 } },
    { id: 'recruit5', name: '5 recrutements', target: () => (state.employees || []).length >= 5, reward: { xp: 80 } },
    { id: 'bureaux3', name: '3 bureaux différents', target: () => getOwnedOfficesCount() >= 3, reward: { xp: 300 } },
    { id: 'level5', name: 'Niveau 5', target: () => state.playerLevel >= 5, reward: { xp: 200 } },
  ];

  const PRESTIGE_BONUSES = [
    { id: 'prod10', name: '+10% prod passive', cost: 1, effect: { prodPercent: 10 } },
    { id: 'click5', name: '+5% clics', cost: 1, effect: { clickPercent: 5 } },
    { id: 'xp20', name: '+20% XP', cost: 2, effect: { xpPercent: 20 } },
  ];

  let state = {
    credits: 0,
    clickPower: 1,
    playerLevel: 1,
    playerXP: 0,
    pendingLevelUp: false,
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
    rnd: RND_DEFS.map((r) => ({ id: r.id, purchased: false })),
    chapterBonuses: {},
    completedQuests: [],
    chapter: 1,
    completedChapters: [],
    reputation: 0,
    prestigeBonuses: {},
    purchasedPrestigeBonuses: [],
    agencyName: 'Mon Agence',
    themeColor: 'default',
    bestRunCredits: 0,
    agencyEventChoice: null,
    agencyEventEndsAt: 0,
    recruitmentContracts: [],
    employees: [],
    nextErrorRollAt: 0,
    errorModalEmployeeId: null,
    lastContractRefreshAt: 0,
  };

  let lastTick = 0;

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
    const mentorSlots = contract.type === 'junior' ? MENTOR_SLOTS_JUNIOR : contract.type === 'senior' ? MENTOR_SLOTS_SENIOR : 0;
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
      menteesIds: [],
      mentorId: null,
      mentorSlots,
    };
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

  function refreshRecruitmentContracts() {
    state.recruitmentContracts = [];
    generateRecruitmentContracts();
    renderRecruitmentContracts();
  }

  function employeeEffectiveProd(emp) {
    if (!emp || !emp.isActive) return 0;
    const now = Date.now();
    if (emp.hasError && now < (emp.errorUntil || 0)) return 0;
    if (emp.mentorId) {
      const mentor = getEmployee(emp.mentorId);
      if (mentor && mentor.hasError && now < (mentor.errorUntil || 0)) return 0;
    }
    let prod = Number(emp.prodPerSec) || 0;
    if (emp.mentorId) prod *= 1 + MENTOR_PROD_BONUS;
    return prod;
  }

  function employeeProduction() {
    return (state.employees || []).reduce((sum, e) => sum + employeeEffectiveProd(e), 0);
  }

  function rollEmployeeErrors() {
    const now = Date.now();
    let firstErrorEmp = null;
    (state.employees || []).forEach((emp) => {
      if (!emp.isActive || emp.hasError) return;
      if (Math.random() < emp.errorChance) {
        emp.hasError = true;
        emp.errorUntil = now + ERROR_BLOCK_DURATION_MS;
        if (!firstErrorEmp) firstErrorEmp = emp;
      }
    });
    if (firstErrorEmp) {
      state.errorModalEmployeeId = firstErrorEmp.id;
      showErrorModal(firstErrorEmp);
    }
  }

  function getRandomErrorMessage() {
    return pickRandom(ERROR_MESSAGES);
  }

  function pardonnerEmployee(empId) {
    const emp = getEmployee(empId);
    if (!emp) return;
    emp.hasError = false;
    emp.errorUntil = 0;
    state.errorModalEmployeeId = null;
    hideErrorModal();
    renderEmployeesList();
    renderCredits();
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
      hideErrorModal();
    }
    if (state.reputation > 0) state.reputation = Math.max(0, state.reputation - 1);
    renderEmployeesList();
    renderCredits();
  }

  function assignMentee(mentorId, menteeId) {
    if (mentorId === menteeId) return;
    const mentor = getEmployee(mentorId);
    const mentee = getEmployee(menteeId);
    if (!mentor || !mentee || mentor.type === 'stagiaire') return;
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
    showLevelUpModal();
  }

  function applyLevelBonus(bonusId) {
    const bonus = LEVEL_BONUSES.find((b) => b.id === bonusId);
    if (!bonus || !bonus.effect) return;
    Object.keys(bonus.effect).forEach((key) => {
      const val = bonus.effect[key];
      state.levelBonuses[key] = (state.levelBonuses[key] || 0) + val;
    });
    state.pendingLevelUp = false;
    hideLevelUpModal();
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

    const cafe = getBrandingState('cafe');
    const cafeDef = getBrandingDef('cafe');
    if (cafe && cafe.quantity > 0 && cafeDef && cafeDef.activeBonus) total *= 1 + cafeDef.activeBonus;
    return total;
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
    checkChapter();
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

  function addCredits(amount) {
    const finalAmount = Math.max(1, Math.floor(getClickPower()) || 1);
    state.credits = (state.credits || 0) + finalAmount;
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
      state.credits += mult * getClickPower();
    }
  }

  function checkChapter() {
    const ch = CHAPTERS.find((c) => c.id === state.chapter + 1);
    if (!ch) return;
    if (state.credits >= ch.creditsReq && state.playerLevel >= ch.levelReq) {
      state.chapter = ch.id;
      document.body.setAttribute('data-chapter', state.chapter);
      renderChapter();
    }
  }

  function checkChapterObjective() {
    const ch = CHAPTERS.find((c) => c.id === state.chapter);
    if (!ch || !ch.objective || (state.completedChapters || []).includes(state.chapter)) return;
    if (state.credits >= ch.objective.credits && state.playerLevel >= ch.objective.level) {
      (state.completedChapters = state.completedChapters || []).push(state.chapter);
      if (ch.bonus) state.chapterBonuses['ch' + state.chapter] = ch.bonus;
      showChapterCompleteModal();
    }
  }

  function completeChapterAndContinue() {
    hideChapterCompleteModal();
    renderAll();
  }

  function processContrats() {
    state.contrats = state.contrats.filter((c) => !c.done);
  }

  function chooseAgencyEventOption(ev, option) {
    state.agencyEventChoice = option;
    state.agencyEventEndsAt = Date.now() + (option.duration || 60) * 1000;
    hideAgencyEventModal();
  }

  function maybeAgencyEvent() {
    if (state.agencyEventChoice && state.agencyEventEndsAt > Date.now()) return;
    if (state.playerLevel < 15) return;
    if (Math.random() > 0.002) return;
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
    QUEST_DEFS.forEach((q) => {
      if (state.completedQuests.includes(q.id)) return;
      if (q.target()) {
        state.completedQuests.push(q.id);
        if (q.reward && q.reward.xp) addXP(q.reward.xp);
      }
    });
  }

  function doPrestige() {
    if (!canPrestige()) return;
    const repGain = Math.floor(Math.sqrt(state.credits / PRESTIGE_THRESHOLD));
    state.reputation += repGain;
    state.credits = 0;
    state.upgrades.forEach((u) => (u.quantity = 0));
    state.offices.forEach((o) => (o.quantity = 0));
    state.branding.forEach((b) => (b.quantity = 0));
    state.managers.forEach((m) => (m.quantity = 0));
    state.intlOffices.forEach((o) => (o.quantity = 0));
    state.training.forEach((t) => (t.quantity = 0));
    state.contrats = [];
    state.rnd.forEach((r) => (r.purchased = false));
    state.playerLevel = 1;
    state.playerXP = 0;
    state.levelBonuses = {};
    state.completedQuests = [];
    state.purchasedPrestigeBonuses = state.purchasedPrestigeBonuses || [];
    state.chapter = 1;
    state.completedChapters = [];
    document.body.setAttribute('data-chapter', '1');
    state.activeEvent = null;
    state.agencyEventChoice = null;
    state.employees = [];
    state.recruitmentContracts = [];
    state.errorModalEmployeeId = null;
    state.nextErrorRollAt = 0;
    generateRecruitmentContracts();
    endEvent();
    scheduleNextEvent();
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
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return (m > 0 ? m + ' min ' : '') + s + ' s';
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function save() {
    try {
      const payload = {
        credits: state.credits,
        clickPower: state.clickPower,
        playerLevel: state.playerLevel,
        playerXP: state.playerXP,
        levelBonuses: state.levelBonuses,
        upgrades: state.upgrades,
        offices: state.offices,
        branding: state.branding,
        managers: state.managers,
        intlOffices: state.intlOffices,
        training: state.training,
        contrats: state.contrats,
        rnd: state.rnd,
        chapterBonuses: state.chapterBonuses,
        completedQuests: state.completedQuests,
        chapter: state.chapter,
        completedChapters: state.completedChapters,
        reputation: state.reputation,
        prestigeBonuses: state.prestigeBonuses,
        purchasedPrestigeBonuses: state.purchasedPrestigeBonuses,
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
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      state.lastSave = Date.now();
    } catch (e) {
      console.warn('Save failed', e);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.credits === 'number') state.credits = data.credits;
      if (typeof data.clickPower === 'number') state.clickPower = data.clickPower;
      if (typeof data.playerLevel === 'number') state.playerLevel = data.playerLevel;
      if (typeof data.playerXP === 'number') state.playerXP = data.playerXP;
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
      if (data.chapterBonuses) state.chapterBonuses = data.chapterBonuses;
      if (typeof data.reputation === 'number') state.reputation = data.reputation;
      if (Array.isArray(data.managers)) data.managers.forEach((s) => { const ms = getManagerState(s.id); if (ms && typeof s.quantity === 'number') ms.quantity = s.quantity; });
      if (Array.isArray(data.intlOffices)) data.intlOffices.forEach((s) => { const os = getIntlOfficeState(s.id); if (os && typeof s.quantity === 'number') os.quantity = s.quantity; });
      if (Array.isArray(data.training)) data.training.forEach((s) => { const ts = getTrainingState(s.id); if (ts && typeof s.quantity === 'number') ts.quantity = s.quantity; });
      if (Array.isArray(data.contrats)) state.contrats = data.contrats;
      if (Array.isArray(data.rnd)) data.rnd.forEach((s) => { const rs = getRndState(s.id); if (rs && typeof s.purchased === 'boolean') rs.purchased = s.purchased; });
      if (typeof data.bestRunCredits === 'number') state.bestRunCredits = data.bestRunCredits;
      if (Array.isArray(data.purchasedPrestigeBonuses)) state.purchasedPrestigeBonuses = data.purchasedPrestigeBonuses;
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
    } catch (e) {
      console.warn('Load failed', e);
    }
  }

  function showLevelUpModal() {
    const modal = document.getElementById('levelup-modal');
    const levelEl = document.getElementById('levelup-level');
    const choicesEl = document.getElementById('levelup-choices');
    if (!modal || !levelEl || !choicesEl) return;
    levelEl.textContent = state.playerLevel;
    const pool = [...LEVEL_BONUSES].sort(() => Math.random() - 0.5).slice(0, 3);
    choicesEl.innerHTML = '';
    pool.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'levelup-choice';
      btn.innerHTML = '<span class="choice-name">' + escapeHtml(b.name) + '</span><span class="choice-desc">' + escapeHtml(b.desc) + '</span>';
      btn.addEventListener('click', () => applyLevelBonus(b.id));
      choicesEl.appendChild(btn);
    });
    modal.hidden = false;
  }

  function hideLevelUpModal() {
    const modal = document.getElementById('levelup-modal');
    if (modal) modal.hidden = true;
  }

  function showChapterCompleteModal() {
    const modal = document.getElementById('chapter-complete-modal');
    const ch = CHAPTERS.find((c) => c.id === state.chapter);
    if (modal && ch && ch.bonus) {
      document.getElementById('chapter-complete-title').textContent = 'Chapitre ' + state.chapter + ' terminé !';
      document.getElementById('chapter-complete-bonus').textContent = 'Bonus permanent : +' + (ch.bonus.prodPercent || 0) + '% production';
      modal.hidden = false;
    }
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

  function showErrorModal(emp) {
    const modal = document.getElementById('error-modal');
    if (!modal || !emp) return;
    document.getElementById('error-modal-message').textContent = getRandomErrorMessage();
    document.getElementById('error-modal-name').textContent = emp.name + ' (' + (EMPLOYEE_TYPE_LABELS[emp.type] || emp.type) + ')';
    modal.setAttribute('data-employee-id', emp.id);
    modal.hidden = false;
  }

  function hideErrorModal() {
    const modal = document.getElementById('error-modal');
    if (modal) modal.hidden = true;
  }

  function renderRecruitmentContracts() {
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
    (state.recruitmentContracts || []).forEach((c, i) => {
      const canSign = canAfford(c.cost) && canRecruitMore();
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card contract-card';
      card.disabled = !canSign;
      card.innerHTML =
        '<span class="name">' + escapeHtml(c.name) + ' — ' + (EMPLOYEE_TYPE_LABELS[c.type] || c.type) + '</span>' +
        '<span class="desc">' + c.prodPerSec + ' créd/s · Erreur ' + (c.errorChance * 100).toFixed(1) + '%/min · ' + escapeHtml(c.trait) + '</span>' +
        '<div class="row"><span class="count">Coût</span><span class="price' + (canSign ? '' : ' too-expensive') + '">' + formatNumber(c.cost) + ' crédits</span></div>';
      card.addEventListener('click', () => signRecruitmentContract(i));
      container.appendChild(card);
    });
  }

  function renderEmployeesList() {
    const container = document.getElementById('employees-list');
    if (!container) return;
    container.innerHTML = '';
    const mentorsWithSlots = (state.employees || []).filter((m) => (m.type === 'junior' || m.type === 'senior') && (m.mentorSlots || 0) > (m.menteesIds || []).length);
    (state.employees || []).forEach((emp) => {
      const row = document.createElement('div');
      row.className = 'employee-row' + (emp.hasError ? ' has-error' : '');
      const mentor = emp.mentorId ? getEmployee(emp.mentorId) : null;
      const mentorLabel = mentor ? mentor.name : '—';
      let assignHtml = '';
      if (emp.type === 'stagiaire' || emp.type === 'junior') {
        if (mentorsWithSlots.length > 0 && !emp.mentorId) {
          const availableMentors = mentorsWithSlots.filter((m) => m.id !== emp.id);
          assignHtml = availableMentors.length > 0 ? '<select class="assign-mentor-select" data-mentee-id="' + emp.id + '"><option value="">Assigner à...</option>' +
            availableMentors.map((m) => '<option value="' + m.id + '">' + escapeHtml(m.name) + ' (' + (EMPLOYEE_TYPE_LABELS[m.type] || m.type) + ')</option>').join('') + '</select>' : '';
        } else if (emp.mentorId) {
          assignHtml = '<button type="button" class="btn-unassign" data-id="' + emp.id + '">Retirer du mentor</button>';
        }
      }
      row.innerHTML =
        '<div class="employee-info">' +
        '<span class="employee-name">' + escapeHtml(emp.name) + '</span>' +
        '<span class="employee-type">' + (EMPLOYEE_TYPE_LABELS[emp.type] || emp.type) + '</span>' +
        '<span class="employee-stats">' + emp.prodPerSec + ' créd/s · ' + (emp.errorChance * 100).toFixed(1) + '% err · ' + escapeHtml(emp.trait || '') + '</span>' +
        (emp.hasError ? '<span class="employee-status error">En erreur</span>' : '<span class="employee-status ok">OK</span>') +
        (emp.menteesIds && emp.menteesIds.length > 0 ? '<span class="employee-mentees">Équipe: ' + emp.menteesIds.length + '/' + (emp.mentorSlots || 0) + '</span>' : '') +
        '<span class="employee-mentor">Mentor: ' + escapeHtml(mentorLabel) + '</span>' +
        assignHtml +
        '</div>' +
        '<div class="employee-actions">' +
        '<button type="button" class="btn-licencier" data-id="' + emp.id + '">Licencier</button>' +
        '</div>';
      container.appendChild(row);
      row.querySelector('.btn-licencier')?.addEventListener('click', function () { licencierEmployee(this.getAttribute('data-id')); });
      row.querySelector('.btn-unassign')?.addEventListener('click', function () { unassignMentee(this.getAttribute('data-id')); });
      row.querySelector('.assign-mentor-select')?.addEventListener('change', function () {
        const mentorId = this.value;
        const menteeId = this.getAttribute('data-mentee-id');
        if (mentorId && menteeId) assignMentee(mentorId, menteeId);
      });
    });
  }

  function renderCredits() {
    try {
      const el = document.getElementById('credits');
      const incomeEl = document.getElementById('income');
      if (!el && !incomeEl) return;
      const credits = (typeof state.credits === 'number' && !isNaN(state.credits)) ? state.credits : 0;
      let prod = 0;
      try {
        prod = getProductionPerSecond();
      } catch (e) {
        console.warn('getProductionPerSecond error', e);
      }
      if (el) el.textContent = formatNumber(credits);
      if (incomeEl) incomeEl.textContent = formatNumber(typeof prod === 'number' && !isNaN(prod) ? prod : 0);
    } catch (err) {
      console.error('renderCredits error', err);
    }
  }

  function renderLevel() {
    const levelEl = document.getElementById('level');
    const xpFill = document.getElementById('xp-fill');
    if (levelEl) levelEl.textContent = state.playerLevel;
    if (xpFill) {
      const pct = (state.playerXP / getXpToNextLevel()) * 100;
      xpFill.style.width = Math.min(100, pct) + '%';
    }
  }

  function renderReputation() {
    const stat = document.getElementById('reputation-stat');
    const el = document.getElementById('reputation');
    if (state.reputation > 0) {
      if (stat) stat.hidden = false;
      if (el) el.textContent = formatNumber(state.reputation);
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
    if (timerEl) timerEl.textContent = 'Fin dans ' + formatDuration(left);
    if (left <= 0) endEvent();
  }

  function renderChapter() {
    const ch = CHAPTERS.find((c) => c.id === state.chapter);
    const el = document.getElementById('chapter-badge');
    if (el && ch) el.textContent = 'Chapitre ' + state.chapter + ' : ' + ch.name;
    document.body.setAttribute('data-chapter', state.chapter);
  }

  function renderQuests() {
    const container = document.getElementById('quests-list');
    if (!container) return;
    container.innerHTML = '';
    QUEST_DEFS.forEach((q) => {
      const done = state.completedQuests.includes(q.id);
      const div = document.createElement('div');
      div.className = 'quest-item' + (done ? ' done' : '');
      div.innerHTML = '<span>' + escapeHtml(q.name) + '</span><span class="quest-progress">' + (done ? '✓ Fait' : 'En cours') + '</span>';
      container.appendChild(div);
    });
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
      if (def.promoteTo && us.quantity >= (def.promoteCost || 10)) {
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
    const container = document.getElementById('managers-list');
    if (!container) return;
    container.innerHTML = '';
    MANAGER_DEFS.forEach((def) => {
      const ms = getManagerState(def.id) || { quantity: 0 };
      const unlocked = isLevelUnlocked(def.levelReq);
      const maxed = def.maxQty && ms.quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, ms.quantity);
      const affordable = maxed || canAfford(price);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card' + (!unlocked ? ' locked' : '');
      card.setAttribute('data-manager', def.id);
      card.disabled = !unlocked || maxed || !affordable;
      card.innerHTML = '<span class="name">' + escapeHtml(def.name) + (unlocked ? '' : ' (Niv.' + def.levelReq + ')') + '</span><span class="desc">' + escapeHtml(def.desc) + '</span><div class="row"><span class="count">' + (maxed ? '✓ Max' : ms.quantity + '/' + (def.maxQty || '∞')) + '</span><span class="price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price) + ' crédits') + '</span></div>';
      if (unlocked && !maxed) card.addEventListener('click', () => buyManager(def.id));
      container.appendChild(card);
    });
  }

  function renderIntlOffices() {
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
    const container = document.getElementById('training-list');
    if (!container) return;
    container.innerHTML = '';
    TRAINING_DEFS.forEach((def) => {
      const ts = getTrainingState(def.id) || { quantity: 0 };
      const maxed = def.maxQty && ts.quantity >= def.maxQty;
      const price = maxed ? 0 : getPrice(def, ts.quantity);
      const affordable = maxed || canAfford(price);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card';
      card.setAttribute('data-training', def.id);
      card.disabled = maxed || !affordable;
      card.innerHTML = '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">' + escapeHtml(def.desc) + '</span><div class="row"><span class="count">' + (maxed ? '✓ Acheté' : '') + '</span><span class="price' + (affordable ? '' : ' too-expensive') + '">' + (maxed ? '—' : formatNumber(price) + ' crédits') + '</span></div>';
      if (!maxed) card.addEventListener('click', () => buyTraining(def.id));
      container.appendChild(card);
    });
  }

  function renderContrats() {
    const container = document.getElementById('contrats-list');
    if (!container) return;
    container.innerHTML = '';
    CONTRAT_DEFS.forEach((def) => {
      if (!isLevelUnlocked(def.levelReq)) return;
      const active = state.contrats.find((c) => c.id === def.id && !c.done);
      const card = document.createElement('div');
      card.className = 'contrat-card';
      if (active) {
        const left = Math.max(0, (active.endsAt - Date.now()) / 1000);
        const canClaim = left <= 0;
        card.innerHTML = '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">' + (canClaim ? 'Terminé !' : 'En cours : ' + formatDuration(left)) + '</span><button type="button" class="contrat-claim" ' + (canClaim ? '' : 'disabled') + '>' + (canClaim ? 'Récupérer ' + formatNumber(def.invest * def.rewardMult) + ' crédits' : 'En attente') + '</button>';
        card.querySelector('.contrat-claim')?.addEventListener('click', () => claimContrat(active));
      } else {
        const affordable = canAfford(def.invest);
        card.innerHTML = '<span class="name">' + escapeHtml(def.name) + '</span><span class="desc">Investis ' + formatNumber(def.invest) + ', récupère ' + formatNumber(def.invest * def.rewardMult) + ' après ' + def.duration + 's</span><button type="button" class="contrat-start" ' + (affordable ? '' : 'disabled') + '>Démarrer</button>';
        card.querySelector('.contrat-start')?.addEventListener('click', () => startContrat(def.id));
      }
      container.appendChild(card);
    });
  }

  function renderRnd() {
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
      const attr = type === 'upgrade' ? 'data-upgrade' : type === 'office' ? 'data-office' : type === 'branding' ? 'data-branding' : type === 'manager' ? 'data-manager' : type === 'intl' ? 'data-intl' : type === 'training' ? 'data-training' : null;
      if (!attr) return;
      container.querySelectorAll('.upgrade-card[' + attr + ']').forEach((card) => {
        const cardId = attr ? card.getAttribute(attr) : null;
        if (!cardId) return;
        const def = getDef(cardId);
        const st = getState(cardId) || { quantity: 0 };
        const quantity = st.quantity;
        const maxed = def && def.maxQty && quantity >= def.maxQty;
        const price = maxed ? 0 : getPrice(def, quantity);
        const affordable = maxed || canAfford(price);
        const levelOk = levelOkCheck(def);
        card.disabled = !levelOk || (!maxed && !affordable);
        const priceEl = card.querySelector('.price');
        if (priceEl) priceEl.classList.toggle('too-expensive', !affordable && !maxed);
      });
    });
  }

  function buyPrestigeBonus(id) {
    const def = PRESTIGE_BONUSES.find((b) => b.id === id);
    if (!def || state.reputation < def.cost || state.purchasedPrestigeBonuses.includes(id)) return;
    state.reputation -= def.cost;
    state.purchasedPrestigeBonuses.push(id);
    Object.keys(def.effect).forEach((key) => {
      state.prestigeBonuses[key] = (state.prestigeBonuses[key] || 0) + def.effect[key];
    });
    renderReputationShop();
    renderReputation();
  }

  function renderReputationShop() {
    const container = document.getElementById('reputation-list');
    if (!container) return;
    container.innerHTML = '';
    PRESTIGE_BONUSES.forEach((def) => {
      const owned = state.purchasedPrestigeBonuses.includes(def.id);
      const affordable = state.reputation >= def.cost;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card';
      card.disabled = owned || !affordable;
      card.innerHTML =
        '<span class="name">' + escapeHtml(def.name) + '</span>' +
        '<div class="row">' +
        '<span class="count">' + (owned ? '✓ Acheté' : def.cost + ' Réputation') + '</span>' +
        '<span class="price' + (affordable && !owned ? '' : ' too-expensive') + '">' + (owned ? '—' : 'Acheter') + '</span>' +
        '</div>';
      if (!owned) card.addEventListener('click', () => buyPrestigeBonus(def.id));
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
    btn.disabled = !can;
    if (can) {
      const rep = Math.floor(Math.sqrt(state.credits / PRESTIGE_THRESHOLD));
      desc.textContent = 'Reset et gagne ' + formatNumber(rep) + ' Réputation. Tu perds tout sauf niveau, XP et réputation.';
    } else {
      desc.textContent = 'Atteins ' + formatNumber(PRESTIGE_THRESHOLD) + ' crédits pour débloquer le Rebranding.';
    }
  }

  function renderAll() {
    renderCredits();
    renderLevel();
    renderClickValue();
    renderReputation();
    renderChapter();
    renderQuests();
    renderRecruitmentContracts();
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
  }

  function gameLoop(now) {
    try {
    const dt = Math.min((now - lastTick) / 1000, 1);
    lastTick = now;

    const prod = getProductionPerSecond();
    const inc = (typeof prod === 'number' && !isNaN(prod) ? prod : 0) * dt;
    state.credits = (typeof state.credits === 'number' && !isNaN(state.credits) ? state.credits : 0) + inc;
    addXP(prod * dt * XP_PER_CREDIT);

    if (state.activeEvent && state.eventEndsAt && Date.now() >= state.eventEndsAt) endEvent();
    if (state.agencyEventChoice && state.agencyEventEndsAt <= Date.now()) state.agencyEventChoice = null;
    const nowMs = Date.now();
    (state.employees || []).forEach((emp) => {
      if (emp.hasError && nowMs >= emp.errorUntil) {
        emp.hasError = false;
        emp.errorUntil = 0;
        if (state.errorModalEmployeeId === emp.id) {
          state.errorModalEmployeeId = null;
          hideErrorModal();
        }
      }
    });
    if (state.errorModalEmployeeId && !getEmployee(state.errorModalEmployeeId)?.hasError) {
      state.errorModalEmployeeId = null;
      hideErrorModal();
    }
    if (nowMs >= state.nextErrorRollAt && (state.employees || []).length > 0) {
      state.nextErrorRollAt = nowMs + ERROR_ROLL_INTERVAL_MS;
      rollEmployeeErrors();
    }
    renderEventTimer();
    maybeTriggerEvent();
    maybeAgencyEvent();
    checkQuests();
    checkChapter();
    checkChapterObjective();
    processContrats();

    if (state.credits > state.bestRunCredits) state.bestRunCredits = state.credits;

    renderLevel();
    renderContrats();
    updateUpgradesAffordability();
    renderPrestige();

    if (Date.now() - state.lastSave > 5000) save();
    } catch (err) {
      console.error('Game loop error:', err);
    }
    renderCredits();
  }

  function onCodeClick() {
    addCredits(state.clickPower);
  }

  function initTabs() {
    const showTab = (tabName) => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tabName));
      document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + tabName));
    };
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.getAttribute('data-tab')));
    });
    showTab('employes');
  }

  function init() {
    load();
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

    initTabs();
    sanitizeEmployeesMentorship();
    renderAll();
    renderCredits();

    requestAnimationFrame(() => {
      renderCredits();
      gameLoop(performance.now());
    });
    document.getElementById('chapter-complete-ok')?.addEventListener('click', completeChapterAndContinue);
    document.getElementById('error-modal-pardonner')?.addEventListener('click', function () {
      const id = document.getElementById('error-modal')?.getAttribute('data-employee-id');
      if (id) pardonnerEmployee(id);
    });
    document.getElementById('error-modal-licencier')?.addEventListener('click', function () {
      const id = document.getElementById('error-modal')?.getAttribute('data-employee-id');
      if (id) { licencierEmployee(id); hideErrorModal(); }
    });
    document.getElementById('recruitment-refresh-btn')?.addEventListener('click', refreshRecruitmentContracts);

    const btnCode = document.getElementById('btn-code');
    if (btnCode) btnCode.addEventListener('click', onCodeClick);

    const actionBtn = document.getElementById('event-action-btn');
    if (actionBtn) actionBtn.addEventListener('click', onEventAction);

    const btnPrestige = document.getElementById('btn-prestige');
    if (btnPrestige) btnPrestige.addEventListener('click', doPrestige);

    setInterval(() => gameLoop(performance.now()), TICK_MS);
    setInterval(renderCredits, 150);
    window.addEventListener('beforeunload', save);
  }

  function sanitizeEmployeesMentorship() {
    (state.employees || []).forEach((emp) => {
      if (emp.mentorId === emp.id) {
        emp.mentorId = null;
      }
      if (Array.isArray(emp.menteesIds)) {
        emp.menteesIds = emp.menteesIds.filter((id) => id !== emp.id);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

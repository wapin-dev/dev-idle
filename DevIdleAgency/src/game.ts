/**
 * Logique du jeu DevIdle Agency (version starter : credits, prod, upgrades legacy)
 * Compatible avec le state existant pour merge futur avec le jeu complet.
 */
import type { GameState, UpgradeState, UserProgress } from './types';

const TICK_MS = 100;
const XP_PER_CLICK = 1;
const XP_PER_CREDIT = 0.001;

const UPGRADE_DEFS = [
  { id: 'stagiaire', name: 'Stagiaire', desc: 'Code des trucs. Parfois.', basePrice: 15, priceGrowth: 1.12, production: 0.5, type: 'producer' as const },
  { id: 'dev', name: 'Développeur', desc: 'Fait des merges. Parfois des bons.', basePrice: 50, priceGrowth: 1.18, production: 3, type: 'producer' as const },
  { id: 'devSenior', name: 'Développeur senior', desc: 'Sait où est le bug sans lire le code.', basePrice: 100, priceGrowth: 1.24, production: 20, type: 'producer' as const },
];

let state: GameState = getInitialState();

function getInitialState(): GameState {
  return {
    credits: 0,
    xp: 0,
    playerLevel: 1,
    upgrades: UPGRADE_DEFS.map((u) => ({ id: u.id, quantity: 0 })),
    employees: [],
    recruitmentContracts: [],
    lastSave: 0,
  };
}

function getUpgradeState(id: string): UpgradeState | undefined {
  return state.upgrades.find((u) => u.id === id);
}

function ensureUpgrade(id: string): void {
  if (!getUpgradeState(id)) {
    state.upgrades.push({ id, quantity: 0 });
  }
}

function getUpgradeDef(id: string) {
  return UPGRADE_DEFS.find((u) => u.id === id);
}

export function getPrice(def: { basePrice: number; priceGrowth?: number }, quantity: number): number {
  return Math.floor(def.basePrice * Math.pow(def.priceGrowth ?? 1.15, quantity));
}

export function canAfford(price: number): boolean {
  return state.credits >= price;
}

function employeeProduction(): number {
  return state.employees.reduce((sum, e) => {
    if (!e.isActive || e.hasError) return sum;
    return sum + (e.prodPerSec ?? 0);
  }, 0);
}

export function getProductionPerSecond(): number {
  let total = employeeProduction();
  UPGRADE_DEFS.forEach((def) => {
    const us = getUpgradeState(def.id);
    if (!us || def.type !== 'producer') return;
    total += (def.production ?? 0) * us.quantity;
  });
  return total;
}

export function getClickPower(): number {
  return 1 + Math.floor(state.playerLevel / 5);
}

export function getXpForNextLevel(): number {
  return (state.playerLevel * 100) + (state.playerLevel * state.playerLevel * 10);
}

export function addXP(amount: number): void {
  state.xp += amount;
  const xpForLevel = (state.playerLevel * 100) + (state.playerLevel * state.playerLevel * 10);
  if (state.xp >= xpForLevel) {
    state.xp -= xpForLevel;
    state.playerLevel += 1;
  }
}

export function buyUpgrade(id: string): boolean {
  const def = getUpgradeDef(id);
  if (!def) return false;
  ensureUpgrade(id);
  const us = getUpgradeState(id)!;
  const price = getPrice(def, us.quantity);
  if (!canAfford(price)) return false;
  state.credits -= price;
  us.quantity += 1;
  addXP(price * XP_PER_CREDIT);
  return true;
}

export function addCredits(amount: number): void {
  state.credits += amount;
}

export function tick(deltaMs: number): void {
  const prod = getProductionPerSecond();
  state.credits += (prod * deltaMs) / 1000;
}

export function getState(): GameState {
  return state;
}

export function setState(s: Partial<GameState>): void {
  state = { ...getInitialState(), ...state, ...s };
  if (s.upgrades) state.upgrades = s.upgrades;
  if (s.employees) state.employees = s.employees;
  if (s.recruitmentContracts) state.recruitmentContracts = s.recruitmentContracts;
}

/** Pour la sauvegarde : extrait l’état sérialisable (UserProgress) */
export function getProgress(): UserProgress {
  return {
    credits: state.credits,
    xp: state.xp,
    playerLevel: state.playerLevel,
    upgrades: [...state.upgrades],
    employees: [...state.employees],
    recruitmentContracts: [...state.recruitmentContracts],
    lastSave: Date.now(),
  };
}

/** Restaure l’état depuis une sauvegarde */
export function loadProgress(data: Partial<UserProgress> | null): void {
  if (!data) return;
  if (typeof data.credits === 'number') state.credits = data.credits;
  if (typeof data.xp === 'number') state.xp = data.xp;
  if (typeof data.playerLevel === 'number') state.playerLevel = data.playerLevel;
  if (Array.isArray(data.upgrades)) state.upgrades = data.upgrades;
  if (Array.isArray(data.employees)) state.employees = data.employees;
  if (Array.isArray(data.recruitmentContracts)) state.recruitmentContracts = data.recruitmentContracts;
}

export function onButtonClick(): void {
  addCredits(getClickPower());
  addXP(XP_PER_CLICK);
}

export { UPGRADE_DEFS, TICK_MS };

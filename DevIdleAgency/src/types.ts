/**
 * Types pour DevIdle Agency – alignés avec la logique du jeu
 */

export interface UpgradeState {
  id: string;
  quantity: number;
}

export interface Employe {
  id: string;
  type: 'stagiaire' | 'junior' | 'senior';
  name: string;
  prodPerSec: number;
  errorChance: number;
  trait: string;
  level: number;
  xp: number;
  isActive: boolean;
  hasError: boolean;
  errorUntil: number;
  menteesIds: string[];
  mentorId: string | null;
  mentorSlots: number;
}

export interface RecruitmentContract {
  type: Employe['type'];
  name: string;
  prodPerSec: number;
  errorChance: number;
  trait: string;
  cost: number;
}

export interface UserProgress {
  credits: number;
  xp: number;
  playerLevel: number;
  upgrades: UpgradeState[];
  employees: Employe[];
  recruitmentContracts: RecruitmentContract[];
  lastSave: number;
  [key: string]: unknown;
}

export interface GameState {
  credits: number;
  xp: number;
  playerLevel: number;
  upgrades: UpgradeState[];
  employees: Employe[];
  recruitmentContracts: RecruitmentContract[];
  lastSave: number;
}

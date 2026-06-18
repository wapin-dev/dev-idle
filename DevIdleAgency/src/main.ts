/**
 * Point d'entrée DevIdle Agency
 * Pour l'instant : affichage du jeu complet (game.js) avec le thème actif.
 * Le login sera réactivé plus tard.
 */
import '../style.css';
import { getIconPath, getIconUrl, getFallbackIconPath } from './icons';
import { supabase } from './supabase';
import { loadProgress, saveProgress } from './storage';
import type { UserProgress } from './types';

const SAVE_KEY = 'agence-dev-idle-save-v4';
// const SYNC_THROTTLE_MS = 2 * 60 * 1000; // 2 min entre chaque envoi serveur

function init(): void {
  document.body.classList.add('game-active');
  // Icônes 100 % locales (Game-icons style), exposées pour game.js
  window.getIconUrl = getIconUrl;
  window.getIconPath = getIconPath;
  window.getFallbackIconPath = getFallbackIconPath;
  const fallback = getFallbackIconPath();
  const setIcon = (el: HTMLImageElement | null, name: string) => {
    if (el) {
      el.src = getIconPath(name);
      el.dataset.fallback = fallback;
    }
  };
  setIcon(document.querySelector<HTMLImageElement>('#header-coin-icon'), 'money-bag');
  setIcon(document.querySelector<HTMLImageElement>('.prestige-btn-icon'), 'refresh');
  document.querySelectorAll<HTMLImageElement>('.nav-icon.game-icon[data-icon]').forEach((img) => {
    const name = img.getAttribute('data-icon');
    if (name) setIcon(img, name);
  });
  setIcon(document.querySelector<HTMLImageElement>('.nav-click-icon'), 'flash');
  setIcon(document.querySelector<HTMLImageElement>('.btn-deconnexion-icon'), 'logout');
  setIcon(document.querySelector<HTMLImageElement>('.recruitment-refresh-icon'), 'refresh');
  document.body.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.fallback) img.src = img.dataset.fallback;
  }, true);
}

function exposeSyncToServer(): void {
  (window as unknown as { devIdleSyncToServer?: (payload: UserProgress) => Promise<void> }).devIdleSyncToServer =
    async (payload: UserProgress) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await saveProgress(user.id, payload);
    };
}

function chooseBestProgress(
  server: Partial<UserProgress> | null,
  localRaw: string | null
): string | null {
  if (!server || typeof server !== 'object' || Object.keys(server).length === 0) return localRaw;
  if (!localRaw) return JSON.stringify(server);
  let local: Partial<UserProgress> & { lastSave?: number };
  try {
    local = JSON.parse(localRaw) as Partial<UserProgress> & { lastSave?: number };
  } catch {
    return localRaw;
  }
  const serverLevel = typeof server.playerLevel === 'number' ? server.playerLevel : 0;
  const localLevel = typeof local.playerLevel === 'number' ? local.playerLevel : 0;
  if (localLevel > serverLevel) return localRaw;
  if (serverLevel > localLevel) return JSON.stringify(server);
  const serverSave = typeof server.lastSave === 'number' ? server.lastSave : 0;
  const localSave = typeof local.lastSave === 'number' ? local.lastSave : 0;
  return localSave >= serverSave ? localRaw : JSON.stringify(server);
}

async function bootAsync(): Promise<void> {
  init();
  exposeSyncToServer();
  const localRaw = localStorage.getItem(SAVE_KEY);
  let serverData: Partial<UserProgress> | null = null;
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    try {
      serverData = await loadProgress(user.id);
    } catch (e) {
      console.warn('Chargement progression serveur:', e);
    }
  }
  const toWrite = chooseBestProgress(serverData, localRaw);
  if (toWrite != null) localStorage.setItem(SAVE_KEY, toWrite);
  // Charge le jeu après que les icônes soient exposées (game.js utilise window.getIconUrl)
  const script = document.createElement('script');
  script.src = '/game.js';
  script.async = false;
  document.body.appendChild(script);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bootAsync(); });
} else {
  bootAsync();
}

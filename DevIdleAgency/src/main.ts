/**
 * Point d'entrée DevIdle Agency.
 *
 * La v1 est 100 % hors ligne : aucune authentification, aucune synchronisation
 * serveur, la partie vit dans le localStorage. Ce module se contente d'exposer
 * les icônes locales puis de charger la logique de jeu (public/game.js), qui a
 * besoin de window.getIconUrl au moment où elle s'exécute.
 */
import '../style.css';
import { getIconPath, getIconUrl, getFallbackIconPath } from './icons';

function exposeIcons(): void {
  document.body.classList.add('game-active');
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
  setIcon(document.querySelector<HTMLImageElement>('.recruitment-refresh-icon'), 'refresh');

  // Une icône manquante ne doit pas laisser un carré cassé à l'écran.
  document.body.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.fallback) img.src = img.dataset.fallback;
  }, true);
}

function boot(): void {
  exposeIcons();
  const script = document.createElement('script');
  script.src = '/game.js';
  script.async = false;
  document.body.appendChild(script);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

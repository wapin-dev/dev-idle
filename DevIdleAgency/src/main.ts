/**
 * Point d'entrée DevIdle Agency
 * Pour l'instant : affichage du jeu complet (game.js) avec le thème actif.
 * Le login sera réactivé plus tard.
 */
import '../style.css';
import { getIconPath, getIconUrl, getFallbackIconPath } from './icons';

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

function boot(): void {
  init();
  // Charge le jeu après que les icônes soient exposées (game.js utilise window.getIconUrl)
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

/**
 * Point d'entrée DevIdle Agency.
 *
 * La v1 est 100 % hors ligne : aucune authentification, aucune synchronisation
 * serveur, la partie vit dans le localStorage. Ce module se contente d'exposer
 * les icônes locales puis de charger la logique de jeu (public/game.js), qui a
 * besoin de window.getIconUrl au moment où elle s'exécute.
 */
import '../style.css';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
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

/**
 * Bouton retour Android.
 *
 * Sans gestionnaire, le retour quitte l'application depuis n'importe quel
 * écran — y compris une modale ouverte. On dépile dans l'ordre attendu :
 * modale, puis onglet, puis mise en arrière-plan.
 *
 * On passe par le DOM plutôt que par l'état de game.js : celui-ci est chargé
 * par une balise <script> et n'expose rien. Les sélecteurs utilisés sont ceux
 * de index.html (`.modal-overlay`, `.modal-close`, `.tab-btn`).
 */
function handleBackButton(): void {
  // Les modales à choix obligatoire (montée de niveau, événement d'agence)
  // n'ont pas de bouton de fermeture : le retour ne doit pas les contourner.
  const openModals = document.querySelectorAll<HTMLElement>('.modal-overlay:not([hidden])');
  const topModal = openModals[openModals.length - 1];
  if (topModal) {
    if (topModal.classList.contains('modal-require-choice')) return;
    topModal.querySelector<HTMLButtonElement>('.modal-close')?.click();
    return;
  }

  const activeTab = document.querySelector<HTMLButtonElement>('.tab-btn.active');
  if (activeTab && activeTab.getAttribute('data-tab') !== 'accueil') {
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="accueil"]')?.click();
    return;
  }

  // Depuis l'accueil : on met en arrière-plan au lieu de quitter. Le jeu
  // calcule des gains hors-ligne, sortir ne doit pas ressembler à une perte.
  void App.minimizeApp();
}

function boot(): void {
  exposeIcons();
  if (Capacitor.isNativePlatform()) {
    void App.addListener('backButton', handleBackButton);
  }
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

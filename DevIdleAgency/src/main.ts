/**
 * Point d'entrée DevIdle Agency
 * Pour l'instant : affichage du jeu complet (game.js) avec le thème actif.
 * Le login sera réactivé plus tard.
 */
import '../style.css';

function init(): void {
  // Active le thème du jeu (game.css) : fond sombre, couleurs agence
  document.body.classList.add('game-active');
  // Écran jeu déjà actif dans le HTML ; login masqué
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

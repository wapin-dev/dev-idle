# Audit logique – DevIdle Agency

Résumé de l’audit sur `public/game.js` (logique métier, cohérence, bugs potentiels).

---

## ✅ Ce qui est cohérent

- **Production** : `getProductionPerSecond()` cumule correctement employés recrutés, upgrades (stagiaire/dev/devSenior/serveur/CTO), bureaux, managers, formations, bonus de niveau/prestige/chapitre, R&D, événements. Pas de double compte.
- **Boucle** : `gameLoop` utilise un `dt` en secondes, plafonné à 1 s ; `state.credits` et XP évoluent correctement.
- **Sauvegarde / chargement** : Les champs importants sont sauvegardés et restaurés (employés, contrats, chapitres, événements d’agence, etc.). Les tableaux sont protégés (`state.employees || []`, etc.).
- **Objectifs de chapitre** : Chapitre 1 (1e9 crédits, niv. 30) et 2 (1e12, niv. 60) ont un objectif + bonus ; à la complétion, `completedChapters` et `chapterBonuses` sont mis à jour et la modale s’affiche.
- **Événement d’agence** : Quand `agencyEventEndsAt <= Date.now()`, `agencyEventChoice` est bien remis à `null` dans la boucle, donc les bonus (prod, crédits, XP) ne restent pas actifs indéfiniment.
- **Contrats** : `claimContrat` met `done: true` ; `processContrats()` retire les contrats terminés. Pas de fuite.
- **Level-up** : Un choix est requis puis « Valider » ; `pendingLevelUp` bloque bien les montées de niveau tant que la modale n’est pas validée.
- **Prestige** : Remet à zéro crédits, upgrades, bureaux, employés, chapitre, etc., et conserve `reputation`, `purchasedPrestigeBonuses`, `bestRunCredits`.

---

## ⚠️ Points d’attention (non bloquants)

1. **Paramètre `amount` de `addCredits(amount)`**  
   Il n’est jamais utilisé : le gain au clic est toujours `getClickPower()`. L’appel `addCredits(state.clickPower)` est trompeur (on envoie la base, pas le pouvoir effectif). Comportement correct, API confuse.  
   **Recommandation** : soit retirer le paramètre et documenter que le clic = `getClickPower()`, soit utiliser `amount` uniquement pour un cas spécifique (ex. bonus) et garder le clic = `getClickPower()`.

2. **Chapitre 3 sans objectif**  
   `CHAPTERS[2].objective === null` : aucun objectif ni bonus pour le chapitre 3. Soit c’est voulu (fin de progression), soit il faudrait ajouter un objectif / une récompense.

3. **Deux sources de production “employés”**  
   - **Upgrades** (stagiaire, dev, devSenior, serveur, CTO) : achetés dans la Boutique, ajoutent de la prod dans `getProductionPerSecond()`.
   - **Employés recrutés** : `state.employees` via Candidats / Équipe, `employeeProduction()`.  
   Les deux coexistent et s’additionnent. Le plafond de recrutement est `getUpgradeState('devSenior')?.quantity`. Donc pas un bug, mais deux systèmes en parallèle (slots + prod des upgrades + prod des recrus).

4. **`agencyEventEndsAt` après expiration**  
   Quand on remet `agencyEventChoice` à `null`, `agencyEventEndsAt` n’est pas remis à 0. En sauvegarde on garde une date passée. Comportement correct (on ne lit que `agencyEventChoice` pour les bonus), mais pour la clarté on peut mettre `agencyEventEndsAt = 0` en même temps que `agencyEventChoice = null`.

---

## 🔧 Correctifs appliqués (ou proposés)

- **Cohérence événement d’agence** : dans `gameLoop`, en remettant `agencyEventChoice` à `null` quand l’événement est expiré, remettre aussi `agencyEventEndsAt = 0`.
- **Nettoyage après level-up** : après `applyLevelBonus(levelUpSelectedId)`, réinitialiser `levelUpSelectedId = null` pour éviter de réutiliser l’ancien choix si la modale rouvre plus tard.

---

## Fichiers concernés

- `DevIdleAgency/public/game.js` : logique principale ; les correctifs ci-dessus y sont appliqués.

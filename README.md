# Agence de Dev Idle

Idle game 100 % HTML/CSS/JS, jouable sur mobile (navigateur ou PWA), sans framework ni moteur externe.

## Concept

- **Clicker** : clique sur « Coder une feature » pour gagner des crédits instantanés.
- **Revenu passif** : les Stagiaires et Développeurs seniors produisent des crédits chaque seconde.
- **Serveurs** : multiplicateur global sur toute la production.
- **Événements** : Client toxique (prod ÷ 2 pendant 30 s), Hackathon (prod × 2 pendant 60 s).

## Lancer le jeu

Ouvre `index.html` dans un navigateur (double-clic ou serveur local) :

```bash
# Option : servir avec un petit serveur (évite certains soucis de CORS si tu ajoutes un SW plus tard)
npx serve .
# puis http://localhost:3000
```

Sur mobile : héberge le dossier sur un serveur ou ouvre le fichier local dans Chrome/Safari.

## Fichiers

- `index.html` — structure de l’app
- `style.css` — style mobile-first, thème sombre
- `main.js` — boucle de jeu, upgrades, événements, sauvegarde `localStorage`
- `manifest.json` — PWA (tu peux ajouter des icônes plus tard)

## Sauvegarde

La partie est sauvegardée automatiquement dans le `localStorage` du navigateur (toutes les 5 s et à la fermeture).

Tu peux ensuite packager en PWA complète ou avec Capacitor/Cordova si tu veux une app native.

# DevIdle Agency

Jeu idle **mobile-first** (agence de dev), **100 % hors ligne** : TypeScript +
Vite pour la coquille, la logique de jeu dans `public/game.js`, sauvegarde dans
le `localStorage`. Empaqueté en application Android avec Capacitor.

Aucun compte, aucun serveur, aucune donnée qui sort de l'appareil.

## Lancer en développement

```bash
cd DevIdleAgency
npm install
npm run dev
```

Ouvre **http://localhost:5173**. `npm run dev` écoute aussi sur l'IP locale : le
lien **Network** affiché par Vite permet de tester depuis un téléphone sur le
même Wi-Fi.

## Build web

```bash
npm run build     # sortie dans dist/
npm run preview   # sert dist/ sur http://localhost:4173
```

## Application Android

Le projet natif est déjà généré (`android/`) et versionné. Il n'y a plus de
`cap init` ni de `cap add android` à faire.

### Prérequis

- Android Studio (fournit le SDK **et** le JDK).
- Java n'est pas sur le `PATH` par défaut sur macOS : il faut pointer `JAVA_HOME`
  sur le JDK embarqué dans Android Studio.

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

### Compiler

```bash
npm run cap:sync                      # build web + copie dans android/
cd android && ./gradlew assembleDebug # APK de debug
```

L'APK sort dans `android/app/build/outputs/apk/debug/app-debug.apk`.

Pour ouvrir le projet dans Android Studio : `npm run cap:open:android`.

### Attention : iCloud Drive

Le projet est sur le Bureau, synchronisé par iCloud. Pendant une compilation
Gradle, iCloud duplique des fichiers en `nom 2.ext`, ce qui fait échouer la
tâche `parseDebugLocalResources` :

```
Failed file name validation for file .../ic_launcher_background 2.xml
```

Nettoyage :

```bash
find . -name "* [0-9]*" -not -path "./node_modules/*" -print0 | xargs -0 rm -rf
```

La solution durable est de sortir le projet du Bureau synchronisé.

## Icônes

L'icône (chevrons de code et curseur, sur le violet de l'interface) est déclinée
dans `android/app/src/main/res/mipmap-*/` et dans `public/assets/icons/`
(`app-icon-192.png`, `app-icon-512.png`, référencées par `manifest.json`).

Le Play Store demande en plus un visuel **512 × 512** au dépôt : utiliser
`public/assets/icons/app-icon-512.png`.

## Structure

- `index.html` – toute la structure de l'interface (onglets, modales)
- `public/game.js` – **la logique du jeu** : état, boucle, production, upgrades,
  objectifs, prestige, sauvegarde (~2500 lignes, non bundlé, chargé par une
  balise `<script>` injectée depuis `main.ts`)
- `public/game.css` + `style.css` – styles ; `style.css` porte le thème actif
  (`tapstorm-theme`) et gagne sur `game.css` là où les deux se croisent
- `src/main.ts` – point d'entrée : expose les icônes, gère le bouton retour
  Android, puis charge `game.js`
- `src/icons.ts` – résolution des chemins d'icônes locales
- `capacitor.config.json` – `appId` `com.devidle.agency`, `webDir` sur `dist`

## Périmètre de la v1

Certains systèmes sont **présents dans le code mais désactivés** pour la
première version : les onglets Candidats et Équipe (donc l'arbre de compétences,
les Cadres et les Formations) et les sections International, Contrats et R&D de
l'onglet Plus.

Tout est piloté par un seul bloc en tête de `public/game.js` :
`V1_LOCKS_ENABLED`, `LOCKED_TABS`, `LOCKED_PLUS_SECTIONS`, `LOCKED_QUEST_IDS`.
Repasser `V1_LOCKS_ENABLED` à `false` rallume l'ensemble.

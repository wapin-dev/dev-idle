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

## Tests

```bash
npm test              # migrations de sauvegarde, chapitres, stagiaires, son…
npm run equilibrage   # simule une partie et date chaque chapitre
```

`npm test` n'utilise aucun framework : Node + jsdom, un seul fichier
(`tests/save-migration.test.mjs`). `game.js` étant une IIFE qui n'exporte rien,
le test la recompile en lui ajoutant un export sur `window`.

`npm run equilibrage` joue la partie en accéléré (achat glouton, 2 clics/s) et
imprime à quelle minute chaque chapitre tombe. C'est l'outil à relancer après
tout changement de coût, de palier ou de but de chapitre. Il ne modélise **pas**
le prestige : ses dates sont un plancher, pas une prévision.

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

## Publier sur le Play Store

Le Play Store attend un **AAB** (`bundleRelease`), pas un APK. L'artefact doit
être signé par une clé qui t'appartient : c'est elle qui prouve, à chaque mise à
jour, qu'il s'agit bien de la même application.

### 1. Générer la clé — une seule fois, à faire soi-même

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
"$JAVA_HOME/bin/keytool" -genkeypair -v \
  -keystore ~/cles/devidle-release.jks \
  -alias devidle \
  -keyalg RSA -keysize 2048 -validity 10000
```

`keytool` demande deux mots de passe (keystore et clé) puis quelques
informations d'identité. Choisis un emplacement **hors du dépôt** — ici
`~/cles/`.

> **Ce fichier n'est pas remplaçable.** Le perdre, ou perdre ses mots de passe,
> rend toute mise à jour de l'application impossible sur le Play Store : il faut
> alors republier sous un nouvel identifiant et repartir de zéro côté
> installations. Sauvegarde-le ailleurs que sur cette machine.

### 2. Renseigner les identifiants

```bash
cp android/keystore.properties.example android/keystore.properties
# puis remplir les quatre valeurs
```

`android/keystore.properties` et tout fichier `*.jks` / `*.keystore` sont
ignorés par git — les mots de passe ne doivent jamais entrer dans l'historique.
`storeFile` est résolu depuis le dossier `android/`, un chemin absolu marche
aussi.

### 3. Compiler

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
npm run cap:sync
cd android && ./gradlew bundleRelease
```

Sortie : `android/app/build/outputs/bundle/release/app-release.aab`.

Sans `keystore.properties`, une compilation de release s'arrête avec un message
explicite plutôt que de produire un artefact non signé que le Store refuserait.
Les compilations de debug, elles, n'ont besoin de rien.

### 4. Remplir la fiche

Tout ce que la console réclame est prêt dans `store/` : l'icône 512×512, le
bandeau 1024×500, six captures en 1080×1920, les textes de la fiche
(`fiche-play-store.md`) et les réponses aux questionnaires « sécurité des
données » et « classification du contenu » (`console-play-reponses.md`).

Un point reste à faire une fois, hors du dépôt : la console exige une **URL
publique de politique de confidentialité**. Le document existe
(`docs/confidentialite.html`, à la racine du dépôt) ; il suffit d'activer GitHub
Pages sur la branche `main`, dossier `/docs`, dans *Settings → Pages*. L'adresse
devient alors :

```
https://wapin-dev.github.io/dev-idle/confidentialite.html
```

### 5. À chaque nouvelle version

Incrémenter `versionCode` (entier, strictement croissant, invisible pour le
joueur) et `versionName` (la version affichée) dans
`android/app/build.gradle`. Le Store refuse deux dépôts avec le même
`versionCode`.

### Vérifier la signature d'un artefact

```bash
"$JAVA_HOME/bin/keytool" -printcert -jarfile app-release.aab
```

## Icônes

L'icône (chevrons de code et curseur, sur le violet de l'interface) est déclinée
dans `android/app/src/main/res/mipmap-*/` et dans `public/assets/icons/`
(`app-icon-192.png`, `app-icon-512.png`, référencées par `manifest.json`).

Le Play Store demande en plus un visuel **512 × 512** au dépôt : utiliser
`public/assets/icons/app-icon-512.png`.

## Structure

- `index.html` – toute la structure de l'interface (onglets, modales)
- `public/game.js` – **la logique du jeu** : état, boucle, chapitres,
  production, upgrades, arbre de compétences, stagiaires, objectifs, événements,
  son, prestige, sauvegarde (~5200 lignes, non bundlé, chargé par une balise
  `<script>` injectée depuis `main.ts`)
- `public/game.css` + `style.css` – styles ; `style.css` porte le thème actif
  (`tapstorm-theme`) et gagne sur `game.css` là où les deux se croisent
- `src/main.ts` – point d'entrée : expose les icônes, gère le bouton retour
  Android, puis charge `game.js`
- `src/icons.ts` – résolution des chemins d'icônes locales
- `capacitor.config.json` – `appId` `com.devidle.agency`, `webDir` sur `dist`
- `store/` – visuels et textes de la fiche Play Store (voir `store/README.md`)
- `tools/equilibrage.mjs` – le simulateur d'économie
- `../docs/confidentialite.html` – la politique de confidentialité publiée

## Périmètre de la v1

Certains systèmes sont **présents dans le code mais désactivés** pour la
première version : les onglets Candidats et Équipe (donc les Cadres et les
Formations) et les sections International, Contrats et R&D de l'onglet Plus.

Tout est piloté par un seul bloc en tête de `public/game.js` :
`V1_LOCKS_ENABLED`, `LOCKED_TABS`, `LOCKED_PLUS_SECTIONS`, `LOCKED_QUEST_IDS`.
Repasser `V1_LOCKS_ENABLED` à `false` rallume l'ensemble.

L'arbre de compétences, lui, **n'est plus derrière ce verrou** : il a quitté
l'onglet Équipe, remplace les bonus de montée de niveau et s'ouvre par un
chapitre. Les onglets qu'un chapitre ouvre apparaissent en cours de partie ; ils
sont masqués par `hidden`, et `public/game.css` pose explicitement
`.tapstorm-nav .tab-btn[hidden] { display: none !important }` — dans ce projet,
`hidden` seul ne suffit presque jamais, plusieurs règles le battent en
spécificité.

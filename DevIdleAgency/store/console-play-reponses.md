# Console Play Store — les réponses à cocher

Ces réponses viennent du code, pas d'une supposition. Chacune est vérifiable
dans le dépôt ; la source est indiquée.

---

## Sécurité des données

> Votre application collecte-t-elle ou partage-t-elle des données utilisateur ?

**Non.**

- Aucune requête réseau : l'authentification Supabase a été retirée le
  2026-08-30, et le lien Google Fonts le 2026-08-31. L'application ne charge
  rien depuis Internet.
- Aucun outil de mesure d'audience, aucune régie publicitaire, aucun SDK tiers.
  Vérifiable : `package.json` ne contient que Vite, TypeScript, Capacitor et
  jsdom.
- La partie est enregistrée dans le stockage local de la WebView, sous la clé
  `agence-dev-idle-save-v4`, et n'en sort jamais.

> Les données sont-elles chiffrées en transit ?

Sans objet, aucune donnée n'est transmise.

> L'utilisateur peut-il demander la suppression de ses données ?

Oui : « Réinitialiser la partie » dans l'écran Réglages, ou la désinstallation.

---

## Classification du contenu (questionnaire IARC)

Répondre **non** à toutes les questions sur :

- la violence, réaliste ou stylisée
- le sang, l'horreur, la peur
- le contenu sexuel ou la nudité
- le langage grossier
- les drogues, l'alcool, le tabac
- les jeux d'argent, réels ou simulés
- les interactions entre utilisateurs, le chat, le partage de position
- les achats intégrés
- le contenu généré par les utilisateurs

**Point à ne pas mal cocher.** La promo de stagiaires est un tirage aléatoire
entre trois candidats. Ce n'est **pas** un jeu d'argent simulé : rien ne se
mise, aucune monnaie ne s'achète avec de l'argent réel, et le tirage ne
reproduit ni machine à sous ni casino. Répondre non.

Classification attendue : **PEGI 3 / ESRB Everyone**.

---

## Public cible

Tout public. L'application ne vise pas spécifiquement les enfants, mais rien
n'en interdit l'accès : aucune collecte, aucune publicité, aucun achat.

---

## Publicités

> Votre application contient-elle des publicités ?

**Non.**

---

## Achats intégrés

Aucun. Aucune facturation n'est intégrée, `com.android.vending.BILLING` n'est
pas déclaré.

---

## Politique de confidentialité

URL à renseigner, une fois GitHub Pages activé sur la branche `main`, dossier
`/docs` :

```
https://wapin-dev.github.io/dev-idle/confidentialite.html
```

Source : `docs/confidentialite.html` à la racine du dépôt.

---

## Autorisations Android

**Vérifié le 2026-09-02** dans `android/app/src/main/AndroidManifest.xml` :
`INTERNET` est la seule déclarée, et elle vient du modèle Capacitor. La WebView
la demande pour charger ses propres fichiers locaux ; la laisser est sans
conséquence sur la déclaration de collecte.

Vérifié en même temps, à l'appui du « non » plus haut : aucun `fetch`, aucun
`XMLHttpRequest`, aucun `WebSocket`, aucun `sendBeacon` dans `public/game.js`,
`src/` ni `index.html`, et le `dist/` produit ne référence aucune adresse
externe hors commentaires.

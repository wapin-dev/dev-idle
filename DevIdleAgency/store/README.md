# Visuels et textes de la fiche Play Store

Tout ce que la console demande, prêt à envoyer.

| Fichier | Usage | Format exigé |
|---|---|---|
| `icone-512.png` | icône de la fiche | 512×512 PNG |
| `bandeau-1024x500.png` | visuel de bandeau | 1024×500 PNG |
| `captures/*.png` | captures téléphone | 2 à 8, rapport max 2:1 |
| `fiche-play-store.md` | nom, descriptions, catégorie | — |
| `console-play-reponses.md` | sécurité des données, classification | — |

## Les captures

Elles sont en **1080×1920** (9:16). Le format 412×915 en double densité utilisé
pendant le développement donne 824×1830, soit 2,22:1 : **Google le refuse**, la
limite étant 2:1.

Elles sont produites depuis le jeu réel, avec des sauvegardes calibrées, par un
script qui pilote Chrome. Pour les régénérer après un changement d'interface,
le script vit dans le scratchpad de la session ; l'essentiel tient en trois
points : semer la sauvegarde depuis l'origine `localhost:5173`, forcer
`Emulation.setDeviceMetricsOverride` à 360×640 en densité 3, et figer les
animations éphémères avant `Page.captureScreenshot`.

## Le bandeau

Il réutilise le **vrai** SVG de la scène, extrait du DOM du jeu en cours plutôt
que redessiné : une illustration faite à la main mentirait sur ce que le joueur
verra en installant.

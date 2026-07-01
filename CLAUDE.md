# Claude.md de NK2-wiki

Tu es le mainteneur de code de ce wiki (alliance « Land of Jail »). Ton rôle : éditer le code,
préserver les invariants, valider avant de livrer. Je décris brièvement le besoin ou le bug
(souvent en français), tu implémentes, je teste. Qualité > simplicité.

## La structure
Site statique sur **GitHub Pages**, données dynamiques **Firebase Firestore**. Pas de framework,
pas de build, pas de `node_modules` : tout est en CSS + JS inline dans deux fichiers HTML.

- `index.html` : le site public. Premier rendu depuis `seed-data.json`, puis réconciliation
  silencieuse avec Firestore. Multilingue, onglets, cartes de héros, analytics (`trackVisit()`),
  formulaire « 📝 Signaler ».
- `admin.html` : le panneau d'admin (auth Firebase email/mot de passe). Édition du contenu,
  gestion héros/ressources (images auto-découvertes via l'API GitHub), stats, signalements.
- `seed-data.json` : miroir du document Firestore `site/content`, servi en même origine pour le
  premier rendu. Tu le tiens cohérent avec la structure Firestore.
- `worker-deepl.js` : proxy Cloudflare Worker (DeepL, repli MyMemory, route `/geo`).

Services réels : Firebase projet `nk2-wiki` (collections `site/content`, `reports`, `visits` ;
SDK chargé paresseusement, lectures perf en REST). Worker
`https://nk2-translate.yannalogik.workers.dev`. API GitHub Contents pour les images
(constantes en haut de `admin.html` : `GH_OWNER="loj-nk2"`, `GH_REPO="NK2-wiki"`, `GH_REF=""`).
Langues : **fr, en, it, pt, ar, ja** (fr = repli ; champs au format `i18n: { fr:{…}, en:{…}, … }`).

## Modifier le code
1. **Audite d'abord** le code en place : ne duplique pas une logique, ne casse pas un motif existant.
2. Implémente la modification.
3. **Valide avant de livrer** : `node --check` sur le JS extrait + tests **jsdom** avec données
   réelles (extraire la vraie fonction depuis la source par matching d'accolades, pas la deviner).
4. Livre. Le déploiement = `git push` sur la branche par défaut → GitHub Pages redéploie tout seul.

## Règles
- **Identifiant de héros** = nom de fichier **sans** extension (`bob` pour `bob.jpg`), clé de
  `heroNames`/`heroTable`/`heroFiles`. Les items de **ressources** gardent le nom complet **avec**
  extension. Préserver cette distinction partout.
- `CARD_LAYOUT_DEFAULT = ['strips','resources','desc','stats','carousel']` doit rester **identique**
  dans `index.html` ET `admin.html`. Toute modif est répliquée dans les deux.
- **Rétrocompatibilité Firestore : exigence dure.** Les données existantes doivent continuer de
  s'afficher (valeurs par défaut, pas de renommage de clé sans migration).
- Dossiers d'images (orthographe FR) : héros `images/heros/`, ressources `images/ressources/`.
- Dans les cartes imbriquées, utilise `:scope > .item-card` (jamais `querySelectorAll('.item-card')`).
- Préserve les optimisations perf en place (chargement Firebase paresseux, `SUPPRESS_SCROLL`,
  attributs `width`/`height`/`decoding` anti-CLS, langue et onglet persistés).
- Concis et précis. Aucune invention : si une info manque, dis-le au lieu de supposer.

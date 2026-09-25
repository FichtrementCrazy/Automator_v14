# BlockFlow Automator

Éditeur d'automatisation Windows 10/11 par blocs, inspiré de Scratch.

## Fonctionnalités

- Souris : clic gauche/droit/molette, double-clic, déplacement, défilement.
- Coordonnées souris en pixels physiques Windows, compatibles avec l'échelle DPI ; capture de position en plaçant la souris puis en appuyant sur **Ctrl**.
- Clavier : touche simple, saisie de texte, raccourcis avec jusqu'à 3 modificateurs (Ctrl, Alt, Windows, Maj) + une touche finale.
- Fenêtres : activer, fermer, attendre, tester l'existence, titre actif.
- Processus, lancement de programmes, variables, conditions, boucles, journal.
- Expressions « valeur directe / variable » dans les champs compatibles.
- Éditeur avec glisser-déposer, imbrications, annuler/rétablir et barre de défilement verticale/horizontale.
- Enregistrement rééditable en `.json`.
- Export d'une **tâche autonome `.blockflow.cmd`** : double-clic sous Windows pour exécuter le workflow sans ouvrir l'éditeur. Le fichier embarque le workflow et n'a besoin que de PowerShell intégré à Windows.

## Compiler sous GitHub Actions

Le workflow `.github/workflows/build-windows.yml` compile l'application en Windows x64. Le build n'effectue pas de publication automatique : `electron-builder` est appelé avec `--publish=never`.

Créer une release :

```bash
git tag v0.4.0
git push origin v0.4.0
```

## Développement local

```bash
npm install
npm start
```

Build Windows :

```bash
npm run build:win
```

## Version 0.4.0
- Clics, double-clics et molette via helper C# `SendInput`, sans instanciation de structures Win32 depuis PowerShell.
- Coordonnées souris lues dans le même espace de coordonnées physiques que l'exécution, avec DPI per-monitor v2.
- Valeurs de champs : `Valeur`, `Variable` ou `Calcul`.
- Calculs imbriqués : `+`, `-`, `*`, `/`, `%`, puissance.
- Les calculs peuvent utiliser des variables et d'autres calculs dans tous les champs d'expression compatibles.

### 0.4.3
Correction du lanceur `.blockflow.cmd` : il utilise désormais explicitement `%~f0` via la variable d’environnement `BF_SELF`, ce qui fonctionne avec un double-clic sans dépendre de `$args[0]`.


## 0.4.3

- Fiabilisation des clics souris avec SendInput + fallback mouse_event et vérification de la position.
- Raccourcis Bureau lancés explicitement via cmd.exe.
- Tâches autonomes `.blockflow.cmd` avec journal `.blockflow.log` en cas d’erreur.


### 0.4.3

La souris utilise `SetCursorPos` + `mouse_event`. Les tâches autonomes `.blockflow.cmd` utilisent un chargeur PowerShell `-EncodedCommand` et enregistrent les erreurs dans un fichier `.blockflow.log` adjacent.

## Version 0.5.0

- Lancement d’un programme par nom/commande, fichier choisi via Parcourir, ou programme système Windows.
- Catalogue intégré : Explorateur, Bloc-notes, Calculatrice, Paint, Gestionnaire des tâches, CMD, PowerShell, Paramètres, Panneau de configuration, Capture d’écran.
- Nouveaux blocs par nom de processus : Activer, Fermer et Attendre un programme. Les blocs basés sur les titres de fenêtres sont conservés.
- Glisser-déposer dans les zones imbriquées fiabilisé avec interception de propagation et zone « Déposer à la fin ».
- Barre de défilement verticale explicitement activée dans l’espace de code.

## Utilisation des nouveaux blocs programme

Le bloc « Lancer un programme » propose trois modes : nom/commande, fichier (avec « Parcourir les fichiers ») et programme système. Les blocs « Activer un programme », « Fermer un programme » et « Attendre un programme » utilisent le nom du processus Windows, par exemple `notepad` ou `notepad.exe`. Les blocs basés sur le titre de fenêtre restent disponibles en parallèle.


## Version 0.5.1

### Correctif de défilement de l’éditeur
- La palette de blocs conserve sa propre zone de défilement et sa hauteur.
- L’éditeur central possède maintenant son propre défilement vertical, uniquement lorsque le workflow dépasse la hauteur disponible.
- Le conteneur de la grille et les panneaux ont `min-height: 0` pour empêcher le workflow de modifier la taille intrinsèque de la palette.
- Le zoom de l’éditeur utilise désormais `zoom` au lieu de `transform: scale(...)`, afin que la taille réelle du contenu soit correctement prise en compte par la zone de défilement.


## Version 0.5.2

Les blocs Fenêtre / Programme sont désormais unifiés. Pour **Activer**, **Fermer**, **Attendre** et **Tester**, le paramètre **Cible** permet de choisir entre **Titre de fenêtre** et **Nom du programme**. Le bloc **Tester une fenêtre / un programme** écrit un booléen `True` ou `False` dans la variable indiquée. Le bloc **Lire le titre actif** peut lire soit la fenêtre active, soit la fenêtre principale d’un programme choisi. Les anciens blocs programme sont migrés automatiquement vers ce nouveau modèle.


## Version 0.6.1

Correctif important de l’export autonome `.cmd` : le moteur autonome utilise désormais un interpréteur PowerShell fixe qui lit le workflow JSON encodé en Base64, ce qui évite les erreurs dues à la génération dynamique du code. La détection des raccourcis clavier est rendue plus défensive et l’export ne dépend plus des guillemets, apostrophes ou accents présents dans les blocs.



- Condition **Touche / raccourci détecté** avec jusqu’à 3 modificateurs (Ctrl, Alt, Windows, Maj) + une touche finale.
- Deux comportements : **Attendre l’appui** (déclenche la branche du `Si`, puis attend le relâchement) ou **Tester maintenant**.
- Détection globale Windows via `GetAsyncKeyState`, utilisable aussi dans les tâches autonomes `.blockflow.cmd`.
- Correction majeure du round-trip JSON : les workflows modernes ne voient plus leurs paramètres réécrits avec les valeurs par défaut lors du rechargement. Cela concerne notamment les délais avec unités, les raccourcis à 3 modificateurs et les paramètres des boucles.
- Les sélecteurs de variables des blocs utilisent désormais correctement leur valeur après modification, y compris **Modifier une variable**.
- Le format de workflow passe à la version 7.
- Ajout d’un test automatisé `npm run test:roundtrip` qui vérifie que les paramètres représentatifs restent identiques après normalisation.

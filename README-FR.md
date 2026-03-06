# RVSQ Bot Web V3

## Ce que cette V3 apporte
- Frontend V3 avec événements en direct par SSE
- Historique persistant côté backend
- Profils persistants côté backend
- Backend navigateur avec Playwright
- Moteur structuré: démarrer, pause, reprendre, stop

## Important
Cette V3 est la bonne base d'architecture, mais je ne prétends pas qu'elle est déjà validée contre le site réel.
Le point à terminer est l'intégration fine des sélecteurs et de l'analyse des créneaux.

## Déploiement
### Backend sur Render
- Root Directory: backend
- Build Command: npm install
- Start Command: npm start

### Frontend sur Netlify
- Dépose le dossier frontend
- Dans le site, entre l'URL du backend Render dans le champ prévu

## Remarque
Le backend utilise Playwright.
Selon l'hébergeur, il peut être nécessaire d'ajuster l'environnement ou le plan pour exécuter Chromium correctement.

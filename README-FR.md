# RVSQ Bot Web - Guide rapide

## Contenu
- `frontend/` : interface web statique à héberger sur GitHub Pages ou Netlify
- `backend/` : serveur Node.js à héberger sur Render

## Déploiement rapide
1. Crée un dépôt GitHub.
2. Dépose le contenu du zip dans ce dépôt.
3. Déploie `backend/` sur Render comme Web Service.
4. Récupère l'URL Render, par exemple `https://mon-backend.onrender.com`.
5. Ouvre `frontend/index.html` et remplace `http://localhost:3000` par ton URL Render si tu veux une valeur par défaut.
6. Déploie `frontend/` sur GitHub Pages ou Netlify.
7. Ouvre le site et utilise l'interface.

## Important
Cette base fournit l'architecture et un moteur simulé.

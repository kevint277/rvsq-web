import express from "express";
import cors from "cors";
import { runtime, db, addHistory, saveProfile } from "./store.js";

const app = express();
app.use(cors());
app.use(express.json());

function statusText() {
  if (runtime.running && runtime.paused) return "En pause";
  if (runtime.running) return "En cours";
  if (runtime.lastAction === "Arrêté") return "Arrêté";
  return "Prêt";
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend RVSQ V2 prêt" });
});

app.get("/status", (req, res) => {
  res.json({
    status: statusText(),
    state: {
      ...runtime,
      historyCount: db.history.length,
      profileCount: db.profiles.size
    }
  });
});

app.get("/history", (req, res) => {
  res.json({ items: db.history });
});

app.post("/profiles/save", (req, res) => {
  const profile = req.body?.profile || {};
  const id = saveProfile(profile);
  res.json({ ok: true, profileId: id, message: "Profil sauvegardé" });
});

app.get("/profiles", (req, res) => {
  res.json({ items: Array.from(db.profiles.values()) });
});

app.post("/start", (req, res) => {
  const profile = req.body?.profile || {};
  const profileId = saveProfile(profile);
  runtime.running = true;
  runtime.paused = false;
  runtime.startedAt = new Date().toISOString();
  runtime.lastAction = "Démarré";
  runtime.profileId = profileId;
  db.sessions.push({ startedAt: runtime.startedAt, profileId });
  addHistory("info", "Démarrage du bot", { profileId });
  res.json({
    status: "Démarré",
    note: "Backend V2 branché. Le vrai moteur d'automatisation reste à connecter.",
    state: runtime
  });
});

app.post("/pause", (req, res) => {
  runtime.paused = true;
  runtime.lastAction = "En pause";
  addHistory("info", "Bot mis en pause");
  res.json({ status: "En pause", note: "Pause enregistrée.", state: runtime });
});

app.post("/resume", (req, res) => {
  runtime.running = true;
  runtime.paused = false;
  runtime.lastAction = "Repris";
  addHistory("info", "Bot repris");
  res.json({ status: "Repris", note: "Reprise enregistrée.", state: runtime });
});

app.post("/stop", (req, res) => {
  runtime.running = false;
  runtime.paused = false;
  runtime.lastAction = "Arrêté";
  addHistory("info", "Bot arrêté");
  res.json({ status: "Arrêté", note: "Arrêt enregistré.", state: runtime });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  addHistory("info", "Backend démarré", { port });
  console.log(`Backend RVSQ V2 en écoute sur le port ${port}`);
});

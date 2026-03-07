import express from "express";
import cors from "cors";
import { runtime, saveProfile, getHistory, getProfiles, addHistory } from "./store.js";
import { addClient, removeClient, broadcast } from "./events.js";
import { BrowserEngine } from "./engine.js";

const app = express();
app.use(cors());
app.use(express.json());

const engine = new BrowserEngine();
let startInFlight = false;

function statusText() {
  if (runtime.running && runtime.paused) return "En pause";
  if (runtime.lastAction === "Créneau trouvé") return "Créneau trouvé";
  if (runtime.running) return "En cours";
  if (runtime.lastAction === "Arrêté") return "Arrêté";
  return "Prêt";
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend RVSQ V3 prêt" });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  addClient(res);
  res.write(`data: ${JSON.stringify({ kind: "status", status: statusText(), lastAction: runtime.lastAction })}\n\n`);
  req.on("close", () => removeClient(res));
});

app.get("/status", (req, res) => {
  res.json({
    status: statusText(),
    state: runtime
  });
});

app.get("/history", (req, res) => {
  res.json({ items: getHistory() });
});

app.get("/profiles", (req, res) => {
  res.json({ items: getProfiles() });
});

app.post("/profiles/save", (req, res) => {
  const profile = req.body?.profile || {};
  const id = saveProfile(profile);
  res.json({ ok: true, profileId: id, profile: getProfiles().find(p => p.id === id) || null, message: "Profil sauvegardé" });
});

app.post("/start", async (req, res) => {
  const profile = req.body?.profile || {};
  const id = saveProfile(profile);
  runtime.profileId = id;

  if (startInFlight || (runtime.running && !runtime.paused)) {
    return res.status(409).json({ status: "Déjà en cours", state: runtime });
  }

  startInFlight = true;
  res.json({
    status: "Démarrage en cours",
    note: "Le moteur démarre en arrière-plan serveur. Suivre le journal pour l'avancement.",
    state: runtime
  });

  Promise.resolve()
    .then(async () => {
      try {
        await engine.start(profile);
      } catch (err) {
        addHistory("error", `Échec du démarrage: ${err.message}`);
        broadcast({ kind: "error", message: `Échec du démarrage: ${err.message}` });
        runtime.running = false;
        runtime.paused = false;
        runtime.lastAction = "Erreur";
        broadcast({ kind: "status", status: statusText(), lastAction: runtime.lastAction });
      } finally {
        startInFlight = false;
      }
    });
});

app.post("/pause", async (req, res) => {
  try {
    await engine.pause();
    res.json({ status: "En pause", state: runtime });
  } catch (err) {
    res.status(409).json({ status: "Erreur", error: err.message, state: runtime });
  }
});

app.post("/resume", async (req, res) => {
  try {
    await engine.resume();
    res.json({ status: "Repris", state: runtime });
  } catch (err) {
    res.status(409).json({ status: "Erreur", error: err.message, state: runtime });
  }
});

app.post("/stop", async (req, res) => {
  await engine.stop();
  res.json({ status: "Arrêté", state: runtime });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  addHistory("info", "Backend démarré", { port });
  console.log(`Backend RVSQ V3 en écoute sur le port ${port}`);
});

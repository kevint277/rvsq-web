import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

let state = {
  running: false,
  paused: false,
  lastAction: "Prêt",
  startedAt: null,
  profile: null
};

app.get("/", (req, res) => {
  res.json({ ok: true, message: "RVSQ backend prêt" });
});

app.get("/status", (req, res) => {
  res.json({
    status: state.running ? (state.paused ? "En pause" : "En cours") : "Prêt",
    state
  });
});

app.post("/start", (req, res) => {
  state.running = true;
  state.paused = false;
  state.startedAt = new Date().toISOString();
  state.lastAction = "Démarré";
  state.profile = req.body?.profile || null;
  res.json({ status: "Démarré", note: "Moteur simulé prêt à être remplacé par le vrai moteur." });
});

app.post("/pause", (req, res) => {
  state.paused = true;
  state.lastAction = "En pause";
  res.json({ status: "En pause" });
});

app.post("/resume", (req, res) => {
  state.paused = false;
  state.lastAction = "Repris";
  res.json({ status: "Repris" });
});

app.post("/stop", (req, res) => {
  state.running = false;
  state.paused = false;
  state.lastAction = "Arrêté";
  res.json({ status: "Arrêté" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend RVSQ en écoute sur le port ${port}`);
});

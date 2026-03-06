import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";

const dataPath = path.resolve(process.cwd(), "data", "db.json");

function ensureDbFile() {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify({
      profiles: {},
      history: [],
      sessions: [],
      found: []
    }, null, 2), "utf-8");
  }
}
ensureDbFile();

function readDb() {
  ensureDbFile();
  return JSON.parse(fs.readFileSync(dataPath, "utf-8"));
}
function writeDb(db) {
  fs.writeFileSync(dataPath, JSON.stringify(db, null, 2), "utf-8");
}

export const runtime = {
  running: false,
  paused: false,
  startedAt: null,
  lastAction: "Prêt",
  profileId: null,
  currentUrl: "",
  step: "idle"
};

export function addHistory(type, message, extra = {}) {
  const db = readDb();
  db.history.push({
    id: nanoid(),
    ts: new Date().toISOString(),
    type,
    message,
    ...extra
  });
  db.history = db.history.slice(-300);
  writeDb(db);
}

export function saveProfile(profile) {
  const db = readDb();
  const key = profile?.nam || `profil-${Date.now()}`;
  db.profiles[key] = { ...profile, savedAt: new Date().toISOString() };
  writeDb(db);
  addHistory("info", "Profil enregistré", { nam: profile?.nam || "" });
  return key;
}

export function getHistory() {
  return readDb().history;
}
export function getProfiles() {
  return Object.values(readDb().profiles);
}
export function addSession(session) {
  const db = readDb();
  db.sessions.push(session);
  db.sessions = db.sessions.slice(-100);
  writeDb(db);
}
export function addFound(item) {
  const db = readDb();
  db.found.push(item);
  db.found = db.found.slice(-100);
  writeDb(db);
  addHistory("found", item.message || "Créneau trouvé");
}

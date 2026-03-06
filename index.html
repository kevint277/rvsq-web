import { nanoid } from "nanoid";

export const runtime = {
  running: false,
  paused: false,
  startedAt: null,
  lastAction: "Prêt",
  profileId: null
};

export const db = {
  profiles: new Map(),
  history: [],
  sessions: []
};

export function addHistory(type, message, extra = {}) {
  db.history.push({
    id: nanoid(),
    ts: new Date().toISOString(),
    type,
    message,
    ...extra
  });
  if (db.history.length > 200) db.history.shift();
}

export function saveProfile(profile) {
  const key = profile?.nam || `profil-${Date.now()}`;
  db.profiles.set(key, { ...profile, savedAt: new Date().toISOString() });
  addHistory("info", "Profil enregistré", { nam: profile?.nam || "" });
  return key;
}

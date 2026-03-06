import { chromium } from "playwright";
import { runtime, addHistory, addSession, addFound } from "./store.js";
import { broadcast } from "./events.js";
import { siteConfig } from "./site-config.js";

function emit(kind, message, extra = {}) {
  if (kind === "log") addHistory(extra.type || "info", message, extra);
  broadcast({ kind, message, ...extra });
}

function birthParts(iso) {
  const [year, month, day] = String(iso || "").split("-");
  return { year: year || "", month: month || "", day: day || "" };
}

export class BrowserEngine {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.loopTimer = null;
    this.profile = null;
  }

  async start(profile) {
    this.profile = profile;
    runtime.running = true;
    runtime.paused = false;
    runtime.startedAt = new Date().toISOString();
    runtime.lastAction = "Démarré";
    runtime.step = "launch";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    addSession({ startedAt: runtime.startedAt, profileId: profile?.nam || "" });

    await this.ensureBrowser(profile);
    await this.login(profile);
    await this.prepareSearch(profile);
    this.startLoop(profile);
  }

  async ensureBrowser(profile) {
    if (this.browser) return;
    emit("log", "Lancement du navigateur serveur");
    this.browser = await chromium.launch({
      headless: String(profile?.headless ?? "true") !== "false"
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.on("console", msg => emit("log", `console: ${msg.text()}`));
    this.page.on("pageerror", err => emit("error", `Erreur page: ${err.message}`));
    this.page.on("response", res => {
      if (res.status() >= 400) emit("log", `HTTP ${res.status()} ${res.url()}`, { type: "warn" });
    });
  }

  async login(profile) {
    runtime.step = "auth";
    runtime.lastAction = "Initialisation de la session";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Ouverture de la page RVSQ");

    await this.page.goto(siteConfig.homeUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    runtime.currentUrl = this.page.url();
    emit("log", `URL courante: ${runtime.currentUrl}`);

    const { day, month, year } = birthParts(profile.birthDate);
    await this.fillIf(siteConfig.selectors.firstName, profile.firstName);
    await this.fillIf(siteConfig.selectors.lastName, profile.lastName);
    await this.fillIf(siteConfig.selectors.nam, profile.nam);
    await this.fillIf(siteConfig.selectors.seq, profile.seq);
    await this.fillIf(siteConfig.selectors.day, day);
    await this.selectIf(siteConfig.selectors.month, month);
    await this.fillIf(siteConfig.selectors.year, year);

    if (profile.gender === "F") await this.clickIf(siteConfig.selectors.genderFemale);
    else await this.clickIf(siteConfig.selectors.genderMale);

    emit("log", "Formulaire patient rempli");
    // Important: on évite ici toute logique de contournement agressive.
    // On clique simplement sur le premier bouton principal disponible.
    await this.page.locator(siteConfig.selectors.primaryButton).first().click({ timeout: 30000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
    runtime.currentUrl = this.page.url();
    emit("log", `Après authentification: ${runtime.currentUrl}`);

    if (!runtime.currentUrl.includes(siteConfig.rechercheUrlPart)) {
      emit("error", "La page de recherche n'a pas été atteinte. Une validation manuelle des sélecteurs est probablement nécessaire.");
    } else {
      emit("log", "Page de recherche atteinte");
    }
  }

  async prepareSearch(profile) {
    runtime.step = "prepare-search";
    runtime.lastAction = "Préparation de la recherche";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });

    const reasonLabel = siteConfig.reasonMap[profile.reasonCode] || siteConfig.reasonMap.urgent;
    await this.selectByTextIf(siteConfig.selectors.consultingReason, reasonLabel);
    if (profile.postalCode) await this.fillIf(siteConfig.selectors.postalCode, profile.postalCode);
    await this.selectByValueIf(siteConfig.selectors.perimeter, String(profile.perimeterKm || "50"));
    emit("log", `Recherche préparée: raison=${reasonLabel} rayon=${profile.perimeterKm || "50"}km`);
  }

  startLoop(profile) {
    const intervalMs = Math.max(2, Number(profile.intervalSeconds || 5)) * 1000;
    runtime.step = "loop";
    runtime.lastAction = "Boucle de recherche";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", `Boucle de recherche active, intervalle ${intervalMs / 1000}s`);

    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = setInterval(async () => {
      if (!runtime.running || runtime.paused) return;
      try {
        await this.searchOnce(profile);
      } catch (err) {
        emit("error", `Erreur moteur: ${err.message}`);
      }
    }, intervalMs);
  }

  async searchOnce(profile) {
    emit("log", "Tentative de recherche");
    runtime.lastAction = "Recherche en cours";
    // Ici, il faudrait brancher le vrai clic de recherche et l'analyse des créneaux.
    // Dans cette V3, on laisse une base propre sans affirmer un faux support complet.
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    if (/créneau|rendez-vous disponible|heure disponible/i.test(bodyText)) {
      const message = "Un créneau potentiel a été détecté. Vérifie la page ou branche l'analyse détaillée des cartes.";
      runtime.lastAction = "Créneau trouvé";
      addFound({ ts: new Date().toISOString(), message });
      emit("found", message);
      emit("status", "Créneau trouvé", { status: "Créneau trouvé", lastAction: runtime.lastAction });
    } else {
      emit("log", "Aucun créneau confirmé détecté dans cette passe");
    }
  }

  async pause() {
    runtime.paused = true;
    runtime.lastAction = "En pause";
    emit("status", "En pause", { status: "En pause", lastAction: runtime.lastAction });
    emit("log", "Moteur en pause");
  }

  async resume() {
    runtime.running = true;
    runtime.paused = false;
    runtime.lastAction = "Repris";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Moteur repris");
  }

  async stop() {
    runtime.running = false;
    runtime.paused = false;
    runtime.lastAction = "Arrêté";
    runtime.step = "stopped";
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
    emit("status", "Arrêté", { status: "Arrêté", lastAction: runtime.lastAction });
    emit("log", "Moteur arrêté");
  }

  async fillIf(selector, value) {
    if (!value) return;
    const loc = this.page.locator(selector).first();
    if (await loc.count()) await loc.fill(String(value));
  }
  async clickIf(selector) {
    const loc = this.page.locator(selector).first();
    if (await loc.count()) await loc.click().catch(() => {});
  }
  async selectIf(selector, value) {
    if (!value) return;
    const loc = this.page.locator(selector).first();
    if (await loc.count()) await loc.selectOption(String(value)).catch(() => {});
  }
  async selectByValueIf(selector, value) {
    if (!value) return;
    const loc = this.page.locator(selector).first();
    if (await loc.count()) await loc.selectOption({ value: String(value) }).catch(() => {});
  }
  async selectByTextIf(selector, text) {
    if (!text) return;
    const loc = this.page.locator(selector).first();
    if (!(await loc.count())) return;
    const options = await loc.locator("option").evaluateAll(nodes => nodes.map(n => ({ value: n.value, text: n.textContent?.trim() || "" })));
    const match = options.find(o => o.text.toLowerCase() === text.toLowerCase()) || options.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (match?.value != null) await loc.selectOption(match.value).catch(() => {});
  }
}

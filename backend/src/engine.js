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

// Script injecté dans chaque page pour masquer les traces headless/webdriver
const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "plugins", {
    get: () => {
      const arr = [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
        { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
      ];
      arr.__proto__ = PluginArray.prototype;
      return arr;
    },
  });
  Object.defineProperty(navigator, "languages", { get: () => ["fr-CA", "fr", "en-CA", "en"] });
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }
};

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
    const loginOk = await this.login(profile);
    if (!loginOk) return;
    await this.prepareSearch(profile);
    this.startLoop(profile);
  }

  async ensureBrowser(profile) {
    if (this.browser) return;
    emit("log", "Lancement du navigateur serveur");

    this.browser = await chromium.launch({
      headless: String(profile?.headless ?? "true") !== "false",
      chromiumSandbox: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "fr-CA",
      timezoneId: "America/Toronto",
      extraHTTPHeaders: {
        "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7",
      },
    });

    // Inject stealth script avant tout JS de la page
    await this.context.addInitScript(STEALTH_SCRIPT);

    this.page = await this.context.newPage();

    this.page.on("console", msg => {
      const text = msg.text();
      // Filtre le bruit Cloudflare (invisible à l'utilisateur mais pollue les logs)
      if (
        text.includes("font-size:0") ||
        text.includes("Private Access Token") ||
        text.includes("console.groupEnd") ||
        text.includes("preloaded using link preload")
      ) return;
      emit("log", `console: ${text}`);
    });
    this.page.on("pageerror", err => emit("error", `Erreur page: ${err.message}`));
    this.page.on("response", res => {
      const status = res.status();
      const url = res.url();
      // Ignore les ressources internes Cloudflare
      if (url.includes("cloudflare.com") || url.includes("cdn-cgi")) return;
      if (status >= 400) emit("log", `HTTP ${status} ${url}`, { type: "warn" });
    });
  }

  // Retourne true si la page affiche un défi Cloudflare
  async isCloudflareChallenge() {
    const url = this.page.url();
    if (url.includes("__cf_chl") || url.includes("challenges.cloudflare.com")) return true;
    const title = await this.page.title().catch(() => "");
    if (/just a moment|cloudflare|attention required/i.test(title)) return true;
    const cfEl = await this.page
      .locator("#challenge-running, #cf-challenge-running, #trk_jschal_js")
      .count()
      .catch(() => 0);
    return cfEl > 0;
  }

  // Attend que CF se résolve automatiquement (max timeoutMs)
  async waitForCloudflare(timeoutMs = 30000) {
    emit("log", "Défi Cloudflare détecté — attente de résolution automatique...", { type: "warn" });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(2000);
      if (!(await this.isCloudflareChallenge())) {
        emit("log", "Cloudflare contourné avec succès");
        return true;
      }
    }
    return false;
  }

  async login(profile) {
    runtime.step = "auth";
    runtime.lastAction = "Initialisation de la session";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Ouverture de la page RVSQ");

    await this.page.goto(siteConfig.homeUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    runtime.currentUrl = this.page.url();
    emit("log", `URL courante: ${runtime.currentUrl}`);

    // ── Gestion Cloudflare ───────────────────────────────────────────────────
    if (await this.isCloudflareChallenge()) {
      const passed = await this.waitForCloudflare(30000);
      if (!passed) {
        emit(
          "error",
          "Cloudflare n'a pas pu être contourné. Le serveur Render est bloqué par le WAF. " +
            "Option 1 : attendre quelques minutes et relancer. " +
            "Option 2 : utiliser un proxy résidentiel.",
          { type: "error" }
        );
        await this.stop();
        return false;
      }
      runtime.currentUrl = this.page.url();
      emit("log", `URL après CF: ${runtime.currentUrl}`);
    }
    // ── Fin gestion Cloudflare ───────────────────────────────────────────────

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
    await this.page.locator(siteConfig.selectors.primaryButton).first().click({ timeout: 30000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
    runtime.currentUrl = this.page.url();
    emit("log", `Après authentification: ${runtime.currentUrl}`);

    if (!runtime.currentUrl.includes(siteConfig.rechercheUrlPart)) {
      emit("error", "La page de recherche n'a pas été atteinte. Validation manuelle des sélecteurs nécessaire.");
    } else {
      emit("log", "Page de recherche atteinte");
    }

    return true;
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

    // Vérifie si CF est revenu pendant la boucle
    if (await this.isCloudflareChallenge()) {
      emit("log", "Cloudflare réapparu pendant la boucle, attente...", { type: "warn" });
      const passed = await this.waitForCloudflare(30000);
      if (!passed) {
        emit("error", "Session bloquée par Cloudflare pendant la recherche.");
        return;
      }
    }

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
    const options = await loc.locator("option").evaluateAll(nodes =>
      nodes.map(n => ({ value: n.value, text: n.textContent?.trim() || "" }))
    );
    const match =
      options.find(o => o.text.toLowerCase() === text.toLowerCase()) ||
      options.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (match?.value != null) await loc.selectOption(match.value).catch(() => {});
  }
}

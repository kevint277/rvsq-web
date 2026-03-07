/**
 * engine.js  –  v5.0
 *
 * Architecture hybride :
 *   - Playwright page.goto() pour navigation (passe CF, même IP blacklistée)
 *   - page.evaluate(fetch) pour les appels API REST (s'exécute dans le browser,
 *     même origin/TLS/cookies, CF invisible)
 *   - Champs de formulaire exacts tirés des HAR (noms ctl00$ContentPlaceHolderMP$...)
 *   - Honeypot vides (critique, détecté dans HAR)
 *
 * Flux :
 *   1. page.goto(Principale.aspx)   → passe CF, parse ViewState
 *   2. page.fill() + page.evaluate(submit) → redirect vers Recherche.aspx
 *   3. page.evaluate(fetch activelinkedconsultationReasons) → UUID raison
 *   4. Boucle : page.evaluate(fetch getClinics) → parse résultats JSON
 */

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
};

export class BrowserEngine {
  constructor() {
    this.browser   = null;
    this.context   = null;
    this.page      = null;
    this.loopTimer = null;
    this.profile   = null;
    this.reasonUid = null;
    this.searchBase = {};
  }

  // ── Démarrage ─────────────────────────────────────────────────────────────

  async start(profile) {
    this.profile = profile;
    runtime.running    = true;
    runtime.paused     = false;
    runtime.startedAt  = new Date().toISOString();
    runtime.lastAction = "Démarré";
    runtime.step = "launch";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    addSession({ startedAt: runtime.startedAt, profileId: profile?.nam || "" });

    await this.launchBrowser();
    const loginOk = await this.login(profile);
    if (!loginOk) return;
    const prepOk = await this.prepareSearch(profile);
    if (!prepOk) return;
    this.startLoop(profile);
  }

  // ── Browser ───────────────────────────────────────────────────────────────

  async launchBrowser() {
    emit("log", "Lancement du navigateur...");
    this.browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
      ],
    });
    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "fr-CA",
      timezoneId: "America/Montreal",
      extraHTTPHeaders: { "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7" },
    });
    await this.context.addInitScript(STEALTH_SCRIPT);
    this.page = await this.context.newPage();

    // Filtre le bruit CF dans les logs
    this.page.on("console", msg => {
      const t = msg.text();
      if (t.includes("font-size:0") || t.includes("Private Access Token") ||
          t.includes("console.groupEnd") || t.includes("preloaded using link preload")) return;
      emit("log", `console: ${t}`);
    });
    this.page.on("pageerror", err => emit("error", `Erreur page: ${err.message}`));
  }

  // ── Gestion Cloudflare ────────────────────────────────────────────────────

  async isCloudflareChallenge() {
    const url = this.page.url();
    if (url.includes("__cf_chl") || url.includes("challenges.cloudflare.com")) return true;
    const title = await this.page.title().catch(() => "");
    if (/just a moment|cloudflare|attention required/i.test(title)) return true;
    return (await this.page.locator("#challenge-running, #cf-challenge-running").count().catch(() => 0)) > 0;
  }

  async waitForCloudflare(timeoutMs = 30000) {
    emit("log", "Défi Cloudflare — attente...", { type: "warn" });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(2000);
      if (!(await this.isCloudflareChallenge())) {
        emit("log", "Cloudflare passé ✓"); return true;
      }
    }
    return false;
  }

  // ── Authentification (page.goto + fill + submit) ──────────────────────────

  async login(profile) {
    runtime.step = "auth";
    runtime.lastAction = "Authentification";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Ouverture de Principale.aspx...");

    await this.page.goto(siteConfig.homeUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    emit("log", `URL: ${this.page.url()} | Titre: ${await this.page.title()}`);

    if (await this.isCloudflareChallenge()) {
      const passed = await this.waitForCloudflare(30000);
      if (!passed) {
        emit("error", "Cloudflare n'a pas pu être contourné (timeout).");
        await this.stop();
        return false;
      }
    }

    const inputs = await this.page.evaluate(() =>
      [...document.querySelectorAll("input")].map(i => ({ name: i.name, id: i.id, type: i.type, value: i.value?.slice(0, 20) }))
    ).catch(() => []);
    emit("log", `Inputs trouvés: ${JSON.stringify(inputs.filter(i => i.name && i.type !== "hidden").slice(0, 15))}`);

    const { day, month, year } = birthParts(profile.birthDate);

    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_FirstName", profile.firstName);
    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_LastName", profile.lastName);
    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_NAM", this.normalizeNam(profile.nam || ""));
    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_CardSeqNumber", profile.seq);
    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_Day", day);
    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_Year", year);

    await this.page.locator(`[name="ctl00$ContentPlaceHolderMP$AssureForm_Month"]`).selectOption(month).catch(() => {});
    await this.fillByName("ctl00$ContentPlaceHolderMP$AssureForm_Month", month);
    await this.fillByName("AssureForm_Month_hidden", "");

    if (profile.gender === "F") {
      await this.page.locator("[id*='FemaleGender']").first().check().catch(() => {});
    } else {
      await this.page.locator("[id*='MaleGender']").first().check().catch(() => {});
    }

    await this.clearHoneyPots();

    const snapshot = await this.page.evaluate(() => {
      const data = {};
      for (const name of [
        "ctl00$ContentPlaceHolderMP$AssureForm_FirstName",
        "ctl00$ContentPlaceHolderMP$AssureForm_LastName",
        "ctl00$ContentPlaceHolderMP$AssureForm_NAM",
        "ctl00$ContentPlaceHolderMP$AssureForm_CardSeqNumber",
        "ctl00$ContentPlaceHolderMP$AssureForm_Day",
        "ctl00$ContentPlaceHolderMP$AssureForm_Month",
        "AssureForm_Month_hidden",
        "ctl00$ContentPlaceHolderMP$AssureForm_Year"
      ]) {
        const el = document.querySelector(`[name="${name}"]`);
        if (el) data[name] = el.value;
      }
      data.__honeyPots = [...document.querySelectorAll('input[name^="ctlhp"], textarea[name^="ctlhp"]')].map(el => ({ name: el.name, value: el.value }));
      return data;
    }).catch(() => ({}));
    emit("log", `Valeurs auth préparées: ${JSON.stringify(snapshot)}`);
    emit("log", "Formulaire rempli - soumission...");

    let submitResult = await this.trySubmitByClick();
    if (!submitResult?.reachedSearch) {
      emit("log", "Clic de soumission insuffisant, fallback POST ASP.NET...", { type: "warn" });
      submitResult = await this.submitAspNetForm();
    }

    emit("log", `Submit: ${submitResult?.method || "aucun"}`);
    const finalUrl = this.page.url();
    emit("log", `Après auth: ${finalUrl}`);

    if (!finalUrl.includes(siteConfig.rechercheUrlPart)) {
      const errorDetails = await this.getPageValidationErrors();
      emit("error", `Page de recherche non atteinte.${errorDetails ? ` Message: "${errorDetails}"` : " Vérifier les informations patient."}`);
      return false;
    }

    emit("log", "Authentification réussie ✓");
    runtime.currentUrl = finalUrl;
    return true;
  }

  // ── Préparation recherche (fetch depuis le browser) ───────────────────────

  async prepareSearch(profile) {
    runtime.step = "prepare-search";
    runtime.lastAction = "Chargement des raisons";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Chargement des raisons de consultation...");

    await this.page.waitForURL(url => url.includes(siteConfig.rechercheUrlPart), { timeout: 15000 }).catch(() => {});
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await this.page.waitForTimeout(1800);

    const domSnapshot = await this.page.evaluate(() => ({
      title: document.title,
      url: location.href,
      selects: [...document.querySelectorAll("select")].map(el => ({ name: el.name, id: el.id, options: el.options.length })),
      buttons: [...document.querySelectorAll("button, input[type='button'], input[type='submit']")].slice(0, 12).map(el => ({
        name: el.name || "",
        id: el.id || "",
        value: el.value || el.innerText || ""
      }))
    })).catch(() => null);
    if (domSnapshot) emit("log", `Recherche DOM: ${JSON.stringify(domSnapshot)}`);

    const result = await this.page.evaluate(async (baseUrl) => {
      const mkHeaders = () => ({
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json; charset=utf-8",
        "x-requested-with": "XMLHttpRequest"
      });
      const getJson = async (url) => {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: mkHeaders(),
          referrer: `${baseUrl}/prendrerendezvous/Recherche.aspx`
        });
        const text = await res.text().catch(() => "");
        let data = null;
        try { data = JSON.parse(text); } catch (_) {}
        return { status: res.status, url: res.url, text: text.slice(0, 600), data };
      };

      const ts1 = Date.now();
      const warmups = [];
      warmups.push(await getJson(`${baseUrl}/api2/ConfigValues?{"cancelLimit":1440,"ajaxTimeStamp":${ts1}}&_=${ts1 - 210}`));
      const ts2 = Date.now() + 1;
      warmups.push(await getJson(`${baseUrl}/api2//assure/CurrentFipa?{"NAM":"","lastName":"","firstName":"","gender":"","birthDate":"","cardSeqNumber":"","ajaxTimeStamp":${ts2}}&_=${ts2 - 210}`));
      const ts3 = Date.now() + 2;
      let reasons = await getJson(`${baseUrl}/api2/activelinkedconsultationReasons?{"ajaxTimeStamp":${ts3}}&_=${ts3 - 210}`);
      if (reasons.status === 403 || reasons.status === 401) {
        await new Promise(r => setTimeout(r, 1500));
        const ts4 = Date.now() + 3;
        reasons = await getJson(`${baseUrl}/api2/activelinkedconsultationReasons?{"ajaxTimeStamp":${ts4}}&_=${ts4 - 210}`);
      }
      return { warmups, reasons };
    }, siteConfig.baseUrl).catch(e => { emit("error", `Raisons: ${e.message}`); return null; });

    if (result?.warmups) {
      for (const w of result.warmups) emit("log", `Warmup API: ${w.url} -> ${w.status}`);
    }
    if (result?.reasons) emit("log", `Raisons API: ${result.reasons.url} -> ${result.reasons.status}`);

    const reasonsPayload = result?.reasons?.data;
    if (!reasonsPayload) {
      const pageErrors = await this.getPageValidationErrors();
      emit("error", `Impossible de charger les raisons de consultation.${pageErrors ? ` Message page: "${pageErrors}"` : ""}`);
      if (result?.reasons?.text) emit("log", `Raisons réponse: ${result.reasons.text}`, { type: "warn" });
      return false;
    }

    const reasons = reasonsPayload.consultationReasons || [];
    emit("log", `${reasons.length} raison(s) disponible(s)`);

    const targetLabel = siteConfig.reasonMap[profile.reasonCode] || siteConfig.reasonMap.urgent;
    let match = reasons.find(r =>
      !r.IsInactive && r.title?.fr?.toLowerCase().includes(targetLabel.toLowerCase())
    ) || reasons.find(r => r.title?.fr?.toLowerCase().includes(targetLabel.toLowerCase()));

    if (!match) {
      match = reasons.find(r => !r.IsInactive) || reasons[0];
      emit("log", `Raison "${targetLabel}" non trouvée, fallback: "${match?.title?.fr}"`, { type: "warn" });
    } else {
      emit("log", `Raison: "${match.title.fr}" → uid=${match.uid}`);
    }

    this.reasonUid = match?.uid || null;
    if (!this.reasonUid) { emit("error", "Aucun UUID de raison."); return false; }

    this.searchBase = {
      postalCode: profile.postalCode || "H0H0H0",
      radius:     Number(profile.perimeterKm || 50),
      reasonUid:  this.reasonUid,
      timeSlot:   "morning;afternoon;evening",
    };

    emit("log", `Prêt: "${match.title.fr}" | rayon ${this.searchBase.radius}km | CP ${this.searchBase.postalCode}`);
    return true;
  }

  // ── Boucle ────────────────────────────────────────────────────────────────

  startLoop(profile) {
    const intervalMs = Math.max(2, Number(profile.intervalSeconds || 5)) * 1000;
    runtime.step = "loop";
    runtime.lastAction = "Boucle active";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", `Boucle active — intervalle ${intervalMs / 1000}s`);

    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = setInterval(async () => {
      if (!runtime.running || runtime.paused) return;
      try { await this.searchOnce(); }
      catch (err) { emit("error", `Erreur boucle: ${err.message}`); }
    }, intervalMs);
  }

  async searchOnce() {
    runtime.lastAction = "Recherche en cours";
    const { postalCode, radius, reasonUid, timeSlot } = this.searchBase;

    // Tous les fetch s'exécutent dans le browser → CF transparent
    const results = await this.page.evaluate(async ({ baseUrl, postalCode, radius, reasonUid, timeSlot }) => {
      const startDate = new Date().toISOString().replace(/:/g, "_");
      const ts = Date.now();
      const found = [];

      const searches = [
        { type: 1, offset: 0,              limit: 25     },
        { type: 2, offset: 0,              limit: 25     },
        { type: 3, offset: Math.max(0, radius - 25), limit: radius },
      ];

      for (const s of searches) {
        const url =
          `${baseUrl}/api2/assure/getClinics` +
          `/Type/${s.type}` +
          `/StartDate/${startDate}` +
          `/timeSlot/${encodeURIComponent(timeSlot)}` +
          `/${postalCode}/${s.offset}/${s.limit}` +
          `/${reasonUid}/null/0/regular` +
          `?{"ajaxTimeStamp":${ts}}&_=${ts - 150 - s.type * 50}`;

        try {
          const res = await fetch(url, {
            headers: { "content-type": "application/json; charset=utf-8" }
          });
          if (!res.ok) { found.push({ _error: res.status, type: s.type }); continue; }
          const data = await res.json();

          for (const key of ["Cascade1Locations", "Cascade2Locations", "Cascade3Locations"]) {
            for (const loc of data[key]?.Locations || []) {
              const slots = loc.nearestAvailabilitiesTime || [];
              if (slots.length > 0) {
                found.push({
                  clinic:     loc.label || loc.company?.name || "Clinique",
                  address:    `${loc.address?.streetName || ""}, ${loc.address?.city || ""}`.trim(),
                  slot:       slots[0].AvailabilityTime,
                  slotsCount: slots.length,
                });
              }
            }
          }
        } catch (e) {
          found.push({ _error: e.message, type: s.type });
        }
      }
      return found;
    }, { baseUrl: siteConfig.baseUrl, postalCode, radius, reasonUid, timeSlot })
      .catch(e => { emit("error", `searchOnce: ${e.message}`); return []; });

    // Vérifie les erreurs
    const errors = results.filter(r => r._error);
    for (const e of errors) {
      if (e._error === 403) {
        emit("log", "Session expirée (403) — renouvellement...", { type: "warn" });
        await this.renewSession(); return;
      }
    }

    const clinics = results.filter(r => !r._error);

    if (clinics.length > 0) {
      const summary = clinics
        .map(f => `${f.clinic} (${f.address}) — ${f.slotsCount} créneau(x) dès ${f.slot}`)
        .join(" | ");
      const message = `✓ ${clinics.length} clinique(s): ${summary}`;
      runtime.lastAction = "Créneau trouvé";
      addFound({ ts: new Date().toISOString(), message, clinics });
      emit("found", message, { clinics });
      emit("status", "Créneau trouvé", { status: "Créneau trouvé", lastAction: runtime.lastAction });
    } else {
      emit("log", "Aucun créneau disponible");
    }
  }

  // ── Renouvellement session ────────────────────────────────────────────────

  async renewSession() {
    emit("log", "Renouvellement de session...", { type: "warn" });
    try {
      await this.page.goto(siteConfig.homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (await this.isCloudflareChallenge()) await this.waitForCloudflare(30000);
      await this.login(this.profile);
      await this.prepareSearch(this.profile);
      emit("log", "Session renouvelée ✓");
    } catch (err) {
      emit("error", `Renouvellement échoué: ${err.message}`);
    }
  }

  // ── Contrôles ────────────────────────────────────────────────────────────

  async pause() {
    runtime.paused = true; runtime.lastAction = "En pause";
    emit("status", "En pause", { status: "En pause", lastAction: runtime.lastAction });
    emit("log", "Moteur en pause");
  }

  async resume() {
    runtime.running = true; runtime.paused = false; runtime.lastAction = "Repris";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Moteur repris");
  }

  async stop() {
    runtime.running = false; runtime.paused = false;
    runtime.lastAction = "Arrêté"; runtime.step = "stopped";
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    if (this.page)    await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.page = null; this.context = null; this.browser = null;
    emit("status", "Arrêté", { status: "Arrêté", lastAction: runtime.lastAction });
    emit("log", "Moteur arrêté");
  }

  async trySubmitByClick() {
    const submitSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "button[id*='btn']",
      "input[id*='btn']",
      "button[class*='btn']",
      "input[value*='Continuer']",
      "button:has-text('Continuer')"
    ];

    for (const selector of submitSelectors) {
      const locator = this.page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      emit("log", `Soumission via ${selector}`);
      await locator.click({ delay: 80 }).catch(() => null);
      const reachedSearch = await this.waitForRecherche();
      if (reachedSearch) return { method: `click:${selector}`, reachedSearch: true };
    }
    return { method: "click:none", reachedSearch: false };
  }

  async submitAspNetForm() {
    const payload = await this.page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) return null;
      const fields = [];
      for (const el of form.querySelectorAll("input, select, textarea")) {
        if (!el.name || el.disabled) continue;
        const type = (el.type || "").toLowerCase();
        if (type === "file") continue;
        if ((type === "checkbox" || type === "radio") && !el.checked) continue;
        let value = el.value ?? "";
        if (el.name.startsWith("ctlhp")) value = "";
        fields.push([el.name, value]);
      }
      const submitter = form.querySelector("button[type='submit'], input[type='submit'], button, input[type='button']");
      if (submitter?.name) {
        fields.push([submitter.name, submitter.value || submitter.innerText || ""]);
      }
      return {
        action: form.action || window.location.href,
        method: (form.method || "POST").toUpperCase(),
        fields
      };
    }).catch(() => null);

    if (!payload?.action) {
      return { method: "aspnet-post:none", reachedSearch: false };
    }

    emit("log", `POST direct vers ${payload.action}`);

    const postResult = await this.page.evaluate(async ({ action, method, fields }) => {
      const body = new URLSearchParams();
      for (const [k, v] of fields) body.append(k, v ?? "");
      const res = await fetch(action, {
        method,
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-requested-with": "XMLHttpRequest"
        },
        body: body.toString(),
        redirect: "follow"
      });
      const text = await res.text().catch(() => "");
      return { ok: res.ok, status: res.status, url: res.url, text: text.slice(0, 1200) };
    }, payload).catch(err => ({ ok: false, status: 0, url: "", text: err.message || String(err) }));

    emit("log", `POST auth: status ${postResult.status} | url ${postResult.url || "?"}`);

    if (postResult.url && postResult.url.includes(siteConfig.rechercheUrlPart)) {
      await this.page.goto(postResult.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    } else {
      await this.page.goto(siteConfig.rechercheUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    }

    const reachedSearch = await this.waitForRecherche();
    if (!reachedSearch && postResult.text) {
      emit("log", `Réponse auth: ${postResult.text.replace(/\s+/g, " ").slice(0, 500)}`, { type: "warn" });
    }
    return { method: "aspnet-post", reachedSearch };
  }

  async waitForRecherche() {
    try {
      await this.page.waitForURL(url => url.includes(siteConfig.rechercheUrlPart), { timeout: 12000 });
      return true;
    } catch (_) {
      await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      return this.page.url().includes(siteConfig.rechercheUrlPart);
    }
  }

  async clearHoneyPots() {
    await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('input[name^="ctlhp"], textarea[name^="ctlhp"], select[name^="ctlhp"]')) {
        try {
          el.value = "";
          if (el.type === "checkbox" || el.type === "radio") el.checked = false;
        } catch (_) {}
      }
    }).catch(() => {});
  }

  async getPageValidationErrors() {
    const details = await this.page.evaluate(() => {
      const texts = [];
      const selectors = [
        ".validation-summary-errors",
        ".field-validation-error",
        ".error",
        ".alert",
        "[class*='error']",
        "[class*='alert']",
        "[role='alert']"
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t) texts.push(t);
        }
      }
      return [...new Set(texts)].join(" | ").slice(0, 500);
    }).catch(() => "");
    return details;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  normalizeNam(value) {
    const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (raw.length >= 12) return `${raw.slice(0,4)} ${raw.slice(4,8)} ${raw.slice(8,12)}`;
    return String(value || "").trim().toUpperCase();
  }

  async fillByName(name, value) {
    if (!value) return;
    await this.page.locator(`[name="${name}"]`).first().fill(String(value)).catch(() => {});
  }
}

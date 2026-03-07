/**
 * http-engine.js  –  Feature #13  (basé sur analyse HAR réelle)
 *
 * Flux réel RVSQ (confirmé par HAR) :
 *   1. GET  Principale.aspx           → parse __VIEWSTATE, __EVENTVALIDATION, RDVSCSRFToken, et, gpStart
 *   2. POST Principale.aspx           → auth patient → 302 → Recherche.aspx
 *   3. GET  /api2/activelinkedconsultationReasons → trouver l'UUID de la raison choisie
 *   4. Boucle : GET /api2/assure/getClinics/Type/{1,2,3}/...  → parse Cascade*Locations
 *
 * IMPORTANT (découvert dans HAR) :
 *   - Les champs honeypot (ctlhp0$fullName, ctlhp2$name, etc.) doivent être VIDES
 *   - La recherche est 100% REST API (pas de form POST sur Recherche.aspx)
 *   - Le consultingReasonUid est un UUID dynamique à fetcher
 */

import { runtime, addHistory, addSession, addFound } from "./store.js";
import { broadcast } from "./events.js";
import { siteConfig } from "./site-config.js";
import { solveCf } from "./cf-solver.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function emit(kind, message, extra = {}) {
  if (kind === "log") addHistory(extra.type || "info", message, extra);
  broadcast({ kind, message, ...extra });
}

function birthParts(iso) {
  const [year, month, day] = String(iso || "").split("-");
  return { year: year || "", month: month || "", day: day || "" };
}

/** Parse la valeur d'un champ hidden dans le HTML */
function extractField(html, name) {
  const esc = name.replace(/[$]/g, "\\$");
  const re = new RegExp(`name=["']${esc}["'][^>]*value=["']([^"']*?)["']`, "i");
  const m = re.exec(html) ||
    new RegExp(`value=["']([^"']*?)["'][^>]*name=["']${esc}["']`, "i").exec(html);
  return m ? m[1] : "";
}

/** Parse tous les inputs hidden du HTML */
function extractHiddenFields(html) {
  const fields = {};
  const re = /<input([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const typeM  = /type=["']([^"']+)["']/i.exec(attrs);
    const nameM  = /name=["']([^"']+)["']/i.exec(attrs);
    const valueM = /value=["']([^"']*?)["']/i.exec(attrs);
    if (!nameM) continue;
    const type = typeM?.[1].toLowerCase() || "text";
    if (type === "hidden") {
      fields[nameM[1]] = valueM ? valueM[1] : "";
    }
  }
  return fields;
}

/** Formate une date pour l'URL getClinics : 2026-03-06T14_30_00.000Z */
function formatDateForUrl(date) {
  return date.toISOString().replace(/:/g, "_");
}

/** Construit le cookie header depuis un Map */
function buildCookieHeader(cookieMap) {
  return Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Met à jour les cookies depuis les headers Set-Cookie */
function updateCookies(cookieMap, headers) {
  const setCookie = headers.get?.("set-cookie") || "";
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of lines) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (m) cookieMap[m[1].trim()] = m[2].trim();
  }
  // undici retourne parfois un tableau via getSetCookie()
  if (headers.getSetCookie) {
    for (const line of headers.getSetCookie()) {
      const m = /^([^=]+)=([^;]*)/.exec(line);
      if (m) cookieMap[m[1].trim()] = m[2].trim();
    }
  }
}

// ── HttpSession ──────────────────────────────────────────────────────────────

class HttpSession {
  constructor(cookieMap, userAgent) {
    this.cookieMap = { ...cookieMap };
    this.userAgent = userAgent;
  }

  _headers(extra = {}) {
    return {
      "User-Agent": this.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Cookie": buildCookieHeader(this.cookieMap),
      ...extra,
    };
  }

  async get(url, extraHeaders = {}) {
    const res = await fetch(url, {
      method: "GET",
      headers: this._headers(extraHeaders),
      redirect: "follow",
    });
    updateCookies(this.cookieMap, res.headers);
    const text = await res.text();
    return { status: res.status, url: res.url, html: text };
  }

  async getJson(url, referer) {
    const res = await fetch(url, {
      method: "GET",
      headers: this._headers({
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer || siteConfig.rechercheUrl,
        "content-type": "application/json; charset=utf-8",
      }),
      redirect: "follow",
    });
    updateCookies(this.cookieMap, res.headers);
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: null, raw: text }; }
  }

  async post(url, formData, referer) {
    const body = new URLSearchParams(formData).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: this._headers({
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": referer || siteConfig.homeUrl,
        "Origin": "https://www.rvsq.gouv.qc.ca",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
      }),
      body,
      redirect: "manual", // On gère manuellement la 302
    });
    updateCookies(this.cookieMap, res.headers);
    const location = res.headers.get("location") || "";
    return { status: res.status, location, url: res.url };
  }
}

// ── HttpEngine ───────────────────────────────────────────────────────────────

export class HttpEngine {
  constructor() {
    this.session    = null;
    this.loopTimer  = null;
    this.profile    = null;
    this.reasonUid  = null;   // UUID de la raison de consultation
    this.searchBase = {};     // Paramètres fixes pour getClinics
  }

  async start(profile) {
    this.profile = profile;
    runtime.running   = true;
    runtime.paused    = false;
    runtime.startedAt = new Date().toISOString();
    runtime.lastAction = "Démarré";
    runtime.step = "launch";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    addSession({ startedAt: runtime.startedAt, profileId: profile?.nam || "" });

    // ── 1. CF Solver ─────────────────────────────────────────────────────────
    emit("log", "Étape 1/3 — Obtention du token Cloudflare...");
    let cfResult;
    try {
      cfResult = await solveCf((msg) => emit("log", msg));
    } catch (err) {
      emit("error", `CF Solver échoué: ${err.message}`); await this.stop(); return;
    }
    this.session = new HttpSession(cfResult.cookieMap, cfResult.userAgent);

    // ── 2. Authentification ───────────────────────────────────────────────────
    const loginOk = await this.login(profile);
    if (!loginOk) return;

    // ── 3. Raisons de consultation + préparation boucle ───────────────────────
    const prepOk = await this.prepareSearch(profile);
    if (!prepOk) return;

    // ── 4. Boucle ─────────────────────────────────────────────────────────────
    this.startLoop(profile);
  }

  // ── Authentification ────────────────────────────────────────────────────────

  async login(profile) {
    runtime.step = "auth";
    runtime.lastAction = "Authentification";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Étape 2/3 — GET Principale.aspx...");

    const { status, html } = await this.session.get(siteConfig.homeUrl).catch(e => {
      emit("error", `GET Principale.aspx: ${e.message}`); return {};
    });
    if (!html) return false;
    emit("log", `GET Principale.aspx → HTTP ${status}`);

    if (status === 403 || status === 503) {
      emit("error", `HTTP ${status} — Cloudflare bloque encore. Réessaie dans quelques minutes.`);
      await this.stop(); return false;
    }

    // Parse les champs dynamiques de la page
    const hidden = extractHiddenFields(html);
    const viewState      = hidden["__VIEWSTATE"]       || "";
    const eventVal       = hidden["__EVENTVALIDATION"] || "";
    const vsGenerator    = hidden["__VIEWSTATEGENERATOR"] || "";
    const csrfToken      = extractField(html, "RDVSCSRFToken") || hidden["RDVSCSRFToken"] || "";
    const etValue        = extractField(html, "ctl00$ContentPlaceHolderMP$et") || "";
    const gpStartValue   = extractField(html, "ctl00$ContentPlaceHolderMP$gpStart") || "";
    const rdvsPageInfo   = hidden["RDVSPageInfo"] || "";
    const rdvsDataSvc    = hidden["RDVSDataServices"] || '{"dataApiUrl":"/api2/"}';

    // Cherche le __EVENTTARGET réel du bouton submit
    // Dans le HAR c'est littéralement "<%= myButton.ClientID %>" mais on cherche l'ID réel dans le HTML
    const btnM = /id=["']([^"']*(?:btnContinue|btnNext|btnSubmit|Confirm|submit|SubmitButton)[^"']*)["']/i.exec(html);
    const eventTarget = btnM ? btnM[1] : "";

    emit("log", `CSRF: ${csrfToken ? csrfToken.slice(0,12)+"..." : "absent"} | VS: ${viewState ? "✓" : "absent"} | et: ${etValue} | gpStart: ${gpStartValue}`);

    const { day, month, year } = birthParts(profile.birthDate);

    // ── Payload exact tel que capturé dans le HAR ──────────────────────────────
    // CRITIQUE: les champs honeypot (ctlhp*) doivent être VIDES
    const payload = {
      // Champs de tracking (injectés par le JS de la page)
      "RDVSUserId":                                        "0",
      "RDVSPageInfo":                                      rdvsPageInfo,
      "RDVSDataServices":                                  rdvsDataSvc,
      "EnableUserTracking":                                "0",
      "RDVSCSRFToken":                                     csrfToken,

      // ASP.NET WebForms
      "__EVENTTARGET":                                     eventTarget,
      "__EVENTARGUMENT":                                   "",
      "__VIEWSTATE":                                       viewState,
      "__VIEWSTATEGENERATOR":                              vsGenerator,
      "__EVENTVALIDATION":                                 eventVal,

      // Champs patient
      "ctl00$ContentPlaceHolderMP$AssureForm_FirstName":   profile.firstName  || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_LastName":    profile.lastName   || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_NAM":         (profile.nam || "").replace(/\s/g, ""),
      "ctl00$ContentPlaceHolderMP$AssureForm_CardSeqNumber": profile.seq      || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Email":       "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Phone":       "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Day":         day,
      "AssureForm_Month_hidden":                           "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Month":       month,
      "ctl00$ContentPlaceHolderMP$AssureForm_Year":        year,

      // Champs de config (valeurs dynamiques extraites du HTML)
      "ctl00$ContentPlaceHolderMP$NamObligatoire":         "1",
      "ctl00$ContentPlaceHolderMP$EmailObligatoire":       "0",
      "ctl00$ContentPlaceHolderMP$PhoneObligatoire":       "0",
      "ctl00$ContentPlaceHolderMP$et":                     etValue,
      "ctl00$ContentPlaceHolderMP$gpStart":                gpStartValue,

      // Honeypot — DOIT rester vide (détection bot)
      "ctlhp0$fullName":  "",
      "ctlhp2$name":      "",
      "ctlhp3$nam":       "",
      "ctlhp4$username":  "",
      "ctlhp6$patientId": "",
    };

    emit("log", "Étape 2/3 — POST Principale.aspx (auth patient)...");
    const post = await this.session.post(siteConfig.homeUrl, payload, siteConfig.homeUrl).catch(e => {
      emit("error", `POST Principale.aspx: ${e.message}`); return {};
    });
    if (!post) return false;

    emit("log", `POST Principale.aspx → HTTP ${post.status} | Location: ${post.location}`);

    if (post.status === 302 && post.location.includes(siteConfig.rechercheUrlPart)) {
      emit("log", "Authentification réussie ✓ → Recherche.aspx");
      runtime.currentUrl = siteConfig.rechercheUrl;
      // Suit la redirection pour charger Recherche.aspx et récupérer les cookies de session
      await this.session.get(siteConfig.rechercheUrl, {
        "Referer": siteConfig.homeUrl
      }).catch(() => {});
      return true;
    }

    if (post.status === 302) {
      const loc = post.location || "";
      emit("error", `Redirigé vers ${loc} — vérifier les informations patient ou les sélecteurs.`);
    } else {
      emit("error", `Authentification échouée HTTP ${post.status}. Vérifier les champs du formulaire.`);
    }
    return false;
  }

  // ── Préparation de la recherche ─────────────────────────────────────────────

  async prepareSearch(profile) {
    runtime.step = "prepare-search";
    runtime.lastAction = "Chargement des raisons";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", "Étape 3/3 — Chargement des raisons de consultation...");

    const ts = Date.now();
    const { status, data } = await this.session.getJson(
      `${siteConfig.baseUrl}/api2/activelinkedconsultationReasons?{"ajaxTimeStamp":${ts}}&_=${ts - 200}`,
      siteConfig.rechercheUrl
    ).catch(e => { emit("error", `activelinkedconsultationReasons: ${e.message}`); return {}; });

    if (!data) {
      emit("error", "Impossible de charger les raisons de consultation.");
      return false;
    }

    const reasons = data.consultationReasons || [];
    emit("log", `${reasons.length} raison(s) chargée(s)`);

    // Mappe les codes du frontend vers les titres FR attendus
    const targetLabel = siteConfig.reasonMap[profile.reasonCode] || siteConfig.reasonMap.urgent;

    // Cherche la raison par titre (ignore les inactives si possible)
    let match = reasons.find(r =>
      !r.IsInactive &&
      (r.title?.fr?.toLowerCase().includes(targetLabel.toLowerCase()) ||
       r.title?.en?.toLowerCase().includes(targetLabel.toLowerCase()))
    ) || reasons.find(r =>
      r.title?.fr?.toLowerCase().includes(targetLabel.toLowerCase()) ||
      r.title?.en?.toLowerCase().includes(targetLabel.toLowerCase())
    );

    if (!match) {
      // Fallback: prend la première raison active
      match = reasons.find(r => !r.IsInactive) || reasons[0];
      emit("log", `Raison "${targetLabel}" non trouvée, fallback: "${match?.title?.fr}"`, { type: "warn" });
    } else {
      emit("log", `Raison: "${match.title.fr}" → uid=${match.uid}`);
    }

    this.reasonUid = match?.uid || null;
    if (!this.reasonUid) {
      emit("error", "Aucun UUID de raison trouvé — impossible de rechercher.");
      return false;
    }

    // Paramètres fixes pour la boucle getClinics
    this.searchBase = {
      postalCode:  profile.postalCode || "H0H0H0",
      radius:      String(profile.perimeterKm || 50),
      reasonUid:   this.reasonUid,
      timeSlot:    "morning;afternoon;evening",
    };

    emit("log", `Prêt: raison="${match.title.fr}" rayon=${this.searchBase.radius}km CP=${this.searchBase.postalCode}`);
    return true;
  }

  // ── Boucle de recherche ─────────────────────────────────────────────────────

  startLoop(profile) {
    const intervalMs = Math.max(2, Number(profile.intervalSeconds || 5)) * 1000;
    runtime.step = "loop";
    runtime.lastAction = "Boucle active";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    emit("log", `Boucle de recherche active — intervalle ${intervalMs / 1000}s`);

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
    const startDate = formatDateForUrl(new Date());
    const ts = Date.now();
    const found = [];

    // RVSQ fait 3 appels (Type 1, 2, 3) correspondant à différents types de cliniques
    // Type 1: sans médecin de famille, 0-25 km
    // Type 2: avec médecin de famille / GMF, 0-25 km  
    // Type 3: élargi, 25-radius km
    const searches = [
      { type: 1, offset: 0,  limit: 25  },
      { type: 2, offset: 0,  limit: 25  },
      { type: 3, offset: Math.max(0, Number(radius) - 25), limit: radius },
    ];

    for (const s of searches) {
      const url =
        `${siteConfig.baseUrl}/api2/assure/getClinics` +
        `/Type/${s.type}` +
        `/StartDate/${startDate}` +
        `/timeSlot/${encodeURIComponent(timeSlot)}` +
        `/${postalCode}` +
        `/${s.offset}/${s.limit}` +
        `/${reasonUid}/null/0/regular` +
        `?{"ajaxTimeStamp":${ts}}&_=${ts - 150 - s.type * 50}`;

      const { status, data } = await this.session
        .getJson(url, siteConfig.rechercheUrl)
        .catch(e => { emit("log", `getClinics type${s.type}: ${e.message}`, { type: "warn" }); return {}; });

      if (!data) continue;

      if (status === 403) {
        emit("log", "Session CF expirée (403) — relance nécessaire", { type: "warn" });
        await this.renewSession(); return;
      }

      // Parse les résultats : Cascade1Locations, Cascade2Locations, Cascade3Locations
      for (const key of ["Cascade1Locations", "Cascade2Locations", "Cascade3Locations"]) {
        const locations = data[key]?.Locations || [];
        for (const loc of locations) {
          const slots = loc.nearestAvailabilitiesTime || [];
          if (slots.length > 0) {
            const firstSlot = slots[0].AvailabilityTime;
            found.push({
              clinic:   loc.label || loc.company?.name || "Clinique inconnue",
              address:  `${loc.address?.streetName || ""}, ${loc.address?.city || ""}`.trim(),
              slot:     firstSlot,
              slotsCount: slots.length,
            });
          }
        }
      }
    }

    if (found.length > 0) {
      const summary = found
        .map(f => `${f.clinic} (${f.address}) — ${f.slotsCount} créneau(x) dès ${f.slot}`)
        .join(" | ");
      const message = `✓ ${found.length} clinique(s) disponible(s): ${summary}`;
      runtime.lastAction = "Créneau trouvé";
      addFound({ ts: new Date().toISOString(), message, clinics: found });
      emit("found", message, { clinics: found });
      emit("status", "Créneau trouvé", { status: "Créneau trouvé", lastAction: runtime.lastAction });
    } else {
      emit("log", "Aucun créneau disponible");
    }
  }

  // Renouvelle le token CF si la session expire
  async renewSession() {
    emit("log", "Renouvellement de la session CF...", { type: "warn" });
    try {
      const cfResult = await solveCf((msg) => emit("log", msg));
      this.session = new HttpSession(cfResult.cookieMap, cfResult.userAgent);
      const loginOk = await this.login(this.profile);
      if (loginOk) {
        emit("log", "Session renouvelée ✓");
        await this.prepareSearch(this.profile);
      }
    } catch (err) {
      emit("error", `Renouvellement échoué: ${err.message}`);
    }
  }

  // ── Contrôles ───────────────────────────────────────────────────────────────

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
    this.loopTimer = null; this.session = null;
    emit("status", "Arrêté", { status: "Arrêté", lastAction: runtime.lastAction });
    emit("log", "Moteur arrêté");
  }
}

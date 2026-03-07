/**
 * http-engine.js  –  Feature #13  (v4.2 — context.request, même TLS que CF)
 *
 * Correction v4.2 : utilise context.request de Playwright au lieu de undici.
 * Raison : cf_clearance est lié à l'empreinte TLS Chrome. Passer à undici
 * change le TLS fingerprint → Cloudflare retourne 403 immédiatement.
 * context.request garde le même TLS, les mêmes cookies, la même session.
 *
 * Flux (confirmé par analyse HAR) :
 *   1. CF Solver → browser context ouvert (même TLS)
 *   2. GET  Principale.aspx via context.request → parse ViewState + champs
 *   3. POST Principale.aspx → 302 → Recherche.aspx
 *   4. GET  /api2/activelinkedconsultationReasons → UUID raison
 *   5. Boucle : GET /api2/assure/getClinics/Type/{1,2,3} → parse résultats
 */

import { runtime, addHistory, addSession, addFound } from "./store.js";
import { broadcast } from "./events.js";
import { siteConfig } from "./site-config.js";
import { solveCf, USER_AGENT } from "./cf-solver.js";

function emit(kind, message, extra = {}) {
  if (kind === "log") addHistory(extra.type || "info", message, extra);
  broadcast({ kind, message, ...extra });
}

function birthParts(iso) {
  const [year, month, day] = String(iso || "").split("-");
  return { year: year || "", month: month || "", day: day || "" };
}

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
    if ((typeM?.[1] || "").toLowerCase() === "hidden") {
      fields[nameM[1]] = valueM ? valueM[1] : "";
    }
  }
  return fields;
}

function extractField(html, name) {
  const esc = name.replace(/[$]/g, "\\$");
  const re1 = new RegExp(`name=["']${esc}["'][^>]*value=["']([^"']*?)["']`, "i");
  const re2 = new RegExp(`value=["']([^"']*?)["'][^>]*name=["']${esc}["']`, "i");
  return (re1.exec(html) || re2.exec(html))?.[1] ?? "";
}

function formatDateForUrl(date) {
  return date.toISOString().replace(/:/g, "_");
}

// ── PlRequestSession ─────────────────────────────────────────────────────────
// Wrapper autour de context.request de Playwright
// Utilise la même session TLS que le browser qui a obtenu cf_clearance

class PlRequestSession {
  constructor(context) {
    this.req = context.request; // APIRequestContext de Playwright
  }

  _headers(extra = {}) {
    return {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      ...extra,
    };
  }

  async get(url, extraHeaders = {}) {
    const res = await this.req.get(url, { headers: this._headers(extraHeaders) });
    const html = await res.text();
    return { status: res.status(), url, html };
  }

  async getJson(url, referer) {
    const res = await this.req.get(url, {
      headers: this._headers({
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer || siteConfig.rechercheUrl,
        "content-type": "application/json; charset=utf-8",
      }),
    });
    const text = await res.text();
    try { return { status: res.status(), data: JSON.parse(text) }; }
    catch { return { status: res.status(), data: null, raw: text?.slice(0, 200) }; }
  }

  async post(url, formData, referer) {
    const res = await this.req.post(url, {
      headers: this._headers({
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": referer || siteConfig.homeUrl,
        "Origin": "https://www.rvsq.gouv.qc.ca",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      }),
      form: formData,
    });
    const text = await res.text();
    // Playwright suit les redirections automatiquement — on détecte Recherche.aspx dans l'URL finale
    return { status: res.status(), url: res.url(), html: text };
  }
}

// ── HttpEngine ───────────────────────────────────────────────────────────────

export class HttpEngine {
  constructor() {
    this.session    = null;
    this.browser    = null;
    this.loopTimer  = null;
    this.profile    = null;
    this.reasonUid  = null;
    this.searchBase = {};
  }

  async start(profile) {
    this.profile = profile;
    runtime.running    = true;
    runtime.paused     = false;
    runtime.startedAt  = new Date().toISOString();
    runtime.lastAction = "Démarré";
    runtime.step = "launch";
    emit("status", "En cours", { status: "En cours", lastAction: runtime.lastAction });
    addSession({ startedAt: runtime.startedAt, profileId: profile?.nam || "" });

    // 1. CF Solver — retourne browser + context OUVERTS
    emit("log", "Étape 1/3 — Obtention du token Cloudflare...");
    let cfResult;
    try {
      cfResult = await solveCf((msg) => emit("log", msg));
    } catch (err) {
      emit("error", `CF Solver échoué: ${err.message}`); await this.stop(); return;
    }
    this.browser = cfResult.browser;
    // context.request utilise le même TLS Chrome → pas de 403
    this.session = new PlRequestSession(cfResult.context);

    // 2. Auth
    const loginOk = await this.login(profile);
    if (!loginOk) return;

    // 3. Raisons
    const prepOk = await this.prepareSearch(profile);
    if (!prepOk) return;

    // 4. Boucle
    this.startLoop(profile);
  }

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
      emit("error", `HTTP ${status} — CF bloque les requêtes HTTP même avec le cookie. L'IP Render est probablement sur liste noire.`);
      await this.stop(); return false;
    }

    const hidden      = extractHiddenFields(html);
    const csrfToken   = extractField(html, "RDVSCSRFToken")  || hidden["RDVSCSRFToken"] || "";
    const etValue     = extractField(html, "ctl00$ContentPlaceHolderMP$et") || "";
    const gpStartVal  = extractField(html, "ctl00$ContentPlaceHolderMP$gpStart") || "";
    const rdvsPageInfo = hidden["RDVSPageInfo"] || "";
    const rdvsDataSvc  = hidden["RDVSDataServices"] || '{ "dataApiUrl":"/api2/" }';

    // __EVENTTARGET : cherche l'ID réel du bouton submit dans le HTML
    const btnM = /id=["']([^"']*(?:btnContinue|btnNext|btnSubmit|Confirm|submit|SubmitButton|btn)[^"']*)["']/i.exec(html);
    const eventTarget = btnM?.[1] || "";

    emit("log", `CSRF: ${csrfToken ? csrfToken.slice(0,12)+"..." : "absent"} | VS: ${hidden["__VIEWSTATE"] ? "✓" : "absent"} | et: ${etValue}`);

    const { day, month, year } = birthParts(profile.birthDate);

    const payload = {
      "RDVSUserId":                                          "0",
      "RDVSPageInfo":                                        rdvsPageInfo,
      "RDVSDataServices":                                    rdvsDataSvc,
      "EnableUserTracking":                                  "0",
      "RDVSCSRFToken":                                       csrfToken,
      "__EVENTTARGET":                                       eventTarget,
      "__EVENTARGUMENT":                                     "",
      "__VIEWSTATE":                                         hidden["__VIEWSTATE"]          || "",
      "__VIEWSTATEGENERATOR":                                hidden["__VIEWSTATEGENERATOR"] || "",
      "__EVENTVALIDATION":                                   hidden["__EVENTVALIDATION"]    || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_FirstName":     profile.firstName  || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_LastName":      profile.lastName   || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_NAM":           (profile.nam || "").replace(/\s/g, ""),
      "ctl00$ContentPlaceHolderMP$AssureForm_CardSeqNumber": profile.seq        || "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Email":         "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Phone":         "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Day":           day,
      "AssureForm_Month_hidden":                             "",
      "ctl00$ContentPlaceHolderMP$AssureForm_Month":         month,
      "ctl00$ContentPlaceHolderMP$AssureForm_Year":          year,
      "ctl00$ContentPlaceHolderMP$NamObligatoire":           "1",
      "ctl00$ContentPlaceHolderMP$EmailObligatoire":         "0",
      "ctl00$ContentPlaceHolderMP$PhoneObligatoire":         "0",
      "ctl00$ContentPlaceHolderMP$et":                       etValue,
      "ctl00$ContentPlaceHolderMP$gpStart":                  gpStartVal,
      // Honeypot — DOIT rester vide
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

    emit("log", `POST Principale.aspx → HTTP ${post.status} | URL finale: ${post.url}`);

    if (post.url?.includes(siteConfig.rechercheUrlPart)) {
      emit("log", "Authentification réussie ✓ → Recherche.aspx");
      runtime.currentUrl = post.url;
      return true;
    }

    // Cherche un message d'erreur dans la page
    const errM = /<[^>]*class=["'][^"']*(?:error|alert|warning)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(post.html || "");
    const errMsg = errM ? errM[1].replace(/<[^>]+>/g, "").trim() : "";
    emit("error", `Page de recherche non atteinte.${errMsg ? ` Message RVSQ: "${errMsg}"` : " Vérifier les informations patient."}`);
    return false;
  }

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
      emit("error", "Impossible de charger les raisons de consultation."); return false;
    }

    const reasons = data.consultationReasons || [];
    emit("log", `${reasons.length} raison(s) chargée(s)`);

    const targetLabel = siteConfig.reasonMap[profile.reasonCode] || siteConfig.reasonMap.urgent;
    let match = reasons.find(r =>
      !r.IsInactive &&
      (r.title?.fr?.toLowerCase().includes(targetLabel.toLowerCase()) ||
       r.title?.en?.toLowerCase().includes(targetLabel.toLowerCase()))
    ) || reasons.find(r =>
      r.title?.fr?.toLowerCase().includes(targetLabel.toLowerCase())
    );

    if (!match) {
      match = reasons.find(r => !r.IsInactive) || reasons[0];
      emit("log", `Raison "${targetLabel}" non trouvée, fallback: "${match?.title?.fr}"`, { type: "warn" });
    } else {
      emit("log", `Raison: "${match.title.fr}" → uid=${match.uid}`);
    }

    this.reasonUid = match?.uid || null;
    if (!this.reasonUid) {
      emit("error", "Aucun UUID de raison trouvé."); return false;
    }

    this.searchBase = {
      postalCode: profile.postalCode || "H0H0H0",
      radius:     String(profile.perimeterKm || 50),
      reasonUid:  this.reasonUid,
      timeSlot:   "morning;afternoon;evening",
    };

    emit("log", `Prêt: raison="${match.title.fr}" rayon=${this.searchBase.radius}km CP=${this.searchBase.postalCode}`);
    return true;
  }

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

    const searches = [
      { type: 1, offset: 0,  limit: 25 },
      { type: 2, offset: 0,  limit: 25 },
      { type: 3, offset: Math.max(0, Number(radius) - 25), limit: radius },
    ];

    for (const s of searches) {
      const url =
        `${siteConfig.baseUrl}/api2/assure/getClinics` +
        `/Type/${s.type}` +
        `/StartDate/${startDate}` +
        `/timeSlot/${encodeURIComponent(timeSlot)}` +
        `/${postalCode}/${s.offset}/${s.limit}` +
        `/${reasonUid}/null/0/regular` +
        `?{"ajaxTimeStamp":${ts}}&_=${ts - 150 - s.type * 50}`;

      const { status, data } = await this.session
        .getJson(url, siteConfig.rechercheUrl)
        .catch(e => { emit("log", `getClinics type${s.type}: ${e.message}`, { type: "warn" }); return {}; });

      if (!data) continue;

      if (status === 403) {
        emit("log", "Session expirée (403) — renouvellement...", { type: "warn" });
        await this.renewSession(); return;
      }

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

  async renewSession() {
    emit("log", "Renouvellement de session CF...", { type: "warn" });
    try {
      if (this.browser) await this.browser.close().catch(() => {});
      const cfResult = await solveCf((msg) => emit("log", msg));
      this.browser = cfResult.browser;
      this.session = new PlRequestSession(cfResult.context);
      const loginOk = await this.login(this.profile);
      if (loginOk) {
        emit("log", "Session renouvelée ✓");
        await this.prepareSearch(this.profile);
      }
    } catch (err) {
      emit("error", `Renouvellement échoué: ${err.message}`);
    }
  }

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
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null; this.session = null;
    emit("status", "Arrêté", { status: "Arrêté", lastAction: runtime.lastAction });
    emit("log", "Moteur arrêté");
  }
}

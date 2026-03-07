/**
 * cf-solver.js
 * Utilise Playwright UNE SEULE FOIS pour obtenir le cookie cf_clearance
 * Retourne { cookies, userAgent } pour être réutilisé dans toutes les requêtes HTTP
 */
import { chromium } from "playwright";
import { siteConfig } from "./site-config.js";

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

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Lance un navigateur headless, passe Cloudflare, extrait les cookies,
 * ferme le navigateur et retourne les cookies sous forme de string header.
 *
 * @param {Function} onLog  callback(message, type) pour les logs
 * @returns {{ cookieHeader: string, userAgent: string, cookieMap: object }}
 */
export async function solveCf(onLog = () => {}) {
  onLog("CF Solver: lancement du navigateur pour obtenir cf_clearance...");

  const browser = await chromium.launch({
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

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "fr-CA",
    timezoneId: "America/Toronto",
    extraHTTPHeaders: { "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7" },
  });
  await context.addInitScript(STEALTH_SCRIPT);

  const page = await context.newPage();

  try {
    await page.goto(siteConfig.homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Attente que CF se résolve (max 30s)
    const deadline = Date.now() + 30000;
    let passed = false;
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => "");
      const url = page.url();
      const isCf =
        /just a moment|cloudflare|attention required/i.test(title) ||
        url.includes("__cf_chl") ||
        (await page.locator("#challenge-running, #cf-challenge-running").count().catch(() => 0)) > 0;

      if (!isCf) { passed = true; break; }
      onLog("CF Solver: en attente du défi Cloudflare...");
      await page.waitForTimeout(2000);
    }

    if (!passed) throw new Error("Cloudflare n'a pas pu être contourné (timeout 30s)");

    // Extraire tous les cookies
    const rawCookies = await context.cookies();
    const cookieMap = {};
    for (const c of rawCookies) cookieMap[c.name] = c.value;

    // Construire le header Cookie pour undici
    const cookieHeader = rawCookies.map(c => `${c.name}=${c.value}`).join("; ");

    onLog(`CF Solver: succès — ${rawCookies.length} cookie(s) obtenus (cf_clearance: ${cookieMap["cf_clearance"] ? "✓" : "absent"})`);
    return { cookieHeader, userAgent: USER_AGENT, cookieMap };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

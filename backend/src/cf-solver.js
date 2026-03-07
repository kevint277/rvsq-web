/**
 * cf-solver.js
 * Lance Playwright, passe Cloudflare, et retourne le contexte OUVERT.
 * Le contexte doit être fermé par l'appelant via cfContext.close().
 *
 * POURQUOI garder le contexte ouvert :
 *   cf_clearance est lié à l'empreinte TLS du navigateur Chrome.
 *   Si on switch vers undici (TLS Node.js), CF détecte le changement et retourne 403.
 *   En utilisant context.request de Playwright, toutes les requêtes HTTP
 *   gardent la même empreinte TLS que celle qui a obtenu le cookie.
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

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Lance un browser headless, passe Cloudflare, et retourne le contexte ouvert.
 * @param {Function} onLog
 * @returns {{ browser, context }} — À fermer avec browser.close() quand terminé
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

    // Attente résolution CF (max 30s)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => "");
      const url = page.url();
      const isCf =
        /just a moment|cloudflare|attention required/i.test(title) ||
        url.includes("__cf_chl") ||
        (await page.locator("#challenge-running, #cf-challenge-running").count().catch(() => 0)) > 0;
      if (!isCf) break;
      onLog("CF Solver: en attente du défi Cloudflare...");
      await page.waitForTimeout(2000);
    }

    const cookies = await context.cookies();
    const hasCf = cookies.some(c => c.name === "cf_clearance");
    onLog(`CF Solver: succès — ${cookies.length} cookie(s) obtenus (cf_clearance: ${hasCf ? "✓" : "absent"})`);

    await page.close().catch(() => {});

    // Retourne browser + context OUVERTS — les requêtes HTTP utilisent context.request
    return { browser, context };

  } catch (err) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

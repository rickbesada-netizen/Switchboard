// Posts to an Instagram profile through instagram.com in a real browser.
// Preferred: the account's Trickster profile (same fingerprint + proxy as normal).
// Fallback: your installed Google Chrome with the account's proxy and saved cookies.
// "Quiet" uses Instagram's own "Post quietly to profile" option. If Instagram has not given that
// option to the account, the post is stopped before sharing (unless you allow a normal post).
const fs = require('fs');
const { chromium } = require('playwright-core');
const U = require('./util');
const trickster = require('./trickster');

function parseProxy(p) {
  if (!p) return undefined;
  try {
    const u = new URL(p.includes('://') ? p : 'http://' + p);
    return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  } catch {
    return undefined;
  }
}

// Accepts Playwright, Electron and exported-JSON cookie shapes
function normCookie(c) {
  const out = { name: c.name, value: String(c.value), domain: c.domain || '.instagram.com', path: c.path || '/', secure: c.secure !== false, httpOnly: !!(c.httpOnly ?? c.http_only) };
  const exp = c.expires ?? c.expirationDate;
  if (exp && exp > 0) out.expires = Math.floor(exp);
  const ss = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' }[String(c.sameSite || '').toLowerCase()];
  if (ss) out.sameSite = ss;
  if (ss === 'None') out.secure = true;
  return out;
}

async function withPage(cfg, acc, log, fn) {
  let browser = null; let page = null; let launched = false; let openedNow = false;
  try {
    if (acc.tricksterProfileId) {
      log('Opening Trickster profile...');
      const c = await trickster.connect(cfg, acc.tricksterProfileId);
      browser = c.browser; openedNow = c.openedNow;
      page = await c.context.newPage();
    } else {
      log('Opening a browser with this account\'s proxy and login...');
      const proxy = parseProxy(acc.proxy);
      try {
        browser = await chromium.launch({ channel: 'chrome', headless: false, proxy });
      } catch {
        browser = await chromium.launch({ channel: 'msedge', headless: false, proxy }); // Edge ships with Windows
      }
      launched = true;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      if (!acc.cookies || !acc.cookies.some((c) => c.name === 'sessionid')) throw new Error('This account is not logged in to Instagram yet. Go to Accounts and press Log in (or Open browser) first.');
      await ctx.addCookies(acc.cookies.filter((c) => /instagram\.com$/.test(String(c.domain).replace(/^\./, ''))).map(normCookie));
      page = await ctx.newPage();
    }
    return await fn(page);
  } catch (e) {
    if (page) {
      try {
        const shot = U.p('logs', `ig-error-${Date.now()}.png`);
        fs.mkdirSync(U.p('logs'), { recursive: true });
        await page.screenshot({ path: shot });
        e.screenshot = shot;
      } catch {}
    }
    throw e;
  } finally {
    try { if (page) await page.close(); } catch {}
    if (launched && browser) await browser.close().catch(() => {});
    if (openedNow && cfg.settings.closeTricksterAfter) {
      await trickster.closeProfile(cfg, acc.tricksterProfileId).catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
}

async function clickIfVisible(loc) {
  try {
    if (await loc.first().isVisible({ timeout: 800 })) { await loc.first().click(); return true; }
  } catch {}
  return false;
}

async function dismissPopups(page) {
  for (let i = 0; i < 3; i++) {
    const hit = await clickIfVisible(page.getByRole('button', { name: /^(Not now|Not Now|Allow all cookies|Decline optional cookies|Only allow essential cookies|OK)$/ }));
    if (!hit) break;
    await page.waitForTimeout(700);
  }
}

async function post(cfg, acc, job, log = () => {}) {
  const files = (job.files || []).filter((f) => fs.existsSync(f));
  if (!files.length) throw new Error('No media files found to post.');
  return withPage(cfg, acc, log, async (page) => {
    log('Loading Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4500);
    await dismissPopups(page);

    const create = page.locator('svg[aria-label="New post"], svg[aria-label="Create"], svg[aria-label="New Post"]').first();
    if (!(await create.count())) throw new Error('This profile is not logged in to Instagram (no Create button). Log in once in the profile, then try again.');
    await create.click();
    await page.waitForTimeout(1500);
    // Newer layouts open a small menu: Post / Reel / Live
    await clickIfVisible(page.locator('a:has(svg[aria-label="Post"]), [role="link"]:has-text("Post"), [role="menuitem"]:has-text("Post")'));
    await page.waitForTimeout(1200);

    log('Adding media...');
    const input = page.locator('div[role="dialog"] input[type="file"], form[enctype="multipart/form-data"] input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 20000 });
    await input.setInputFiles(files);
    await page.waitForTimeout(3000);
    // Reels notice ("Video posts are now shared as reels")
    await clickIfVisible(page.getByRole('button', { name: /^OK$/ }));

    const dlg = page.locator('div[role="dialog"]').last();
    for (let i = 0; i < 2; i++) {
      const next = dlg.getByRole('button', { name: /^Next$/ }).first();
      await next.waitFor({ state: 'visible', timeout: 30000 });
      await next.click();
      await page.waitForTimeout(2000);
    }

    if (job.caption) {
      log('Writing caption...');
      const cap = dlg.locator('[aria-label^="Write a caption"], div[contenteditable="true"]').first();
      await cap.click();
      await page.keyboard.insertText(job.caption);
      await page.waitForTimeout(500);
    }

    let quietSet = false;
    if (job.quiet) {
      log('Looking for "Post quietly to profile"...');
      await clickIfVisible(dlg.getByText(/^Advanced settings$/i));
      await page.waitForTimeout(800);
      const rx = /post quietly|quietly to (your )?profile|share to profile only|only (share )?to (your )?profile|don.?t share to feed/i;
      const label = dlg.getByText(rx).first();
      if (await label.count()) {
        const holder = label.locator('xpath=ancestor::*[.//input[@type="checkbox"] or .//*[@role="switch"] or .//*[@role="checkbox"]][1]');
        const sw = holder.locator('input[type="checkbox"], [role="switch"], [role="checkbox"]').first();
        if (await sw.count()) {
          let on = (await sw.getAttribute('aria-checked')) === 'true';
          if (!on) { try { on = await sw.isChecked(); } catch {} }
          if (!on) await sw.click({ force: true });
        } else {
          await label.click();
        }
        quietSet = true;
        await page.waitForTimeout(600);
      }
      if (!quietSet && !job.allowNormal && !job.dryRun) {
        const e = new Error('Instagram has not given this account the "Post quietly to profile" option yet, so nothing was posted. Tick "Post normally if quiet isn\'t available" to post anyway.');
        e.code = 'QUIET_UNAVAILABLE';
        throw e;
      }
    }

    if (job.dryRun) {
      log('Test finished - nothing was posted.');
      return { ok: true, dryRun: true, quietAvailable: quietSet };
    }

    log('Sharing...');
    await dlg.getByRole('button', { name: /^Share$/ }).first().click();
    await page.getByText(/(post|reel) (has been|was) shared|your (post|reel) has been shared/i).first().waitFor({ timeout: 240000 });
    log(quietSet ? 'Posted quietly to profile.' : 'Posted.');
    await page.waitForTimeout(1500);
    return { ok: true, quiet: quietSet };
  });
}

module.exports = { post, parseProxy };

// Posting to Instagram and Facebook (feed posts and stories) by driving the real websites in a
// browser: the account's Trickster profile if linked, otherwise Chrome/Edge with the account's own
// saved login and proxy. Each step is logged; on failure a screenshot is saved. "Test" runs
// stop right before the final Share/Post click and report which options were found.
const fs = require('fs');
const { chromium, devices } = require('playwright-core');
const U = require('./util');
const trickster = require('./trickster');

const PHONE = devices['iPhone 13'];

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
  const out = { name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/', secure: c.secure !== false, httpOnly: !!(c.httpOnly ?? c.http_only) };
  const exp = c.expires ?? c.expirationDate;
  if (exp && exp > 0) out.expires = Math.floor(exp);
  const ss = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' }[String(c.sameSite || '').toLowerCase()];
  if (ss) out.sameSite = ss;
  if (ss === 'None') out.secure = true;
  return out;
}

async function withPage(cfg, acc, opts, log, fn) {
  let browser = null; let page = null; let launched = false; let openedNow = false;
  try {
    if (acc.tricksterProfileId) {
      log('Opening Trickster profile...');
      const c = await trickster.connect(cfg, acc.tricksterProfileId);
      browser = c.browser; openedNow = c.openedNow;
      page = await c.context.newPage();
      if (opts.mobile) {
        const s = await page.context().newCDPSession(page);
        await s.send('Emulation.setUserAgentOverride', { userAgent: PHONE.userAgent });
        await s.send('Emulation.setDeviceMetricsOverride', { width: PHONE.viewport.width, height: PHONE.viewport.height, deviceScaleFactor: PHONE.deviceScaleFactor, mobile: true });
        await s.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
    } else {
      if (!acc.cookies || !acc.cookies.some((c) => c.name === opts.loginCookie)) {
        throw new Error(`This account is not logged in to ${opts.siteName} yet. Go to Accounts and press Log in (or Open browser) first.`);
      }
      log('Opening a browser with this account\'s login and proxy...');
      const proxy = parseProxy(acc.proxy);
      try { browser = await chromium.launch({ channel: 'chrome', headless: false, proxy }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: false, proxy }); }
      launched = true;
      const ctxOpts = opts.mobile ? { ...PHONE } : { viewport: { width: 1280, height: 900 } };
      const ctx = await browser.newContext(ctxOpts);
      await ctx.addCookies(acc.cookies.filter((c) => c.domain && c.name).map(normCookie));
      page = await ctx.newPage();
    }
    return await fn(page);
  } catch (e) {
    if (page) {
      try {
        fs.mkdirSync(U.p('logs'), { recursive: true });
        const shot = U.p('logs', `post-error-${Date.now()}.png`);
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

// ---------------------------------------------------------------- helpers
async function visible(loc, timeout = 800) {
  try { return await loc.first().isVisible({ timeout }); } catch { return false; }
}
async function clickIfVisible(loc, timeout = 800) {
  if (await visible(loc, timeout)) { await loc.first().click(); return true; }
  return false;
}
async function firstVisible(page, locators, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const l of locators) if (await visible(l, 300)) return l.first();
    await page.waitForTimeout(400);
  }
  return null;
}
async function chooseFiles(page, trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), trigger.click()]);
  await chooser.setFiles(files);
}
async function dismissPopups(page) {
  for (let i = 0; i < 3; i++) {
    const hit = await clickIfVisible(page.getByRole('button', { name: /^(Not now|Not Now|Allow all cookies|Decline optional cookies|Only allow essential cookies|OK|Cancel|Close)$/ }));
    if (!hit) break;
    await page.waitForTimeout(700);
  }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- Instagram feed post
async function igPost(page, job, log) {
  log('Loading Instagram...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4500);
  await dismissPopups(page);
  const create = page.locator('svg[aria-label="New post"], svg[aria-label="Create"], svg[aria-label="New Post"]').first();
  if (!(await create.count())) throw new Error('This account is not logged in to Instagram (no Create button). Log in again under Accounts.');
  await create.click();
  await page.waitForTimeout(1500);
  await clickIfVisible(page.locator('a:has(svg[aria-label="Post"]), [role="link"]:has-text("Post"), [role="menuitem"]:has-text("Post")'));
  await page.waitForTimeout(1200);

  log('Adding media...');
  const input = page.locator('div[role="dialog"] input[type="file"], form[enctype="multipart/form-data"] input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 20000 });
  await input.setInputFiles(job.files);
  await page.waitForTimeout(3000);
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
    const label = dlg.getByText(/post quietly|quietly to (your )?profile|share to profile only|only (share )?to (your )?profile|don.?t share to feed/i).first();
    if (await label.count()) {
      const holder = label.locator('xpath=ancestor::*[.//input[@type="checkbox"] or .//*[@role="switch"] or .//*[@role="checkbox"]][1]');
      const sw = holder.locator('input[type="checkbox"], [role="switch"], [role="checkbox"]').first();
      if (await sw.count()) {
        let on = (await sw.getAttribute('aria-checked')) === 'true';
        if (!on) { try { on = await sw.isChecked(); } catch {} }
        if (!on) await sw.click({ force: true });
      } else await label.click();
      quietSet = true;
      await page.waitForTimeout(600);
    }
    if (!quietSet && !job.allowNormal && !job.dryRun) {
      throw Object.assign(new Error('Instagram has not given this account the "Post quietly to profile" option yet, so nothing was posted. Tick "Post normally if quiet isn\'t available" to post anyway.'), { code: 'QUIET_UNAVAILABLE' });
    }
  }
  if (job.dryRun) return { ok: true, dryRun: true, found: { quiet: quietSet } };
  log('Sharing...');
  await dlg.getByRole('button', { name: /^Share$/ }).first().click();
  await page.getByText(/(post|reel) (has been|was) shared|your (post|reel) has been shared/i).first().waitFor({ timeout: 240000 });
  log(quietSet ? 'Posted quietly to profile.' : 'Posted.');
  await page.waitForTimeout(1500);
  return { ok: true, quiet: quietSet };
}

// ---------------------------------------------------------------- Instagram story (phone version of the site)
async function igStory(page, job, log) {
  if (job.files.length !== 1) throw new Error('Stories take one photo or video at a time.');
  log('Loading Instagram (phone version)...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  await dismissPopups(page);

  log('Opening the story camera...');
  const opener = await firstVisible(page, [
    page.locator('[aria-label="New story"], [aria-label="Add to story"], [aria-label="Add to your story"]'),
    page.getByRole('button', { name: /Your story/i }),
    page.getByText(/^Your story$/),
    page.locator('svg[aria-label="New post"], svg[aria-label="Create"]'),
  ], 15000);
  if (!opener) throw new Error('Could not find "Your story" on Instagram. Make sure the account is logged in.');
  try {
    await chooseFiles(page, opener, job.files);
  } catch {
    // Some layouts open a menu first (Post / Story)
    const storyItem = await firstVisible(page, [page.getByRole('menuitem', { name: /Story/i }), page.getByText(/^Story$/)], 5000);
    if (!storyItem) throw new Error('Instagram did not open the story uploader.');
    await chooseFiles(page, storyItem, job.files);
  }
  await page.waitForTimeout(5000);

  const closeFriends = page.getByRole('button', { name: /Close friends/i }).or(page.getByText(/^Close friends$/i));
  const everyone = page.getByRole('button', { name: /(Add to your story|Your story|Share to story)/i }).or(page.getByText(/^(Add to your story|Your story)$/i));
  const hasCF = await visible(closeFriends, 6000);
  const hasAll = await visible(everyone, 3000);
  log(`Story editor open (Close Friends option: ${hasCF ? 'yes' : 'no'}).`);
  if (job.dryRun) return { ok: true, dryRun: true, found: { closeFriends: hasCF, share: hasAll } };

  if (job.audience === 'close_friends') {
    if (!hasCF) throw new Error('Instagram did not offer "Close Friends" here, so nothing was posted.');
    await closeFriends.first().click();
  } else {
    if (!hasAll) throw new Error('Could not find the "Add to your story" button.');
    await everyone.first().click();
  }
  log('Uploading story...');
  await page.waitForTimeout(3000);
  await page.waitForLoadState('domcontentloaded');
  // the editor closes when the upload has been accepted
  await closeFriends.first().waitFor({ state: 'hidden', timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  log(job.audience === 'close_friends' ? 'Shared to Close Friends.' : 'Shared to your story.');
  return { ok: true };
}

// ---------------------------------------------------------------- Facebook: acting as a Page
async function switchToPage(page, pageUrl, log) {
  log('Opening the Page...');
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);
  await dismissPopups(page);
  const sw = page.getByRole('button', { name: /^Switch( now| Now)?$/ }).or(page.getByRole('button', { name: /Switch to /i }));
  if (await visible(sw, 4000)) {
    log('Switching to the Page...');
    await sw.first().click();
    await page.waitForTimeout(2500);
    await clickIfVisible(page.getByRole('dialog').getByRole('button', { name: /^Switch$/ }), 3000);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);
    if (!page.url().startsWith(pageUrl.replace(/\/$/, ''))) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(4000);
    }
  } else {
    log('Already acting as the Page (or no switch needed).');
  }
}

const FB_AUDIENCE = { public: 'Public', friends: 'Friends', friends_except: 'Friends except', specific: 'Specific friends', only_me: 'Only me', custom: 'Custom' };

async function pickPeople(page, names, log) {
  const dlg = page.locator('[role="dialog"]').last();
  const search = dlg.locator('input[type="search"], input[placeholder*="Search"], input[aria-label*="Search"]').first();
  for (const name of names) {
    log(`Adding "${name}"...`);
    await search.fill('');
    await search.type(name, { delay: 40 });
    await page.waitForTimeout(1800);
    const hit = dlg.getByRole('checkbox', { name: new RegExp(esc(name), 'i') }).or(dlg.getByRole('option', { name: new RegExp(esc(name), 'i') })).or(dlg.locator('[role="listitem"], [role="row"]').filter({ hasText: new RegExp(esc(name), 'i') }));
    if (!(await visible(hit, 3000))) throw new Error(`Could not find "${name}" in your friends list.`);
    await hit.first().click();
    await page.waitForTimeout(600);
  }
  await clickIfVisible(dlg.getByRole('button', { name: /^(Save changes|Save|Done)$/ }), 3000);
  await page.waitForTimeout(1000);
}

async function setFbAudience(page, editBtn, job, log, allowed) {
  if (!job.audience || job.audience === 'default') return true;
  const label = FB_AUDIENCE[job.audience];
  if (!label || (allowed && !allowed.includes(job.audience))) throw new Error('That audience is not available here.');
  log(`Setting audience to "${label}"...`);
  await editBtn.click();
  await page.waitForTimeout(1500);
  const dlg = page.locator('[role="dialog"]').last();
  const opt = dlg.getByRole('radio', { name: new RegExp('^' + esc(label), 'i') }).or(dlg.getByText(new RegExp('^' + esc(label) + '(\\.\\.\\.|…)?$', 'i')));
  if (!(await visible(opt, 5000))) return false;
  await opt.first().click();
  await page.waitForTimeout(1200);
  if (job.audience === 'friends_except' || job.audience === 'specific' || job.audience === 'custom') {
    const names = (job.people || []).map((s) => s.trim()).filter(Boolean);
    if (!names.length) throw new Error('Add at least one name for this audience.');
    await pickPeople(page, names, log);
  }
  await clickIfVisible(page.locator('[role="dialog"]').last().getByRole('button', { name: /^(Done|Save)$/ }), 3000);
  await page.waitForTimeout(1000);
  return true;
}

// ---------------------------------------------------------------- Facebook post (profile or Page)
async function fbPost(page, job, log) {
  if (job.pageUrl) await switchToPage(page, job.pageUrl, log);
  else {
    log('Loading Facebook...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4500);
    await dismissPopups(page);
  }
  const composer = await firstVisible(page, [
    page.getByRole('button', { name: /What.s on your mind/i }),
    page.getByText(/What.s on your mind/i),
    page.locator('[aria-label="Create a post"] [role="button"]'),
  ], 20000);
  if (!composer) throw new Error('Could not find the "What\'s on your mind?" box. Make sure the account is logged in to Facebook.');
  await composer.click();
  const dlg = page.locator('[role="dialog"]').filter({ hasText: /Create post/i }).last();
  await dlg.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);

  if (job.files && job.files.length) {
    log('Adding media...');
    let input = dlg.locator('input[type="file"]').first();
    if (!(await input.count())) {
      await clickIfVisible(dlg.getByRole('button', { name: /Photo\/video/i }).or(dlg.locator('[aria-label="Photo/video"]')), 4000);
      await page.waitForTimeout(1200);
      input = dlg.locator('input[type="file"]').first();
    }
    if (await input.count()) await input.setInputFiles(job.files);
    else await chooseFiles(page, dlg.getByText(/Add photos\/videos/i).first(), job.files);
    await page.waitForTimeout(4000);
  }
  if (job.caption) {
    log('Writing text...');
    const box = dlg.locator('[contenteditable="true"][role="textbox"]').first();
    await box.click();
    await page.keyboard.insertText(job.caption);
    await page.waitForTimeout(600);
  }
  let audienceSet = true;
  if (!job.pageUrl) {
    const edit = dlg.locator('[aria-label^="Edit privacy"], [aria-label*="Sharing with"]').first();
    if (await visible(edit, 3000)) audienceSet = await setFbAudience(page, edit, job, log);
    else audienceSet = !job.audience || job.audience === 'default';
    if (!audienceSet && !job.dryRun) throw new Error('Could not set the audience, so nothing was posted.');
  }
  if (job.dryRun) return { ok: true, dryRun: true, found: { audience: audienceSet } };

  await clickIfVisible(dlg.getByRole('button', { name: /^Next$/ }), 1500);
  await page.waitForTimeout(1200);
  log('Posting...');
  const post = page.locator('[role="dialog"]').last().getByRole('button', { name: /^Post$/ }).first();
  await post.waitFor({ state: 'visible', timeout: 20000 });
  await post.click();
  await dlg.waitFor({ state: 'hidden', timeout: 180000 });
  await page.waitForTimeout(3000);
  log('Posted to Facebook.');
  return { ok: true };
}

// ---------------------------------------------------------------- Facebook story
async function fbStory(page, job, log) {
  if (job.files.length !== 1) throw new Error('Stories take one photo at a time.');
  if (!/\.(jpe?g|png|webp|gif|heic)$/i.test(job.files[0])) throw new Error('Facebook on the web only lets you post photo stories (no video).');
  if (job.pageUrl) await switchToPage(page, job.pageUrl, log);
  log('Opening story creator...');
  await page.goto('https://www.facebook.com/stories/create', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4500);
  await dismissPopups(page);
  const photo = await firstVisible(page, [page.getByText(/Create a photo story/i), page.getByRole('button', { name: /photo story/i })], 20000);
  if (!photo) throw new Error('Could not open Facebook\'s story creator. Make sure the account is logged in.');
  await chooseFiles(page, photo, job.files);
  await page.waitForTimeout(5000);

  let audienceSet = !job.audience || job.audience === 'default';
  if (!audienceSet) {
    const settings = await firstVisible(page, [page.getByRole('button', { name: /^(Settings|Privacy|Story privacy)$/i }), page.locator('[aria-label="Settings"], [aria-label="Story settings"]')], 5000);
    if (settings) {
      log('Setting story audience...');
      await settings.click();
      await page.waitForTimeout(1500);
      const label = FB_AUDIENCE[job.audience];
      const dlg = page.locator('[role="dialog"]').last();
      const opt = dlg.getByRole('radio', { name: new RegExp('^' + esc(label), 'i') }).or(dlg.getByText(new RegExp('^' + esc(label), 'i')));
      if (await visible(opt, 4000)) {
        await opt.first().click();
        await page.waitForTimeout(1000);
        if (job.audience === 'custom') {
          const names = (job.people || []).map((s) => s.trim()).filter(Boolean);
          if (!names.length) throw new Error('Add at least one name for a Custom story audience.');
          await pickPeople(page, names, log);
        }
        await clickIfVisible(page.locator('[role="dialog"]').last().getByRole('button', { name: /^(Save|Done)$/ }), 3000);
        audienceSet = true;
      }
    }
    if (!audienceSet && !job.dryRun) throw new Error('Could not set the story audience, so nothing was posted.');
  }
  const share = page.getByRole('button', { name: /Share to story/i });
  const hasShare = await visible(share, 8000);
  if (job.dryRun) return { ok: true, dryRun: true, found: { audience: audienceSet, share: hasShare } };
  if (!hasShare) throw new Error('Could not find "Share to story".');
  log('Sharing story...');
  await share.first().click();
  await page.waitForURL((u) => !/stories\/create/.test(String(u)), { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3000);
  log('Story shared on Facebook.');
  return { ok: true };
}

// ---------------------------------------------------------------- entry point
const KINDS = {
  igpost: { fn: igPost, mobile: false, siteName: 'Instagram', loginCookie: 'sessionid', network: 'instagram' },
  igstory: { fn: igStory, mobile: true, siteName: 'Instagram', loginCookie: 'sessionid', network: 'instagram' },
  fbpost: { fn: fbPost, mobile: false, siteName: 'Facebook', loginCookie: 'c_user', network: 'messenger' },
  fbstory: { fn: fbStory, mobile: false, siteName: 'Facebook', loginCookie: 'c_user', network: 'messenger' },
};

async function run(cfg, acc, job, log = () => {}) {
  const kind = KINDS[job.kind || 'igpost'];
  if (!kind) throw new Error('Unknown post type');
  if (acc.network !== kind.network) throw new Error(`Pick a ${kind.siteName === 'Facebook' ? 'Facebook / Messenger' : 'Instagram'} account for this.`);
  const files = (job.files || []).filter((f) => fs.existsSync(f));
  if ((job.kind === 'igpost' || job.kind === 'igstory' || job.kind === 'fbstory') && !files.length) throw new Error('Choose a photo or video first.');
  if (job.kind === 'fbpost' && !files.length && !(job.caption || '').trim()) throw new Error('Write something or add a photo.');
  return withPage(cfg, acc, kind, log, (page) => kind.fn(page, { ...job, files }, log));
}

module.exports = { run, KINDS };

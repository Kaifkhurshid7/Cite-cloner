import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import type { Emit } from '../events.js';
import type { Workspace } from '../workspace.js';
import type { Analysis, Extraction } from './types.js';

const EXTRACT_SRC = fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract.browser.js'), 'utf8');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const MAX_SHOT_HEIGHT = 14000;
const MAX_SECTION_SHOT = 2400;
const MAX_ASSETS = 80;

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
}

/** Navigate, dismiss consent banners, scroll to trigger lazy content, settle. */
export async function loadPage(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e: Error) => {
    throw new Error(`Could not load ${url} – ${e.message.split('\n')[0].replace(/^page\.goto: /, '')}`);
  });
  if (res && res.status() >= 400) throw new Error(`Site responded with HTTP ${res.status()}`);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await dismissOverlays(page);
  await autoScroll(page);
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  // wait for images that are in the DOM to decode
  await page
    .evaluate(async () => {
      const imgs = Array.from(document.images).filter((i) => !i.complete);
      await Promise.race([
        Promise.all(imgs.map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r))))),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    })
    .catch(() => {});
  // stop animations so screenshots are deterministic
  await page.addStyleTag({ content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
  await page.waitForTimeout(400);
}

async function dismissOverlays(page: Page) {
  const labels = /^(accept( all)?( cookies)?|allow all|agree|i agree|got it|ok|okay|close|dismiss|continue|accept & close)$/i;
  for (const frame of [page.mainFrame()]) {
    const buttons = frame.getByRole('button', { name: labels });
    const n = await buttons.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 2); i++) {
      await buttons.nth(i).click({ timeout: 1500 }).catch(() => {});
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function autoScroll(page: Page) {
  await page
    .evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.8);
      const maxH = Math.min(document.documentElement.scrollHeight, 30000);
      for (let y = 0; y < maxH; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function fullScreenshot(page: Page, file: string) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const w = page.viewportSize()!.width;
  await page.screenshot({
    path: file,
    type: 'jpeg',
    quality: 70,
    fullPage: true,
    clip: { x: 0, y: 0, width: w, height: Math.min(h, MAX_SHOT_HEIGHT) },
  });
}

function extFromType(ct: string, url: string) {
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('icon')) return 'ico';
  return path.extname(new URL(url).pathname).slice(1).toLowerCase() || 'img';
}

/** Download referenced images into public/media so the clone does not hotlink. */
async function downloadAssets(ctx: BrowserContext, ex: Extraction, ws: Workspace, emit: Emit) {
  const map: Record<string, string> = {};
  let ok = 0;
  const list = ex.assets.slice(0, MAX_ASSETS);
  await Promise.all(
    list.map(async (a) => {
      try {
        if (a.kind === 'svg' && a.svg) {
          let svg = a.svg;
          if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
          await ws.write(`public/media/${a.id}.svg`, svg);
          map[a.id] = `media/${a.id}.svg`;
          ok++;
          return;
        }
        if (a.url.startsWith('data:')) {
          const m = a.url.match(/^data:([^;,]+)(;base64)?,(.*)$/);
          if (!m) return;
          const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
          const file = `${a.id}.${extFromType(m[1], 'http://x/y')}`;
          await ws.write(`public/media/${file}`, buf);
          map[a.id] = `media/${file}`;
          ok++;
          return;
        }
        const res = await ctx.request.get(a.url, { timeout: 15_000, headers: { referer: ex.url } });
        if (!res.ok()) throw new Error(String(res.status()));
        const body = await res.body();
        if (body.length > 6_000_000) throw new Error('too large');
        const file = `${a.id}.${extFromType(res.headers()['content-type'] ?? '', a.url)}`;
        await ws.write(`public/media/${file}`, body);
        map[a.id] = `media/${file}`;
        ok++;
      } catch {
        if (!a.url.startsWith('svg:')) map[a.id] = a.url; // hotlink fallback
      }
    }),
  );
  for (const a of ex.assets.slice(MAX_ASSETS)) if (!a.url.startsWith('svg:')) map[a.id] = a.url;
  emit({ stage: 'analyze', level: 'info', message: `Downloaded ${ok}/${list.length} assets into public/media` });
  return map;
}

const GENERIC_FONTS = /^(system-ui|-apple-system|blinkmacsystemfont|segoe ui|helvetica( neue)?|arial|sans-serif|serif|monospace|times( new roman)?|georgia|roboto|ui-sans-serif|inherit)$/i;

/** Reuse the site's web-font links, or look up the detected families on Google Fonts. */
async function resolveFonts(ctx: BrowserContext, ex: Extraction): Promise<string[]> {
  const head: string[] = [];
  const google = ex.fontLinks.filter((l) => l.includes('fonts.googleapis.com') || l.includes('fonts.bunny.net'));
  if (google.length) return google.map((href) => `<link rel="stylesheet" href="${href}" />`);
  const fams = [ex.tokens.headingFont, ex.tokens.bodyFont, ...ex.tokens.fonts.map((f) => f.value)]
    .filter((f): f is string => !!f && !GENERIC_FONTS.test(f))
    .filter((f, i, arr) => arr.indexOf(f) === i)
    .slice(0, 2);
  for (const fam of fams) {
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@300;400;500;600;700;800&display=swap`;
    const res = await ctx.request.get(href, { timeout: 8000 }).catch(() => null);
    if (res?.ok()) head.push(`<link rel="stylesheet" href="${href}" />`);
  }
  // proprietary font not on Google Fonts → load Inter as a neutral, close-enough fallback
  if (!head.length && fams.length) head.push('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" />');
  if (head.length) head.unshift('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />');
  return head;
}

/** Download the site's own @font-face fonts into public/fonts and return an inline <style> for index.html. */
async function localFonts(ctx: BrowserContext, page: Page, ws: Workspace, emit: Emit): Promise<string[]> {
  try {
    const sheets = await page.evaluate(() => ({
      links: Array.from(document.styleSheets).map((s) => s.href).filter((h): h is string => !!h),
      inline: Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? ''),
    }));
    const css: { text: string; base: string }[] = sheets.inline.map((t) => ({ text: t, base: page.url() }));
    await Promise.all(
      sheets.links.slice(0, 25).map(async (href) => {
        const r = await ctx.request.get(href, { timeout: 8000 }).catch(() => null);
        if (r?.ok()) css.push({ text: await r.text(), base: href });
      }),
    );
    const out: string[] = [];
    const seen = new Set<string>();
    for (const { text, base } of css) {
      for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
        const body = m[1];
        const fam = body.match(/font-family:\s*["']?([^;"']+)["']?/)?.[1]?.trim();
        const urls = [...body.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((u) => u[1]).filter((u) => !u.startsWith('data:'));
        const src = urls.find((u) => /\.woff2?(\?|#|$)/i.test(u)) ?? urls[0];
        if (!fam || !src || out.length >= 16) continue;
        let abs: string;
        try {
          abs = new URL(src, base).href;
        } catch {
          continue;
        }
        const weight = body.match(/font-weight:\s*([^;]+)/)?.[1]?.trim() ?? '400';
        const style = body.match(/font-style:\s*([^;]+)/)?.[1]?.trim() ?? 'normal';
        const key = `${fam}|${weight}|${style}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const res = await ctx.request.get(abs, { timeout: 12_000 }).catch(() => null);
        if (!res?.ok()) continue;
        const file = `fonts/${out.length}-${fam.replace(/[^\w-]/g, '')}${path.extname(new URL(abs).pathname) || '.woff2'}`;
        await ws.write(`public/${file}`, await res.body());
        out.push(`@font-face{font-family:"${fam}";src:url("/${file}");font-weight:${weight};font-style:${style};font-display:swap}`);
      }
    }
    if (out.length) emit({ stage: 'analyze', level: 'info', message: `Downloaded ${out.length} web fonts into public/fonts` });
    return out.length ? [`<style>${out.join('')}</style>`] : [];
  } catch {
    return [];
  }
}

/** Stage 1: turn a URL into screenshots + structured page description + local assets. */
export async function analyzeWebsite(url: string, ws: Workspace, emit: Emit): Promise<Analysis> {
  const browser = await launchBrowser();
  try {
    // desktop pass
    const ctx = await browser.newContext({ viewport: config.desktop, userAgent: UA, deviceScaleFactor: 1, locale: 'en-US' });
    const page = await ctx.newPage();
    emit({ stage: 'analyze', level: 'info', message: `Loading ${url} (desktop ${config.desktop.width}px)` });
    await loadPage(page, url);

    const src = await EXTRACT_SRC;
    const ex = (await page.evaluate(`(${src.trim()})(${JSON.stringify({ maxSections: 18, maxSectionChars: config.provider === 'offline' ? 120_000 : 9000 })})`)) as Extraction;
    emit({
      stage: 'analyze',
      level: 'info',
      message: `Found ${ex.sections.length} sections, ${ex.assets.length} assets, ${ex.nav.length} nav links; fonts: ${ex.tokens.fonts
        .slice(0, 2)
        .map((f) => f.value)
        .join(', ')}`,
      data: { sections: ex.sections.map((s) => ({ index: s.index, role: s.role, headings: s.headings, h: s.rect.h })) },
    });

    const desktopFull = path.join(ws.captureDir, 'original-desktop.jpg');
    await fullScreenshot(page, desktopFull);
    const sectionShots: string[] = [];
    for (const s of ex.sections) {
      const file = path.join(ws.captureDir, `section-${s.index}.jpg`);
      const h = Math.max(1, Math.min(s.rect.h, MAX_SECTION_SHOT));
      await page
        .screenshot({ path: file, type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: s.rect.y, width: config.desktop.width, height: h } })
        .catch(() => {});
      sectionShots.push(file);
    }
    emit({ stage: 'analyze', level: 'info', message: 'Captured full-page and per-section screenshots', data: { screenshot: 'original-desktop.jpg' } });

    const assetMap = await downloadAssets(ctx, ex, ws, emit);
    const own = await localFonts(ctx, page, ws, emit);
    const fontHead = own.length ? own : await resolveFonts(ctx, ex);
    await ctx.close();

    // mobile pass (for responsive intent)
    const mctx = await browser.newContext({ viewport: config.mobile, userAgent: MOBILE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const mpage = await mctx.newPage();
    emit({ stage: 'analyze', level: 'info', message: `Loading mobile view (${config.mobile.width}px)` });
    let mobileNavCollapsed = false;
    const mobileFull = path.join(ws.captureDir, 'original-mobile.jpg');
    try {
      await loadPage(mpage, url);
      await fullScreenshot(mpage, mobileFull);
      mobileNavCollapsed = await mpage.evaluate((texts: string[]) => {
        const visible = Array.from(document.querySelectorAll('a')).filter((a) => {
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top < 200 && texts.includes((a.textContent || '').trim());
        });
        return visible.length < Math.max(2, texts.length / 2);
      }, ex.nav.map((n) => n.text));
    } catch (e) {
      emit({ stage: 'analyze', level: 'warn', message: `Mobile capture failed: ${(e as Error).message}` });
    }
    await mctx.close();

    const analysis: Analysis = {
      ...ex,
      assetMap,
      fontHead,
      screenshots: { desktopFull, mobileFull, sections: sectionShots },
      mobileNavCollapsed,
    };
    await fs.writeFile(path.join(ws.captureDir, 'analysis.json'), JSON.stringify({ ...analysis, assets: analysis.assets.map((a) => ({ ...a, svg: undefined })) }, null, 2));
    return analysis;
  } finally {
    await browser.close();
  }
}

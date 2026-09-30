import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Browser } from 'playwright';
import { launchBrowser } from '../analyze/crawl.js';
import { config } from '../config.js';
import type { Workspace } from '../workspace.js';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2',
};

/** Minimal static server for dist/ (ES modules cannot be loaded from file://). */
export async function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(dir, p.endsWith('/') ? p + 'index.html' : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const st = await fs.stat(file);
      if (st.isDirectory()) file = path.join(file, 'index.html');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) };
}

export interface RuntimeResult {
  ok: boolean;
  /** section component name → runtime error */
  sectionErrors: Record<string, string>;
  pageErrors: string[];
  renderedTextLength: number;
  shots: { desktop: string; mobile: string };
  /** section name → rect (page coords) in the desktop render */
  sectionRects: Record<string, { y: number; h: number }>;
}

/**
 * Load the built site in a real browser: catch runtime exceptions (which blank a React page even when the
 * build is green), then capture desktop + mobile screenshots for visual scoring.
 */
export async function runtimeCheck(ws: Workspace, browser?: Browser): Promise<RuntimeResult> {
  const own = !browser;
  browser ??= await launchBrowser();
  const srv = await serveDir(ws.distDir);
  try {
    const ctx = await browser.newContext({ viewport: config.desktop, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const sectionErrors: Record<string, string> = {};
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const m = msg.text().match(/\[section-error\] ([\w$]+): ([\s\S]*)/);
      if (m) sectionErrors[m[1]] = m[2].slice(0, 500);
    });
    page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 500)));
    await page.goto(srv.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const renderedTextLength = await page.evaluate(() => document.getElementById('root')?.innerText.trim().length ?? 0);
    const sectionRects = await page.evaluate(() => {
      const out: Record<string, { y: number; h: number }> = {};
      document.querySelectorAll<HTMLElement>('[data-section]').forEach((el) => {
        let top = Infinity;
        let bottom = -Infinity;
        for (const c of Array.from(el.children)) {
          const r = c.getBoundingClientRect();
          if (!r.height) continue;
          top = Math.min(top, r.top + scrollY);
          bottom = Math.max(bottom, r.bottom + scrollY);
        }
        if (top < bottom) out[el.dataset.section!] = { y: Math.round(top), h: Math.round(bottom - top) };
      });
      return out;
    });
    const desktop = path.join(ws.captureDir, 'generated-desktop.jpg');
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: desktop, type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: 0, width: config.desktop.width, height: Math.min(h, 14000) } });
    // per-section crops for the visual refinement loop
    for (const [name, r] of Object.entries(sectionRects)) {
      if (r.h < 2) continue;
      await page
        .screenshot({ path: path.join(ws.captureDir, `gen-${name}.jpg`), type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: r.y, width: config.desktop.width, height: Math.min(r.h, 2400) } })
        .catch(() => {});
    }
    await ctx.close();

    const mctx = await browser.newContext({ viewport: config.mobile, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const mpage = await mctx.newPage();
    await mpage.goto(srv.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await mpage.waitForTimeout(400);
    const mobile = path.join(ws.captureDir, 'generated-mobile.jpg');
    const mh = await mpage.evaluate(() => document.documentElement.scrollHeight);
    await mpage.screenshot({ path: mobile, type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: 0, width: config.mobile.width, height: Math.min(mh, 14000) } });
    const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 8) pageErrors.push(`[layout] horizontal overflow of ${overflow}px on mobile`);
    await mctx.close();

    const fatal = pageErrors.filter((e) => !e.startsWith('[layout]'));
    return {
      ok: !fatal.length && !Object.keys(sectionErrors).length && renderedTextLength > 0,
      sectionErrors,
      pageErrors,
      renderedTextLength,
      shots: { desktop, mobile },
      sectionRects,
    };
  } finally {
    await srv.close();
    if (own) await browser.close();
  }
}

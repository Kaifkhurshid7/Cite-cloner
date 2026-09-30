import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATE_DIR } from '../config.js';

/**
 * Cheap, deterministic fixes applied to every generated file BEFORE building.
 * Each one prevents a whole class of build errors without spending an LLM repair call.
 */

let lucideNames: Set<string> | null = null;
function lucideExports(): Set<string> {
  if (lucideNames) return lucideNames;
  lucideNames = new Set();
  try {
    const dts = fs.readFileSync(path.join(TEMPLATE_DIR, 'node_modules/lucide-react/dist/lucide-react.d.ts'), 'utf8');
    for (const block of dts.matchAll(/export \{([^}]+)\}/g)) {
      for (const part of block[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Z]\w*$/.test(name)) lucideNames.add(name);
      }
    }
  } catch {
    /* template not installed – skip icon validation */
  }
  return lucideNames;
}

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const ICON_ALIASES: Record<string, string> = {
  Twitter: 'AtSign', Github: 'Code', Linkedin: 'Briefcase', Facebook: 'ThumbsUp', Instagram: 'Camera', Youtube: 'Play',
  Dribbble: 'Circle', Figma: 'PenTool', Slack: 'Hash', Discord: 'MessageCircle', Tiktok: 'Music',
};

function closestIcon(name: string, names: Set<string>) {
  if (ICON_ALIASES[name] && names.has(ICON_ALIASES[name])) return ICON_ALIASES[name];
  const base = name.replace(/Icon$/, '');
  if (names.has(base)) return base;
  let best = 'Circle';
  let bestD = Infinity;
  for (const n of names) {
    if (Math.abs(n.length - base.length) > 3) continue;
    const d = editDistance(n.toLowerCase(), base.toLowerCase());
    if (d < bestD) [best, bestD] = [n, d];
  }
  return bestD <= 3 ? best : 'Circle';
}

/** Rewrites unknown lucide imports as aliases of existing icons: `Foo` → `Circle as Foo` (JSX untouched). */
export function fixLucideImports(code: string): { code: string; fixed: string[] } {
  const names = lucideExports();
  const fixed: string[] = [];
  if (!names.size) return { code, fixed };
  const out = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"];?/g, (_m, list: string) => {
    const parts = list
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !p.startsWith('type '))
      .map((p) => {
        const [imported, local] = p.split(/\s+as\s+/).map((s) => s.trim());
        if (names.has(imported)) return p;
        const repl = closestIcon(imported, names);
        fixed.push(`${imported}→${repl}`);
        return `${repl} as ${local ?? imported}`;
      });
    return `import { ${parts.join(', ')} } from 'lucide-react';`;
  });
  return { code: out, fixed };
}

export function sanitizeComponent(code: string, name: string): { code: string; notes: string[] } {
  const notes: string[] = [];
  let c = code.replace(/\r\n/g, '\n');

  // Next.js-isms → plain React
  if (/from ['"]next\/image['"]/.test(c)) {
    c = c.replace(/import\s+\w+\s+from\s+['"]next\/image['"];?\n?/g, '').replace(/<Image\b/g, '<img').replace(/<\/Image>/g, '</img>');
    notes.push('next/image → img');
  }
  if (/from ['"]next\/link['"]/.test(c)) {
    c = c.replace(/import\s+\w+\s+from\s+['"]next\/link['"];?\n?/g, '').replace(/<Link\b/g, '<a').replace(/<\/Link>/g, '</a>');
    notes.push('next/link → a');
  }
  c = c.replace(/^['"]use client['"];?\n/m, '');
  // UI primitives imported with wrong paths / default vs named
  c = c.replace(/from\s+['"](?:@\/components\/ui|\.\.?\/(?:components\/)?ui)\/(Button|Container)['"]/g, "from '../ui/$1'");
  c = c.replace(/import\s+(Button|Container)\s+from\s+'\.\.\/ui\/(Button|Container)'/g, "import { $1 } from '../ui/$2'");
  // absolute media paths break when the site is served from a sub-path
  c = c.replace(/(["'(])\/media\//g, '$1media/');
  // class= → className=
  c = c.replace(/<([a-z][\w-]*)([^>]*?)\sclass=/g, '<$1$2 className=');

  const lucide = fixLucideImports(c);
  c = lucide.code;
  if (lucide.fixed.length) notes.push(`icons: ${lucide.fixed.join(', ')}`);

  // ensure a default export with the expected name exists
  if (!/export\s+default/.test(c)) {
    const fn = c.match(/(?:function|const)\s+([A-Z]\w*)/);
    if (fn) {
      c += `\nexport default ${fn[1]};\n`;
      notes.push('added default export');
    }
  }
  if (!new RegExp(`\\b${name}\\b`).test(c)) {
    c = c.replace(/export\s+default\s+function\s+[A-Z]\w*/, `export default function ${name}`);
  }
  return { code: c, notes };
}

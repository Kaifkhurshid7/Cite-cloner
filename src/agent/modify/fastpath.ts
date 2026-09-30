import { sectionsFromApp } from '../generate/assemble.js';
import type { FileOp } from '../llm/parse.js';
import type { Workspace } from '../workspace.js';

/**
 * Deterministic handlers for the most common, unambiguous edit requests.
 * They cost $0 and ~0s; anything not matched precisely goes to the LLM agent.
 */

const NAMED: Record<string, string> = {
  blue: '#2563eb', red: '#dc2626', green: '#16a34a', emerald: '#059669', teal: '#0d9488', cyan: '#0891b2', sky: '#0284c7',
  indigo: '#4f46e5', violet: '#7c3aed', purple: '#9333ea', fuchsia: '#c026d3', pink: '#db2777', rose: '#e11d48',
  orange: '#ea580c', amber: '#d97706', yellow: '#eab308', lime: '#65a30d', black: '#111111', white: '#ffffff',
  gray: '#6b7280', grey: '#6b7280', slate: '#475569', navy: '#1e3a8a', brown: '#92400e', gold: '#ca8a04',
};

function toHex(v: string): string | null {
  const s = v.toLowerCase().replace(/[.!]$/, '');
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  return NAMED[s] ?? null;
}

function contrast(hex: string) {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#111111' : '#ffffff';
}

function setVar(css: string, name: string, value: string) {
  const re = new RegExp(`(--${name}:\\s*)[^;]+;`);
  return re.test(css) ? css.replace(re, `$1${value};`) : css;
}

export async function fastPath(ws: Workspace, instruction: string): Promise<{ ops: FileOp[]; summary: string } | null> {
  const text = instruction.trim();

  // "change the primary color to blue" / "make the accent colour #ff0055"
  const color = text.match(/^(?:change|make|set|update|switch)\s+(?:the\s+)?(primary|brand|main|accent|background|text)\s+colou?r\s+(?:to|=|into)?\s*(#[0-9a-f]{3,6}|[a-z]+)\.?$/i);
  if (color) {
    const hex = toHex(color[2]);
    if (!hex) return null;
    const target = color[1].toLowerCase();
    let css = await ws.read('src/theme.css');
    if (['primary', 'brand', 'main'].includes(target)) {
      css = setVar(css, 'color-primary', hex);
      css = setVar(css, 'color-primary-foreground', contrast(hex));
    } else if (target === 'accent') css = setVar(css, 'color-accent', hex);
    else if (target === 'background') css = setVar(css, 'color-background', hex);
    else css = setVar(css, 'color-foreground', hex);
    return { ops: [{ path: 'src/theme.css', action: 'write', content: css }], summary: `Set the ${target} colour to ${hex} in the theme tokens (src/theme.css).` };
  }

  // "make the navbar sticky"
  if (/^make\s+(?:the\s+)?(?:navbar|nav|navigation|header|menu)(?:\s+bar)?\s+sticky\.?$/i.test(text)) {
    const app = await ws.read('src/App.tsx');
    const nav = sectionsFromApp(app).find((n) => /nav|header|menu/i.test(n));
    if (!nav) return null;
    const file = `src/components/sections/${nav}.tsx`;
    const code = await ws.read(file);
    const ret = code.indexOf('return (');
    if (ret < 0) return null;
    const m = /<([a-z][\w]*)(\s[^>]*?)?>/.exec(code.slice(ret));
    if (!m) return null;
    const tagStart = ret + m.index;
    const tag = m[0];
    let newTag: string;
    if (/className="[^"]*"/.test(tag)) {
      newTag = tag.replace(/className="([^"]*)"/, (_x, c: string) => `className="${c.replace(/\b(relative|static|fixed|absolute)\b/g, '').trim()} sticky top-0 z-50"`);
    } else if (!/className=/.test(tag)) {
      newTag = tag.replace(/^<([a-z][\w]*)/, '<$1 className="sticky top-0 z-50"');
    } else return null; // dynamic className – let the LLM do it
    if (/\bsticky\b/.test(tag)) return { ops: [], summary: `${nav} is already sticky.` };
    const updated = code.slice(0, tagStart) + newTag + code.slice(tagStart + tag.length);
    return { ops: [{ path: file, action: 'write', content: updated }], summary: `Made ${nav} sticky (sticky top-0 z-50 on its root element).` };
  }

  // "remove the pricing section"
  const rm = text.match(/^(?:remove|delete|drop|hide)\s+(?:the\s+)?([\w\s-]+?)\s+section\.?$/i);
  if (rm) {
    const key = rm[1].toLowerCase().replace(/[\s-]+/g, '');
    const names = sectionsFromApp(await ws.read('src/App.tsx'));
    const hits = names.filter((n) => n.toLowerCase().includes(key));
    if (hits.length !== 1) return null;
    return { ops: [{ path: `src/components/sections/${hits[0]}.tsx`, action: 'delete' }], summary: `Removed the ${hits[0]} section.` };
  }
  return null;
}

import type { Analysis } from '../analyze/types.js';
import type { LLM } from '../llm/client.js';
import { extractCode } from '../llm/parse.js';
import { compileSection, resolveAssets, type TokenMap } from './domToJsx.js';
import { imagePart } from './images.js';
import type { SectionPlan, SitePlan, Theme } from './plan.js';
import { SECTION_SYSTEM } from './prompts.js';

export interface GeneratedSection {
  name: string;
  code: string;
  /** true when produced by the deterministic compiler instead of the LLM */
  fallback: boolean;
  error?: string;
}

function assetListFor(dom: string, a: Analysis) {
  const ids = [...new Set([...dom.matchAll(/\{\{(img_\d+)\}\}/g)].map((m) => m[1]))];
  return ids
    .map((id) => {
      const asset = a.assets.find((x) => x.id === id);
      const p = a.assetMap[id];
      if (!p) return null;
      return `- ${p}${asset?.w ? ` (${asset.w}x${asset.h} on page)` : ''}${asset?.alt ? ` alt="${asset.alt}"` : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function tokenMap(theme: Theme): TokenMap {
  const m: TokenMap = {};
  // order matters: later entries win for duplicate hex values
  const pairs: [string, string][] = [
    ['muted-foreground', theme.mutedForeground], ['muted', theme.muted], ['accent', theme.accent],
    ['foreground', theme.foreground], ['background', theme.background], ['primary', theme.primary],
  ];
  for (const [k, v] of pairs) if (/^#[0-9a-f]{6}$/i.test(v)) m[v.toLowerCase()] = k;
  return m;
}

export function fallbackSection(sec: SectionPlan, a: Analysis, theme?: Theme): string {
  const s = a.sections[sec.index];
  return compileSection(sec.name, resolveAssets(s?.dom ?? '', a.assetMap), s?.role ?? 'content', theme ? tokenMap(theme) : {});
}

/** Generate one section component with the vision model (screenshot + annotated DOM). */
export async function generateSection(sec: SectionPlan, plan: SitePlan, a: Analysis, llm: LLM): Promise<GeneratedSection> {
  if (!llm.available) return { name: sec.name, code: fallbackSection(sec, a, plan.theme), fallback: true };
  const s = a.sections[sec.index];
  const dom = resolveAssets(s.dom, a.assetMap);
  const neighbours = plan.sections.map((x) => `${x.index === sec.index ? '→ ' : '  '}${x.name} (${x.role})`).join('\n');
  const text = [
    `Component name: ${sec.name}\nRole: ${sec.role}\nPlan: ${sec.description}\nMobile behaviour: ${sec.responsive || 'stack columns, scale type down'}`,
    `Page structure (this component is marked →):\n${neighbours}`,
    `Theme tokens: ${JSON.stringify(plan.theme)}`,
    sec.role === 'navbar' || s.role === 'header'
      ? `Navigation: ${a.nav.map((l) => `${l.text} → ${l.href}`).join(' | ')}. On mobile the nav ${a.mobileNavCollapsed ? 'collapses behind a menu button' : 'stays visible'}. Original position: ${s.position}.`
      : '',
    `Section box on the original page: ${s.rect.w}x${s.rect.h}px, background ${s.bg ?? 'transparent (page background)'}.`,
    `Images available for this section (use these exact paths):\n${assetListFor(s.dom, a) || '(none)'}`,
    `Annotated DOM:\n${dom}`,
    'The image is a screenshot of the ORIGINAL section at 1440px width. Recreate it.',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await llm.complete({
      label: `section:${sec.name}`,
      tier: 'main',
      system: SECTION_SYSTEM,
      maxTokens: 8000,
      content: [{ type: 'text', text }, await imagePart(a.screenshots.sections[sec.index], { width: 1200, maxHeight: 2000 })],
    });
    const code = extractCode(res.text);
    if (!/export\s+default/.test(code) || code.length < 80) throw new Error('model returned no component');
    return { name: sec.name, code, fallback: false };
  } catch (e) {
    return { name: sec.name, code: fallbackSection(sec, a, plan.theme), fallback: true, error: (e as Error).message };
  }
}

/** Runs async tasks with a bounded number of concurrent workers. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

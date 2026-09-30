import { z } from 'zod';
import type { Analysis } from '../analyze/types.js';
import type { Emit } from '../events.js';
import type { LLM } from '../llm/client.js';
import { extractJson } from '../llm/parse.js';
import { imageTiles } from './images.js';
import { PLANNER_SYSTEM } from './prompts.js';

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);

export const ThemeSchema = z.object({
  primary: hex,
  primaryForeground: hex,
  secondary: hex,
  secondaryForeground: hex,
  background: hex,
  foreground: hex,
  muted: hex,
  mutedForeground: hex,
  accent: hex,
  border: hex,
  headingFont: z.string(),
  bodyFont: z.string(),
  radius: z.number(),
  containerWidth: z.number(),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const SectionPlanSchema = z.object({
  index: z.number(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  responsive: z.string().optional().default(''),
});
export type SectionPlan = z.infer<typeof SectionPlanSchema>;

export const SitePlanSchema = z.object({
  siteName: z.string(),
  theme: ThemeSchema,
  sections: z.array(SectionPlanSchema),
});
export type SitePlan = z.infer<typeof SitePlanSchema>;

// ---------------------------------------------------------------- heuristics

function luminance(h: string) {
  const n = h.replace('#', '').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function saturation(h: string) {
  const n = h.replace('#', '').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
const solid = (h?: string | null) => (h && /^#[0-9a-f]{6}$/i.test(h) ? h : null);
const contrastFg = (bg: string) => (luminance(bg) > 0.55 ? '#111111' : '#ffffff');

/** Deterministic theme from measured computed styles – used as LLM hint and offline fallback. */
export function heuristicTheme(a: Analysis): Theme {
  const t = a.tokens;
  const background = solid(t.bodyBg) ?? '#ffffff';
  const foreground = solid(t.bodyColor) ?? contrastFg(background);
  const colorful = [...t.buttonColors, ...t.bgColors, ...t.textColors]
    .map((c) => solid(c.value))
    .filter((c): c is string => !!c && saturation(c) > 0.35 && c !== background);
  const primary = colorful[0] ?? foreground;
  const accent = colorful.find((c) => c !== primary) ?? primary;
  const bgs = t.bgColors.map((c) => solid(c.value)).filter((c): c is string => !!c && c !== background);
  const muted = bgs.find((c) => saturation(c) < 0.3) ?? (luminance(background) > 0.5 ? '#f5f5f5' : '#1a1a1a');
  const texts = t.textColors.map((c) => solid(c.value)).filter((c): c is string => !!c && c !== foreground && c !== background);
  const mutedForeground = texts.find((c) => saturation(c) < 0.4) ?? (luminance(background) > 0.5 ? '#6b7280' : '#a1a1aa');
  const radius = Number(t.radii[0]?.value ?? 8);
  return {
    primary,
    primaryForeground: contrastFg(primary),
    secondary: muted,
    secondaryForeground: foreground,
    background,
    foreground,
    muted,
    mutedForeground,
    accent,
    border: luminance(background) > 0.5 ? '#e5e7eb' : '#27272a',
    headingFont: t.headingFont ?? t.bodyFont,
    bodyFont: t.bodyFont,
    radius: Number.isFinite(radius) ? radius : 8,
    containerWidth: 1200,
  };
}

const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'your', 'our', 'we', 'is', 'are']);

function pascal(words: string) {
  return words
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()))
    .slice(0, 3)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

export function heuristicSections(a: Analysis): SectionPlan[] {
  let heroDone = false;
  return a.sections.map((s) => {
    let name: string;
    let role: string = s.role;
    if (s.role === 'header') name = 'Navbar';
    else if (s.role === 'footer') name = 'Footer';
    else if (!heroDone && (s.dom.includes('<h1') || s.index <= 2) && s.rect.h > 250) {
      name = 'Hero';
      role = 'hero';
      heroDone = true;
    } else if (s.rect.h < 60) {
      name = 'AnnouncementBar';
      role = 'announcement';
    } else name = (pascal(s.headings[0] ?? '') || 'Content') + 'Section';
    return { index: s.index, name, role, description: s.headings[0] ?? s.textPreview.slice(0, 80), responsive: '' };
  });
}

/** Make component names valid, unique identifiers. */
export function normalizeSections(sections: SectionPlan[]): SectionPlan[] {
  const seen = new Map<string, number>();
  return sections.map((s) => {
    let name = s.name.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''));
    name = name ? name[0].toUpperCase() + name.slice(1) : 'Section';
    if (/^[0-9]/.test(name)) name = 'S' + name;
    if (['App', 'Container', 'Button', 'SectionBoundary'].includes(name)) name += 'Section';
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return { ...s, name: n ? `${name}${n + 1}` : name };
  });
}

// ---------------------------------------------------------------- planner

export async function planSite(a: Analysis, llm: LLM, emit: Emit): Promise<SitePlan> {
  const baseTheme = heuristicTheme(a);
  const baseSections = heuristicSections(a);
  const fallback: SitePlan = { siteName: a.title || new URL(a.url).hostname, theme: baseTheme, sections: normalizeSections(baseSections) };
  if (!llm.available) {
    emit({ stage: 'plan', level: 'info', message: 'No LLM configured – using heuristic plan' });
    return fallback;
  }

  const outline = a.sections
    .map(
      (s) =>
        `#${s.index} role=${s.role} tag=${s.tag} y=${s.rect.y} h=${s.rect.h} bg=${s.bg ?? 'transparent'} links=${s.counts.links} images=${s.counts.images}\n` +
        `   headings: ${JSON.stringify(s.headings)}\n   text: ${s.textPreview.slice(0, 200)}`,
    )
    .join('\n');

  const text = [
    `URL: ${a.url}\nTitle: ${a.title}\nDescription: ${a.description}`,
    `Navigation links: ${a.nav.map((n) => n.text).join(' | ')}`,
    `Mobile: navigation ${a.mobileNavCollapsed ? 'collapses into a menu button' : 'stays visible'} at 390px.`,
    `Measured design tokens (computed styles, weighted by usage):\n${JSON.stringify(a.tokens)}`,
    `Heuristic theme guess (correct it using the screenshots):\n${JSON.stringify(baseTheme)}`,
    `Detected sections (top → bottom). You MUST return exactly one entry per index, same order:\n${outline}`,
    'Images: first the desktop page (1440px wide, downscaled, split top→bottom into tiles), then the mobile page (390px) tiles.',
  ].join('\n\n');

  try {
    const res = await llm.complete({
      label: 'plan',
      tier: 'main',
      system: PLANNER_SYSTEM,
      maxTokens: 4000,
      content: [
        { type: 'text', text },
        ...(await imageTiles(a.screenshots.desktopFull, { width: 720, tileHeight: 1400, maxTiles: 4 })),
        ...(await imageTiles(a.screenshots.mobileFull, { width: 390, tileHeight: 1600, maxTiles: 2 }).catch(() => [])),
      ],
    });
    const parsed = SitePlanSchema.parse(extractJson(res.text));
    // keep 1:1 mapping with the extracted sections even if the model skipped/merged some
    const byIndex = new Map(parsed.sections.map((s) => [s.index, s]));
    const sections = baseSections.map((b) => byIndex.get(b.index) ?? b);
    const plan = { ...parsed, sections: normalizeSections(sections) };
    emit({
      stage: 'plan',
      level: 'success',
      message: `Planned ${plan.sections.length} components: ${plan.sections.map((s) => s.name).join(', ')}`,
      data: { theme: plan.theme },
    });
    return plan;
  } catch (e) {
    emit({ stage: 'plan', level: 'warn', message: `Planner failed (${(e as Error).message.slice(0, 160)}) – using heuristic plan` });
    return fallback;
  }
}

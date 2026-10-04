/**
 * Deterministic "DOM → JSX" compiler.
 *
 * Converts the annotated DOM produced by the analyzer into a Tailwind React component without any LLM.
 * Used for: (1) offline mode (no API key), (2) the safety net when an LLM-generated section still fails
 * to build/run after the repair budget is exhausted – the page always renders.
 */

interface Node {
  kind: 'el' | 'text' | 'icon' | 'placeholder';
  tag?: string;
  attrs?: Record<string, string>;
  flags?: Set<string>;
  text?: string;
  children: Node[];
  parent?: Node;
  heavy?: boolean;
}

const KNOWN_TAGS = new Set([
  'div', 'section', 'header', 'nav', 'footer', 'main', 'article', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'a',
  'ul', 'ol', 'li', 'b', 'strong', 'em', 'i', 'small', 'img', 'button', 'label', 'blockquote', 'figure', 'figcaption', 'code',
  'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'input', 'textarea', 'dl', 'dt', 'dd', 'sup', 'sub', 'time', 'address',
]);
const INLINE = new Set(['span', 'b', 'strong', 'em', 'i', 'small', 'label', 'code', 'sup', 'sub', 'time']);
const VOID = new Set(['img', 'input', 'hr']);

/** Replace {{img_3}} placeholders with local media paths (or remote URLs). */
export function resolveAssets(dom: string, map: Record<string, string>) {
  return dom.replace(/\{\{(img_\d+)\}\}/g, (_, id) => map[id] ?? `https://picsum.photos/seed/${id}/800/600`);
}

function parseAttrs(s: string): { attrs: Record<string, string>; flags: Set<string> } {
  const attrs: Record<string, string> = {};
  const flags = new Set<string>();
  let last: string | null = null;
  for (const m of s.matchAll(/([\w-]+)=("([^"]*)"|\S+)|(\S+)/g)) {
    if (m[1]) {
      attrs[m[1]] = m[3] ?? m[2];
      last = m[1];
    } else if (m[4]) {
      if (m[4].startsWith('#') && last && /^border/.test(last)) attrs[last] += ' ' + m[4];
      else if (/^-?\d+$/.test(m[4]) && last && (last === 'pad' || last === 'm' || last === 'mx')) attrs[last] += ' ' + m[4];
      else flags.add(m[4]);
    }
  }
  return { attrs, flags };
}

export function parseDom(dom: string): Node[] {
  const roots: Node[] = [];
  const stack: { depth: number; node: Node }[] = [];
  for (const raw of dom.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('…')) continue;
    const depth = Math.floor((raw.length - raw.trimStart().length) / 2);
    const line = raw.trim();
    let node: Node;
    if (line.startsWith('"')) node = { kind: 'text', text: line.slice(1, -1), children: [] };
    else if (line.startsWith('[icon')) node = { kind: 'icon', text: line.match(/"([^"]+)"/)?.[1], attrs: { size: line.match(/(\d+x\d+)/)?.[1] ?? '20x20' }, children: [] };
    else if (line.startsWith('[')) node = { kind: 'placeholder', text: line.slice(1, -1), children: [] };
    else {
      const m = line.match(/^<([\w-]+)\s*(.*?)>$/);
      if (!m) continue;
      const { attrs, flags } = parseAttrs(m[2]);
      // size=WxH appears as attr; src/bg-image paths too
      node = { kind: 'el', tag: m[1].toLowerCase(), attrs, flags, children: [] };
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) {
      node.parent = stack[stack.length - 1].node;
      stack[stack.length - 1].node.children.push(node);
    }
    else roots.push(node);
    if (node.kind === 'el') stack.push({ depth, node });
  }
  return roots;
}

const n = (v?: string) => Math.round(parseFloat(v ?? '0') || 0);
const JUSTIFY: Record<string, string> = {
  center: 'justify-center', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly',
  'flex-end': 'justify-end', end: 'justify-end',
};
const ITEMS: Record<string, string> = { center: 'items-center', 'flex-start': 'items-start', start: 'items-start', 'flex-end': 'items-end', end: 'items-end', baseline: 'items-baseline' };

const WEIGHT: Record<number, string> = {
  100: 'font-thin', 200: 'font-extralight', 300: 'font-light', 400: 'font-normal', 500: 'font-medium', 600: 'font-semibold', 700: 'font-bold', 800: 'font-extrabold', 900: 'font-black',
};

function fontSize(px: number) {
  if (px >= 36) return `text-[${Math.round(px * 0.62)}px] md:text-[${px}px]`;
  if (px >= 24) return `text-[${Math.round(px * 0.8)}px] md:text-[${px}px]`;
  return `text-[${px}px]`;
}

/** hex (lowercase) → theme token name, so global theme edits also restyle compiled sections */
export type TokenMap = Record<string, string>;
let TOKENS: TokenMap = {};
const color = (prefix: string, hex: string) => (TOKENS[hex.toLowerCase()] ? `${prefix}-${TOKENS[hex.toLowerCase()]}` : `${prefix}-[${hex}]`);

function classesFor(node: Node, ctx: { role: string; isRoot: boolean }): { cls: string[]; style: Record<string, string> } {
  const a = node.attrs ?? {};
  const f = node.flags ?? new Set();
  const cls: string[] = [];
  const style: Record<string, string> = {};
  const tag = node.tag!;
  const elKids = node.children.filter((c) => c.kind === 'el');

  if (f.has('flex-row') || f.has('flex-col')) {
    const col = f.has('flex-col');
    const [rg, cg] = (a.gap ?? '0/0').split('/').map(Number);
    // multi-column content rows stack on mobile; nav-like rows (many small items) stay horizontal
    const heavy = !col && ctx.role !== 'header' && elKids.length >= 2 && elKids.length <= 4 && cg >= 24 &&
      elKids.some((k) => k.children.some((c) => c.kind === 'el'));
    node.heavy = heavy;
    cls.push(col ? 'flex flex-col' : heavy ? 'flex flex-col md:flex-row' : 'flex flex-row');
    if (f.has('wrap') || (!col && (ctx.role === 'header' || elKids.length > 4))) cls.push('flex-wrap', 'gap-x-4');
    if (a.justify && JUSTIFY[a.justify]) cls.push(JUSTIFY[a.justify]);
    if (a.items && ITEMS[a.items]) cls.push(heavy ? `md:${ITEMS[a.items]}` : ITEMS[a.items]);
    if (rg) cls.push(`gap-y-[${rg}px]`);
    if (cg) cls.push(heavy ? `gap-y-[${Math.max(rg, 24)}px] md:gap-x-[${cg}px]` : `gap-x-[${cg}px]`);
  }
  if (f.has('grid')) {
    const cols = n(a.cols) || 1;
    const tr = (a.gtc ?? '').split(',').map(Number).filter((v) => v > 0);
    if (tr.length >= 2) {
      const min = Math.min(...tr);
      const fr = tr.map((v) => `minmax(0,${Math.round((v / min) * 100) / 100}fr)`).join('_');
      cls.push('grid', tr.length >= 3 ? `grid-cols-1 ${tr.length >= 4 ? 'sm:grid-cols-2 ' : ''}md:grid-cols-[${fr}]` : `grid-cols-1 md:grid-cols-[${fr}]`);
    } else cls.push('grid', cols >= 3 ? `grid-cols-1 sm:grid-cols-2 md:grid-cols-${Math.min(cols, 12)}` : cols === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1');
    const [rg, cg] = (a.gap ?? '0/0').split('/').map(Number);
    if (rg || cg) cls.push(`gap-y-[${rg || cg}px] gap-x-[${cg}px]`);
  }
  if (f.has('sticky') || f.has('fixed')) cls.push('sticky top-0 z-50');
  if (f.has('rel') && !f.has('sticky') && !f.has('fixed')) cls.push('relative');
  if (f.has('clip')) cls.push('overflow-hidden');
  if (a.gcol && /^[\w-]+\/[\w-]+$/.test(a.gcol)) cls.push(`md:[grid-column:${a.gcol}]`);
  if (a.grow && /^[\w-]+\/[\w-]+$/.test(a.grow)) cls.push(`md:[grid-row:${a.grow}]`);
  if (a.hfix) cls.push(`min-h-[${Math.round(n(a.hfix) * 0.7)}px] md:min-h-[${n(a.hfix)}px]`);
  if (f.has('abs')) {
    const z = a.z ? `z-[${a.z}]` : 'z-[1]';
    if (f.has('inset0')) cls.push('absolute inset-0', z);
    else cls.push('absolute', `top-[${n(a.top)}px]`, `left-[${n(a.left)}px]`, `w-[${n(a.wpx)}px] max-w-full`, n(a.hpx) && n(a.hpx) < 1200 ? `h-[${n(a.hpx)}px]` : '', z);
  } else if (a.wp && node.parent) {
    const w = `${a.wp}%`;
    cls.push(node.parent.heavy ? `w-full md:w-[${w}] md:shrink` : `md:w-[${w}]`);
  } else if (f.has('grow') && node.parent) cls.push('grow basis-0 min-w-0');
  if (a.font) {
    const fam = a.font.replace(/^"|"$/g, '');
    if (fam && !/^(inherit|sans-serif|serif|system-ui)$/i.test(fam) && !/[\[\]{}"'`]/.test(fam)) cls.push(`font-[family-name:${fam.replace(/ /g, '_')}]`);
  }
  if (a.bg) cls.push(color('bg', a.bg));
  if (a['bg-image']) {
    style.backgroundImage = `url(${a['bg-image']})`;
    cls.push('bg-cover bg-center');
  }
  if (a['bg-gradient']) style.background = a['bg-gradient'];
  if (a.pad) {
    const [t, r, b, l] = a.pad.split(' ').map(Number);
    const v = (side: string, px: number) => (px >= 48 ? `${side}-[${Math.round(px * 0.6)}px] md:${side}-[${px}px]` : px ? `${side}-[${px}px]` : '');
    const h = (side: string, px: number) => (px >= 40 ? `${side}-5 md:${side}-[${px}px]` : px ? `${side}-[${px}px]` : '');
    cls.push(v('pt', t), h('pr', r), v('pb', b), h('pl', l));
  }
  if (a.radius) {
    const [w] = (a.size ?? '0x0').split('x').map(Number);
    cls.push(n(a.radius) >= 500 || (w && n(a.radius) * 2 >= w) ? 'rounded-full' : `rounded-[${n(a.radius)}px]`);
  }
  if (a.border) {
    const [w, c] = a.border.split(' ');
    cls.push(w === '1' ? 'border' : `border-[${w}px]`, c ? color('border', c) : 'border-border');
  }
  if (a['border-b']) {
    const [w, c] = a['border-b'].split(' ');
    cls.push(w === '1' ? 'border-b' : `border-b-[${w}px]`, c ? `border-[${c}]` : '');
  }
  if (f.has('shadow')) cls.push('shadow-lg');
  if (a['max-w'] && tag !== 'img' && n(a['max-w']) >= 240) cls.push(`max-w-[${n(a['max-w'])}px]`, a.wp || f.has('abs') ? '' : 'w-full');
  if (f.has('center')) cls.push('mx-auto');
  if (a.mx) {
    const [ml, mr] = a.mx.split(' ').map(Number);
    if (ml) cls.push(`ml-[${ml}px]`);
    if (mr) cls.push(`mr-[${mr}px]`);
  }
  if (a['min-h']) cls.push(`min-h-[${Math.round(n(a['min-h']) * 0.7)}px] md:min-h-[${n(a['min-h'])}px]`);
  if (f.has('italic')) cls.push('italic');
  if (a.size && tag !== 'img') {
    const [w, h] = a.size.split('x').map(Number);
    if (w <= 96 && h <= 96) cls.push(`w-[${w}px] h-[${h}px] shrink-0`);
  }
  if (a.fs) cls.push(fontSize(n(a.fs)));
  if (a.fw && a.fw !== '400') cls.push(WEIGHT[Math.round(n(a.fw) / 100) * 100] ?? 'font-normal');
  if (a.c) cls.push(color('text', a.c));
  if (a.align === 'center') cls.push('text-center');
  if (a.align === 'right') cls.push('text-right');
  if (a.tt === 'uppercase') cls.push('uppercase');
  if (a.ls) cls.push(`tracking-[${a.ls}]`);
  if (a.lh && a.fs) cls.push(`leading-[${(n(a.lh) / n(a.fs)).toFixed(2)}]`);
  if (/^h[1-6]$/.test(tag) && !a.font) cls.push('font-heading');
  if (a.m) {
    const [mt, mb] = a.m.split(' ').map(Number);
    if (mt < 0) cls.push(`-mt-[${-mt}px]`);
    if (mb < 0) cls.push(`-mb-[${-mb}px]`);
    if (mt > 0) cls.push(mt >= 48 ? `mt-[${Math.round(mt * 0.6)}px] md:mt-[${mt}px]` : `mt-[${mt}px]`);
    if (mb > 0) cls.push(mb >= 48 ? `mb-[${Math.round(mb * 0.6)}px] md:mb-[${mb}px]` : `mb-[${mb}px]`);
  }
  if (f.has('block')) cls.push('block');
  if (f.has('inline-block')) cls.push('inline-block');
  if (a.list === 'disc' || a.list === 'circle' || a.list === 'square') cls.push('list-disc');
  if (a.list === 'decimal') cls.push('list-decimal');
  if (tag === 'a' && f.has('button')) cls.push('inline-flex items-center justify-center');
  if (tag === 'img') {
    const [w, h] = (a.size ?? '0x0').split('x').map(Number);
    if (a.fit === 'cover' && h) cls.push(`w-full h-[${h}px] object-cover`);
    else if (w >= 200) cls.push(`w-full max-w-[${w}px] h-auto`);
    else if (w && h) cls.push(`w-[${w}px] h-[${h}px] object-contain`);
  }
  if (ctx.isRoot) cls.push('w-full');
  return { cls: cls.filter(Boolean), style };
}

function jsxText(s: string) {
  return `{${JSON.stringify(s)}}`;
}

function emit(node: Node, depth: number, ctx: { role: string; usesIcon: { v: boolean } }, isRoot = false): string {
  const pad = '  '.repeat(depth);
  if (node.kind === 'text') return `${pad}${jsxText(node.text ?? '')}`;
  if (node.kind === 'icon') {
    ctx.usesIcon.v = true;
    const [w] = (node.attrs?.size ?? '20x20').split('x').map(Number);
    const size = Number.isFinite(w) && w > 0 ? w : 20;
    return `${pad}<Circle size={${size}} aria-hidden="true" />`;
  }
  if (node.kind === 'placeholder') return `${pad}<div className="w-full min-h-[120px] rounded-lg bg-black/5" aria-hidden="true" />`;

  let tag = node.tag!;
  const a = node.attrs ?? {};
  if (tag === 'svg') {
    const [w, h] = (a.size ?? '').split('x').map(Number);
    return `${pad}<img src=${JSON.stringify(a.src ?? '')} alt="" className="${w ? `w-[${w}px] max-w-full` : ''} ${h ? 'h-auto' : ''}" />`;
  }
  if (tag === 'picture') {
    const img = node.children.find((c) => c.tag === 'img');
    if (!img) return '';
    // the <picture> wrapper owns the grid placement / sizing; hand it to the <img>
    const keep = ['gcol', 'grow', 'wp', 'm'];
    img.attrs = { ...Object.fromEntries(keep.filter((k) => a[k]).map((k) => [k, a[k]])), ...img.attrs };
    img.parent = node.parent;
    return emit(img, depth, ctx);
  }
  if (tag === 'video') tag = a.poster ? 'img' : 'div';
  if (!KNOWN_TAGS.has(tag)) tag = 'div';

  const { cls, style } = classesFor(node, { role: ctx.role, isRoot });
  if (tag === 'nav' && ctx.role === 'header') cls.push('overflow-x-auto max-w-full');
  const props: string[] = [];
  if (cls.length) props.push(`className="${cls.join(' ')}"`);
  if (Object.keys(style).length) props.push(`style={${JSON.stringify(style)}}`);
  if (tag === 'a') props.push(`href=${JSON.stringify(a.href || '#')}`);
  if (tag === 'img') {
    props.push(`src=${JSON.stringify(a.src ?? a.poster ?? '')}`, `alt=${JSON.stringify(a.alt ?? '')}`, 'loading="lazy"');
  }
  if (tag === 'button') props.push('type="button"');
  if (tag === 'input' || tag === 'textarea') {
    if (a.placeholder) props.push(`placeholder=${JSON.stringify(a.placeholder)}`);
    if (a.type && tag === 'input') props.push(`type=${JSON.stringify(a.type)}`);
  }
  if (a.aria) props.push(`aria-label=${JSON.stringify(a.aria)}`);
  const open = `<${tag}${props.length ? ' ' + props.join(' ') : ''}`;
  if (VOID.has(tag)) return `${pad}${open} />`;
  const kids = node.children.map((c) => emit(c, depth + 1, ctx)).filter(Boolean);
  if (!kids.length) return `${pad}${open}></${tag}>`;
  if (kids.length === 1 && node.children[0].kind === 'text' && INLINE.has(tag)) return `${pad}${open}>${kids[0].trim()}</${tag}>`;
  return `${pad}${open}>\n${kids.join('\n')}\n${pad}</${tag}>`;
}

/** Compile one analyzed section into a complete .tsx component file. */
export function compileSection(name: string, dom: string, role: string, tokens: TokenMap = {}): string {
  TOKENS = tokens;
  const roots = parseDom(dom);
  const ctx = { role, usesIcon: { v: false } };
  const body = roots.map((r) => emit(r, 3, ctx, true)).join('\n');
  const imports = ctx.usesIcon.v ? `import { Circle } from 'lucide-react';\n\n` : '';
  return `${imports}/** ${name} – compiled deterministically from the analyzed DOM (no LLM). */
export default function ${name}() {
  return (
    <>
${body || '      <div />'}
    </>
  );
}
`;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeWebsite } from './analyze/crawl.js';
import type { Analysis } from './analyze/types.js';
import { config } from './config.js';
import type { Emit } from './events.js';
import { appTsx, writeScaffold } from './generate/assemble.js';
import { imagePart } from './generate/images.js';
import { planSite, type SitePlan } from './generate/plan.js';
import { REFINE_SYSTEM } from './generate/prompts.js';
import { fallbackSection, generateSection, pool } from './generate/section.js';
import { LLM } from './llm/client.js';
import { extractCode } from './llm/parse.js';
import { buildValidateRepair } from './validate/loop.js';
import { similarity } from './validate/visual.js';
import { Workspace } from './workspace.js';

export interface CloneOptions {
  /** Run the screenshot-diff refinement pass on the weakest sections (extra LLM calls). */
  refine?: boolean;
  /** Max sections to refine. */
  refineTop?: number;
}

async function scoreSite(ws: Workspace, plan: SitePlan, a: Analysis) {
  const desktop = await similarity(path.join(ws.captureDir, 'original-desktop.jpg'), path.join(ws.captureDir, 'generated-desktop.jpg'));
  const mobile = await similarity(path.join(ws.captureDir, 'original-mobile.jpg'), path.join(ws.captureDir, 'generated-mobile.jpg'));
  const perSection: Record<string, number> = {};
  for (const s of plan.sections) {
    perSection[s.name] = Number(
      (await similarity(a.screenshots.sections[s.index], path.join(ws.captureDir, `gen-${s.name}.jpg`), 120)).toFixed(3),
    );
  }
  return { desktop: Number(desktop.toFixed(3)), mobile: Number(mobile.toFixed(3)), perSection };
}

/**
 * The agent: URL → analysis → plan → parallel section generation → validate/repair → visual scoring (→ refine).
 * Returns the workspace id. All progress is reported through `emit`.
 */
export async function cloneWebsite(url: string, emit: Emit, opts: CloneOptions = {}, existing?: Workspace): Promise<Workspace> {
  const llm = new LLM(emit);
  const ws = existing ?? (await Workspace.create(url, llm.provider?.name ?? 'offline'));
  const started = Date.now();
  const reportCost = () => ws.updateMeta({ cost: llm.summary() });

  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  try {
    // 1. ANALYZE
    await ws.updateMeta({ status: 'analyzing' });
    emit({ stage: 'analyze', level: 'info', message: `Workspace ${ws.id} · provider: ${llm.provider ? `${llm.provider.name} (${llm.provider.modelFor('main')})` : 'offline heuristics'}` });
    const analysis = await analyzeWebsite(url, ws, emit);
    if (!analysis.sections.length) throw new Error('No visible content found on the page');

    // 2. PLAN
    await ws.updateMeta({ status: 'generating', title: analysis.title || ws.id });
    const plan = await planSite(analysis, llm, emit);
    await fs.writeFile(path.join(ws.captureDir, 'plan.json'), JSON.stringify(plan, null, 2));
    await writeScaffold(ws, analysis, plan.siteName, plan.theme);
    emit({ stage: 'plan', level: 'info', message: 'Wrote design tokens → src/theme.css', data: { theme: plan.theme } });
    await reportCost();

    // 3. GENERATE (parallel, one call per section)
    emit({ stage: 'generate', level: 'info', message: `Generating ${plan.sections.length} section components (concurrency ${config.concurrency})` });
    const generated = await pool(plan.sections, config.concurrency, async (sec) => {
      const g = await generateSection(sec, plan, analysis, llm);
      await ws.write(`src/components/sections/${g.name}.tsx`, g.code);
      emit({
        stage: 'generate',
        level: g.fallback && llm.available ? 'warn' : 'info',
        message: `${g.name}: ${g.fallback ? (llm.available ? `fallback compiler (${g.error})` : 'compiled from DOM') : 'generated'} · ${g.code.split('\n').length} lines`,
      });
      await reportCost();
      return g;
    });
    await ws.write('src/App.tsx', appTsx(plan.sections.map((s) => s.name)));
    await ws.updateMeta({
      sections: plan.sections.map((s) => ({ name: s.name, role: s.role, description: s.description, fallback: generated.find((g) => g.name === s.name)?.fallback })),
    });

    // 4. VALIDATE + REPAIR
    await ws.updateMeta({ status: 'validating' });
    const byName = new Map(plan.sections.map((s) => [s.name, s]));
    const fallbackFor = (name: string) => {
      const sec = byName.get(name);
      return sec ? fallbackSection(sec, analysis, plan.theme) : null;
    };
    const fixedFiles = { 'src/App.tsx': appTsx(plan.sections.map((s) => s.name)) };
    let result = await buildValidateRepair(ws, { llm, emit, fallbackFor, fixTypes: true, fixedFiles });
    if (!result.ok) {
      // last resort: whole site from the deterministic compiler
      emit({ stage: 'repair', level: 'warn', message: 'Falling back to compiled components for the whole page' });
      for (const s of plan.sections) await ws.write(`src/components/sections/${s.name}.tsx`, fallbackSection(s, analysis, plan.theme));
      await ws.write('src/App.tsx', appTsx(plan.sections.map((s) => s.name)));
      result = await buildValidateRepair(ws, { llm, emit, fallbackFor, maxRounds: 0, fixedFiles });
      if (!result.ok) throw new Error(`Generated site does not build: ${JSON.stringify(result.lastErrors).slice(0, 500)}`);
    }

    // 5. VISUAL SCORE (+ optional refinement)
    let score = await scoreSite(ws, plan, analysis);
    emit({ stage: 'visual', level: 'info', message: `Visual similarity – desktop ${(score.desktop * 100).toFixed(0)}%, mobile ${(score.mobile * 100).toFixed(0)}%`, data: { score } });

    if (opts.refine && llm.available) {
      const worst = plan.sections
        .filter((s) => !result.fallbacks.includes(s.name) && (score.perSection[s.name] ?? 1) < 0.9)
        .sort((x, y) => score.perSection[x.name] - score.perSection[y.name])
        .slice(0, opts.refineTop ?? 3);
      if (worst.length) {
        emit({ stage: 'visual', level: 'info', message: `Refining weakest sections against screenshots: ${worst.map((w) => w.name).join(', ')}` });
        const backups = new Map<string, string>();
        await pool(worst, config.concurrency, async (sec) => {
          const file = `src/components/sections/${sec.name}.tsx`;
          const code = await ws.read(file);
          backups.set(file, code);
          try {
            const res = await llm.complete({
              label: `refine:${sec.name}`,
              tier: 'main',
              system: REFINE_SYSTEM,
              maxTokens: 8000,
              content: [
                { type: 'text', text: `Component: ${sec.name}\nTheme: ${JSON.stringify(plan.theme)}\n\nCurrent code:\n\`\`\`tsx\n${code}\n\`\`\`` },
                await imagePart(analysis.screenshots.sections[sec.index], { width: 1100, maxHeight: 1800 }),
                await imagePart(path.join(ws.captureDir, `gen-${sec.name}.jpg`), { width: 1100, maxHeight: 1800 }),
              ],
            });
            const improved = extractCode(res.text);
            if (!/export\s+default/.test(improved)) throw new Error('model returned no component');
            await ws.write(file, improved);
          } catch (e) {
            emit({ stage: 'visual', level: 'warn', message: `Refine ${sec.name} skipped: ${(e as Error).message}` });
          }
        });
        const r2 = await buildValidateRepair(ws, { llm, emit, maxRounds: 1, fixedFiles });
        const newScore = r2.ok ? await scoreSite(ws, plan, analysis) : null;
        if (!r2.ok || !newScore || newScore.desktop < score.desktop - 0.005) {
          for (const [f, c] of backups) await ws.write(f, c);
          await buildValidateRepair(ws, { llm, emit, maxRounds: 0, fixedFiles });
          score = await scoreSite(ws, plan, analysis);
          emit({ stage: 'visual', level: 'warn', message: 'Refinement did not improve the score – kept previous version' });
        } else {
          score = newScore;
          emit({ stage: 'visual', level: 'success', message: `After refinement – desktop ${(score.desktop * 100).toFixed(0)}%, mobile ${(score.mobile * 100).toFixed(0)}%`, data: { score } });
        }
      }
    }

    await ws.snapshot('Initial generation');
    const cost = llm.summary();
    await ws.updateMeta((m) => {
      m.status = 'ready';
      m.score = score;
      m.cost = cost;
      m.sections = m.sections?.map((s) => ({ ...s, fallback: s.fallback || result.fallbacks.includes(s.name) }));
      m.chat.push({ role: 'agent', ts: new Date().toISOString(), ok: true, text: `Generated ${plan.sections.length} sections. Ask me to change anything.` });
    });
    emit({
      stage: 'done',
      level: 'success',
      message: `Done in ${((Date.now() - started) / 1000).toFixed(0)}s · ${cost.calls} LLM calls (${cost.cachedCalls} cached) · ${cost.inputTokens + cost.outputTokens} tokens · $${cost.usd.toFixed(3)}`,
      data: { id: ws.id, score, cost },
    });
    return ws;
  } catch (e) {
    const msg = (e as Error).message;
    await ws.updateMeta({ status: 'failed', error: msg, cost: llm.summary() }).catch(() => {});
    emit({ stage: 'error', level: 'error', message: msg });
    throw e;
  }
}

import type { Emit } from '../events.js';
import { sectionsFromApp } from '../generate/assemble.js';
import { MODIFY_EDIT_SYSTEM, MODIFY_PLAN_SYSTEM } from '../generate/prompts.js';
import { LLM } from '../llm/client.js';
import { extractFileOps, extractJson, type FileOp } from '../llm/parse.js';
import { buildValidateRepair } from '../validate/loop.js';
import { similarity } from '../validate/visual.js';
import { Workspace } from '../workspace.js';
import { fastPath } from './fastpath.js';
import path from 'node:path';

const EDITABLE = /^(src\/[\w./-]+\.(tsx|ts|css)|index\.html)$/;

/** Remove imports/usages in App.tsx that point at deleted section files (deterministic cleanup). */
async function pruneApp(ws: Workspace) {
  let app = await ws.read('src/App.tsx');
  for (const name of sectionsFromApp(app)) {
    if (await ws.exists(`src/components/sections/${name}.tsx`)) continue;
    app = app
      .replace(new RegExp(`^import ${name} from '\\./components/sections/${name}';\\n`, 'm'), '')
      .replace(new RegExp(`\\s*<SectionBoundary name="${name}">\\s*<${name} />\\s*</SectionBoundary>`), '');
  }
  await ws.write('src/App.tsx', app);
}

async function manifest(ws: Workspace) {
  const meta = await ws.readMeta();
  const app = await ws.read('src/App.tsx');
  const order = sectionsFromApp(app);
  const desc = new Map((meta.sections ?? []).map((s) => [s.name, s]));
  const files = await ws.listSource('src');
  return [
    `Sections in page order:\n${order.map((n, i) => `${i + 1}. ${n}${desc.get(n) ? ` – ${desc.get(n)!.role}: ${desc.get(n)!.description}` : ''}`).join('\n')}`,
    `Files:\n${files.join('\n')}\nindex.html`,
    `src/App.tsx:\n\`\`\`tsx\n${app}\`\`\``,
    `src/theme.css:\n\`\`\`css\n${await ws.read('src/theme.css')}\`\`\``,
  ].join('\n\n');
}

export interface ModifyResult {
  ok: boolean;
  summary: string;
  changed: string[];
  version?: number;
}

/**
 * Natural-language modification agent.
 *  1. deterministic fast path for trivial edits (theme colour, sticky nav, remove section) – $0
 *  2. otherwise: plan (fast model picks files) → edit (main model rewrites them) → validate/repair
 *  3. any failure → roll back to the last good version
 */
export async function modifyWebsite(id: string, instruction: string, emit: Emit): Promise<ModifyResult> {
  const ws = new Workspace(id);
  const llm = new LLM(emit);
  const meta = await ws.readMeta();
  const lastGood = meta.versions.at(-1)?.v ?? (await ws.snapshot('Before edits'));
  await ws.updateMeta((m) => {
    m.status = 'modifying';
    m.chat.push({ role: 'user', text: instruction, ts: new Date().toISOString() });
  });
  emit({ stage: 'modify', level: 'info', message: `Instruction: “${instruction}”` });

  const finish = async (res: ModifyResult) => {
    const cost = llm.summary();
    await ws.updateMeta((m) => {
      m.status = 'ready';
      m.chat.push({ role: 'agent', text: res.summary, ts: new Date().toISOString(), ok: res.ok });
      if (m.cost) {
        m.cost = {
          calls: m.cost.calls + cost.calls,
          cachedCalls: m.cost.cachedCalls + cost.cachedCalls,
          inputTokens: m.cost.inputTokens + cost.inputTokens,
          outputTokens: m.cost.outputTokens + cost.outputTokens,
          usd: Number((m.cost.usd + cost.usd).toFixed(4)),
        };
      }
    });
    emit({
      stage: 'done',
      level: res.ok ? 'success' : 'error',
      message: `${res.summary} (cost $${cost.usd.toFixed(3)}, ${cost.calls} call(s))`,
      data: { changed: res.changed, version: res.version },
    });
    return res;
  };

  try {
    let ops: FileOp[] = [];
    let summary = '';

    const fast = await fastPath(ws, instruction);
    if (fast) {
      ops = fast.ops;
      summary = fast.summary;
      emit({ stage: 'modify', level: 'info', message: `Handled deterministically (no LLM call): ${summary}` });
    } else {
      if (!llm.available) {
        return finish({ ok: false, summary: 'No LLM configured – only simple edits (colours, sticky navbar, remove section) are supported offline.', changed: [] });
      }
      // ---- step 1: choose files to read (cheap model)
      const man = await manifest(ws);
      const planRes = await llm.complete({
        label: 'modify:plan',
        tier: 'fast',
        system: MODIFY_PLAN_SYSTEM,
        maxTokens: 600,
        content: [{ type: 'text', text: `${man}\n\nInstruction: ${instruction}` }],
      });
      let toRead: string[] = ['src/App.tsx'];
      try {
        const p = extractJson<{ read: string[]; reasoning?: string }>(planRes.text);
        toRead = [...new Set(['src/App.tsx', ...p.read])].filter((f) => EDITABLE.test(f)).slice(0, 8);
        emit({ stage: 'modify', level: 'info', message: `Plan: read ${toRead.join(', ')}${p.reasoning ? ` – ${p.reasoning}` : ''}` });
      } catch {
        emit({ stage: 'modify', level: 'warn', message: 'Planner output unparseable – reading App.tsx only' });
      }
      const contents: string[] = [];
      for (const f of toRead) {
        if (await ws.exists(f)) contents.push(`<current path="${f}">\n${await ws.read(f)}\n</current>`);
      }

      // ---- step 2: edit (main model)
      const siblingStyle = (await ws.listSource('src/components/sections')).slice(0, 1);
      const editRes = await llm.complete({
        label: 'modify:edit',
        tier: 'main',
        system: MODIFY_EDIT_SYSTEM,
        maxTokens: 12000,
        content: [
          {
            type: 'text',
            text: `${man}\n\nCurrent contents of relevant files:\n${contents.join('\n\n')}\n\n(Existing section files for reference: ${siblingStyle.join(', ')})\n\nInstruction: ${instruction}`,
          },
        ],
      });
      const parsed = extractFileOps(editRes.text);
      ops = parsed.ops.filter((o) => EDITABLE.test(o.path) && !o.path.startsWith('src/components/ui/SectionBoundary'));
      summary = parsed.summary || `Applied: ${instruction}`;
      if (!ops.length) return finish({ ok: false, summary: 'The model did not propose any file changes. Try rephrasing the instruction.', changed: [] });
    }

    if (!ops.length) return finish({ ok: true, summary, changed: [] });

    // ---- apply
    for (const op of ops) {
      if (op.action === 'delete') await ws.remove(op.path);
      else await ws.write(op.path, op.content ?? '');
    }
    await pruneApp(ws);
    emit({ stage: 'modify', level: 'info', message: `Changed ${ops.map((o) => `${o.action === 'delete' ? '−' : '±'} ${o.path}`).join(', ')}` });

    // ---- validate (repair allowed, no fallbacks – on failure we roll back)
    const result = await buildValidateRepair(ws, { llm, emit, maxRounds: llm.available ? 2 : 0, fixTypes: false });
    if (!result.ok) {
      await ws.restore(lastGood);
      await buildValidateRepair(ws, { llm, emit, maxRounds: 0 });
      return finish({ ok: false, summary: `Could not apply the change without breaking the site – rolled back to v${lastGood}.`, changed: [] });
    }
    const desktop = await similarity(path.join(ws.captureDir, 'original-desktop.jpg'), path.join(ws.captureDir, 'generated-desktop.jpg'));
    const version = await ws.snapshot(instruction.slice(0, 80));
    await ws.updateMeta((m) => {
      if (m.score) m.score.desktop = Number(desktop.toFixed(3));
    });
    return finish({ ok: true, summary, changed: ops.map((o) => o.path), version });
  } catch (e) {
    await ws.restore(lastGood).catch(() => {});
    await buildValidateRepair(ws, { llm, emit, maxRounds: 0 }).catch(() => {});
    return finish({ ok: false, summary: `Error: ${(e as Error).message} – rolled back to v${lastGood}.`, changed: [] });
  }
}

/** Undo: restore the previous version and rebuild. */
export async function undoLast(id: string, emit: Emit) {
  const ws = new Workspace(id);
  const meta = await ws.readMeta();
  if (meta.versions.length < 2) throw new Error('Nothing to undo');
  const prev = meta.versions[meta.versions.length - 2];
  await ws.restore(prev.v);
  await buildValidateRepair(ws, { llm: new LLM(emit), emit, maxRounds: 0 });
  await ws.updateMeta((m) => {
    m.versions.pop();
    m.chat.push({ role: 'agent', text: `Reverted to v${prev.v} (${prev.label}).`, ts: new Date().toISOString(), ok: true });
  });
  emit({ stage: 'done', level: 'success', message: `Reverted to v${prev.v}` });
}

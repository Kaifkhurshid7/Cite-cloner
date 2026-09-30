import { config } from '../config.js';
import type { Emit } from '../events.js';
import type { LLM } from '../llm/client.js';
import type { Workspace } from '../workspace.js';
import { typecheck, viteBuild } from './build.js';
import { repairFile } from './repair.js';
import { runtimeCheck, type RuntimeResult } from './runtime.js';
import { sanitizeComponent } from './sanitize.js';
import { appTsx, sectionsFromApp } from '../generate/assemble.js';

async function localizeRuntimeError(ws: Workspace, names: string[], message: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const name of names) {
    await ws.write('src/App.tsx', appTsx([name]));
    if (!(await viteBuild(ws)).ok) continue;
    const rt = await runtimeCheck(ws);
    const fatal = rt.pageErrors.filter((e) => !e.startsWith('[layout]'));
    if (fatal.length || rt.sectionErrors[name]) out[sectionFile(name)] = [`Runtime error when this module loads/renders: ${fatal[0] ?? rt.sectionErrors[name] ?? message}`];
  }
  return out;
}

export interface LoopOptions {
  llm: LLM;
  emit: Emit;
  /** Deterministic replacement for a section that cannot be repaired. null → no fallback available. */
  fallbackFor?: (sectionName: string) => string | null;
  maxRounds?: number;
  /** Also repair tsc type errors (build still succeeds without this). */
  fixTypes?: boolean;
  /** Files with a known-good deterministic version (e.g. App.tsx during cloning): restored instead of LLM-repaired. */
  fixedFiles?: Record<string, string>;
}

export interface LoopResult {
  ok: boolean;
  runtime?: RuntimeResult;
  fallbacks: string[];
  repaired: string[];
  typeErrors: number;
  lastErrors: Record<string, string[]>;
}

const sectionFile = (name: string) => `src/components/sections/${name}.tsx`;
const sectionName = (file: string) => file.match(/sections\/(\w+)\.tsx$/)?.[1];

export async function sanitizeAll(ws: Workspace, emit: Emit) {
  for (const f of await ws.listSource('src/components/sections')) {
    if (!f.endsWith('.tsx')) continue;
    const name = sectionName(f)!;
    const before = await ws.read(f);
    const { code, notes } = sanitizeComponent(before, name);
    if (code !== before) {
      await ws.write(f, code);
      emit({ stage: 'validate', level: 'info', message: `Auto-fixed ${name}: ${notes.join('; ')}` });
    }
  }
}

/**
 * Validation loop: sanitize → vite build → run in browser → (repair failing files → repeat).
 * Guarantees termination: after maxRounds, failing sections are swapped for their deterministic fallback.
 */
export async function buildValidateRepair(ws: Workspace, opts: LoopOptions): Promise<LoopResult> {
  const { llm, emit } = opts;
  const maxRounds = opts.maxRounds ?? config.maxRepairRounds;
  const fallbacks: string[] = [];
  const repaired: string[] = [];
  let lastErrors: Record<string, string[]> = {};
  let runtime: RuntimeResult | undefined;

  for (let round = 0; round <= maxRounds + 1; round++) {
    await sanitizeAll(ws, emit);
    emit({ stage: 'validate', level: 'info', message: `Building (round ${round + 1})…` });
    const build = await viteBuild(ws);
    let errors: Record<string, string[]> = {};
    if (build.ok) {
      runtime = await runtimeCheck(ws);
      for (const [name, msg] of Object.entries(runtime.sectionErrors)) errors[sectionFile(name)] = [`Runtime error while rendering: ${msg}`];
      const fatal = runtime.pageErrors.filter((e) => !e.startsWith('[layout]'));
      if (fatal.length && !Object.keys(errors).length) errors['src/App.tsx'] = fatal.map((e) => `Runtime error: ${e}`);
      if (!runtime.renderedTextLength && !Object.keys(errors).length) errors['src/App.tsx'] = ['Page rendered empty'];
      if (!Object.keys(errors).length) {
        emit({
          stage: 'validate',
          level: 'success',
          message: `Build + runtime check passed${runtime.pageErrors.length ? ` (warnings: ${runtime.pageErrors.join('; ')})` : ''}`,
        });
        lastErrors = {};
        break;
      }
    } else {
      errors = build.errors;
    }
    // A page-level runtime error with a pristine App.tsx really comes from a module-level bug in some
    // section (e.g. a stray identifier). tsc can usually localize it.
    const app = opts.fixedFiles?.['src/App.tsx'];
    if (build.ok && Object.keys(errors).length === 1 && errors['src/App.tsx'] && app && (await ws.read('src/App.tsx')) === app) {
      const tc = await typecheck(ws);
      const located = Object.fromEntries(Object.entries(tc.errors).filter(([f]) => f !== 'src/App.tsx'));
      if (Object.keys(located).length) errors = located;
      else {
        // last resort (no LLM needed): render each section alone to find the culprit(s)
        emit({ stage: 'validate', level: 'info', message: 'Localizing page-level runtime error by rendering sections one at a time…' });
        const culprits = await localizeRuntimeError(ws, sectionsFromApp(app), errors['src/App.tsx'].join('\n'));
        await ws.write('src/App.tsx', app);
        if (Object.keys(culprits).length) errors = culprits;
      }
    }
    lastErrors = errors;
    const files = Object.keys(errors);
    emit({
      stage: 'validate',
      level: 'warn',
      message: `${build.ok ? 'Runtime' : 'Build'} errors in ${files.join(', ')}`,
      data: { errors },
    });

    if (round >= maxRounds) {
      // out of repair budget → deterministic fallback for sections, stop otherwise
      if (!opts.fallbackFor || round > maxRounds) break;
      let replaced = 0;
      for (const f of files) {
        const name = sectionName(f);
        const fb = name ? opts.fallbackFor(name) : null;
        if (fb) {
          await ws.write(f, fb);
          fallbacks.push(name!);
          replaced++;
        }
      }
      emit({ stage: 'repair', level: 'warn', message: `Repair budget exhausted – replaced ${replaced} section(s) with safe fallback: ${fallbacks.join(', ')}` });
      if (!replaced) break;
      continue;
    }

    if (!llm.available) {
      // offline: jump straight to fallback round
      round = maxRounds - 1;
      continue;
    }
    emit({ stage: 'repair', level: 'info', message: `Repairing ${files.length} file(s) with the model (attempt ${round + 1}/${maxRounds})` });
    await Promise.all(
      files.map(async (f) => {
        const fixed = opts.fixedFiles?.[f];
        if (fixed !== undefined && (await ws.read(f).catch(() => '')) !== fixed) {
          await ws.write(f, fixed);
          return;
        }
        try {
          if (await repairFile(ws, f, errors[f], llm, round)) repaired.push(f);
        } catch (e) {
          emit({ stage: 'repair', level: 'warn', message: `Repair of ${f} failed: ${(e as Error).message}` });
        }
      }),
    );
  }

  // type errors don't block the preview, but we try once to clean them up
  let typeErrors = 0;
  if (!Object.keys(lastErrors).length) {
    const tc = await typecheck(ws);
    typeErrors = Object.values(tc.errors).flat().length;
    if (typeErrors && opts.fixTypes && llm.available) {
      emit({ stage: 'repair', level: 'info', message: `Fixing ${typeErrors} type error(s) in ${Object.keys(tc.errors).length} file(s)` });
      const backups = new Map<string, string>();
      for (const f of Object.keys(tc.errors)) {
        backups.set(f, await ws.read(f));
        await repairFile(ws, f, tc.errors[f], llm, 0).catch(() => false);
      }
      await sanitizeAll(ws, emit);
      const rebuild = await viteBuild(ws);
      const rt = rebuild.ok ? await runtimeCheck(ws) : undefined;
      if (!rebuild.ok || !rt?.ok) {
        for (const [f, code] of backups) await ws.write(f, code);
        await viteBuild(ws);
        emit({ stage: 'repair', level: 'warn', message: 'Type fixes broke the build – reverted them' });
      } else {
        runtime = rt;
        typeErrors = Object.values((await typecheck(ws)).errors).flat().length;
      }
    }
    emit({ stage: 'validate', level: typeErrors ? 'warn' : 'success', message: typeErrors ? `${typeErrors} TypeScript error(s) remain (non-blocking)` : 'TypeScript: no errors' });
  }

  return { ok: !Object.keys(lastErrors).length, runtime, fallbacks, repaired, typeErrors, lastErrors };
}

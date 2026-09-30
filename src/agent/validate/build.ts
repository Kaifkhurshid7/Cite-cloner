import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Workspace } from '../workspace.js';

export interface CheckResult {
  ok: boolean;
  /** relative file → error messages */
  errors: Record<string, string[]>;
  raw: string;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    // .cmd shims need a shell on Windows; pass one pre-joined string (args are fixed, trusted values) to avoid Node's DEP0190 warning
    const child =
      process.platform === 'win32'
        ? spawn([`"${cmd}"`, ...args].join(' '), { cwd, shell: true, env })
        : spawn(cmd, args, { cwd, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += `\nTimed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: String(e) });
    });
  });
}

const bin = (ws: Workspace, name: string) => path.join(ws.dir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

/** Type-check with tsc. Errors are grouped per file so each file can be repaired independently. */
export async function typecheck(ws: Workspace): Promise<CheckResult> {
  const { code, out } = await run(bin(ws, 'tsc'), ['--noEmit', '-p', '.'], ws.dir, 120_000);
  const errors: Record<string, string[]> = {};
  for (const m of out.matchAll(/^(src\/[^(\n]+)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
    (errors[m[1]] ??= []).push(`line ${m[2]}:${m[3]} ${m[4]}: ${m[5]}`);
  }
  return { ok: code === 0, errors, raw: out.slice(-4000) };
}

/** Production build with Vite – the real gate: if this fails there is nothing to preview. */
export async function viteBuild(ws: Workspace): Promise<CheckResult> {
  const { code, out } = await run(bin(ws, 'vite'), ['build', '--logLevel', 'error'], ws.dir, 180_000);
  const errors: Record<string, string[]> = {};
  if (code !== 0) {
    const dir = ws.dir.replace(/\\/g, '/');
    const msg = out.replace(/\\/g, '/').split(dir + '/').join('').trim();
    const files = [...new Set([...msg.matchAll(/(src\/[\w./-]+\.(?:tsx?|css))/g)].map((m) => m[1]))];
    for (const f of files.length ? files : ['src/App.tsx']) (errors[f] ??= []).push(msg.slice(0, 1800));
  }
  return { ok: code === 0, errors, raw: out.slice(-4000) };
}

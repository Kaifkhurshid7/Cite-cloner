import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEMPLATE_DIR, WORKSPACES_DIR } from './config.js';

export type ProjectStatus = 'queued' | 'analyzing' | 'generating' | 'validating' | 'ready' | 'modifying' | 'failed';

export interface VersionInfo {
  v: number;
  label: string;
  createdAt: string;
}

export interface ProjectMeta {
  id: string;
  url: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  sections?: { name: string; role: string; description: string; fallback?: boolean }[];
  score?: { desktop: number; mobile: number; perSection?: Record<string, number> };
  cost?: { calls: number; cachedCalls: number; inputTokens: number; outputTokens: number; usd: number };
  versions: VersionInfo[];
  chat: { role: 'user' | 'agent'; text: string; ts: string; ok?: boolean }[];
  provider: string;
}

const metaLocks = new Map<string, Promise<unknown>>();
const SKIP = new Set(['node_modules', 'dist', '.history', '.capture']);

async function copyDir(src: string, dst: string) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

export function slugFromUrl(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    return `${host}${seg ? '-' + seg : ''}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
  } catch {
    return 'site';
  }
}

/** A generated project on disk: workspaces/<id>/ is a standalone Vite + React + TS app. */
export class Workspace {
  constructor(readonly id: string) {}

  get dir() {
    return path.join(WORKSPACES_DIR, this.id);
  }
  get captureDir() {
    return path.join(this.dir, '.capture');
  }
  get distDir() {
    return path.join(this.dir, 'dist');
  }

  static async create(url: string, provider: string): Promise<Workspace> {
    const id = `${slugFromUrl(url)}-${crypto.randomBytes(3).toString('hex')}`;
    const ws = new Workspace(id);
    await copyDir(TEMPLATE_DIR, ws.dir);
    // share the template's installed deps → no per-project npm install (seconds instead of minutes)
    await fs.symlink(path.join(TEMPLATE_DIR, 'node_modules'), path.join(ws.dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(ws.captureDir, { recursive: true });
    const now = new Date().toISOString();
    await ws.writeMeta({
      id,
      url,
      title: slugFromUrl(url),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      versions: [],
      chat: [],
      provider,
    });
    return ws;
  }

  static async list(): Promise<ProjectMeta[]> {
    try {
      const ids = await fs.readdir(WORKSPACES_DIR);
      const metas = await Promise.all(ids.map((id) => new Workspace(id).readMeta().catch(() => null)));
      return metas.filter((m): m is ProjectMeta => !!m).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  resolve(rel: string) {
    const abs = path.resolve(this.dir, rel);
    if (!abs.startsWith(this.dir + path.sep)) throw new Error(`Path escapes workspace: ${rel}`);
    return abs;
  }

  async read(rel: string) {
    return fs.readFile(this.resolve(rel), 'utf8');
  }

  async write(rel: string, content: string | Buffer) {
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async remove(rel: string) {
    await fs.rm(this.resolve(rel), { force: true });
  }

  async exists(rel: string) {
    return fs
      .access(this.resolve(rel))
      .then(() => true)
      .catch(() => false);
  }

  /** Source files the agent owns (relative paths). */
  async listSource(dir = 'src'): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      for (const e of await fs.readdir(this.resolve(rel), { withFileTypes: true })) {
        const r = path.posix.join(rel, e.name);
        if (e.isDirectory()) await walk(r);
        else out.push(r);
      }
    };
    await walk(dir);
    return out.sort();
  }

  async readMeta(): Promise<ProjectMeta> {
    return JSON.parse(await fs.readFile(path.join(this.dir, 'project.json'), 'utf8'));
  }

  /** Atomic write (tmp + rename) so concurrent readers never see a half-written file. */
  async writeMeta(meta: ProjectMeta) {
    meta.updatedAt = new Date().toISOString();
    const file = path.join(this.dir, 'project.json');
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, file);
  }

  /** Serialized read-modify-write per project (parallel section workers update cost concurrently). */
  async updateMeta(patch: Partial<ProjectMeta> | ((m: ProjectMeta) => void)): Promise<ProjectMeta> {
    const prev = metaLocks.get(this.id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const meta = await this.readMeta();
      if (typeof patch === 'function') patch(meta);
      else Object.assign(meta, patch);
      await this.writeMeta(meta);
      return meta;
    });
    metaLocks.set(this.id, run.catch(() => undefined));
    return run;
  }

  // version history (snapshot of src/ + index.html)
  async snapshot(label: string): Promise<number> {
    const v = ((await this.readMeta()).versions.at(-1)?.v ?? 0) + 1;
    const dst = path.join(this.dir, '.history', `v${v}`);
    await fs.rm(dst, { recursive: true, force: true });
    await copyDir(path.join(this.dir, 'src'), path.join(dst, 'src'));
    await fs.copyFile(path.join(this.dir, 'index.html'), path.join(dst, 'index.html'));
    await this.updateMeta((m) => {
      m.versions.push({ v, label, createdAt: new Date().toISOString() });
    });
    return v;
  }

  async restore(v: number) {
    const src = path.join(this.dir, '.history', `v${v}`);
    await fs.rm(path.join(this.dir, 'src'), { recursive: true, force: true });
    await copyDir(path.join(src, 'src'), path.join(this.dir, 'src'));
    await fs.copyFile(path.join(src, 'index.html'), path.join(this.dir, 'index.html'));
  }
}

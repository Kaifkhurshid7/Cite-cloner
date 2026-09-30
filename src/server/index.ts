import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { cloneWebsite } from '../agent/clone.js';
import { ROOT, config } from '../agent/config.js';
import { modifyWebsite, undoLast } from '../agent/modify/modify.js';
import { Workspace } from '../agent/workspace.js';
import { hub } from './jobs.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const ID = /^[a-z0-9-]+$/;
function ws(req: Request): Workspace {
  const id = String(req.params.id);
  if (!ID.test(id) || !fs.existsSync(new Workspace(id).dir)) throw Object.assign(new Error('Project not found'), { status: 404 });
  return new Workspace(id);
}
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

// ------------------------------------------------------------------ API
app.get('/api/config', (_req, res) => {
  const p = config.provider;
  const model = p === 'anthropic' ? config.anthropic : p === 'openai' ? config.openai : null;
  res.json({ provider: p, model: model?.model ?? null, fastModel: model?.fastModel ?? null, hasKey: p === 'offline' || !!model?.apiKey || p === 'mock' });
});

app.get('/api/projects', wrap(async (_req, res) => res.json(await Workspace.list())));

app.post(
  '/api/projects',
  wrap(async (req, res) => {
    let url = String(req.body?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      const u = new URL(url);
      if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error();
    } catch {
      return res.status(400).json({ error: 'Please enter a valid public URL' });
    }
    const w = await Workspace.create(url, config.provider);
    hub.run(w.id, (emit) => cloneWebsite(url, emit, { refine: !!req.body?.refine }, w));
    res.json({ id: w.id });
  }),
);

app.get('/api/projects/:id', wrap(async (req, res) => res.json({ ...(await ws(req).readMeta()), running: hub.isRunning(String(req.params.id)) })));

app.get('/api/projects/:id/events', (req, res) => {
  try {
    hub.subscribe(ws(req).id, res);
  } catch (e) {
    res.status(404).end();
  }
});

app.post(
  '/api/projects/:id/modify',
  wrap(async (req, res) => {
    const w = ws(req);
    const instruction = String(req.body?.instruction ?? '').trim();
    if (!instruction) return res.status(400).json({ error: 'Instruction is empty' });
    if (instruction.length > 2000) return res.status(400).json({ error: 'Instruction too long' });
    hub.run(w.id, (emit) => modifyWebsite(w.id, instruction, emit));
    res.json({ ok: true });
  }),
);

app.post(
  '/api/projects/:id/undo',
  wrap(async (req, res) => {
    const w = ws(req);
    hub.run(w.id, (emit) => undoLast(w.id, emit));
    res.json({ ok: true });
  }),
);

app.get(
  '/api/projects/:id/files',
  wrap(async (req, res) => {
    const w = ws(req);
    res.json([...(await w.listSource('src')), 'index.html']);
  }),
);

app.get(
  '/api/projects/:id/file',
  wrap(async (req, res) => {
    const w = ws(req);
    const rel = String(req.query.path ?? '');
    if (!/^(src\/[\w./-]+|index\.html)$/.test(rel) || rel.includes('..')) return res.status(400).json({ error: 'bad path' });
    res.type('text/plain').send(await w.read(rel));
  }),
);

// ------------------------------------------------------------------ static
const noCache = { etag: false, lastModified: false, setHeaders: (r: Response) => r.setHeader('cache-control', 'no-store') };
app.use('/preview/:id', (req, res, next) => {
  if (!ID.test(req.params.id)) return res.status(404).end();
  express.static(new Workspace(req.params.id).distDir, noCache)(req, res, next);
});
app.use('/captures/:id', (req, res, next) => {
  if (!ID.test(req.params.id)) return res.status(404).end();
  express.static(new Workspace(req.params.id).captureDir, noCache)(req, res, next);
});

const studio = path.join(ROOT, 'studio', 'dist');
app.use(express.static(studio));
app.get('/', (_req, res) => {
  if (fs.existsSync(path.join(studio, 'index.html'))) res.sendFile(path.join(studio, 'index.html'));
  else res.send('Studio not built. Run: npm run build:studio');
});

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`\n  Site Cloner studio → http://localhost:${config.port}`);
  console.log(`  LLM provider: ${config.provider}${config.provider === 'offline' ? ' (set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env for AI generation)' : ''}\n`);
});

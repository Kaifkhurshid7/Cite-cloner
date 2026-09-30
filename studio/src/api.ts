export interface AgentEvent {
  ts: number;
  stage: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  data?: Record<string, unknown>;
}

export interface Project {
  id: string;
  url: string;
  title: string;
  status: 'queued' | 'analyzing' | 'generating' | 'validating' | 'ready' | 'modifying' | 'failed';
  createdAt: string;
  error?: string;
  sections?: { name: string; role: string; description: string; fallback?: boolean }[];
  score?: { desktop: number; mobile: number; perSection?: Record<string, number> };
  cost?: { calls: number; cachedCalls: number; inputTokens: number; outputTokens: number; usd: number };
  versions: { v: number; label: string; createdAt: string }[];
  chat: { role: 'user' | 'agent'; text: string; ts: string; ok?: boolean }[];
  provider: string;
  running?: boolean;
}

export interface ServerConfig {
  provider: string;
  model: string | null;
  fastModel: string | null;
  hasKey: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export const api = {
  config: () => fetch('/api/config').then((r) => json<ServerConfig>(r)),
  projects: () => fetch('/api/projects').then((r) => json<Project[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<Project>(r)),
  create: (url: string, refine: boolean) =>
    fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, refine }) }).then((r) =>
      json<{ id: string }>(r),
    ),
  modify: (id: string, instruction: string) =>
    fetch(`/api/projects/${id}/modify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction }) }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  undo: (id: string) => fetch(`/api/projects/${id}/undo`, { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  files: (id: string) => fetch(`/api/projects/${id}/files`).then((r) => json<string[]>(r)),
  file: (id: string, path: string) => fetch(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`).then((r) => r.text()),
};

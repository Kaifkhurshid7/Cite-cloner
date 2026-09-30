import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentEvent, type Project, type ServerConfig } from './api';

// ------------------------------------------------------------------ routing (hash based)
function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const m = hash.match(/^#\/p\/([a-z0-9-]+)/);
  return m ? { page: 'project' as const, id: m[1] } : { page: 'home' as const };
}

export default function App() {
  const route = useRoute();
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="logo">◧</span> Site Cloner <span className="muted">Studio</span>
        </a>
        {cfg && (
          <span className={`pill ${cfg.provider === 'offline' ? 'warn' : ''}`} title="LLM provider">
            {cfg.provider === 'offline' ? 'offline mode · no API key' : `${cfg.provider} · ${cfg.model ?? ''}`}
          </span>
        )}
      </header>
      {route.page === 'home' ? <Home cfg={cfg} /> : <ProjectView key={route.id} id={route.id} />}
    </div>
  );
}

// ------------------------------------------------------------------ home
function Home({ cfg }: { cfg: ServerConfig | null }) {
  const [url, setUrl] = useState('');
  const [refine, setRefine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    api.projects().then(setProjects).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { id } = await api.create(url, refine);
      window.location.hash = `#/p/${id}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <section className="hero">
        <h1>Clone any website's frontend.</h1>
        <p>
          Paste a public URL. The agent analyzes layout, sections, typography, colours and assets, generates a responsive
          React + TypeScript + Tailwind project, validates it in a real browser, and lets you edit it with plain English.
        </p>
        <form className="url-form" onSubmit={submit}>
          <input autoFocus placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy || !url.trim()}>
            {busy ? 'Starting…' : 'Clone website →'}
          </button>
        </form>
        <label className="check">
          <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} /> Visual refinement pass (compares screenshots and
          rewrites the weakest sections – more accurate, ~30% more tokens)
        </label>
        {err && <div className="error">{err}</div>}
        {cfg?.provider === 'offline' && (
          <div className="note">
            No API key configured – the agent runs in <b>offline mode</b> (deterministic DOM→JSX compiler, rule-based edits). Add{' '}
            <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> to <code>.env</code> for AI generation.
          </div>
        )}
      </section>

      <section className="projects">
        <h2>Projects</h2>
        {!projects.length && <p className="muted">No projects yet.</p>}
        <div className="grid">
          {projects.map((p) => (
            <a key={p.id} href={`#/p/${p.id}`} className="card">
              <div className="thumb">
                <img src={`/captures/${p.id}/original-desktop.jpg`} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
              </div>
              <div className="card-body">
                <div className="row">
                  <b className="ellipsis">{p.title}</b>
                  <StatusBadge status={p.status} />
                </div>
                <div className="muted small ellipsis">{p.url}</div>
                <div className="muted small">
                  {p.score ? `match ${(p.score.desktop * 100).toFixed(0)}%` : ''} {p.cost ? `· $${p.cost.usd.toFixed(3)}` : ''} · {p.versions.length} version(s)
                </div>
              </div>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}

function StatusBadge({ status }: { status: Project['status'] }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

// ------------------------------------------------------------------ project view
const STAGES = ['analyze', 'plan', 'generate', 'validate', 'visual', 'done'] as const;
const DEVICES = { desktop: 1440, tablet: 768, mobile: 390 } as const;
type Device = keyof typeof DEVICES;
type View = 'generated' | 'original' | 'split';

function ProjectView({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(true);
  const [previewKey, setPreviewKey] = useState(0);
  const [device, setDevice] = useState<Device>('desktop');
  const [view, setView] = useState<View>('generated');
  const [tab, setTab] = useState<'log' | 'code' | 'sections'>('log');

  const refresh = useCallback(() => api.project(id).then(setProject).catch(() => {}), [id]);

  useEffect(() => {
    refresh();
    const es = new EventSource(`/api/projects/${id}/events`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as AgentEvent;
      setEvents((prev) => [...prev, ev]);
      setRunning(true);
      if (ev.stage === 'done' || ev.stage === 'error') {
        refresh();
        setPreviewKey((k) => k + 1);
      }
    };
    es.addEventListener('idle', () => {
      setRunning(false);
      refresh();
    });
    return () => es.close();
  }, [id, refresh]);

  // only the events of the current job for the stage tracker
  const lastJob = useMemo(() => {
    let start = 0;
    events.forEach((e, i) => {
      if ((e.stage === 'analyze' && e.message.startsWith('Workspace')) || (e.stage === 'modify' && e.message.startsWith('Instruction'))) start = i;
    });
    return events.slice(start);
  }, [events]);
  const isModify = lastJob[0]?.stage === 'modify';
  const ready = project && !['queued', 'analyzing', 'generating', 'validating'].includes(project.status) && project.status !== 'failed';

  return (
    <main className="project">
      <div className="project-head">
        <div className="ellipsis">
          <div className="row gap">
            <h2 className="ellipsis">{project?.title ?? id}</h2>
            {project && <StatusBadge status={running && project.status === 'ready' ? 'modifying' : project.status} />}
          </div>
          <a className="muted small" href={project?.url} target="_blank" rel="noreferrer">
            {project?.url}
          </a>
        </div>
        <div className="stats">
          {project?.score && (
            <Stat label="Visual match" value={`${(project.score.desktop * 100).toFixed(0)}% / ${(project.score.mobile * 100).toFixed(0)}%`} hint="desktop / mobile screenshot similarity" />
          )}
          {project?.cost && <Stat label="Cost" value={`$${project.cost.usd.toFixed(3)}`} hint={`${project.cost.calls} calls, ${project.cost.cachedCalls} cached, ${(project.cost.inputTokens + project.cost.outputTokens).toLocaleString()} tokens`} />}
          {project && <Stat label="Version" value={`v${project.versions.at(-1)?.v ?? 0}`} hint={project.versions.at(-1)?.label ?? ''} />}
          {ready && (
            <a className="btn" href={`/preview/${id}/`} target="_blank" rel="noreferrer">
              Open preview ↗
            </a>
          )}
        </div>
      </div>

      {!isModify && <StageTracker events={lastJob} running={running} />}

      <div className="workspace">
        <aside className="side">
          <div className="tabs">
            <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
              Agent log
            </button>
            <button className={tab === 'sections' ? 'active' : ''} onClick={() => setTab('sections')}>
              Sections
            </button>
            <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
              Code
            </button>
          </div>
          <div className="side-body">
            {tab === 'log' && <Log events={events} />}
            {tab === 'sections' && <Sections project={project} />}
            {tab === 'code' && <CodeBrowser id={id} version={previewKey} />}
          </div>
          <Chat id={id} project={project} running={running} disabled={!ready} onSent={() => setRunning(true)} />
        </aside>

        <section className="stage">
          <div className="toolbar">
            <div className="seg">
              {(Object.keys(DEVICES) as Device[]).map((d) => (
                <button key={d} className={device === d ? 'active' : ''} onClick={() => setDevice(d)}>
                  {d} <span className="muted">{DEVICES[d]}</span>
                </button>
              ))}
            </div>
            <div className="seg">
              {(['generated', 'original', 'split'] as View[]).map((v) => (
                <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                  {v === 'split' ? 'side by side' : v}
                </button>
              ))}
            </div>
            <button className="btn ghost" onClick={() => setPreviewKey((k) => k + 1)}>
              ↻ Reload
            </button>
          </div>
          <div className={`frames ${view}`}>
            {(view === 'original' || view === 'split') && (
              <Frame label="Original (screenshot)" width={DEVICES[device]}>
                <img
                  className="shot"
                  src={`/captures/${id}/original-${device === 'mobile' ? 'mobile' : 'desktop'}.jpg`}
                  alt="original"
                  style={{ width: '100%' }}
                />
              </Frame>
            )}
            {(view === 'generated' || view === 'split') && (
              <Frame label="Generated (live)" width={DEVICES[device]}>
                {ready ? (
                  <iframe key={previewKey} title="preview" src={`/preview/${id}/?v=${previewKey}`} style={{ width: DEVICES[device] }} />
                ) : (
                  <div className="placeholder">{project?.status === 'failed' ? `Generation failed: ${project.error}` : 'The agent is working… the preview appears when validation passes.'}</div>
                )}
              </Frame>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="muted small">{label}</div>
      <b>{value}</b>
    </div>
  );
}

function StageTracker({ events, running }: { events: AgentEvent[]; running: boolean }) {
  const seen = new Set(events.map((e) => (e.stage === 'repair' ? 'validate' : e.stage)));
  const failed = events.some((e) => e.stage === 'error');
  const current = [...STAGES].reverse().find((s) => seen.has(s));
  return (
    <ol className="stages">
      {STAGES.map((s) => {
        const state = failed && s === current ? 'failed' : seen.has(s) ? (s === current && running && s !== 'done' ? 'active' : 'done') : 'todo';
        return (
          <li key={s} className={state}>
            <span className="dot" />
            {s === 'done' ? 'preview' : s}
          </li>
        );
      })}
    </ol>
  );
}

function Log({ events }: { events: AgentEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [events.length]);
  return (
    <div className="log" ref={ref}>
      {events.map((e, i) => (
        <div key={i} className={`log-line ${e.level}`}>
          <span className="t">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
          <span className="s">{e.stage}</span>
          <span className="m">{e.message}</span>
        </div>
      ))}
      {!events.length && <div className="muted small">Waiting for events…</div>}
    </div>
  );
}

function Sections({ project }: { project: Project | null }) {
  if (!project?.sections) return <div className="muted small">No sections yet.</div>;
  return (
    <ul className="sections">
      {project.sections.map((s) => (
        <li key={s.name}>
          <div className="row">
            <b>{s.name}</b>
            <span className="muted small">
              {s.role}
              {project.score?.perSection?.[s.name] !== undefined && ` · ${(project.score.perSection[s.name] * 100).toFixed(0)}%`}
              {s.fallback && ' · compiled'}
            </span>
          </div>
          <div className="muted small">{s.description}</div>
        </li>
      ))}
    </ul>
  );
}

function CodeBrowser({ id, version }: { id: string; version: number }) {
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState('src/App.tsx');
  const [code, setCode] = useState('');
  useEffect(() => {
    api.files(id).then(setFiles).catch(() => {});
  }, [id, version]);
  useEffect(() => {
    api.file(id, sel).then(setCode).catch(() => setCode('// not found'));
  }, [id, sel, version]);
  return (
    <div className="code">
      <select value={sel} onChange={(e) => setSel(e.target.value)}>
        {files.map((f) => (
          <option key={f}>{f}</option>
        ))}
      </select>
      <pre>{code}</pre>
    </div>
  );
}

const SUGGESTIONS = ['Change the primary color to blue', 'Make the navbar sticky', 'Add a testimonials section', 'Replace the hero section with a bakery hero', 'Remove the pricing section'];

function Chat({ id, project, running, disabled, onSent }: { id: string; project: Project | null; running: boolean; disabled: boolean; onSent: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [project?.chat.length]);

  const send = async (instruction: string) => {
    if (!instruction.trim()) return;
    setErr('');
    try {
      await api.modify(id, instruction);
      setText('');
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const busy = running || disabled;
  return (
    <div className="chat">
      <div className="chat-head">
        <b>Modify with AI</b>
        <button className="btn ghost small" disabled={busy || (project?.versions.length ?? 0) < 2} onClick={() => api.undo(id).then(onSent).catch((e) => setErr(e.message))}>
          ↶ Undo
        </button>
      </div>
      <div className="chat-log" ref={ref}>
        {project?.chat.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.ok === false ? 'fail' : ''}`}>
            {m.text}
          </div>
        ))}
        {running && !disabled && <div className="msg agent typing">working…</div>}
      </div>
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} disabled={busy} onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input placeholder={busy ? 'Agent is busy…' : 'e.g. Make the hero background dark'} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
        <button className="btn primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

/** Renders children at their real device width, scaled down to fit the available space. */
function Frame({ label, width, children }: { label: string; width: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, (box.w - 2) / width);
  return (
    <div className="frame">
      <div className="frame-label muted small">
        {label} · {width}px {scale < 1 ? `· ${(scale * 100).toFixed(0)}%` : ''}
      </div>
      <div className="frame-box" ref={ref}>
        <div className="frame-inner" style={{ width, height: box.h / scale, transform: `scale(${scale})`, left: Math.max(0, (box.w - width * scale) / 2) }}>
          {children}
        </div>
      </div>
    </div>
  );
}

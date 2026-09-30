import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import type { AgentEvent, Emit } from '../agent/events.js';
import { Workspace } from '../agent/workspace.js';

interface Channel {
  events: AgentEvent[];
  clients: Set<Response>;
  running: boolean;
}

/** In-memory event bus per project, mirrored to .capture/events.jsonl so logs survive restarts. */
class JobHub {
  private channels = new Map<string, Channel>();

  private channel(id: string): Channel {
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { events: this.loadHistory(id), clients: new Set(), running: false };
      this.channels.set(id, ch);
    }
    return ch;
  }

  private logFile(id: string) {
    return path.join(new Workspace(id).captureDir, 'events.jsonl');
  }

  private loadHistory(id: string): AgentEvent[] {
    try {
      return fs
        .readFileSync(this.logFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  isRunning(id: string) {
    return this.channel(id).running;
  }

  emitter(id: string): Emit {
    return (e) => {
      const ev: AgentEvent = { ...e, ts: Date.now() };
      const ch = this.channel(id);
      ch.events.push(ev);
      fs.appendFile(this.logFile(id), JSON.stringify(ev) + '\n', () => {});
      for (const res of ch.clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const icon = { info: '·', warn: '!', error: '✗', success: '✓' }[e.level];
      console.log(`${icon} [${id}] [${e.stage}] ${e.message}`);
    };
  }

  /** Run a job for a project; rejects if one is already running (one writer per workspace). */
  run(id: string, job: (emit: Emit) => Promise<unknown>) {
    const ch = this.channel(id);
    if (ch.running) throw new Error('A job is already running for this project');
    ch.running = true;
    const emit = this.emitter(id);
    job(emit)
      .catch((e) => emit({ stage: 'error', level: 'error', message: (e as Error).message }))
      .finally(() => {
        ch.running = false;
        for (const res of ch.clients) res.write(`event: idle\ndata: {}\n\n`);
      });
  }

  subscribe(id: string, res: Response) {
    const ch = this.channel(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const ev of ch.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (!ch.running) res.write(`event: idle\ndata: {}\n\n`);
    ch.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      ch.clients.delete(res);
    });
  }
}

export const hub = new JobHub();

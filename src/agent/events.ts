export type Stage = 'analyze' | 'plan' | 'generate' | 'validate' | 'repair' | 'visual' | 'modify' | 'done' | 'error';

export interface AgentEvent {
  ts: number;
  stage: Stage;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  /** Optional structured payload (e.g. cost, score, screenshot path). */
  data?: Record<string, unknown>;
}

export type Emit = (e: Omit<AgentEvent, 'ts'>) => void;

export const consoleEmit: Emit = (e) => {
  const icon = { info: '·', warn: '!', error: '✗', success: '✓' }[e.level];
  console.log(`${icon} [${e.stage}] ${e.message}`);
};

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TEMPLATE_DIR = path.join(ROOT, 'template');
export const WORKSPACES_DIR = process.env.WORKSPACES_DIR ?? path.join(ROOT, 'workspaces');
export const CACHE_DIR = path.join(ROOT, '.cache');

export type ProviderName = 'anthropic' | 'openai' | 'offline' | 'mock';

function pickProvider(): ProviderName {
  const explicit = process.env.LLM_PROVIDER as ProviderName | undefined;
  if (explicit) return explicit;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'offline';
}

export const config = {
  provider: pickProvider(),
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    fastModel: process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1',
    fastModel: process.env.OPENAI_FAST_MODEL ?? 'gpt-4.1-mini',
  },
  cache: (process.env.LLM_CACHE ?? 'true') !== 'false',
  maxCostUsd: Number(process.env.MAX_COST_USD ?? 3),
  concurrency: Number(process.env.CONCURRENCY ?? 4),
  port: Number(process.env.PORT ?? 4000),
  /** Max build → repair rounds before falling back to a safe component. */
  maxRepairRounds: 3,
  /** Viewports used for analysis and visual scoring. */
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/** USD per 1M tokens [input, output]. Unknown models fall back to the "default" row. */
export const PRICING: Record<string, [number, number]> = {
  'claude-opus-4-1': [15, 75],
  'claude-sonnet-4-5': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  default: [3, 15],
};

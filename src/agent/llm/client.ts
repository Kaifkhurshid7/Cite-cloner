import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR, PRICING, config } from '../config.js';
import type { Emit } from '../events.js';
import { MockProvider } from './mock.js';
import { AnthropicProvider, OpenAIProvider } from './providers.js';
import type { CompletionRequest, CompletionResult, Provider } from './types.js';

export class BudgetExceededError extends Error {}

export interface CostEntry {
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cached: boolean;
}

function priceFor(model: string): [number, number] {
  const key = Object.keys(PRICING).find((k) => k !== 'default' && model.startsWith(k));
  return PRICING[key ?? 'default'];
}

/**
 * Thin wrapper around a provider that adds:
 *  - on-disk response cache (identical prompt → free re-run)
 *  - per-job cost accounting + a hard budget
 *  - retry on empty responses
 */
export class LLM {
  readonly provider: Provider | null;
  readonly ledger: CostEntry[] = [];

  constructor(
    private emit: Emit,
    private budgetUsd = config.maxCostUsd,
  ) {
    this.provider =
      config.provider === 'anthropic' && config.anthropic.apiKey
        ? new AnthropicProvider()
        : config.provider === 'openai' && config.openai.apiKey
          ? new OpenAIProvider()
          : config.provider === 'mock'
            ? new MockProvider()
            : null;
  }

  /** false → pipeline runs its deterministic (heuristic) generators instead. */
  get available() {
    return this.provider !== null;
  }

  get totalUsd() {
    return this.ledger.reduce((s, e) => s + e.usd, 0);
  }

  summary() {
    const tokens = this.ledger.reduce(
      (s, e) => ({ in: s.in + e.inputTokens, out: s.out + e.outputTokens }),
      { in: 0, out: 0 },
    );
    return {
      calls: this.ledger.length,
      cachedCalls: this.ledger.filter((e) => e.cached).length,
      inputTokens: tokens.in,
      outputTokens: tokens.out,
      usd: Number(this.totalUsd.toFixed(4)),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.provider) throw new Error('No LLM provider configured');
    if (this.totalUsd >= this.budgetUsd) {
      throw new BudgetExceededError(`Budget of $${this.budgetUsd} reached (spent $${this.totalUsd.toFixed(2)})`);
    }
    const model = this.provider.modelFor(req.tier);
    const key = crypto
      .createHash('sha256')
      .update(JSON.stringify({ model, s: req.system, c: req.content, t: req.temperature, m: req.maxTokens }))
      .digest('hex');
    const cacheFile = path.join(CACHE_DIR, 'llm', `${key}.json`);

    if (config.cache) {
      try {
        const hit = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as CompletionResult;
        this.ledger.push({ label: req.label, model, inputTokens: 0, outputTokens: 0, usd: 0, cached: true });
        return { ...hit, cached: true };
      } catch {
        /* miss */
      }
    }

    let res = await this.provider.complete(req);
    if (!res.text.trim()) res = await this.provider.complete({ ...req, temperature: 0.4 });

    const [pin, pout] = priceFor(model);
    const cacheRead = res.usage.cacheReadTokens ?? 0;
    // cache reads are billed at ~10% of input price
    const usd = ((res.usage.inputTokens - cacheRead) * pin + cacheRead * pin * 0.1 + res.usage.outputTokens * pout) / 1e6;
    this.ledger.push({
      label: req.label,
      model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      usd,
      cached: false,
    });

    if (config.cache) {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(res));
    }
    return { ...res, cached: false };
  }
}

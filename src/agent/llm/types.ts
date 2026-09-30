export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: 'image/jpeg' | 'image/png' };

export type Tier = 'main' | 'fast';

export interface CompletionRequest {
  /** Human-readable label for logs / cost breakdown, e.g. "section:Hero". */
  label: string;
  tier: Tier;
  system: string;
  content: ContentPart[];
  maxTokens?: number;
  temperature?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
  cached: boolean;
}

export interface Provider {
  name: string;
  modelFor(tier: Tier): string;
  complete(req: CompletionRequest): Promise<Omit<CompletionResult, 'cached'>>;
}

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config.js';
import type { CompletionRequest, Provider, Tier } from './types.js';

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 3 });

  modelFor(tier: Tier) {
    return tier === 'fast' ? config.anthropic.fastModel : config.anthropic.model;
  }

  async complete(req: CompletionRequest) {
    const model = this.modelFor(req.tier);
    const stream = this.client.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.2,
      // The system prompt is identical across all section calls of a job → prompt caching.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: req.content.map((p) =>
            p.type === 'text'
              ? { type: 'text' as const, text: p.text }
              : {
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: p.mediaType, data: p.data },
                },
          ),
        },
      ],
    });
    const msg = await stream.finalMessage();
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      text,
      model,
      usage: {
        inputTokens: msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}

export class OpenAIProvider implements Provider {
  name = 'openai';
  private client = new OpenAI({ apiKey: config.openai.apiKey, maxRetries: 3 });

  modelFor(tier: Tier) {
    return tier === 'fast' ? config.openai.fastModel : config.openai.model;
  }

  async complete(req: CompletionRequest) {
    const model = this.modelFor(req.tier);
    const res = await this.client.chat.completions.create({
      model,
      max_completion_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.2,
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: req.content.map((p) =>
            p.type === 'text'
              ? { type: 'text' as const, text: p.text }
              : {
                  type: 'image_url' as const,
                  image_url: { url: `data:${p.mediaType};base64,${p.data}`, detail: 'high' as const },
                },
          ),
        },
      ],
    });
    return {
      text: res.choices[0]?.message?.content ?? '',
      model,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}

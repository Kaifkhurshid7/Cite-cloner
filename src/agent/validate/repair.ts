import { REPAIR_SYSTEM } from '../generate/prompts.js';
import type { LLM } from '../llm/client.js';
import { extractCode } from '../llm/parse.js';
import type { Workspace } from '../workspace.js';

/**
 * Ask the model to fix one file given its errors. First attempt uses the cheap "fast" model;
 * later attempts escalate to the main model (most errors are trivial – missing import, wrong prop type).
 */
export async function repairFile(ws: Workspace, file: string, errors: string[], llm: LLM, attempt: number): Promise<boolean> {
  if (!llm.available) return false;
  let code: string;
  try {
    code = await ws.read(file);
  } catch {
    return false;
  }
  const res = await llm.complete({
    label: `repair:${file.split('/').pop()}#${attempt}`,
    tier: attempt === 0 ? 'fast' : 'main',
    system: REPAIR_SYSTEM,
    maxTokens: 8000,
    content: [
      {
        type: 'text',
        text: `File: ${file}\n\nErrors:\n${errors.join('\n').slice(0, 4000)}\n\nCurrent code:\n\`\`\`tsx\n${code}\n\`\`\``,
      },
    ],
  });
  const fixed = extractCode(res.text);
  if (fixed.length < 40 || fixed === code) return false;
  await ws.write(file, fixed);
  return true;
}

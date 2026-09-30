/** Helpers to pull structured output out of free-form model responses. */

export function extractCode(text: string): string {
  const fences = [...text.matchAll(/```(?:tsx|typescript|ts|jsx|javascript|js|css)?\s*\n([\s\S]*?)```/g)];
  if (fences.length) {
    // the longest block is the component; small ones are usually explanations
    return fences.map((m) => m[1]).sort((a, b) => b.length - a.length)[0].trim() + '\n';
  }
  // unterminated fence (output truncated) – take everything after the opening
  const open = text.match(/```(?:tsx|typescript|ts|jsx)?\s*\n([\s\S]*)$/);
  return (open ? open[1] : text).trim() + '\n';
}

export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model output');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(close);
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    // common model slip: trailing commas
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as T;
  }
}

export interface FileOp {
  path: string;
  action: 'write' | 'delete';
  content?: string;
}

/**
 * Parses the multi-file edit format used by the modification agent:
 *   <file path="src/x.tsx">...full content...</file>
 *   <delete path="src/y.tsx" />
 *   <summary>...</summary>
 */
export function extractFileOps(text: string): { ops: FileOp[]; summary: string } {
  const ops: FileOp[] = [];
  for (const m of text.matchAll(/<file\s+path="([^"]+)"\s*>\n?([\s\S]*?)<\/file>/g)) {
    let content = m[2];
    const fenced = content.match(/^\s*```[a-z]*\n([\s\S]*?)```\s*$/);
    if (fenced) content = fenced[1];
    ops.push({ path: m[1].trim(), action: 'write', content: content.replace(/^\n+/, '').trimEnd() + '\n' });
  }
  for (const m of text.matchAll(/<delete\s+path="([^"]+)"\s*\/?>/g)) {
    ops.push({ path: m[1].trim(), action: 'delete' });
  }
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1].trim() ?? '';
  return { ops, summary };
}

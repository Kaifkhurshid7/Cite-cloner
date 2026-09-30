#!/usr/bin/env tsx
/**
 * CLI
 *   npm run clone  -- https://example.com [--refine]
 *   npm run modify -- <project-id> "Make the navbar sticky"
 */
import { cloneWebsite } from './agent/clone.js';
import { config } from './agent/config.js';
import { consoleEmit } from './agent/events.js';
import { modifyWebsite } from './agent/modify/modify.js';

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  if (cmd === 'clone') {
    const url = rest.find((a) => !a.startsWith('--'));
    if (!url) throw new Error('usage: npm run clone -- <url> [--refine]');
    const ws = await cloneWebsite(url, consoleEmit, { refine: rest.includes('--refine') });
    console.log(`\nProject: ${ws.id}\nSource:  ${ws.dir}\nPreview: npm run server → http://localhost:${config.port}/#/p/${ws.id}\n     or: cd ${ws.dir} && npm run dev`);
  } else if (cmd === 'modify') {
    const [id, ...words] = rest;
    if (!id || !words.length) throw new Error('usage: npm run modify -- <project-id> "<instruction>"');
    const res = await modifyWebsite(id, words.join(' '), consoleEmit);
    process.exitCode = res.ok ? 0 : 1;
  } else {
    console.log('commands: clone <url> [--refine] | modify <id> "<instruction>"');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

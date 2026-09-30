# Site Cloner: AI frontend-cloning agent

Paste a public URL. The agent analyzes the page (layout, sections, navigation, text, images, colours, typography, spacing and responsive behaviour), generates a **React 19 + TypeScript + Tailwind v4** project, builds and runs it in a headless browser, repairs its own errors and shows a live local preview. You can then change the site with plain English ("make the navbar sticky", "add a testimonials section").

The output is a new component-based codebase. It does not embed or proxy the original site.

![architecture](docs/architecture.png)

## Setup

Requirements: Node 20+ (tested on 22).

```bash
npm run setup                  # installs root deps, the generated-site template deps, and Playwright Chromium
cp .env.example .env           # add ANTHROPIC_API_KEY (default) or OPENAI_API_KEY + LLM_PROVIDER=openai
npm start                      # builds the studio UI → http://localhost:4000
```

CLI (does the same without the UI):

```bash
npm run clone  -- https://example.com --refine
npm run modify -- <project-id> "Change the primary color to blue"
cd workspaces/<project-id> && npm run dev     # every generated project is a standalone Vite app
```

Without an API key the agent runs in **offline mode**. A deterministic DOM→JSX compiler generates the site, and rule-based edits handle colours, the sticky navbar and removing sections. Offline mode is handy for smoke tests, and the compiler also serves as the safety net in AI mode. `LLM_PROVIDER=mock` runs a scripted provider that deliberately returns broken code, which exercises the repair loop in tests.

Local test sites are included: `npm run fixtures` serves `http://localhost:5055/{saas,bakery,portfolio}/`.

## Architecture

| Stage | What happens | Code |
|---|---|---|
| **1. Analyze** (no LLM) | Playwright loads the page at 1440px. It dismisses cookie banners and auto-scrolls to trigger lazy content. An in-page extractor segments the page into sections: it walks down single-child wrappers, splits `main` or tall stacked blocks, detects sticky/fixed headers, merges slivers and caps the count at 18. For each section it serializes an **annotated DOM** (tags, text, flex/grid, gap, padding, colours, font size/weight, radius, borders, sizes). It also measures **design tokens** (usage-weighted colours, fonts, sizes, radii), downloads images and inline SVGs to `public/media`, looks up fonts on Google Fonts, and captures full-page plus per-section screenshots. A second 390px pass records mobile behaviour. | `src/agent/analyze/` |
| **2. Plan** (1 vision call) | Screenshot tiles, the section outline and the measured tokens go to the model, which returns a JSON plan (theme tokens + component name/role/description/responsive notes per section). The plan is zod-validated, and a heuristic plan is used if it fails. | `generate/plan.ts` |
| **3. Generate** (1 call per section, parallel) | Each section gets its screenshot crop, annotated DOM, tokens and the exact asset paths, and becomes one `.tsx` component. Tokens go to `src/theme.css` (Tailwind `@theme`), so global edits touch one file. `App.tsx` composes the sections, each wrapped in an error boundary. | `generate/section.ts`, `assemble.ts`, `prompts.ts` |
| **4. Validate & repair** | Free deterministic fixes run first (unknown lucide icons → nearest real icon, `next/*` imports, absolute media paths, missing default export). Then `vite build`, then the built site runs in headless Chromium, which catches per-section runtime errors, page errors, empty renders and mobile horizontal overflow. Failing files go back to the model with their errors (fast model first, then the main model, up to 3 rounds). A module-level crash gets localized with `tsc` or by rendering sections one at a time. When the budget runs out, the failing section is swapped for its compiled fallback, so **the preview always renders**. `tsc` type errors are fixed once and the fix is reverted if it breaks the build. | `validate/` |
| **5. Visual score / refine** | The generated site is screenshotted (desktop, mobile, per section) and pixel similarity is computed against the original. With `--refine`, the weakest sections are sent back with *original vs current* screenshots for a rewrite, which is kept only if the score improves. | `validate/visual.ts`, `clone.ts` |
| **6. Modify** | Unambiguous requests (theme colour, sticky navbar, remove section) run on a **$0 deterministic fast path**. Everything else is two steps: a fast model picks the files to read from a manifest, then the main model returns `<file>`/`<delete>` operations. Edits go through the same validate/repair loop. Every successful edit is a snapshot (`.history/vN`) with undo, and a failed edit rolls back automatically. | `modify/` |

**Studio** (`studio/`, React): URL input, live agent log over SSE, stage tracker, desktop/tablet/mobile preview, original vs generated side by side, per-section scores, code browser and the modification chat with undo. **Server** (`src/server/`, Express): REST + SSE. Each project has one job at a time, and the built preview is served at `/preview/<id>/`.

## Technologies and models

TypeScript everywhere · Playwright (analysis, runtime validation, screenshots) · sharp (image prep, similarity) · Vite + React 19 + Tailwind v4 + lucide-react (generated sites) · Express + SSE · zod.
Models: Anthropic **Claude Sonnet 4.5** for vision and codegen, **Claude Haiku 4.5** for repairs and edit planning (default). OpenAI **GPT-4.1 / 4.1-mini** is supported via `LLM_PROVIDER=openai`. All model IDs can be set in `.env`.

## Key decisions

- **Screenshot + annotated DOM, per section.** Screenshots give visual intent. The DOM gives exact text, links, asset URLs and computed px values, which removes most guessing. Working per section keeps each prompt small, runs in parallel and isolates failures.
- **Vite rather than Next.js for the output.** Builds take about 2 seconds, which makes a build → run → repair loop practical. All projects share one installed `node_modules` through a symlink, so creating a project takes milliseconds, with no `npm install` per clone. The components are plain React and port to Next.js unchanged.
- **Tokens in `theme.css`.** Brand colours and fonts are Tailwind theme variables, so "change the primary colour" is a one-line, deterministic edit.
- **Always ship something.** Every stage has a non-LLM fallback: heuristic plan, compiled sections and rollback on failed edits.
- **Cost awareness.** Downscaled or tiled JPEG screenshots, pruned DOM (≤9k chars per section), prompt caching (static system prompts), a cheap model for repairs and planning, free sanitizer fixes before any LLM repair, the $0 edit fast path, an on-disk response cache (re-runs cost $0), a per-job `MAX_COST_USD` budget, and live token/cost accounting in the UI. A typical page is about 10–14 calls.

## Limitations

- It clones a single page (the given URL), not multi-page navigation, and it doesn't replicate client-side interactivity beyond menus and toggles (carousels are rendered static, animations are dropped).
- Canvas/WebGL content, videos and iframes become placeholders or posters. Very long pages are capped at 18 sections, with extra content merged.
- Sites behind bot protection, logins or geo-walls may fail to load, and there is no proxy or stealth.
- Proprietary fonts fall back to a close Google font (Inter/Georgia).
- The similarity score is a coarse pixel metric for ranking and trend, not a perceptual truth.
- Quality depends on the model. The offline compiler is faithful on desktop but its responsive behaviour is simpler.

## With more time

Multi-page crawl and routing · perceptual/SSIM + LLM-judge scoring loop · component deduplication across sections (shared `Card`, `SectionHeading`) · embeddings-based retrieval of relevant files for edits in large projects · a job queue + containerized builds for horizontal scaling · Next.js export option.

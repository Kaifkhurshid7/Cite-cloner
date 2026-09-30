# Demo video script (≈7 min)

Before recording: `cp .env.example .env`, add your API key, then run `npm start` and open http://localhost:4000. Test the three evaluation URLs once beforehand; the response cache makes a second run instant and free, so record a *fresh* URL live.

| Time | Show | Say |
|---|---|---|
| 0:00 | README architecture diagram | "The agent takes a URL through analyze → plan → generate → validate/repair → visual scoring, then supports natural-language edits." |
| 0:45 | Studio home: paste URL #1, tick *visual refinement*, click **Clone** | "Nothing is hard-coded per site. This is a live run." |
| 1:00 | Agent log + stage tracker while **Analyze** runs | Point out: sections found, assets downloaded, fonts, the mobile pass. Open *Sections*. |
| 1:45 | **Plan / Generate** log lines | "One vision call plans the components and theme, then each section is generated in parallel from its screenshot crop and annotated DOM." |
| 2:30 | **Validate / Repair** lines | "Every build runs in a real headless browser. Errors are fed back to a cheap model, and a section that can't be fixed falls back to a compiled version, so the preview always renders." |
| 3:15 | Preview: **Desktop**, then **Side by side** with the original | Scroll both. Mention the similarity score and the cost shown in the header. |
| 4:00 | **Mobile 390** + **Tablet** | Open the hamburger menu, show stacked columns. |
| 4:30 | **Code** tab: `theme.css`, `App.tsx`, one section | "Reusable components, data arrays + map, theme tokens." |
| 5:00 | Chat: "Change the primary color to blue" | "Simple edits take a deterministic fast path: no LLM, $0." |
| 5:30 | Chat: "Add a testimonials section" (or "Replace the hero section with a bakery hero") | Show the plan → edit → validate log, then the new section in the preview. |
| 6:15 | **Undo** | "Every edit is a snapshot, and failed edits roll back automatically." |
| 6:30 | Home: projects for URL #2 and #3 (pre-generated) | Quick side-by-side of each, showing that it generalizes. |
| 7:00 | Close on limitations + next steps from the README | |

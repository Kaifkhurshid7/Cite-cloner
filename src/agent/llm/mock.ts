import type { CompletionRequest, Provider } from './types.js';

/**
 * Scripted provider for integration tests (LLM_PROVIDER=mock). It exercises every agent code path without
 * an API key: planner JSON parsing, section generation with deliberately broken code (bad import,
 * unknown icon, runtime crash), the repair loop, and the modification file-op protocol.
 */
export class MockProvider implements Provider {
  name = 'mock';
  modelFor() {
    return 'mock-model';
  }

  async complete(req: CompletionRequest) {
    const usage = { inputTokens: 1000, outputTokens: 500 };
    const text = this.respond(req);
    return { text, usage, model: 'mock-model' };
  }

  private respond(req: CompletionRequest): string {
    const input = req.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    if (req.label === 'plan') return 'Sure! ```json\n{ "siteName": "broken" ```'; // unparseable → heuristic fallback
    if (req.label.startsWith('section:')) {
      const name = req.label.slice(8);
      const heading = input.match(/"([^"]{3,80})"/)?.[1] ?? name;
      if (name === 'Hero')
        // unknown icon (sanitizer fixes it) + disallowed package (build error → repair)
        return "```tsx\nimport { SparkleMagicIcon } from 'lucide-react';\nimport { motion } from 'framer-motion';\nexport default function Hero() {\n  return <section className=\"py-24 bg-muted\"><motion.h1 className=\"text-5xl font-bold\">" +
          JSON.stringify(heading).slice(1, -1) + '</motion.h1><SparkleMagicIcon /></section>;\n}\n```';
      if (name === 'ContentSection')
        // module-level crash: happens outside any error boundary → must be localized by the validator
        return "```tsx\nconst config = (window as any).missingConfig.value;\nexport default function ContentSection() {\n  return <section className=\"py-10\">{String(config)}</section>;\n}\n```";
      if (name === 'Footer')
        // runtime crash → caught by SectionBoundary → runtime check → repair
        return '```tsx\nexport default function Footer() {\n  const cols: { links: string[] }[] | undefined = undefined;\n  return <footer className="p-10">{cols!.map((c) => c.links.join())}</footer>;\n}\n```';
      return `\`\`\`tsx\nimport { Container } from '../ui/Container';\nexport default function ${name}() {\n  return (\n    <section className="py-12">\n      <Container><h2 className="text-3xl font-heading">${heading.replace(/[{}<>]/g, '')}</h2></Container>\n    </section>\n  );\n}\n\`\`\``;
    }
    if (req.label.startsWith('repair:')) {
      const name = req.label.match(/repair:(\w+)\.tsx/)?.[1] ?? 'Fixed';
      return `\`\`\`tsx\nexport default function ${name}() {\n  return <section className="py-16 text-center"><h2 className="text-4xl">${name} (repaired)</h2></section>;\n}\n\`\`\``;
    }
    if (req.label === 'modify:plan') return '{"read": ["src/App.tsx", "src/theme.css"], "reasoning": "new section goes into App"}';
    if (req.label === 'modify:edit') {
      const app = input.match(/<current path="src\/App.tsx">\n([\s\S]*?)\n<\/current>/)?.[1] ?? '';
      const newApp = app
        .replace("import { SectionBoundary } from './components/ui/SectionBoundary';", "import { SectionBoundary } from './components/ui/SectionBoundary';\nimport Testimonials from './components/sections/Testimonials';")
        .replace(/(\s*<SectionBoundary name="Footer">)/, '\n      <SectionBoundary name="Testimonials">\n        <Testimonials />\n      </SectionBoundary>$1');
      return `<file path="src/components/sections/Testimonials.tsx">
import { Star } from 'lucide-react';
import { Container } from '../ui/Container';

const quotes = [
  { name: 'Jane Doe', role: 'CTO, Acme', text: 'Absolutely transformed how we work.' },
  { name: 'Sam Lee', role: 'Founder, Beta', text: 'Fast, reliable and a joy to use.' },
  { name: 'Ana Ruiz', role: 'PM, Gamma', text: 'Our team could not be happier.' },
];

export default function Testimonials() {
  return (
    <section className="bg-muted py-16 md:py-24">
      <Container>
        <h2 className="text-center font-heading text-3xl font-bold md:text-4xl">What our customers say</h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {quotes.map((q) => (
            <figure key={q.name} className="rounded-brand border border-border bg-background p-6">
              <div className="flex gap-1 text-primary">{[0, 1, 2, 3, 4].map((i) => <Star key={i} size={16} fill="currentColor" />)}</div>
              <blockquote className="mt-4 text-foreground">“{q.text}”</blockquote>
              <figcaption className="mt-4 text-sm text-muted-foreground">{q.name} · {q.role}</figcaption>
            </figure>
          ))}
        </div>
      </Container>
    </section>
  );
}
</file>
<file path="src/App.tsx">
${newApp}
</file>
<summary>Added a Testimonials section with three customer quotes above the footer.</summary>`;
    }
    return 'ok';
  }
}

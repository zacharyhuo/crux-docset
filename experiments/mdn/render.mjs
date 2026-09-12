// Invoked by run.mjs in its clean subprocess environment; no HTTP server required.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORK, samples } from './run.mjs';

export function validateContext(context) {
  if (context?.renderer !== 'Doc' || !context.url?.startsWith('/en-US/docs/Web/') ||
      !Array.isArray(context.doc?.body) || context.doc.body.length === 0) {
    throw new Error('Expected a nonempty Rari Doc context, not an unsupported/fallback route');
  }
}
export function inspectHTML(html) {
  if (!/<h1[\s>]/.test(html) || !/<section[\s>]/.test(html) || html.length < 1000) {
    throw new Error('Empty or structurally incomplete simplified HTML');
  }
  const refs = [...html.matchAll(/\b(href|src)="([^"]+)"/g)].map(m => ({ attribute: m[1], url: m[2] }));
  return {
    bytes: Buffer.byteLength(html), sections: [...html.matchAll(/<section[\s>]/g)].length,
    code_blocks: [...html.matchAll(/<pre[\s>]/g)].length,
    scripts: [...html.matchAll(/<script[\s>]/g)].length,
    iframes: [...html.matchAll(/<iframe[\s>]/g)].length,
    custom_elements: [...new Set([...html.matchAll(/<(mdn-[\w-]+)/g)].map(m => m[1]))],
    unresolved_macros: [...html.matchAll(/\{\{[^}]+\}\}/g)].map(m => m[0]),
    resource_refs: refs.filter(r => r.attribute === 'src'),
    root_relative_links: refs.filter(r => r.url.startsWith('/')).length,
    external_links: refs.filter(r => /^https?:/.test(r.url)).length,
  };
}
export async function main() {
  if (process.env.MDN_EXPERIMENT_CLEAN !== '1' || process.env.HOME !== path.join(WORK, 'home')) {
    throw new Error('Use run.mjs render so upstream code runs with the clean environment');
  }
  // The official prebuilt bundle exports renderSimplified; build/ssr.js uses full render.
  const { renderSimplified } = await import(pathToFileURL(path.join(WORK,
    'node_modules/@mdn/fred/out/static/ssr/index.js')).href);
  const results = [];
  let failed = false;
  for (const sample of samples) {
    try {
      const file = path.join(WORK, 'out/en-us/docs', sample, 'index.json');
      const context = JSON.parse(await readFile(file, 'utf8'));
      validateContext(context);
      const start = performance.now();
      const html = await renderSimplified(context.url, context);
      const metrics = inspectHTML(html);
      const output = path.join(WORK, 'rendered', sample.split('/').at(-1) + '.html');
      await mkdir(path.dirname(output), { recursive: true });
      // Preserve the raw upstream fragment, without rewriting links or hiding flaws.
      await writeFile(output, html);
      results.push({ sample, url: context.url, title: context.doc.title,
        render_ms: +(performance.now() - start).toFixed(3), ...metrics,
        output: path.relative(WORK, output), context_bytes: (await readFile(file)).length,
        flaw_counts: Object.fromEntries(Object.entries(context.doc.flaws ?? context.flaws ?? {})
          .map(([kind, items]) => [kind, items.length])),
        missing_support: (context.doc.flaws?.unknown ?? []).map(f => f.explanation) });
    } catch (error) {
      results.push({ sample, error: error.stack });
      failed = true;
    }
  }
  const unsupported = await renderSimplified('/en-US/', { renderer: 'Homepage' });
  const result = { generated_at: new Date().toISOString(), node: process.version,
    unsupported_route_bytes: Buffer.byteLength(unsupported), results };
  await writeFile(path.join(WORK, 'render-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (failed) throw new Error('Some samples failed; see .work/render-results.json');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

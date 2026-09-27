import { load } from 'cheerio';

const playgroundURL = 'https://unpkg.com/kotlin-playground@1/dist/playground.min.js';

/** One Dokka 2.1 adaptation, not an offline/safety certification of the page.
 * Resource closure and the pinned local runtime profile are caller-owned gates.
 * Never fetch or execute the upstream Playground loader.
 */
export function prepareSpringKotlinPage(html) {
  if (typeof html !== 'string') throw new Error('Invalid Kotlin page input');
  if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error('Kotlin page byte limit exceeded');
  const $ = load(html);
  if ($('code.runnablesample').length) throw new Error('Unsupported runnable Kotlin sample; explicit offline adaptation required');
  const loaders = $('script[src]').filter((_, node) => node.attribs.src.includes('kotlin-playground'));
  if (loaders.length > 1) throw new Error('Duplicate Playground loader');
  for (const node of loaders) {
    const attrs = node.attribs;
    if (attrs.src !== playgroundURL || attrs.type !== 'text/javascript' || attrs.async !== '' ||
        Object.keys(attrs).some(key => !['src', 'type', 'async'].includes(key)) || $(node).text().trim()) {
      throw new Error('Unreviewed Playground loader');
    }
  }
  const removedPlayground = loaders.length === 1;
  loaders.remove();
  return { html: $.html(), removedPlayground };
}

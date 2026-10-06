import { createWriteStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { sha256 as hashFile } from '../identity.js';

const hosts = new Set(['nodejs.org', 'github.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com']);
function approved(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Spring asset URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hosts.has(url.hostname)) throw new Error('Unapproved Spring asset URL');
  return url.href;
}

/** Repository-owned pinned artifacts only. Redirects are checked before making
 * the next request; no caller credentials or cookies are attached. */
export async function downloadSpringAsset({ url, destination, sha256, maxBytes, fetcher = fetch }) {
  if (!path.isAbsolute(destination) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 256 * 1024 ** 2) throw new Error('Invalid Spring asset lock/limit');
  try { await lstat(destination); throw new Error('Spring asset destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let current = approved(url), response;
  const signal = AbortSignal.timeout(180000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetcher(current, { redirect: 'manual', signal });
    if (response.redirected || response.url && response.url !== current) { await response.body?.cancel(); throw new Error('Unexpected Spring asset HTTP redirect'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('Spring asset HTTP redirect limit');
      current = approved(new URL(location, current).href); continue;
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`Spring asset HTTP ${response.status}`); }
    break;
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
    await response.body.cancel(); throw new Error('Spring asset byte limit');
  }
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, _, done) {
    bytes += chunk.length; done(bytes > maxBytes ? new Error('Spring asset byte limit') : null, chunk);
  } });
  await pipeline(response.body, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  if (!bytes || await hashFile(destination) !== sha256) throw new Error('Spring asset hash mismatch');
  return { url, sha256, bytes }; // Do not persist signed redirect URLs.
}

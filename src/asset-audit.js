import path from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8192;
const safePath = value => text(value) && !/[\\\x00-\x1f\x7f:%?#]/.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const list = value => Array.isArray(value) && value.length > 0 && value.length <= 30000;

/** Read-only comparison against a separately reviewed manifest, NOT legal approval.
 * Covers every Documents file, including HTML/embedded code and unknown extensions.
 * Callers must keep the trusted, unpacked tree immutable during this local audit.
 */
export async function auditAssets(documents, manifestPath) {
  const report = { schemaVersion: 1, passed: false, fileCount: 0, bytes: 0, errorCount: 0, errors: [] };
  const error = message => { report.errorCount++; if (report.errors.length < 100) report.errors.push(String(message).slice(0, 1200)); };
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ** 2) throw new Error('Invalid manifest file or size');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest?.schemaVersion !== 1 || !list(manifest.components) || !list(manifest.files)) throw new Error('Invalid asset manifest schema');
    const components = new Map(), files = new Map();
    for (const component of manifest.components) {
      if (!component || !text(component.id) || components.has(component.id)) throw new Error('Invalid or duplicate component');
      components.set(component.id, component);
      if (component.reviewed !== true) error(`Component requires review: ${component.id}`);
      if (!text(component.version) || !text(component.license)) error(`Missing component version/license: ${component.id}`);
      let url;
      try { url = new URL(component.source); } catch { /* Report below without echoing possible credentials. */ }
      if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) error(`Invalid component source URL: ${component.id}`);
      if (!list(component.notices) || component.notices.some(p => !safePath(p))) error(`Missing or invalid component notices: ${component.id}`);
    }
    for (const file of manifest.files) {
      if (!file || !safePath(file.path) || !sha(file.sha256)) throw new Error('Invalid file path or checksum in manifest');
      if (files.has(file.path)) throw new Error(`Duplicate manifest path: ${file.path}`);
      if (!list(file.components) || file.components.some(id => !components.has(id))) error(`Unknown or missing component: ${file.path}`);
      files.set(file.path, file);
    }
    for (const component of components.values()) {
      if (!Array.isArray(component.notices)) continue;
      for (const notice of component.notices) if (!files.get(notice)?.components?.includes(component.id)) error(`Unlisted or unattributed notice for ${component.id}`);
    }
    const rootInfo = await lstat(documents);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Documents directory symlink or non-directory rejected');
    const seen = new Set(); let entries = 0;
    async function walk(relative = '') {
      if (relative.split('/').length > 32) throw new Error('Asset directory depth limit');
      for (const name of (await readdir(path.join(documents, relative))).sort()) {
        if (++entries > 30000) throw new Error('Asset entry count limit');
        const file = relative ? `${relative}/${name}` : name;
        if (!safePath(file)) throw new Error('Unsafe asset path');
        const absolute = path.join(documents, file), stat = await lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error(`Asset symlink rejected: ${file}`);
        if (stat.isDirectory()) { await walk(file); continue; }
        if (!stat.isFile()) throw new Error(`Nonregular asset rejected: ${file}`);
        if (stat.size > 16 * 1024 ** 2 || (report.bytes += stat.size) > 512 * 1024 ** 2) throw new Error('Asset byte limit');
        report.fileCount++; seen.add(file);
        const expected = files.get(file);
        if (!expected) { error(`Unlisted asset: ${file}`); continue; }
        const bytes = await readFile(absolute);
        if (bytes.length !== stat.size || digest(bytes) !== expected.sha256) error(`Asset checksum mismatch: ${file}`);
        if (!bytes.length && [...components.values()].some(c => c.notices?.includes(file))) error(`Empty notice: ${file}`);
      }
    }
    await walk();
    for (const file of files.keys()) if (!seen.has(file)) error(`Missing asset or notice: ${file}`);
  } catch (cause) { error(cause.message); }
  report.passed = report.errorCount === 0;
  return report;
}

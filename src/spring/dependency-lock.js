import { DOMParser } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';

const children = node => Array.from(node.childNodes).filter(n => n.nodeType === 1);
const fail = message => { throw new Error(`Invalid Spring dependency lock: ${message}`); };

/** Inspect a restrictive checksum-only Gradle lock. This verifies its shape,
 * not the authenticity of initially observed downloads or dependency coverage.
 */
export function inspectSpringDependencyLock(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 8 * 1024 ** 2 || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XML size/DOCTYPE');
  let document;
  try {
    document = new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(xml, 'text/xml');
  } catch { fail('malformed XML'); }
  const root = document.documentElement;
  if (root.tagName !== 'verification-metadata') fail('verification root');
  const nodes = children(root);
  if (nodes.length !== 2 || nodes[0].tagName !== 'configuration' || nodes[1].tagName !== 'components') fail('verification sections');
  const configuration = children(nodes[0]);
  if (configuration.filter(n => n.tagName === 'verify-metadata' && n.textContent === 'true').length !== 1 ||
      configuration.filter(n => n.tagName === 'verify-metadata').length !== 1 ||
      configuration.some(n => !['verify-metadata', 'verify-signatures'].includes(n.tagName)) ||
      configuration.filter(n => n.tagName === 'verify-signatures').length > 1 ||
      configuration.some(n => n.tagName === 'verify-signatures' && n.textContent !== 'false')) fail('verification configuration bypass');
  const artifacts = [], seen = new Set();
  const coordinate = /^[A-Za-z0-9_.+-]+$/;
  for (const component of children(nodes[1])) {
    if (component.tagName !== 'component') fail('unexpected component');
    const group = component.getAttribute('group'), name = component.getAttribute('name'), version = component.getAttribute('version');
    if (![group, name, version].every(v => typeof v === 'string' && coordinate.test(v)) || /SNAPSHOT|\+|latest/i.test(version)) fail('unpinned version/coordinate');
    const entries = children(component);
    if (!entries.length) fail('empty component');
    for (const entry of entries) {
      const artifact = entry.getAttribute('name'), hashes = children(entry);
      if (entry.tagName !== 'artifact' || typeof artifact !== 'string' || !coordinate.test(artifact) || hashes.length !== 1 || hashes[0].tagName !== 'sha256' || children(hashes[0]).length) fail('artifact checksum alternatives');
      const sha256 = hashes[0].getAttribute('value');
      if (!/^[a-f0-9]{64}$/.test(sha256)) fail('checksum');
      const key = JSON.stringify([group, name, version, artifact]);
      if (seen.has(key)) fail('duplicate artifact');
      seen.add(key); artifacts.push({ group, name, version, artifact, sha256 });
      if (artifacts.length > 20000) fail('artifact count');
    }
  }
  if (!artifacts.length) fail('empty artifact lock');
  return { sha256: createHash('sha256').update(xml).digest('hex'), artifacts, authenticated: false };
}

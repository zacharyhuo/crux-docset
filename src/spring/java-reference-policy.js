import { createHash } from 'node:crypto';

const policies = new WeakMap();
const sourcePrefix = 'spring-webmvc/src/main/java/org/springframework/web/servlet/mvc/';
const pagePrefix = 'api/javadoc-api/org/springframework/web/servlet/mvc/';
const reviewed = new Map([
  ['Controller.java', 'db256ca0143532078111cc9c0f5c26fb3c4b7bea9ab97d3c715d0f9cf9b5ee2d'],
  ['AbstractController.java', '2c097d68323eb311e30d02743f947380bafbeb46821c02cfd06077e8188e0f2d'],
]);
const digest = text => createHash('sha256').update(text).digest('hex');

/** Compile an exact source-evidence exception, not a global link allowlist.
 * Acquisition must authenticate the supplied commit, source files and render.
 * Unknown source revisions get no exception, even if the link text is similar.
 */
export function createSpringJavaReferencePolicy({ version, commit, sources }) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit) || !(sources instanceof Map) || sources.size > 3) throw new Error('Invalid Java reference source identity');
  const inputs = new Map();
  for (const [file, text] of sources) {
    if (file !== 'gradle.properties' && ![...reviewed.keys()].some(name => file === sourcePrefix + name)) throw new Error('Invalid Java reference source path');
    if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > 4 * 1024 ** 2) throw new Error('Java reference source input limit');
    inputs.set(file, { text, sha256: digest(text) });
  }
  const versions = [...(inputs.get('gradle.properties')?.text.replaceAll('\r\n', '\n') ?? '').matchAll(/^version=(.*)$/gm)].map(m => m[1]);
  if (versions.length !== 1 || versions[0] !== version) throw new Error('Java reference source version mismatch');
  const evidence = []; let result;
  if ([...reviewed].every(([name, sha256]) => inputs.get(sourcePrefix + name)?.sha256 === sha256)) {
    const origin = inputs.get(sourcePrefix + 'AbstractController.java').text;
    const line = origin.slice(0, origin.indexOf('<a href="Controller.html#config">')).split('\n').length;
    result = Object.freeze({ kind: 'unavailable', reason: 'upstream-missing-section', ruleId: 'controller-interface-config',
      evidence: `https://github.com/spring-projects/spring-framework/blob/${commit}/${sourcePrefix}AbstractController.java#L${line}` });
    evidence.push(Object.freeze({ ruleId: result.ruleId, result, proofs: Object.freeze([...reviewed].map(([name, sha256]) => Object.freeze({ file: sourcePrefix + name, sha256 }))) }));
  }
  const policy = Object.freeze({ version, commit, evidence: Object.freeze(evidence) });
  policies.set(policy, { version, result });
  return policy;
}

/** Only call after testing the original rendered target. */
export function resolveReviewedSpringJavaReference(policy, version, from, target, fragment) {
  const data = policies.get(policy);
  if (!data || data.version !== version) throw new Error('Invalid Java reference policy/version');
  if (from === pagePrefix + 'AbstractController.html' && target === pagePrefix + 'Controller.html' && fragment === 'config') return data.result;
}

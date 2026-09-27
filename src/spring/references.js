import { createHash } from 'node:crypto';
import { springReferenceRules } from './reference-rules.js';

const policies = new WeakMap();
const digest = text => createHash('sha256').update(text).digest('hex');
const key = (from, target, fragment) => JSON.stringify([from, target, fragment]);
const relativeSource = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.adoc$/;

/** Compile source evidence from verified input strings; does not acquire files
 * or authenticate a commit. Acquisition must establish those facts first.
 */
export function createSpringReferencePolicy({ version, commit, sources }) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || /[\r\n]/.test(version) ||
      typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit) || commit.length !== 40 || !(sources instanceof Map) || sources.size > 2000) throw new Error('Invalid Spring reference source identity');
  let bytes = 0;
  const input = new Map();
  for (const [file, text] of sources) {
    if (typeof file !== 'string' || file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file) || (file !== 'gradle.properties' && !relativeSource.test(file))) throw new Error('Unsafe Spring reference source path');
    if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('Invalid Spring reference source text');
    const size = Buffer.byteLength(text);
    if (size > 4 * 1024 ** 2 || (bytes += size) > 32 * 1024 ** 2) throw new Error('Spring reference source size limit');
    input.set(file, { text: text.replaceAll('\r\n', '\n'), sha256: digest(text) });
  }
  const versions = [...(input.get('gradle.properties')?.text ?? '').matchAll(/^version=(.*)$/gm)].map(m => m[1]);
  if (versions.length !== 1 || versions[0] !== version) throw new Error('Spring reference source version mismatch');
  const entries = new Map(), evidence = [];
  const proof = (file, source, position, snippet) => Object.freeze({ file, sha256: source.sha256,
    line: source.text.slice(0, position).split('\n').length, snippetSha256: digest(snippet) });
  for (const rule of springReferenceRules) {
    const destination = rule.destination ?? rule.target;
    const targetFile = `${destination}.adoc`, target = input.get(targetFile);
    if (!target) continue;
    let targetProof;
    if (rule.sha256) {
      if (target.sha256 !== rule.sha256) continue;
      targetProof = Object.freeze({ file: targetFile, sha256: target.sha256 });
    } else {
      const position = target.text.indexOf(rule.proof);
      if (position < 0 || (rule.atStart && position !== 0) || target.text.indexOf(rule.proof, position + 1) >= 0 ||
          (position > 0 && target.text[position - 1] !== '\n') || !['\n', undefined].includes(target.text[position + rule.proof.length])) continue;
      targetProof = proof(targetFile, target, position, rule.proof);
    }
    for (const from of rule.from) {
      const fromFile = `${from}.adoc`, source = input.get(fromFile);
      if (!source) continue;
      const needles = rule.reference ? [rule.reference] : [`xref:${rule.target}.adoc#${rule.fragment}[`, ...(rule.shortReference ? [`xref:${rule.fragment}[`] : [])];
      const needle = needles.find(n => source.text.includes(n));
      if (!needle) continue;
      const position = source.text.indexOf(needle);
      const sourceProof = proof(fromFile, source, position, needle);
      const sourceUrl = `https://github.com/spring-projects/spring-framework/blob/${commit}/framework-docs/modules/ROOT/pages/${fromFile}#L${sourceProof.line}`;
      const result = Object.freeze(rule.sha256 ? { kind: 'unavailable', reason: 'upstream-missing-section', evidence: sourceUrl, ruleId: rule.id } :
        { kind: 'local', target: `${destination}.html`, fragment: rule.replacement, ruleId: rule.id });
      entries.set(key(`${from}.html`, `${rule.target}.html`, rule.fragment), result);
      evidence.push(Object.freeze({ id: rule.id, from: `${from}.html`, target: `${rule.target}.html#${rule.fragment}`, result,
        proofs: Object.freeze([sourceProof, targetProof]) }));
    }
  }
  const policy = Object.freeze({ version, commit, evidence: Object.freeze(evidence) });
  policies.set(policy, { version, entries });
  return policy;
}

/** Called only after the original target is proven missing; callers must also
 * verify local replacements against actual rendered content before rewriting.
 */
export function resolveReviewedSpringReference(policy, version, from, target, fragment) {
  const data = policies.get(policy);
  if (!data || data.version !== version) throw new Error('Invalid Spring reference policy/version');
  return data.entries.get(key(from, target, fragment));
}

import { createHash } from 'node:crypto';
import reviewed from './bundle-reference-rules.json' with { type: 'json' };

const policies = new WeakMap();
const key = (from, target, fragment) => JSON.stringify([from, target, fragment]);

/** Source-content authorization for the reviewed 7.0.9 commit only. Acquisition
 * must authenticate the commit and bound filesystem reads before calling this.
 * This is not a serialized allowlist, release qualification or Git verifier.
 */
export function createSpringBundleReferencePolicy({ version, commit, sources }) {
  if (version !== reviewed.version || commit !== reviewed.commit) throw new Error('Unreviewed Spring reference version/commit identity');
  if (!(sources instanceof Map) || sources.size !== Object.keys(reviewed.proofs).length) throw new Error('Missing Spring reference source proofs');
  for (const [file, sha256] of Object.entries(reviewed.proofs)) {
    const text = sources.get(file);
    if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > 1024 ** 2 ||
        createHash('sha256').update(text).digest('hex') !== sha256) throw new Error(`Spring reference source proof changed: ${file}`);
  }
  const rules = new Map(), evidence = [];
  for (const rule of reviewed.rules) {
    const proof = `https://github.com/spring-projects/spring-framework/blob/${commit}/${rule.proofs[0]}`;
    const result = Object.freeze({ kind: rule.replacement ? 'local' : 'unavailable', ruleId: rule.id,
      ...(rule.replacement ?? { reason: 'upstream-missing-api' }), evidence: proof });
    rules.set(key(rule.from, rule.target, rule.fragment), result);
    evidence.push(Object.freeze({ ruleId: rule.id, from: rule.from, target: rule.target, fragment: rule.fragment,
      result, proofs: Object.freeze(rule.proofs.map(file => Object.freeze({ file, sha256: reviewed.proofs[file] }))) }));
  }
  const policy = Object.freeze({ version, commit, evidence: Object.freeze(evidence), verifiedSources: Object.freeze({ ...reviewed.proofs }) });
  policies.set(policy, { version, commit, rules });
  return policy;
}

export function verifySpringBundleReferencePolicy(policy, { version, commit = policy?.commit }) {
  const data = policies.get(policy);
  if (!data || data.version !== version || data.commit !== commit) throw new Error('Invalid Spring bundle reference policy identity');
}

/** Call only when the original rendered target is absent. */
export function resolveSpringBundleReference(policy, version, from, target, fragment) {
  verifySpringBundleReferencePolicy(policy, { version });
  return policies.get(policy).rules.get(key(from, target, fragment));
}

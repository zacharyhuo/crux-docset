import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GO_CONTEXTS } from './inventory.js';

// Reviewed excerpts from Go's BSD-licensed source. Match content, not patch
// numbers or hardcoded line numbers. Unknown changes never grant exceptions.
const proof = (file, snippet) => ({ file, snippet });
const sql = proof('database/sql/driver/types.go', '// like [database/sql.Query], [database/sql.Exec], or [database/sql.QueryRow].');
const jsonOptions = proof('encoding/json/v2_options.go', 'type Options = jsonopts.Options');
const jsonDefault = proof('encoding/json/v2_options.go', 'func DefaultOptionsV1() Options {');
const jsonTag = proof('encoding/json/v2_options.go', '//go:build goexperiment.jsonv2');
const rules = [
  ...['Query', 'Exec', 'QueryRow'].map(name => ({ id: `sql-${name}`, from: 'database/sql/driver', target: 'database/sql', fragment: name, proofs: [sql] })),
  { id: 'os-exec', from: 'os/signal', target: 'os', fragment: 'Exec', proofs: [proof('os/signal/doc.go', 'started by [os.Exec], or by [os/exec], will inherit the\nmodified signal mask.')] },
  { id: 'simd-path', from: 'simd', target: 'arch/simd', fragment: '', proofs: [proof('simd/doc.go', 'For an example of converting between [simd] and [arch/simd] types,\nsee the test file sum_amd64_test.go.')] },
  { id: 'time-parse', from: 'encoding/json/v2', target: 'time', fragment: 'Time.Parse', proofs: [proof('encoding/json/v2/arshal.go', '//     Otherwise, the format is used as-is with [time.Time.Parse] if non-empty.')] },
  { id: 'netip-appender', from: 'net/netip', target: 'encoding', fragment: 'BinaryAppendler', proofs: [proof('net/netip/netip.go', '// AppendBinary implements the [encoding.BinaryAppendler] interface.')] },
  { id: 'netip-marshaler', from: 'net/netip', target: 'encoding', fragment: 'AppendMarshaler', proofs: [proof('net/netip/netip.go', '// AppendBinary implements the [encoding.AppendMarshaler] interface.')] },
  { id: 'plan9-error', from: 'os', target: 'syscall', fragment: 'EPLAN9', reason: 'out-of-scope-platform', destination: 1,
    proofs: [proof('os/file_posix.go', '// [syscall.EPLAN9] error, wrapped in [*PathError].'), proof('syscall/errors_plan9.go', 'EPLAN9       = NewError("not supported by plan 9")')] },
  { id: 'jsontext-options', from: 'encoding/json/jsontext', target: 'encoding/json', fragment: 'Options', reason: 'out-of-scope-build-tag', destination: 1, tag: 'goexperiment.jsonv2',
    proofs: [proof('encoding/json/jsontext/options.go', '// The Options type is identical to [encoding/json.Options] and\n// [encoding/json/v2.Options]. Options from the other packages may'), jsonOptions, jsonTag] },
  { id: 'jsonv2-options', from: 'encoding/json/v2', target: 'encoding/json', fragment: 'Options', reason: 'out-of-scope-build-tag', destination: 1, tag: 'goexperiment.jsonv2',
    proofs: [proof('encoding/json/v2/options.go', '// The Options type is identical to [encoding/json.Options] and\n// [encoding/json/jsontext.Options]. Options from the other packages can'), jsonOptions, jsonTag] },
  { id: 'jsonv2-default', from: 'encoding/json/v2', target: 'encoding/json', fragment: 'DefaultOptionsV1', reason: 'out-of-scope-build-tag', destination: 1, tag: 'goexperiment.jsonv2',
    proofs: [proof('encoding/json/v2/options.go', '// It is equivalent to the set of options in [encoding/json.DefaultOptionsV1]\n// all being set to false. All other options are not present.'), jsonDefault, jsonTag] },
];
const policies = new WeakMap();
const digest = data => createHash('sha256').update(data).digest('hex');
const normalized = text => text.replaceAll('\r\n', '\n').split('\n').map(line => line.trim()).join('\n');
const key = (from, target, fragment) => `${from}:${target}#${fragment}`;

export function assertGoReferencePolicy(policy, version) {
  if (!policies.has(policy) || policies.get(policy).version !== version) throw new Error('Invalid Go reference policy/version');
}
export function resolveReviewedGoReference(policy, version, from, target, fragment) {
  if (policy === undefined) return undefined;
  assertGoReferencePolicy(policy, version);
  return policies.get(policy).entries.get(key(from, target, fragment));
}

export async function readGoReferencePolicy(goroot, { version, sourceInventory }) {
  if (!path.isAbsolute(goroot) || !/^1\.\d+\.\d+$/.test(version) || sourceInventory?.version !== `go${version}` ||
      JSON.stringify(sourceInventory.contexts) !== JSON.stringify(GO_CONTEXTS) || !Array.isArray(sourceInventory.toolTags) || sourceInventory.toolTags.some(tag => typeof tag !== 'string')) throw new Error('Invalid Go reference source version/context');
  const rootStat = await lstat(goroot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Go reference root must be regular, not symlink');
  let total = 0;
  const cache = new Map();
  async function read(relative, optional = false) {
    if (cache.has(relative)) return cache.get(relative);
    const components = relative.split('/'); let file = goroot;
    try {
      for (const [i, component] of components.entries()) {
        file = path.join(file, component);
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || (i === components.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Go reference source must be regular, not symlink');
        if (i === components.length - 1 && stat.size > 4 * 1024 ** 2) throw new Error('Go reference source size limit');
      }
      const bytes = await readFile(file);
      if (bytes.length > 4 * 1024 ** 2 || (total += bytes.length) > 16 * 1024 ** 2) throw new Error('Go reference source size limit');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const result = { text, sha256: digest(bytes), normalized: `\n${normalized(text)}\n` };
      cache.set(relative, result); return result;
    } catch (error) {
      if (optional && error.code === 'ENOENT') { cache.set(relative, null); return null; }
      throw error;
    }
  }
  if ((await read('VERSION')).text.split(/\r?\n/)[0] !== `go${version}`) throw new Error('Go reference SDK version mismatch');
  const entries = new Map(), evidence = [];
  for (const rule of rules) {
    if (rule.tag && sourceInventory.toolTags.includes(rule.tag)) continue;
    const proofs = [];
    for (const required of rule.proofs) {
      const source = await read(`src/${required.file}`, true);
      if (!source) break;
      const needle = `\n${normalized(required.snippet)}\n`;
      const position = source.normalized.indexOf(needle);
      if (position < 0 || source.normalized.indexOf(needle, position + 1) >= 0) break;
      proofs.push(Object.freeze({ file: required.file, sha256: source.sha256, line: source.normalized.slice(0, position).split('\n').length,
        snippetSha256: digest(normalized(required.snippet)) }));
    }
    if (proofs.length !== rule.proofs.length) continue;
    const destination = proofs[rule.destination ?? 0];
    const url = `https://github.com/golang/go/blob/go${version}/src/${destination.file}#L${destination.line}`;
    const result = Object.freeze(rule.reason ? { kind: 'online', reason: rule.reason, ruleId: rule.id, href: url,
      ...(rule.tag ? { requirement: 'GOEXPERIMENT=jsonv2' } : {}) } : { kind: 'literal', reason: 'upstream-broken-reference', ruleId: rule.id, evidence: url });
    entries.set(key(rule.from, rule.target, rule.fragment), result);
    evidence.push(Object.freeze({ id: rule.id, from: rule.from, target: `${rule.target}#${rule.fragment}`, result, proofs: Object.freeze(proofs) }));
  }
  const policy = Object.freeze({ version, evidence: Object.freeze(evidence) });
  // Serialized evidence is an audit record, never a replayable exception grant.
  policies.set(policy, { version, entries });
  return policy;
}

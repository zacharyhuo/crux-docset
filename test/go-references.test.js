import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readGoReferencePolicy } from '../src/go/references.js';
import { createGoLinkResolver } from '../src/go/links.js';

const sqlComment = '// like [database/sql.Query], [database/sql.Exec], or [database/sql.QueryRow].';
const entry = name => ({ packagePath: name, context: 'linux/amd64', outputPath: `platforms/linux-amd64/${name}/index.html` });
async function fixture(t, version = '1.27.2') {
  const goroot = await mkdtemp(path.join(os.tmpdir(), 'crux-go-reference-'));
  t.after(() => rm(goroot, { recursive: true, force: true }));
  await writeFile(path.join(goroot, 'VERSION'), `go${version}\n`);
  await mkdir(path.join(goroot, 'src'));
  const put = async (file, text) => { await mkdir(path.dirname(path.join(goroot, 'src', file)), { recursive: true }); await writeFile(path.join(goroot, 'src', file), text); };
  const sourceInventory = { version: `go${version}`, contexts: ['linux/amd64', 'windows/amd64', 'darwin/amd64', 'js/wasm'], toolTags: [] };
  const policy = () => readGoReferencePolicy(goroot, { version, sourceInventory });
  return { goroot, version, sourceInventory, put, policy };
}
function resolver(f, policy, names = ['database/sql/driver', 'database/sql'], ids = []) {
  const pages = names.map(entry);
  return createGoLinkResolver({ pages }, { version: f.version, goroot: f.goroot, referencePolicy: policy,
    anchors: new Map(pages.map(p => [p.outputPath, new Set(ids)])) });
}

test('reviewed source text survives a patch bump and line shift with new hashes and exact source URLs', async t => {
  const f = await fixture(t);
  await f.put('database/sql/driver/types.go', `package driver\n\n${sqlComment}\n`);
  const a = await f.policy();
  const first = resolver(f, a)('/database/sql#Query', entry('database/sql/driver'));
  assert.equal(first.kind, 'literal');
  assert.equal(first.evidence, 'https://github.com/golang/go/blob/go1.27.2/src/database/sql/driver/types.go#L3');
  await f.put('database/sql/driver/types.go', `// unrelated patch addition\npackage driver\n\n${sqlComment}\n`);
  const b = await f.policy();
  const next = resolver(f, b)('/database/sql#Query', entry('database/sql/driver'));
  assert.match(next.evidence, /#L4$/);
  assert.notEqual(a.evidence[0].proofs[0].sha256, b.evidence[0].proofs[0].sha256);
  assert.throws(() => resolver({ ...f, version: '1.27.3' }, b), /policy.*version|version.*policy/i);
});

test('changed, missing or ambiguous source never inherits old version-based exceptions', async t => {
  const f = await fixture(t, '1.27.1');
  for (const text of ['package driver\n', '// like [database/sql.DB.Query].\n', `${sqlComment}\n${sqlComment}\n`]) {
    await f.put('database/sql/driver/types.go', text);
    const policy = await f.policy();
    assert.throws(() => resolver(f, policy)('/database/sql#Query', entry('database/sql/driver')), /anchor/);
  }
});

test('grants are source/target scoped and never override an available local target', async t => {
  const f = await fixture(t);
  await f.put('database/sql/driver/types.go', sqlComment);
  const policy = await f.policy();
  assert.throws(() => resolver(f, policy)('/database/sql#Query', entry('database/sql')), /anchor/);
  assert.throws(() => resolver(f, policy)('/database/sql#Unknown', entry('database/sql/driver')), /anchor/);
  assert.equal(resolver(f, policy, undefined, ['Query'])('/database/sql#Query', entry('database/sql/driver')).kind, 'local');
  assert.throws(() => resolver(f, JSON.parse(JSON.stringify(policy))), /policy/);
});

test('experimental aliases need both the reviewed reference and excluded build-tag proof', async t => {
  const f = await fixture(t, '1.26.9');
  await f.put('encoding/json/jsontext/options.go', '// The Options type is identical to [encoding/json.Options] and\n// [encoding/json/v2.Options]. Options from the other packages may\n');
  await f.put('encoding/json/v2_options.go', '//go:build goexperiment.jsonv2\npackage json\ntype Options = jsonopts.Options\n');
  const names = ['encoding/json/jsontext', 'encoding/json'];
  const result = resolver(f, await f.policy(), names)('/encoding/json#Options', entry(names[0]));
  assert.equal(result.reason, 'out-of-scope-build-tag'); assert.equal(result.requirement, 'GOEXPERIMENT=jsonv2');
  assert.equal(result.href, 'https://github.com/golang/go/blob/go1.26.9/src/encoding/json/v2_options.go#L3');
  for (const text of ['package json\ntype Options = jsonopts.Options\n', '//go:build goexperiment.jsonv2\npackage json\n']) {
    await f.put('encoding/json/v2_options.go', text);
    assert.throws(() => resolver(f, undefined, names)('/encoding/json#Options', entry(names[0])), /anchor/);
    const incomplete = await f.policy();
    assert.throws(() => resolver(f, incomplete, names)('/encoding/json#Options', entry(names[0])), /anchor/);
  }
  await f.put('encoding/json/v2_options.go', '//go:build goexperiment.jsonv2\npackage json\ntype Options = jsonopts.Options\n');
  f.sourceInventory.toolTags.push('goexperiment.jsonv2');
  const enabledPolicy = await f.policy();
  assert.throws(() => resolver(f, enabledPolicy, names)('/encoding/json#Options', entry(names[0])), /anchor/);
});

test('source identity, symlinks and malformed UTF8 fail before granting a policy', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.goroot, 'VERSION'), 'go1.26.9\n');
  await assert.rejects(f.policy(), /version/i);
  await writeFile(path.join(f.goroot, 'VERSION'), `go${f.version}\n`);
  await f.put('database/sql/driver/types.go', Buffer.from([0xff]));
  await assert.rejects(f.policy(), /UTF|encoded|encoding/i);
  await rm(path.join(f.goroot, 'src/database/sql/driver/types.go'));
  await symlink(path.join(f.goroot, 'VERSION'), path.join(f.goroot, 'src/database/sql/driver/types.go'));
  await assert.rejects(f.policy(), /symlink|regular/i);
});

test('Plan 9 online source requires both the originating reference and actual declaration', async t => {
  const f = await fixture(t);
  const names = ['os', 'syscall'];
  await f.put('os/file_posix.go', '// [syscall.EPLAN9] error, wrapped in [*PathError].');
  let policy = await f.policy();
  assert.throws(() => resolver(f, policy, names)('/syscall#EPLAN9', entry('os')), /anchor/);
  await f.put('syscall/errors_plan9.go', 'package syscall\n\nEPLAN9       = NewError("not supported by plan 9")\n');
  policy = await f.policy();
  assert.equal(resolver(f, policy, names)('/syscall#EPLAN9', entry('os')).href, 'https://github.com/golang/go/blob/go1.27.2/src/syscall/errors_plan9.go#L3');
  assert.throws(() => resolver(f, policy, names)('/syscall#EPLAN9', entry('syscall')), /anchor/);
});

test('oversized source cannot allocate an unbounded reference policy', async t => {
  const f = await fixture(t);
  await f.put('database/sql/driver/types.go', 'x'.repeat(4 * 1024 ** 2 + 1));
  await assert.rejects(f.policy(), /size limit/);
});

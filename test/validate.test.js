import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { validate } from '../src/validate.js';
import { PNG } from 'pngjs';

test('required icons must both exist, decode and have correct dimensions', async t => {
  const { bundle } = await fixture(t);
  const configured = { ...recipe, validation: { ...recipe.validation, requireIcons: true } };
  await fails(bundle, /icon/i, configured);
  for (const [name, size] of [['icon.png', 16], ['icon@2x.png', 32]]) {
    await writeFile(join(bundle, name), PNG.sync.write(new PNG({ width: size, height: size })));
  }
  assert.equal((await validate(bundle, configured)).passed, true);
  const corrupt = await readFile(join(bundle, 'icon.png'));
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(join(bundle, 'icon.png'), corrupt);
  await fails(bundle, /icon/i, configured);
  await writeFile(join(bundle, 'icon.png'), PNG.sync.write(new PNG({ width: 32, height: 32 })));
  await fails(bundle, /icon.*16/i, configured);
  await writeFile(join(bundle, 'icon.png'), Buffer.from('not a png'));
  await fails(bundle, /icon/i, configured);
});

const recipe = { id: 'python', name: 'Python', bundleName: 'Python', identifier: 'dev.crux.python', homepage: 'index.html', validation: { minimumPages: 2, minimumSymbols: 3, requiredSymbols: ['list', 'dict', 'asyncio'], requiredPages: [{ path: 'library/functions.html', containsText: 'Built-in Functions' }] } };
const info = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.crux.python</string><key>CFBundleName</key><string>Python</string><key>DocSetPlatformFamily</key><string>python</string><key>isDashDocset</key><true/></dict></plist>`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crux-validator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'Python.docset');
  const resources = join(bundle, 'Contents/Resources');
  const docs = join(resources, 'Documents');
  await mkdir(join(docs, 'library'), { recursive: true });
  await writeFile(join(bundle, 'Contents/Info.plist'), info);
  await writeFile(join(docs, 'index.html'), '<html><body><h1 id="list">list</h1><a name="dict"></a><i id="a+b">plus</i><i id="中文">中文</i></body></html>');
  await writeFile(join(docs, 'library/functions.html'), '<html><body>Built-in Functions<h2 id="asyncio">asyncio</h2></body></html>');
  const dbPath = join(resources, 'docSet.dsidx');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE searchIndex (id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT)');
  const insert = db.prepare('INSERT INTO searchIndex(name,type,path) VALUES (?,?,?)');
  for (const [name, path] of [['list', 'index.html#list'], ['dict', 'index.html#dict'], ['asyncio', 'library/functions.html#asyncio']]) insert.run(name, 'Function', path);
  db.close();
  return { root, bundle, docs, dbPath };
}
function update(path, sql, ...args) { const db = new DatabaseSync(path); try { db.prepare(sql).run(...args); } finally { db.close(); } }
async function fails(bundle, expected, r = recipe) { const report = await validate(bundle, r); assert.equal(report.passed, false); assert.match(report.errors.join('\n'), expected); return report; }

test('valid bundle accepts standard Apple doctype, counts all pages and symbols', async t => {
  const f = await fixture(t); const report = await validate(f.bundle, recipe);
  assert.deepEqual(report.errors, []); assert.equal(report.passed, true); assert.equal(report.schemaVersion, 1);
  assert.equal(report.pageCount, 2); assert.equal(report.symbolCount, 3); assert.ok(report.documentBytes > 0); assert.deepEqual(report.warnings, []);
});
test('missing indexed page does not prevent true symbol counts', async t => { const f = await fixture(t); await rm(join(f.docs, 'library/functions.html')); const r = await fails(f.bundle, /missing|ENOENT/i); assert.equal(r.symbolCount, 3); assert.equal(r.pageCount, 1); });
test('missing anchors are bounded but every row is counted', async t => {
  const f = await fixture(t); const db = new DatabaseSync(f.dbPath); const stmt = db.prepare('INSERT INTO searchIndex(name,type,path) VALUES (?,?,?)');
  for (let i = 0; i < 250; i++) stmt.run(`missing${i}`, 'Function', `index.html#missing${i}`); db.close();
  const r = await fails(f.bundle, /anchor/i); assert.equal(r.symbolCount, 253); assert.ok(r.errors.length <= 101); assert.match(r.errors.join('\n'), /omitted/i);
});
test('literal plus and percent-encoded Unicode and filenames resolve', async t => {
  const f = await fixture(t); await writeFile(join(f.docs, 'a+b.html'), '<a id="x+y"></a>');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'a%2Bb.html#x+y', 'list');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'index.html#a+b', 'dict');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'index.html#%E4%B8%AD%E6%96%87', 'asyncio');
  assert.equal((await validate(f.bundle, recipe)).passed, true);
});
test('accepts literal percent-encoded HTML IDs before the decoded-fragment fallback', async t => {
  const f = await fixture(t);
  await writeFile(join(f.docs, 'dokka.html'), '<html><body><a id="2016386603%2FFunctions%2F-535100867"></a><a name="literal%20name"></a><i id="中文"></i></body></html>');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'dokka.html#2016386603%2FFunctions%2F-535100867', 'list');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'dokka.html#literal%20name', 'dict');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'dokka.html#%E4%B8%AD%E6%96%87', 'asyncio');
  assert.equal((await validate(f.bundle, recipe)).passed, true);
  await writeFile(join(f.docs, 'dokka.html'), '<html><body><a id="2016386603/Functions/-535100867"></a><a name="literal name"></a><i id="中文"></i></body></html>');
  assert.equal((await validate(f.bundle, recipe)).passed, true, 'decoded fallback still works when literal spelling is absent');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'dokka.html#literal%2520name', 'dict');
  await fails(f.bundle, /missing anchor/i);
});
for (const path of ['../secret.html', '%2e%2e/secret.html', '%252e%252e/secret.html', '/index.html', 'https://example.com/', 'file:///tmp/x', '//example.com/x', 'a\\b.html', 'index.html%00', '%FF.html']) {
  test(`rejects unsafe index path ${path}`, async t => { const f = await fixture(t); update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', path, 'list'); await fails(f.bundle, /unsafe|invalid|encoding/i); });
}
test('rejects unsafe homepage and required page', async t => { const f = await fixture(t); await fails(f.bundle, /unsafe/i, { ...recipe, homepage: '../Info.plist' }); await fails(f.bundle, /unsafe/i, { ...recipe, validation: { ...recipe.validation, requiredPages: [{ path: 'https://example.com' }] } }); });
test('symlinks in documents and bundle components fail closed', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'outside.html'), '<h1 id="list"></h1>'); await rm(join(f.docs, 'index.html')); await symlink(join(f.root, 'outside.html'), join(f.docs, 'index.html')); await fails(f.bundle, /symlink/i);
});
test('symlink bundle is rejected', async t => { const f = await fixture(t); await symlink(f.bundle, join(f.root, 'alias.docset')); await fails(join(f.root, 'alias.docset'), /symlink/i); });
test('nonregular indexed target fails', async t => { const f = await fixture(t); update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'library', 'list'); await fails(f.bundle, /regular/i); });
test('malformed and missing SQLite produce reports', async t => { const f = await fixture(t); await writeFile(f.dbPath, 'not sqlite'); await fails(f.bundle, /sqlite|database/i); await rm(f.dbPath); await fails(f.bundle, /missing|ENOENT/i); });
test('schema and invalid symbol fields fail closed', async t => { const f = await fixture(t); update(f.dbPath, 'UPDATE searchIndex SET type=NULL WHERE name=?', 'list'); await fails(f.bundle, /type/i); const db = new DatabaseSync(f.dbPath); db.exec('DROP TABLE searchIndex; CREATE TABLE searchIndex(name TEXT)'); db.close(); await fails(f.bundle, /schema/i); });
test('identifier mismatch and malformed plist fail', async t => { const f = await fixture(t); const p = join(f.bundle, 'Contents/Info.plist'); await writeFile(p, info.replace('dev.crux.python', 'wrong')); await fails(f.bundle, /identifier/i); await writeFile(p, '<plist><dict>'); await fails(f.bundle, /plist/i); });
test('entity declarations are rejected without resolving external resources', async t => { const f = await fixture(t); await writeFile(join(f.bundle, 'Contents/Info.plist'), '<!DOCTYPE plist [<!ENTITY x SYSTEM "file:///etc/passwd">]><plist><dict><key>CFBundleIdentifier</key><string>&x;</string></dict></plist>'); await fails(f.bundle, /entity|doctype|plist/i); });
test('required symbols use exact names, and required text and minima are enforced', async t => { const f = await fixture(t); await fails(f.bundle, /required symbol/i, { ...recipe, validation: { ...recipe.validation, requiredSymbols: ["list' OR 1=1 --"] } }); await fails(f.bundle, /text/i, { ...recipe, validation: { ...recipe.validation, requiredPages: [{ path: 'index.html', containsText: 'absent text' }] } }); await fails(f.bundle, /minimum/i, { ...recipe, validation: { minimumPages: 3, minimumSymbols: 4 } }); });
test('reviewed alternate page paths verify real body content across upstream relocations, not redirect placeholders', async t => {
  const f = await fixture(t);
  const configured = { ...recipe, validation: { ...recipe.validation, requiredPages: [{ paths: ['library/functions.html', 'builtins/functions.html'], containsText: 'Built-in Functions' }] } };
  assert.equal((await validate(f.bundle, configured)).passed, true, 'old archives retain their original canonical path');
  await mkdir(join(f.docs, 'builtins'));
  await rename(join(f.docs, 'library/functions.html'), join(f.docs, 'builtins/functions.html'));
  await writeFile(join(f.docs, 'library/functions.html'), '<html><body><a href="../builtins/functions.html">Continue</a></body></html>');
  update(f.dbPath, 'UPDATE searchIndex SET path=? WHERE name=?', 'builtins/functions.html#asyncio', 'asyncio');
  assert.equal((await validate(f.bundle, configured)).passed, true, 'new canonical path must contain the same required body text');
  await writeFile(join(f.docs, 'builtins/functions.html'), '<html><body><h2 id="asyncio">asyncio</h2></body></html>');
  await fails(f.bundle, /required page.*text/i, configured);
});
test('alternate page rules are bounded and reject all unsafe paths even if an earlier path would pass', async t => {
  const f = await fixture(t);
  for (const item of [
    { paths: [] }, { paths: 'index.html' }, { paths: Array(5).fill('index.html') },
    { path: 'index.html', paths: ['index.html'] }, { paths: ['index.html', '../Info.plist'] },
    { paths: ['index.html', 'https://example.invalid/page.html'] }
  ]) {
    await fails(f.bundle, /required page/i, { ...recipe, validation: { ...recipe.validation, requiredPages: [item] } });
  }
});
test('oversized page is rejected before HTML parsing', async t => { const f = await fixture(t); await writeFile(join(f.docs, 'big.html'), Buffer.alloc(16 * 1024 * 1024 + 1, 32)); await fails(f.bundle, /size|limit/i); });
test('missing bundle and invalid recipe return reports', async t => { const f = await fixture(t); await fails(join(f.root, 'missing'), /missing|ENOENT/i); await fails(f.bundle, /recipe/i, {}); });
test('malformed XML that a tolerant parser repairs must fail closed', async t => { const f = await fixture(t); await writeFile(join(f.bundle, 'Contents/Info.plist'), info.replace('version="1.0"><dict>', 'version=1.0><dict>')); await fails(f.bundle, /plist/i); });
test('Documents directory symlink and metadata symlink are rejected', async t => {
  const f = await fixture(t); await rename(f.docs, join(f.root, 'moved')); await symlink(join(f.root, 'moved'), f.docs); await fails(f.bundle, /symlink/i);
  await rm(f.docs); await rename(join(f.root, 'moved'), f.docs);
  const p = join(f.bundle, 'Contents/Info.plist'); await rename(p, join(f.root, 'info')); await symlink(join(f.root, 'info'), p); await fails(f.bundle, /symlink/i);
});
test('view masquerading as index and SQLite sidecars fail closed', async t => {
  const f = await fixture(t); const db = new DatabaseSync(f.dbPath); db.exec('ALTER TABLE searchIndex RENAME TO original; CREATE VIEW searchIndex AS SELECT * FROM original'); db.close(); await fails(f.bundle, /schema/i);
  await writeFile(`${f.dbPath}-wal`, 'sidecar'); await fails(f.bundle, /sidecar/i);
});
test('validation leaves the database bytes unchanged', async t => { const f = await fixture(t); const before = await readFile(f.dbPath); await validate(f.bundle, recipe); assert.deepEqual(await readFile(f.dbPath), before); });
test('license text is decoded from HTML and whitespace normalized', async t => {
  const f = await fixture(t);
  await writeFile(join(f.docs, 'license.html'), '<html><body><h1>PYTHON\n SOFTWARE&nbsp; FOUNDATION   LICENSE</h1><script>hidden claim</script></body></html>');
  const r = { ...recipe, validation: { ...recipe.validation, requiredPages: [{ path: 'license.html', containsText: 'PYTHON SOFTWARE FOUNDATION LICENSE' }] } };
  assert.equal((await validate(f.bundle, r)).passed, true);
  r.validation.requiredPages[0].containsText = 'hidden claim';
  await fails(f.bundle, /text/i, r);
});

for (const relative of ['meta.json', 'icon.png', 'Contents/Resources/extra', 'extras/nested/entry']) {
  for (const kind of ['symlink', 'fifo']) {
    test(`whole bundle rejects ${kind} at ${relative} without changing document counts`, async t => {
      const f = await fixture(t);
      const before = await validate(f.bundle, recipe);
      const entry = join(f.bundle, relative);
      await mkdir(dirname(entry), { recursive: true });
      if (kind === 'symlink') await symlink('/etc', entry);
      else execFileSync('mkfifo', [entry]);
      const after = await fails(f.bundle, kind === 'symlink' ? /symlink/i : /regular/i);
      assert.ok(after.errors.some(message => message.includes(relative)));
      assert.equal(after.pageCount, before.pageCount);
      assert.equal(after.documentBytes, before.documentBytes);
      assert.equal(after.symbolCount, before.symbolCount);
    });
  }
}
test('regular extras are allowed but not counted as document pages or bytes', async t => {
  const f = await fixture(t); const before = await validate(f.bundle, recipe);
  await mkdir(join(f.bundle, 'extras/nested'), { recursive: true });
  await writeFile(join(f.bundle, 'extras/nested/extra.html'), '<h1>extra</h1>');
  await writeFile(join(f.bundle, 'icon.png'), 'icon');
  assert.deepEqual(await validate(f.bundle, recipe), before);
});
test('whole bundle traversal bounds depth outside Documents', async t => {
  const f = await fixture(t);
  await mkdir(join(f.bundle, 'extras', ...Array(129).fill('d')), { recursive: true });
  await fails(f.bundle, /depth limit/i);
});

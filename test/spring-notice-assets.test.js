import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('recipe notice evidence retains exact text hashes and resolves every component/font notice reference', async () => {
  const bytes = await readFile(new URL('../recipes/spring-framework/notices/dokka-2.1.0.json', import.meta.url)).catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  assert.ok(bytes, 'Dokka notice evidence must be stored with the recipe');
  const data = JSON.parse(bytes), notices = new Map(), identities = new Set();
  assert.equal(data.status, 'byte-provenance-only-not-release-approved');
  assert.ok(data.components.length > 0 && data.notices.length > 0);
  for (const notice of data.notices) {
    assert.ok(notice.text.trim());
    assert.equal(createHash('sha256').update(notice.text).digest('hex'), notice.sha256);
    assert.equal(notices.has(notice.sha256), false); notices.set(notice.sha256, notice);
  }
  const used = new Set();
  for (const component of data.components) {
    const id = `${component.name}@${component.version}`;
    assert.equal(identities.has(id), false); identities.add(id);
    const source = new URL(component.archive);
    assert.equal(source.origin, 'https://registry.npmjs.org');
    assert.equal(source.search + source.hash + source.username + source.password, '');
    assert.match(component.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.match(component.packageSha256, /^[a-f0-9]{64}$/);
    assert.match(component.statsSha256, /^[a-f0-9]{64}$/);
    assert.ok(component.notices.length > 0);
    for (const ref of component.notices) { assert.ok(notices.has(ref.sha256)); used.add(ref.sha256); }
  }
  assert.equal(used.size, notices.size, 'no orphan/unattributed license text');
  const files = new Set();
  for (const font of data.fonts) {
    assert.match(font.file, /^api\/kdoc-api\/ui-kit\/fonts\/[a-z0-9-]+\.woff2?$/);
    assert.match(font.sha256, /^[a-f0-9]{64}$/);
    assert.equal(files.has(font.file), false); files.add(font.file);
    const owner = data.components.find(c => c.name === font.component && c.version === font.version);
    assert.ok(owner && font.notices.length > 0);
    for (const ref of font.notices) assert.ok(owner.notices.some(n => n.sha256 === ref.sha256));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

const digest='a'.repeat(64);
const xml=(body,configuration='<verify-metadata>true</verify-metadata><verify-signatures>false</verify-signatures>')=>`<?xml version="1.0"?><verification-metadata><configuration>${configuration}</configuration><components>${body}</components></verification-metadata>`;
const component=`<component group="org.example" name="lib" version="1.0"><artifact name="lib-1.0.jar"><sha256 value="${digest}" origin="local discovery"/></artifact></component>`;
async function inspect(value) {
  const m=await import('../src/spring/dependency-lock.js').catch(()=>({}));
  assert.equal(typeof m.inspectSpringDependencyLock,'function');
  return m.inspectSpringDependencyLock(value);
}
test('extracts exact Gradle artifact checksums without treating observation as authentication',async()=>{
  const result=await inspect(xml(component));
  assert.deepEqual(result.artifacts,[{group:'org.example',name:'lib',version:'1.0',artifact:'lib-1.0.jar',sha256:digest}]);
  assert.equal(result.authenticated,false);
});
test('rejects trust bypasses, unpinned artifacts and ambiguous checksum alternatives',async()=>{
  for(const value of [
    xml(component,'<verify-metadata>false</verify-metadata>'),
    xml(component,'<verify-metadata>true</verify-metadata><trusted-artifacts><trust group=".*" regex="true"/></trusted-artifacts>'),
    xml(component.replace(/<sha256[^>]*\/>/,'')),
    xml(component.replace('/></artifact>',`><also-trust value="${'b'.repeat(64)}"/></sha256></artifact>`)),
    xml(component+component),
    xml(component.replace('version="1.0"','version="1.0-SNAPSHOT"')),
    xml(component.replace('group="org.example"','')),
    xml(component.replace('name="lib-1.0.jar"','')),
    xml(component,'<verify-metadata>true</verify-metadata><verify-metadata>false</verify-metadata>'),
    '<!DOCTYPE verification-metadata [<!ENTITY x SYSTEM "file:///tmp/a">]>'+xml(component),
  ])await assert.rejects(inspect(value),/lock|verification|checksum|duplicate|version|DOCTYPE/i);
});

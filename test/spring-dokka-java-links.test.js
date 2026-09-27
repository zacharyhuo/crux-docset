import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDokkaJavaMember } from '../src/spring/dokka-java-links.js';

const member = (anchor, kind = 'Method', page = 'org/example/Api.html') => ({ anchor, kind, page });
test('matches mapped Kotlin types against actual Java member candidates', () => {
  const wanted = member('get(java.lang.String)');
  assert.deepEqual(resolveDokkaJavaMember('get(kotlin.String)', [member('get(int)'), wanted]), wanted);
  assert.deepEqual(resolveDokkaJavaMember('size(kotlin.Int)', [member('size(int)')]), member('size(int)'));
  assert.equal(resolveDokkaJavaMember('missing(kotlin.String)', [wanted]), null);
});
test('erases well-formed nested DRI generics and a single bounded type parameter', () => {
  const wanted = member('body(org.reactivestreams.Publisher,java.lang.Class)');
  assert.deepEqual(resolveDokkaJavaMember('body(TypeParam(bounds=[org.reactivestreams.Publisher[TypeParam(bounds=[kotlin.Any])]]),java.lang.Class[TypeParam(bounds=[kotlin.Any])])', [wanted]), wanted);
  assert.deepEqual(resolveDokkaJavaMember('map(kotlin.collections.MutableMap[kotlin.String,kotlin.Any])', [member('map(java.util.Map)')]), member('map(java.util.Map)'));
});
test('uses verified array and varargs declarations without dropping overload ambiguity', () => {
  const bytes = member('content(byte[])'), varargs = member('accept(java.lang.String...)');
  assert.deepEqual(resolveDokkaJavaMember('content(kotlin.ByteArray)', [bytes]), bytes);
  assert.deepEqual(resolveDokkaJavaMember('accept(kotlin.String)', [varargs]), varargs);
  assert.equal(resolveDokkaJavaMember('accept(kotlin.String)', [varargs, member('accept(java.lang.String)')]), null);
  assert.equal(resolveDokkaJavaMember('size(kotlin.Int)', [member('size(int)'), member('size(java.lang.Integer)')]), null);
});
test('preserves declaring-class target supplied by verified inheritance inventory', () => {
  const inherited = member('content(byte[])', 'Method', 'org/example/Base.html');
  assert.deepEqual(resolveDokkaJavaMember('content(kotlin.ByteArray)', [inherited]), inherited);
  assert.equal(resolveDokkaJavaMember('content(kotlin.ByteArray)', [inherited, member('content(byte[])')]), null);
});
test('treats synthetic no-arg field references only as actual documented fields', () => {
  assert.deepEqual(resolveDokkaJavaMember('TEXT_HTML()', [member('TEXT_HTML', 'Constant')]), member('TEXT_HTML', 'Constant'));
  assert.equal(resolveDokkaJavaMember('TEXT_HTML()', [member('TEXT_HTML', 'Class')]), null);
  assert.deepEqual(resolveDokkaJavaMember('size()', [member('size()'), member('size', 'Field')]), member('size()'));
});
test('does not repair malformed or unsupported DRI signatures', () => {
  for (const value of ['get(java.lang.Class[)', 'get(TypeParam(bounds=[]))', 'get(TypeParam(bounds=[A,B]))', 'get(kotlin.String)junk', 'get(kotlin.String,,kotlin.Int)', 'get(../../x)', 'get(java.lang.Class['.repeat(1000)]) {
    assert.equal(resolveDokkaJavaMember(value, [member('get(java.lang.String)')]), null);
  }
});
test('rejects invalid inventory entries and bounds input before resolution', () => {
  for (const candidate of [member('get()', 'Method', '../Api.html'), member('get()', 'Method', 'https://host/Api.html'), member('bad\u0000'), { anchor: 'get()' }]) {
    assert.throws(() => resolveDokkaJavaMember('get()', [candidate]), /inventory/i);
  }
  assert.throws(() => resolveDokkaJavaMember('get()', new Array(10001).fill(member('get()'))), /limit/i);
});

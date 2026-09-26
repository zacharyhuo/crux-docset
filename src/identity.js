import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/;
const identityKeys = ['sourceId', 'familyId', 'variantId', 'versionLine', 'language', 'identifier', 'bundleName'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function fingerprint(input) {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function recipeIdentity(recipe) {
  for (const key of identityKeys) {
    if (typeof recipe[key] !== 'string' || !recipe[key] || recipe[key].length > 512 || /[\x00-\x1f]/.test(recipe[key])) throw new Error(`Invalid recipe identity: ${key}`);
  }
  if (recipe.schemaVersion !== 2 || recipe.id !== recipe.familyId || !ID.test(recipe.familyId) || !ID.test(recipe.variantId) || !recipe.variantId.startsWith(`${recipe.familyId}-`) || recipe.language !== 'en' || !/^[A-Za-z0-9_-]+$/.test(recipe.bundleName)) throw new Error('Invalid recipe identity');
  if (recipe.versionLine !== 'current' && !VERSION.test(recipe.versionLine)) throw new Error('Invalid version line');
  return Object.fromEntries(identityKeys.map(key => [key, recipe[key]]));
}

export function assertIdentity(record, identity) {
  for (const key of identityKeys) if (record[key] !== identity[key]) throw new Error(`Build owner/identity mismatch: ${key}`);
}

export function assertVersionLine(version, recipe) {
  if (!VERSION.test(version) || !version.split('.').every(n => Number.isSafeInteger(Number(n)))) throw new Error('Only stable numeric document versions are supported');
  if (recipe.versionLine === 'current') throw new Error('Snapshot version policy is not implemented for this adapter');
  if (version !== recipe.versionLine && !version.startsWith(`${recipe.versionLine}.`)) throw new Error(`Document version ${version} is outside version line ${recipe.versionLine}`);
}

export function rejectDowngrade(previous, next) {
  for (const version of [previous, next].filter(v => v !== undefined)) {
    if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('Only stable numeric document versions are supported');
  }
  if (!previous) return;
  const a = previous.split('.').map(Number), b = next.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) < (a[i] ?? 0)) throw new Error(`Automatic downgrade rejected: ${previous} -> ${next}`);
    if ((b[i] ?? 0) > (a[i] ?? 0)) return;
  }
}

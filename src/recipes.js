import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { hasAdapter } from './adapters.js';

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const variantKeys = new Set(['variantId', 'versionLine', 'language', 'enabled', 'source', 'builder', 'validation', 'limits']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkId(value, label) {
  if (typeof value !== 'string' || value.length > 100 || !idPattern.test(value)) throw new Error(`Invalid ${label}`);
}

async function readJSON(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Expected bounded regular file, not symlink: ${file}`);
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!object(value)) throw new Error(`Expected JSON object: ${file}`);
  return value;
}

async function readBase(file) {
  const base = await readJSON(file);
  if (base.schemaVersion === 1 && base.id === 'python' && base.identifier === 'dev.crux.python' && base.bundleName === 'Python') {
    // A reviewed compatibility mapping, never inferred from a mutable remote version.
    return { ...base, schemaVersion: 2, sourceId: 'dev.crux', defaultVariant: 'python-3-14-en', legacyPython: true };
  }
  if (base.schemaVersion !== 2) throw new Error('Unsupported recipe schema');
  checkId(base.id, 'family id');
  checkId(base.defaultVariant, 'default variant id');
  if (!/^[A-Za-z0-9_-]+$/.test(base.bundleName ?? '')) throw new Error('Invalid bundle name');
  for (const key of ['sourceId', 'identifier', 'name', 'homepage']) {
    if (typeof base[key] !== 'string' || !base[key].trim() || base[key].length > 512 || /[\x00-\x1f]/.test(base[key])) throw new Error(`Invalid recipe ${key}`);
  }
  if (!object(base.source) || !object(base.builder) || typeof base.builder.adapter !== 'string') throw new Error('Invalid recipe source or builder');
  return base;
}

async function readVariant(directory, base, variantId) {
  checkId(variantId, 'variant id');
  if (!variantId.startsWith(`${base.id}-`)) throw new Error('Variant belongs to another family');
  if (base.legacyPython && variantId === 'python-3-14-en') return {
    variantId, versionLine: '3.14', language: 'en', enabled: true,
    source: { discoveryUrl: 'https://docs.python.org/3.14/download.html', strategy: 'stable-line-official-html' }
  };
  const variantsDirectory = path.join(directory, 'variants');
  const stat = await lstat(variantsDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Variant directory must not be a symlink');
  const variant = await readJSON(path.join(variantsDirectory, `${variantId}.json`));
  for (const key of Object.keys(variant)) if (!variantKeys.has(key)) throw new Error(`Unknown variant override: ${key}`);
  if (variant.variantId !== variantId) throw new Error('Variant identity mismatch');
  if (typeof variant.versionLine !== 'string' || !/^(?:\d+(?:\.\d+){0,3}|current)$/.test(variant.versionLine)) throw new Error('Invalid version line');
  if (variant.language !== 'en') throw new Error('Only English variants are enabled');
  if (typeof variant.enabled !== 'boolean') throw new Error('Variant enabled must be boolean');
  for (const key of ['source', 'builder', 'validation', 'limits']) {
    if (variant[key] !== undefined && !object(variant[key])) throw new Error(`Invalid variant ${key}`);
  }
  return variant;
}

function effective(base, variant) {
  const recipe = { ...base, familyId: base.id, variantId: variant.variantId, versionLine: variant.versionLine, language: variant.language };
  delete recipe.legacyPython;
  delete recipe.defaultVariant;
  for (const key of ['source', 'builder', 'validation', 'limits']) {
    if (base[key] || variant[key]) recipe[key] = { ...base[key], ...variant[key] };
  }
  return recipe;
}

export async function loadRecipe({ root, id, recipePath, variantId, work } = {}) {
  if (id !== undefined && recipePath !== undefined) throw new Error('--id and --recipe cannot be used together');
  root = path.resolve(root ?? '.');
  if (!recipePath) checkId(id ?? 'python', 'family id');
  const file = recipePath ? path.resolve(recipePath) : path.join(root, 'recipes', id ?? 'python', 'recipe.json');
  const base = await readBase(file);
  if (!recipePath && base.id !== (id ?? 'python')) throw new Error('Family identity mismatch');
  const directory = path.dirname(file);
  const variant = await readVariant(directory, base, variantId ?? base.defaultVariant);
  if (!variant.enabled) throw new Error(`Variant is disabled: ${variant.variantId}`);
  const legacy = base.id === 'python' && variant.variantId === 'python-3-14-en' && base.identifier === 'dev.crux.python' && base.bundleName === 'Python';
  return { recipe: effective(base, variant), recipeDirectory: directory, work: work ? path.resolve(work) : path.join(root, '.work', legacy ? 'python' : variant.variantId) };
}

export async function listRecipes({ root = '.' } = {}) {
  const rows = [];
  const directory = path.join(path.resolve(root), 'recipes');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const recipeDirectory = path.join(directory, entry.name);
    const base = await readBase(path.join(recipeDirectory, 'recipe.json'));
    if (entry.name !== base.id) throw new Error('Family identity mismatch');
    const variants = base.legacyPython ? [base.defaultVariant] : (await readdir(path.join(recipeDirectory, 'variants'))).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort();
    for (const id of variants) {
      const variant = await readVariant(recipeDirectory, base, id);
      const adapter = variant.builder?.adapter ?? base.builder.adapter;
      const implemented = hasAdapter(adapter);
      rows.push({ familyId: base.id, variantId: id, versionLine: variant.versionLine, language: variant.language, enabled: variant.enabled, isDefault: id === base.defaultVariant, adapter, implemented, buildable: variant.enabled && implemented });
    }
  }
  return rows;
}

// Hash every file under the selected implementation roots, including nested templates.
export async function hashBuildInputs(root, inputs) {
  const hashes = {};
  async function visit(relative) {
    const file = path.join(root, relative), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Build input must not be a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hashes[relative.split(path.sep).join('/')] = createHash('sha256').update(await readFile(file)).digest('hex');
    } else throw new Error(`Build input must be regular: ${relative}`);
  }
  for (const input of [...inputs].sort()) await visit(input);
  return hashes;
}

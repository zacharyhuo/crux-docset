import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadRecipe, listRecipes } from '../src/recipes.js';
import { loadRecipeIcons } from '../src/icons.js';
import { resolveEnabledVariants } from '../src/version-matrix.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Spring assets load offline but its unqualified variant cannot build or enter the matrix', async () => {
  const row = (await listRecipes({ root })).find(r => r.variantId === 'spring-framework-7-0-en');
  assert.ok(row, 'Spring recipe is discoverable');
  assert.equal(row.enabled, false); assert.equal(row.buildable, false);
  assert.equal(row.implemented, true);
  assert.equal((await resolveEnabledVariants({ root })).some(r => r.familyId === 'spring-framework'), false);
  await assert.rejects(loadRecipe({ root, id: 'spring-framework' }), /disabled/i);
  const icons = await loadRecipeIcons(fileURLToPath(new URL('../recipes/spring-framework/', import.meta.url)));
  assert.deepEqual(Object.keys(icons).sort(), ['icon.png', 'icon@2x.png']);
});

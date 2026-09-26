import { listRecipes, loadRecipe } from './recipes.js';

// Scheduling is repository-configured, not discovered from arbitrary upstream
// tags. Exact source digests are resolved later inside each variant's lock.
export async function resolveEnabledVariants({ root = '.', id } = {}) {
  const listed = await listRecipes({ root });
  if (id !== undefined && !listed.some(row => row.familyId === id)) throw new Error(`Unknown family: ${id}`);
  const selected = listed.filter(row => row.buildable && (id === undefined || row.familyId === id));
  const rows = [];
  for (const row of selected) {
    const { recipe, work } = await loadRecipe({ root, id: row.familyId, variantId: row.variantId });
    rows.push({ familyId: row.familyId, variantId: row.variantId, versionLine: row.versionLine,
      language: row.language, source: recipe.source, builder: recipe.builder, limits: recipe.limits, work });
  }
  return rows;
}

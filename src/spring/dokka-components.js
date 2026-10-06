import path from 'node:path';

// Webpack's identifier includes build-time loaders; nameForCondition identifies
// the resource actually emitted. Concatenated children inherit their chunk.
export function dokkaComponentPaths(stats, { root }) {
  if (stats.errors?.length) throw new Error('Webpack build failed');
  if (!path.isAbsolute(root) || !Array.isArray(stats.modules)) {
    throw new Error('Expected absolute build root and Webpack modules');
  }
  const packages = new Set();
  function visit(modules, inherited = false) {
    for (const module of modules) {
      const emitted = inherited || Boolean(module.chunks?.length);
      if (!emitted) continue;
      if (module.nameForCondition) {
        const relative = path.relative(root, module.nameForCondition);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Emitted resource outside build root: ${module.nameForCondition}`);
        }
        const parts = relative.split(path.sep);
        const index = parts.lastIndexOf('node_modules');
        if (index >= 0 && parts[index + 1]) {
          const end = index + (parts[index + 1].startsWith('@') ? 3 : 2);
          packages.add(parts.slice(0, end).join('/'));
        }
      }
      if (module.modules) visit(module.modules, emitted);
    }
  }
  visit(stats.modules);
  return [...packages].sort();
}

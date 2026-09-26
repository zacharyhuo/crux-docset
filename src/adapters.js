import { pythonAdapter } from './adapters/python.js';

// Reviewed repository code only. Recipes cannot import modules or supply shell commands.
const adapters = new Map([['python-intersphinx', pythonAdapter]]);

export function hasAdapter(name) { return adapters.has(name); }

export function getAdapter(name) {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unsupported adapter: ${name}`);
  return adapter;
}

import { pythonAdapter } from './adapters/python.js';
import { goAdapter } from './adapters/go.js';
import { springAdapter } from './adapters/spring.js';

// Reviewed repository code only. Recipes cannot import modules or supply shell commands.
const adapters = new Map([['python-intersphinx', pythonAdapter], ['go-pkgsite', goAdapter], ['spring-framework', springAdapter]]);

export function hasAdapter(name) { return adapters.has(name); }

export function getAdapter(name) {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unsupported adapter: ${name}`);
  return adapter;
}

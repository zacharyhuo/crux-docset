/** Parse Dokka's generated source-set assignment as data, never execute it.
 * This profile covers Spring main source sets only. Renderer/source provenance
 * and the correspondence to generated module pages belong to the caller.
 */
export function readSpringKotlinDependencies(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('Invalid Kotlin dependencies text');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Kotlin dependencies input limit');
  const source = text.trim(), prefix = "sourceset_dependencies = '";
  if (!source.startsWith(prefix) || !source.endsWith("'")) throw new Error('Invalid Kotlin dependencies wrapper');
  const json = source.slice(prefix.length, -1);
  // Pinned Dokka emits a compact JSON string inside a single-quoted JS string.
  // No JSON or JS escaping is needed for this profile's source-set identifiers.
  if (/[\\'\r\n]/.test(json)) throw new Error('Unsupported Kotlin dependencies escaping');
  let graph;
  try { graph = JSON.parse(json); } catch { throw new Error('Invalid Kotlin dependencies JSON'); }
  if (!graph || Array.isArray(graph) || typeof graph !== 'object' || JSON.stringify(graph) !== json) throw new Error('Noncanonical/duplicate Kotlin dependencies data');
  const entries = Object.entries(graph);
  if (!entries.length || entries.length > 64) throw new Error('Kotlin source-set count limit');
  const validName = name => typeof name === 'string' && name.length <= 256 && /^:spring-[a-z0-9]+(?:-[a-z0-9]+)*\/main$/.test(name);
  for (const [name, dependencies] of entries) {
    if (!validName(name) || !Array.isArray(dependencies) || dependencies.length > 64) throw new Error('Invalid Kotlin source-set shape/limit');
    const seen = new Set();
    for (const dependency of dependencies) {
      if (!validName(dependency) || dependency === name || !Object.hasOwn(graph, dependency) || seen.has(dependency)) throw new Error('Invalid Kotlin source-set dependency');
      seen.add(dependency);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error('Cyclic Kotlin source-set dependencies');
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph[name]) visit(dependency);
    visiting.delete(name); visited.add(name);
  }
  for (const [name] of entries) visit(name);
  return entries.map(([sourceSet, dependencies]) => ({ sourceSet, dependencies }));
}

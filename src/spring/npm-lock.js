/** No installation or registry lookup: detect incomplete upstream renderer locks
 * before they are used as reproducibility evidence. */
export function inspectSpringNpmLock(lock) {
  const fail = () => { throw new Error('Incomplete or unsupported Spring npm lock'); };
  if (lock?.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) fail();
  let packages = 0;
  for (const [file, entry] of Object.entries(lock.packages)) {
    if (!file) continue;
    if (!/^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/.test(file) ||
        entry.link || typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.version) ||
        typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) fail();
    let url;
    try { url = new URL(entry.resolved); } catch { fail(); }
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.hash || url.search || !url.pathname.endsWith('.tgz')) fail();
    packages++;
  }
  if (!packages || packages > 10000) fail();
  return { packages };
}

import { spawn, execFileSync } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read numeric ancestry and birth identity only, never process arguments/env.
// Gradle's single-use daemon creates its own session, outside the wrapper group.
function processTable() {
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 ** 2, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), birth: match[3] }] : [];
  });
}
function descendants(root, table) {
  const owned = new Set([root]), result = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const row of table) if (!owned.has(row.pid) && owned.has(row.parent)) {
      owned.add(row.pid); result.push(row); changed = true;
    }
  }
  return result.reverse();
}

/** Internal runner for repository-owned argument lists; never used as a recipe
 * shell escape. Caller must supply a fresh private cwd and explicit environment.
 */
export async function runSpringCommand({ command, args, cwd, env, stage, timeoutMs = 900000, maxBytes = 8 * 1024 ** 2 }) {
  if (!path.isAbsolute(command) || !path.isAbsolute(cwd) || !Array.isArray(args) || args.some(x => typeof x !== 'string') ||
      !env || typeof env !== 'object' || !/^[a-z][a-z0-9-]{0,63}$/.test(stage) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 8 * 1024 ** 2) throw new Error('Invalid Spring command boundary');
  const logFile = await open(path.join(cwd, stage + '.log'), 'wx', 0o600);
  const start = performance.now(), chunks = [];
  let child, fatal, cleanup, timer, size = 0, code = null;
  const stop = signal => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    // Output callbacks can arrive after a short-lived command has already
    // disappeared. macOS may report EPERM, not ESRCH, for its vanished group.
    try {
      if (processTable().some(row => row.pid === child.pid)) process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') fatal = `${fatal ?? 'stop failed'}; ${error.message}`; }
  };
  const fail = message => {
    if (fatal) return;
    fatal = message;
    let owned = [];
    try { if (child?.pid && child.exitCode === null && child.signalCode === null) owned = descendants(child.pid, processTable()); }
    catch (error) { fatal += `; descendant inventory failed: ${error.message}`; }
    const signalOwned = signal => {
      if (!owned.length) return;
      const current = new Map(processTable().map(row => [row.pid, row]));
      for (const row of owned) if (current.get(row.pid)?.birth === row.birth) {
        try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    try { signalOwned('SIGTERM'); } catch (error) { fatal += `; descendant stop failed: ${error.message}`; }
    stop('SIGTERM');
    // Await the full cleanup even if the wrapper exits first. Never SIGCONT a
    // stopped executable; the hard-stop also handles suspended descendants.
    cleanup = new Promise(resolve => setTimeout(() => {
      try { signalOwned('SIGKILL'); stop('SIGKILL'); }
      catch (error) { fatal += `; descendant cleanup failed: ${error.message}`; }
      resolve();
    }, 2000));
  };
  try {
    child = spawn(command, args, { cwd, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (fatal) return;
      if (size + chunk.length > maxBytes) return fail('output limit');
      size += chunk.length; chunks.push(chunk);
    });
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } catch (error) { fatal = String(error.message).slice(0, 4096); }
  finally {
    clearTimeout(timer);
    if (cleanup) await cleanup;
    if (fatal) stop('SIGKILL');
    try { await logFile.writeFile(Buffer.concat(chunks)); } finally { await logFile.close(); }
  }
  const report = { stage, code, fatal, passed: code === 0 && !fatal, seconds: (performance.now() - start) / 1000 };
  await writeFile(path.join(cwd, stage + '-result.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  if (!report.passed) throw new Error(`Spring ${stage} failed (${fatal ?? code}); see ${stage}.log`);
  return report;
}

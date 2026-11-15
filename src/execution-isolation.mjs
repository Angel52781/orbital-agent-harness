import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export async function canonicalWriteScopes(workspaceRoot, scopes = []) {
  const root = await fs.realpath(workspaceRoot);
  const resolved = await Promise.all(scopes.map(async (scope) => {
    const target = path.resolve(root, scope);
    const existing = await existingAncestor(target);
    // A future child of an already-existing symlink still resolves through
    // that symlink. Reconstruct it from the canonical ancestor, not the raw
    // path, or two spellings of one future write scope would evade conflict.
    // A dangling symlink fails closed because realpath(existing) rejects it.
    const ancestor = await fs.realpath(existing);
    if (!inside(ancestor, root)) throw new Error('execution-isolation:scope-outside-workspace');
    let canonical;
    try {
      canonical = await fs.realpath(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      canonical = path.resolve(ancestor, path.relative(existing, target));
    }
    // An existing symlink may resolve outside the original workspace even
    // though its nearest ancestor was inside it. Never lease that escape.
    if (!inside(canonical, root)) throw new Error('execution-isolation:scope-outside-workspace');
    return canonical;
  }));
  return [...new Set(resolved)].sort();
}

async function existingAncestor(target) {
  let current = target;
  while (true) {
    try { await fs.lstat(current); return current; } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function scopesConflict(left, right) {
  return left.some((a) => right.some((b) => inside(a, b) || inside(b, a)));
}

async function readLease(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteLease(file, value) {
  // A killed worker must not leave a truncated JSON lease that makes every
  // later acquisition fail to parse. Publish from a same-directory temp file
  // only after the complete bytes have been written.
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function activeConflict(directory, ignoredFile, scopes) {
  const names = await fs.readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const candidate = path.join(directory, name);
    if (candidate === ignoredFile) continue;
    const lease = await readLease(candidate);
    // Identical run IDs from DIFFERENT children are not an isolation
    // exemption. The exact same-process replay is checked separately below.
    if (lease && !lease.released && ownerAlive(lease) && scopesConflict(scopes, lease.scopes ?? [])) return lease;
  }
  return null;
}

function pidStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  try {
    // /proc/<pid>/stat field 22 is process start time; after the final ')'
    // (the command name may contain spaces) the third field starts at index 0.
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

function ownerAlive(lease) {
  if (!Number.isInteger(lease?.pid) || lease.pid <= 0) return false;
  try {
    process.kill(lease.pid, 0);
    const currentStart = pidStartTicks(lease.pid);
    // A recycled PID belongs to a different process. Never treat its
    // existence alone as proof that the old lease owner is still alive.
    return !lease.pidStartTicks || !currentStart || lease.pidStartTicks === currentStart;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function acquireExecutionLease({
  stateDir, runId, principal, workspaceRoot, writeScopes, allowIdempotent = false
}) {
  const scopes = await canonicalWriteScopes(workspaceRoot, writeScopes);
  const key = digest(JSON.stringify({ workspaceRoot: await fs.realpath(workspaceRoot), scopes }));
  const file = path.join(stateDir, 'execution-leases', `${key}.json`);
  const lock = `${file}.lock`;
  const directory = path.dirname(file);
  const registryLock = path.join(directory, '.acquire.lock');
  // Do not request setgid on an unprivileged sandbox filesystem (/tmp may
  // reject it with EPERM); the shared state parent already owns group policy.
  await fs.mkdir(directory, { recursive: true, mode: 0o770 });
  try {
    await fs.mkdir(registryLock, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // A process crash may leave only the short-lived registry lock behind.
    // Reclaim a demonstrably stale lock, not a running worker lease.
    const stat = await fs.stat(registryLock).catch((cause) => cause.code === 'ENOENT' ? null : Promise.reject(cause));
    if (!stat || Date.now() - stat.mtimeMs < 60_000) {
      return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_ACQUIRE_BUSY' };
    }
    const stale = `${registryLock}.stale.${process.pid}.${crypto.randomUUID()}`;
    try {
      await fs.rename(registryLock, stale);
      await fs.rm(stale, { recursive: true, force: true });
      await fs.mkdir(registryLock, { mode: 0o700 });
    } catch (cause) {
      return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_RECOVERY_RACE' };
    }
  }
  try {
    let existing = await readLease(file);
    if (existing && !existing.released && ownerAlive(existing)) {
      // Same PID and run ID do not prove same operation: two work graphs can
      // run concurrently within one Node process. Only explicit inspection
      // callers may request an idempotent lease; real runner never does.
      if (allowIdempotent && existing.runId === runId && existing.pid === process.pid
          && (!existing.pidStartTicks || existing.pidStartTicks === pidStartTicks(process.pid))) {
        return { ok: true, file, lease: existing, idempotent: true };
      }
      return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_HELD', holder: { runId: existing.runId, principal: existing.principal, fence: existing.fence } };
    }
    const conflict = await activeConflict(directory, file, scopes);
    if (conflict) return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_HELD', holder: { runId: conflict.runId, principal: conflict.principal, fence: conflict.fence } };
    try { await fs.mkdir(lock, { mode: 0o700 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      existing = await readLease(file);
      if (allowIdempotent && existing?.runId === runId && existing.pid === process.pid
          && !existing?.released && ownerAlive(existing)) {
        return { ok: true, file, lease: existing, idempotent: true };
      }
      if (!existing?.released && ownerAlive(existing)) return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_HELD', holder: { runId: existing?.runId ?? null, principal: existing?.principal ?? null, fence: existing?.fence ?? null } };
      const quarantine = `${lock}.stale.${process.pid}.${crypto.randomUUID()}`;
      try { await fs.rename(lock, quarantine); } catch { return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_RECOVERY_RACE' }; }
      await fs.rm(quarantine, { recursive: true, force: true });
      try { await fs.mkdir(lock, { mode: 0o700 }); } catch { return { ok: false, reasonCode: 'WRITE_SCOPE_LEASE_RECOVERY_RACE' }; }
    }
    const fence = (existing?.fence ?? 0) + 1;
    const lease = {
      schema: 'orbital.execution-lease.v1',
      runId, principal, pid: process.pid, pidStartTicks: pidStartTicks(process.pid),
      fence, scopes, released: false, createdAt: new Date().toISOString()
    };
    await atomicWriteLease(file, lease);
    return { ok: true, file, lease, recoveredStaleLease: Boolean(existing && !existing.released) };
  } finally {
    await fs.rm(registryLock, { recursive: true, force: true });
  }
}

export async function releaseExecutionLease({ file, stateDir, workspaceRoot, writeScopes, runId, fence }) {
  let targetFile = file;
  if (!targetFile && stateDir && workspaceRoot && writeScopes) {
    const scopes = await canonicalWriteScopes(workspaceRoot, writeScopes);
    const key = digest(JSON.stringify({ workspaceRoot: await fs.realpath(workspaceRoot), scopes }));
    targetFile = path.join(stateDir, 'execution-leases', `${key}.json`);
  }
  if (!targetFile) return { ok: true };
  const directory = path.dirname(targetFile);
  const registryLock = path.join(directory, '.acquire.lock');
  // Use the very same registry mutex for release and acquisition. Otherwise
  // one process could read an old lease, await I/O, then mark a newly acquired
  // fencing token released after another process replaces the lease file.
  let locked = false;
  for (let tries = 0; tries < 100 && !locked; tries += 1) {
    try {
      await fs.mkdir(registryLock, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!locked) return { ok: false, released: false, reasonCode: 'LEASE_RELEASE_REGISTRY_BUSY' };
  try {
    const lease = await readLease(targetFile);
    if (!lease) return { ok: true, released: false, reasonCode: 'LEASE_ABSENT' };
    if (lease.runId !== runId || (fence !== undefined && lease.fence !== fence)) {
      return { ok: false, released: false, reasonCode: 'LEASE_FENCE_MISMATCH' };
    }
    if (lease.released) return { ok: true, released: false, reasonCode: 'LEASE_ALREADY_RELEASED' };
    await atomicWriteLease(targetFile, { ...lease, released: true, releasedAt: new Date().toISOString() });
    await fs.rm(`${targetFile}.lock`, { recursive: true, force: true });
    return { ok: true, released: true };
  } finally {
    await fs.rm(registryLock, { recursive: true, force: true });
  }
}

export function snapshotBarrier({ sourceSha256, artifactDigest, fence }) {
  if (![sourceSha256, artifactDigest].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))) {
    throw new Error('execution-isolation:invalid-snapshot');
  }
  if (!Number.isInteger(fence) || fence < 1) throw new Error('execution-isolation:invalid-fence');
  return Object.freeze({ schema: 'orbital.qa-snapshot.v1', sourceSha256, artifactDigest, fence });
}

export function verifySnapshotBarrier(expected, observed) {
  if (!expected || !observed) return { ok: false, reasonCode: 'QA_SNAPSHOT_MISSING' };
  if (expected.sourceSha256 !== observed.sourceSha256) {
    return { ok: false, reasonCode: 'QA_SNAPSHOT_DRIFT', detail: { field: 'sourceSha256', expected: expected.sourceSha256, observed: observed.sourceSha256 } };
  }
  if (expected.artifactDigest !== observed.artifactDigest) {
    return { ok: false, reasonCode: 'QA_SNAPSHOT_DRIFT', detail: { field: 'artifactDigest', expected: expected.artifactDigest, observed: observed.artifactDigest } };
  }
  if (expected.fence !== observed.fence) {
    return { ok: false, reasonCode: 'QA_SNAPSHOT_DRIFT', detail: { field: 'fence', expected: expected.fence, observed: observed.fence } };
  }
  return { ok: true };
}

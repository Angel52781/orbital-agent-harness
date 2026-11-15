import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRequiredDomainVerdict } from './binding-verdict.mjs';
import { verifyAttestedArtifact } from './attested-artifacts.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function atomicMarkerWrite(marker, bytes) {
  const directory = path.dirname(marker);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(marker)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, marker);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function prepareMarkerTransition(markers) {
  const targets = Array.isArray(markers) ? markers : [markers];
  const entries = await Promise.all(targets.map(async (marker) => {
    const resolved = path.resolve(marker);
    const previous = await fs.readFile(resolved).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    return {
      marker: resolved,
      previous: previous?.toString('base64') ?? null,
      previousSha256: previous ? sha(previous) : null
    };
  }));

  return {
    schema: 'orbital.release-transition.v1',
    marker: entries[0].marker,
    previous: entries[0].previous,
    previousSha256: entries[0].previousSha256,
    entries
  };
}

export async function activateMarkerTransition(manifest, value) {
  const entries = manifest.entries ?? [{ marker: manifest.marker, previous: manifest.previous, previousSha256: manifest.previousSha256 }];
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const targetSha = sha(valueBytes);

  for (const entry of entries) {
    const current = await fs.readFile(entry.marker).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const currentSha = current ? sha(current) : null;
    if (currentSha === targetSha) {
      entry.alreadyActive = true;
    } else if (currentSha !== entry.previousSha256) {
      throw new Error(`release-transition:marker-drift:${entry.marker}`);
    }
  }
  // Post-state for compare-and-restore. Without this hash, rollback could
  // erase a different writer's newer marker after a late verification error.
  manifest.targetSha256 = targetSha;

  const activated = [];
  try {
    for (const entry of entries) {
      await atomicMarkerWrite(entry.marker, valueBytes);
      activated.push(entry);
      const verify = await fs.readFile(entry.marker);
      if (sha(verify) !== targetSha) {
        throw new Error(`release-transition:verification-failed:${entry.marker}`);
      }
    }
  } catch (error) {
    try {
      await compensateMarkerTransition(manifest);
    } catch (compensationError) {
      throw new AggregateError([error, compensationError], 'release-transition:activation-and-compensation-failed');
    }
    throw error;
  }

  return {
    ok: true,
    postSha256: targetSha,
    activatedMarkers: entries.map((e) => e.marker),
    idempotentReplay: entries.every((e) => e.alreadyActive)
  };
}

export async function compensateMarkerTransition(manifest) {
  const entries = manifest.entries ?? [{ marker: manifest.marker, previous: manifest.previous, previousSha256: manifest.previousSha256 }];
  if (!manifest.targetSha256) throw new Error('release-transition:compensation-target-missing');
  // Validate ALL aliases before any change: an external writer can publish a
  // newer marker while a prior transition fails. Never erase that evidence.
  for (const entry of entries) {
    const current = await fs.readFile(entry.marker).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const currentSha = current ? sha(current) : null;
    if (currentSha !== manifest.targetSha256 && currentSha !== entry.previousSha256) {
      throw new Error(`release-transition:compensation-drift:${entry.marker}`);
    }
  }
  for (const entry of entries) {
    if (entry.previous === null) {
      await fs.rm(entry.marker, { force: true });
    } else {
      await atomicMarkerWrite(entry.marker, Buffer.from(entry.previous, 'base64'));
    }
  }
  return { ok: true, compensated: true, status: 'ROLLBACK_COMPENSATED' };
}

/**
 * The only high-level marker-activation entrypoint for audited work.
 * prepare/activate/compensate are low-level reversible primitives; callers
 * must not treat a wrapper PASS or a model-provided SHA as release authority.
 */
export async function activateAttestedRelease({
  manifest, payload, qaResult, releaseResult, executionRoot,
  hostGuardMarker, validateActivated
} = {}) {
  const qa = validateRequiredDomainVerdict(qaResult, 'auditVerdict', 'QA_GO');
  if (!qa.ok) return { ok: false, reasonCode: 'RELEASE_QA_NOT_APPROVED', detail: qa.reasonCode };
  const evidence = qa.evidence;
  if (!evidence.qa_report_ref || typeof evidence.qa_report_ref !== 'string') {
    return { ok: false, reasonCode: 'RELEASE_QA_ARTIFACT_REQUIRED' };
  }
  const artifact = await verifyAttestedArtifact({
    path: evidence.qa_report_ref,
    sha256: evidence.qa_report_sha256 ?? evidence.artifactDigest
  }, { executionRoot });
  if (!artifact.ok) return { ok: false, reasonCode: artifact.reasonCode };
  if (artifact.sha256 !== evidence.artifactDigest) {
    return { ok: false, reasonCode: 'RELEASE_QA_ARTIFACT_BINDING_DRIFT' };
  }
  let report;
  try { report = JSON.parse(artifact.bytes); } catch {
    return { ok: false, reasonCode: 'RELEASE_QA_REPORT_INVALID' };
  }
  if (report.auditVerdict !== 'QA_GO') {
    return { ok: false, reasonCode: 'RELEASE_QA_REPORT_NOT_APPROVED' };
  }
  if (!Array.isArray(report.verified_source_allowlist) || report.verified_source_allowlist.length === 0) {
    return { ok: false, reasonCode: 'RELEASE_SOURCE_PROOF_ABSENT' };
  }
  const release = validateRequiredDomainVerdict(releaseResult, 'releaseVerdict', 'PASS', {
    snapshot: {
      sourceSha256: evidence.sourceSha256 ?? evidence.signed_hashes_digest_sha256,
      artifactDigest: artifact.sha256
    }
  });
  if (!release.ok) return { ok: false, reasonCode: 'RELEASE_REVIEW_NOT_APPROVED', detail: release.reasonCode };
  if (!manifest || !Array.isArray(manifest.entries) || !hostGuardMarker
      || !manifest.entries.some((entry) => entry.marker === path.resolve(hostGuardMarker))) {
    return { ok: false, reasonCode: 'RELEASE_HOST_GUARD_PATH_MISMATCH' };
  }
  if (typeof validateActivated !== 'function') {
    return { ok: false, reasonCode: 'RELEASE_POSTVALIDATOR_REQUIRED' };
  }
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''));
  if (!bytes.length) return { ok: false, reasonCode: 'RELEASE_MARKER_PAYLOAD_EMPTY' };
  let result;
  try {
    result = await activateMarkerTransition(manifest, bytes);
    const validated = await validateActivated({
      manifest, artifact: { path: artifact.path, sha256: artifact.sha256 },
      report, expectedMarkerSha256: result.postSha256
    });
    if (validated !== true && validated?.ok !== true) {
      const rollback = await compensateMarkerTransition(manifest);
      return { ok: false, reasonCode: 'RELEASE_POSTVALIDATION_FAILED', rollback };
    }
    return {
      ...result, qaVerdict: 'QA_GO', releaseVerdict: 'PASS',
      qaArtifactSha256: artifact.sha256,
      verifiedSourceAllowlist: report.verified_source_allowlist,
      hostGuardMarker: path.resolve(hostGuardMarker)
    };
  } catch (error) {
    let rollback = null;
    if (manifest.targetSha256) {
      try { rollback = await compensateMarkerTransition(manifest); } catch (cause) {
        return { ok: false, reasonCode: 'RELEASE_ROLLBACK_DRIFT', error: String(error), rollbackError: String(cause) };
      }
    }
    return { ok: false, reasonCode: 'RELEASE_ATOMIC_TRANSITION_FAILED', error: String(error), rollback };
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateEvidenceResult } from './result-contracts.mjs';

const SHA256 = /^[a-f0-9]{64}$/i;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function pythonJsonString(value) {
  // Match Python json.dumps(..., sort_keys=True) default ensure_ascii=True for
  // the string-only signed-hash map contract used by domain QA reports.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => (
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

function signedHashMapDigest(map) {
  const canonical = `{${Object.keys(map).sort().map((key) => (
    `${pythonJsonString(key)}: ${pythonJsonString(map[key])}`
  )).join(', ')}}`;
  return sha256(Buffer.from(canonical, 'utf8'));
}

async function workspaceRegularFile(workspaceRoot, relative, missingReason) {
  if (!workspaceRoot || typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) {
    return rejected(missingReason, { path: relative ?? null });
  }
  const root = await fs.realpath(workspaceRoot);
  const candidate = path.resolve(root, relative);
  if (!within(candidate, root)) return rejected('QA_SIGNED_FILE_OUTSIDE_WORKSPACE', { path: relative });
  const info = await fs.lstat(candidate).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) return rejected(missingReason, { path: relative });
  const real = await fs.realpath(candidate);
  if (!within(real, root)) return rejected('QA_SIGNED_FILE_OUTSIDE_WORKSPACE', { path: relative });
  return { ok: true, root, real, bytes: await fs.readFile(real) };
}

async function validateSignedHashEvidence(body, { workspaceRoot } = {}) {
  const manifestPath = body?.signed_hashes_manifest_path;
  let map = body?.signed_source_and_test_hashes;
  let declared = body?.signed_hashes_digest_sha256;
  let manifest = null;
  if (manifestPath !== undefined) {
    if (map !== undefined) return rejected('QA_SIGNED_HASHES_MULTIPLE_AUTHORITIES');
    const physical = await workspaceRegularFile(
      workspaceRoot,
      manifestPath,
      'QA_SIGNED_HASHES_MANIFEST_MISSING_OR_UNSAFE'
    );
    if (!physical.ok) return physical;
    let parsed;
    try { parsed = JSON.parse(physical.bytes.toString('utf8')); } catch {
      return rejected('QA_SIGNED_HASHES_MANIFEST_INVALID_JSON', { path: manifestPath });
    }
    map = parsed?.signed_source_and_test_hashes;
    const manifestDeclared = parsed?.signed_hashes_digest_sha256;
    if (declared !== undefined && declared !== manifestDeclared) {
      return rejected('QA_SIGNED_HASHES_MANIFEST_DIGEST_MISMATCH', {
        declared, manifestDeclared: manifestDeclared ?? null
      });
    }
    declared = manifestDeclared;
    manifest = {
      path: manifestPath,
      real: physical.real,
      sha256: sha256(physical.bytes)
    };
  }
  // Preserve legacy/domain reports that do not declare the paired signed-map
  // contract. Once BOTH fields are declared, they become cryptographic claims
  // and must be verified rather than merely shape-checked.
  if (map === undefined || declared === undefined) return { ok: true };
  if (!map || typeof map !== 'object' || Array.isArray(map)
      || Object.keys(map).length === 0 || Object.keys(map).length > 4096) {
    return rejected('QA_SIGNED_HASHES_INVALID');
  }
  if (typeof declared !== 'string' || !SHA256.test(declared)) {
    return rejected('QA_SIGNED_HASHES_DIGEST_INVALID');
  }
  for (const [relative, expected] of Object.entries(map)) {
    if (!relative || path.isAbsolute(relative) || typeof expected !== 'string' || !SHA256.test(expected)) {
      return rejected('QA_SIGNED_HASHES_INVALID', { path: relative || null });
    }
  }
  const computed = signedHashMapDigest(map);
  if (computed !== declared.toLowerCase()) {
    return rejected('QA_SIGNED_HASHES_DIGEST_MISMATCH', {
      declared: declared.toLowerCase(), computed
    });
  }
  if (!workspaceRoot) return { ok: true, computed, count: Object.keys(map).length };

  const root = await fs.realpath(workspaceRoot);
  let signedBase = root;
  if (manifest) signedBase = path.dirname(manifest.real);
  if (body?.signed_hashes_workspace_base !== undefined) {
    const relativeBase = body.signed_hashes_workspace_base;
    if (typeof relativeBase !== 'string' || !relativeBase.trim() || path.isAbsolute(relativeBase)) {
      return rejected('QA_SIGNED_HASHES_BASE_INVALID', { path: relativeBase ?? null });
    }
    const candidateBase = path.resolve(root, relativeBase);
    if (!within(candidateBase, root)) return rejected('QA_SIGNED_HASHES_BASE_OUTSIDE_WORKSPACE');
    const baseInfo = await fs.lstat(candidateBase).catch(() => null);
    if (!baseInfo || !baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
      return rejected('QA_SIGNED_HASHES_BASE_MISSING_OR_UNSAFE', { path: relativeBase });
    }
    signedBase = await fs.realpath(candidateBase);
    if (!within(signedBase, root)) return rejected('QA_SIGNED_HASHES_BASE_OUTSIDE_WORKSPACE');
  }
  for (const [relative, expected] of Object.entries(map)) {
    const candidate = path.resolve(signedBase, relative);
    if (!within(candidate, signedBase) || !within(candidate, root)) {
      return rejected('QA_SIGNED_FILE_OUTSIDE_WORKSPACE', { path: relative });
    }
    const info = await fs.lstat(candidate).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) {
      return rejected('QA_SIGNED_FILE_MISSING_OR_UNSAFE', { path: relative });
    }
    const real = await fs.realpath(candidate);
    if (!within(real, signedBase) || !within(real, root)) {
      return rejected('QA_SIGNED_FILE_OUTSIDE_WORKSPACE', { path: relative });
    }
    const observed = sha256(await fs.readFile(real));
    if (observed !== expected.toLowerCase()) {
      return rejected('QA_SIGNED_FILE_DRIFT', {
        path: relative, expected: expected.toLowerCase(), observed
      });
    }
  }
  return {
    ok: true,
    computed,
    count: Object.keys(map).length,
    normalizedFields: {
      sourceSha256: computed,
      signed_hashes_digest_sha256: computed,
      ...(manifest ? {
        signed_hashes_manifest_path: manifest.path,
        signed_hashes_manifest_sha256: manifest.sha256
      } : {})
    }
  };
}

function rejected(reasonCode, detail = null) {
  return { ok: false, reasonCode, detail };
}

/**
 * The model's JSON is a PROPOSAL, not cryptographic authority.
 * Materialize exact UTF-8 report bytes before another agent signs them.
 * A predeclared, incorrect digest is rejected rather than silently repaired.
 *
 * Backward compatible: ordinary evidence results without an embedded
 * serialized_qa_report_json are returned unchanged. These are NOT attested.
 */
export async function materializeQaEvidenceResult(value, {
  executionRoot, nodeId, workspaceRoot = null,
  maxBytes = 4 * 1024 * 1024, requireArtifact = false,
  boundSourceSha256 = null
} = {}) {
  const parsed = validateEvidenceResult(value, { verdictAsEvidence: true });
  if (!parsed.ok) return parsed;
  const result = parsed.parsed;
  const evidence = result.evidence ?? {};
  if (evidence.auditVerdict !== 'QA_GO') {
    return { ok: true, result: parsed.normalizedResult ?? value, artifactRefs: [], attested: false };
  }
  const hasSerializedReport = Object.hasOwn(evidence, 'serialized_qa_report_json');
  if (!hasSerializedReport && !requireArtifact) {
    return { ok: true, result: parsed.normalizedResult ?? value, artifactRefs: [], attested: false };
  }
  if (!executionRoot || !nodeId) return rejected('QA_ARTIFACT_ROOT_MISSING');
  if (evidence.auditVerdict !== 'QA_GO' || Object.hasOwn(evidence, 'releaseVerdict')) {
    return rejected('QA_ARTIFACT_DOMAIN_MISMATCH');
  }
  let report;
  let signedEvidence = null;
  let runnerBoundSource = null;
  if (hasSerializedReport) {
    report = evidence.serialized_qa_report_json;
    if (typeof report !== 'string' || !report.trim()) return rejected('QA_ARTIFACT_BYTES_MISSING');
  } else {
    signedEvidence = await validateSignedHashEvidence(evidence, { workspaceRoot });
    if (!signedEvidence.ok) return signedEvidence;
    const canonicalEvidence = { ...evidence, ...(signedEvidence.normalizedFields ?? {}) };
    // For non-release QA reviews without a domain-specific signed-file map,
    // the runner can bind the exact upstream node results cryptographically.
    // The source digest comes from trusted runner bytes, never the model.
    // Domain-signed QA reports retain their stronger file-hash authority.
    if (boundSourceSha256 !== null && !signedEvidence.normalizedFields) {
      if (typeof boundSourceSha256 !== 'string' || !SHA256.test(boundSourceSha256)) {
        return rejected('QA_UPSTREAM_BINDING_INVALID');
      }
      if (evidence.sourceSha256 !== undefined && evidence.sourceSha256 !== boundSourceSha256) {
        return rejected('QA_UPSTREAM_BINDING_MISMATCH');
      }
      if (evidence.signed_hashes_digest_sha256 !== undefined
          && evidence.signed_hashes_digest_sha256 !== boundSourceSha256) {
        return rejected('QA_UPSTREAM_BINDING_MISMATCH');
      }
      canonicalEvidence.sourceSha256 = boundSourceSha256;
      runnerBoundSource = boundSourceSha256;
    }
    delete canonicalEvidence.artifactDigest;
    delete canonicalEvidence.qa_report_sha256;
    delete canonicalEvidence.qa_report_ref;
    delete canonicalEvidence.serialized_qa_report_json;
    report = JSON.stringify(canonicalEvidence, null, 2) + '\n';
  }
  const bytes = Buffer.from(report, 'utf8');
  if (bytes.length > maxBytes) return rejected('QA_ARTIFACT_TOO_LARGE');
  let body;
  try {
    body = JSON.parse(report);
  } catch {
    return rejected('QA_ARTIFACT_INVALID_JSON');
  }
  if (!body || Array.isArray(body) || body.auditVerdict !== 'QA_GO'
      || body.node_id !== evidence.node_id && evidence.node_id) {
    return rejected('QA_ARTIFACT_BODY_MISMATCH');
  }
  if (hasSerializedReport) {
    signedEvidence = await validateSignedHashEvidence(body, { workspaceRoot });
    if (!signedEvidence.ok) return signedEvidence;
  }
  const actual = sha256(bytes);
  for (const claim of [evidence.artifactDigest, evidence.qa_report_sha256].filter((s) => s !== undefined)) {
    if (typeof claim !== 'string' || !SHA256.test(claim) || claim.toLowerCase() !== actual) {
      return rejected('QA_ARTIFACT_SHA256_MISMATCH', { actual, declared: claim });
    }
  }
  const directory = path.resolve(executionRoot, 'attested-artifacts', sha256(Buffer.from(nodeId)).slice(0, 16));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, actual + '.json');
  const temporary = path.join(directory, '.pending-' + crypto.randomUUID());
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    // The content address includes bytes, so even a concurrent writer can be
    // allowed only if it wrote exactly the same report.
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const stored = await fs.readFile(target);
  if (!stored.equals(bytes) || sha256(stored) !== actual) return rejected('QA_ARTIFACT_PERSISTENCE_FAILED');
  const normalizedEvidence = { ...evidence, ...(signedEvidence?.normalizedFields ?? {}) };
  if (runnerBoundSource) normalizedEvidence.sourceSha256 = runnerBoundSource;
  delete normalizedEvidence.serialized_qa_report_json;
  normalizedEvidence.artifactDigest = actual;
  normalizedEvidence.qa_report_sha256 = actual;
  normalizedEvidence.qa_report_ref = target;
  const normalized = JSON.stringify({ ...result, evidence: normalizedEvidence });
  return {
    ok: true,
    attested: true,
    result: normalized,
    artifactRefs: [target],
    artifact: { path: target, sha256: actual, sizeBytes: stored.length, contentAddressed: true }
  };
}

/** Open exactly the staged file, reject symlinks, changed bytes and path escape. */
export async function verifyAttestedArtifact(ref, { executionRoot } = {}) {
  if (!ref || typeof ref !== 'object' || !executionRoot
      || typeof ref.path !== 'string' || !SHA256.test(ref.sha256 ?? '')) {
    return rejected('ATTESTED_ARTIFACT_INVALID_REFERENCE');
  }
  const root = await fs.realpath(executionRoot);
  const candidate = path.resolve(ref.path);
  const info = await fs.lstat(candidate).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) return rejected('ATTESTED_ARTIFACT_NOT_REGULAR_FILE');
  const real = await fs.realpath(candidate);
  if (!within(real, path.join(root, 'attested-artifacts'))) return rejected('ATTESTED_ARTIFACT_OUTSIDE_ROOT');
  const bytes = await fs.readFile(real);
  const observed = sha256(bytes);
  if (observed !== ref.sha256.toLowerCase() || path.basename(real) !== observed + '.json'
      || (ref.sizeBytes !== undefined && ref.sizeBytes !== bytes.length)) {
    return rejected('ATTESTED_ARTIFACT_DRIFT', { expected: ref.sha256, observed });
  }
  return { ok: true, sha256: observed, sizeBytes: bytes.length, path: real, bytes };
}

/**
 * Preserve the active-execution-root trust boundary across resume/steer.
 * A preserved QA result may legitimately reference a content-addressed artifact
 * from an earlier execution root in the same prepared-run lineage. Verify the
 * original physical bytes against one explicitly supplied prior root, then
 * rematerialize the same canonical evidence inside the new execution root.
 * Never broaden verifyAttestedArtifact() to accept arbitrary ancestor paths.
 */
export async function rehomeAttestedQaEvidenceResult(value, {
  sourceExecutionRoots = [], targetExecutionRoot, nodeId
} = {}) {
  const parsed = validateEvidenceResult(value, { verdictAsEvidence: true });
  if (!parsed.ok) return { ok: true, changed: false, result: value, artifactRefs: [] };
  const evidence = parsed.parsed?.evidence ?? {};
  if (evidence.auditVerdict !== 'QA_GO' || typeof evidence.qa_report_ref !== 'string') {
    return { ok: true, changed: false, result: value, artifactRefs: [] };
  }
  const claimedSha = evidence.qa_report_sha256 ?? evidence.artifactDigest;
  if (typeof claimedSha !== 'string' || !SHA256.test(claimedSha)) {
    return rejected('ATTESTED_ARTIFACT_INVALID_REFERENCE');
  }
  if (!targetExecutionRoot || !nodeId || !Array.isArray(sourceExecutionRoots)
      || sourceExecutionRoots.length === 0) {
    return rejected('ATTESTED_ARTIFACT_ROOT_MISSING');
  }

  let verified = null;
  let lastReason = 'ATTESTED_ARTIFACT_OUTSIDE_ROOT';
  for (const sourceExecutionRoot of sourceExecutionRoots) {
    const outcome = await verifyAttestedArtifact({
      path: evidence.qa_report_ref,
      sha256: claimedSha
    }, { executionRoot: sourceExecutionRoot });
    if (outcome.ok) {
      verified = outcome;
      break;
    }
    lastReason = outcome.reasonCode ?? lastReason;
    // OUTSIDE_ROOT is expected while walking an explicit resume lineage. Any
    // other failure describes the referenced physical artifact itself and must
    // fail closed rather than searching for an unrelated copy elsewhere.
    if (outcome.reasonCode !== 'ATTESTED_ARTIFACT_OUTSIDE_ROOT') return outcome;
  }
  if (!verified) return rejected(lastReason);

  const directory = path.resolve(
    targetExecutionRoot,
    'attested-artifacts',
    sha256(Buffer.from(nodeId)).slice(0, 16)
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, verified.sha256 + '.json');
  const temporary = path.join(directory, '.pending-' + crypto.randomUUID());
  try {
    await fs.writeFile(temporary, verified.bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const imported = await verifyAttestedArtifact({
    path: target,
    sha256: verified.sha256,
    sizeBytes: verified.sizeBytes
  }, { executionRoot: targetExecutionRoot });
  if (!imported.ok) return imported;
  const normalizedEvidence = {
    ...evidence,
    artifactDigest: verified.sha256,
    qa_report_sha256: verified.sha256,
    qa_report_ref: imported.path
  };
  const normalized = JSON.stringify({ ...parsed.parsed, evidence: normalizedEvidence });
  return {
    ok: true,
    changed: true,
    result: normalized,
    artifactRefs: [imported.path],
    source: { path: verified.path, sha256: verified.sha256 },
    artifact: {
      path: imported.path,
      sha256: imported.sha256,
      sizeBytes: imported.sizeBytes,
      contentAddressed: true
    }
  };
}

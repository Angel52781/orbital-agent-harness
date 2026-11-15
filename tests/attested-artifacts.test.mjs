import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  materializeQaEvidenceResult,
  rehomeAttestedQaEvidenceResult,
  verifyAttestedArtifact
} from '../src/attested-artifacts.mjs';
import { createWorkGraph, runWorkGraph } from '../src/work-graph.mjs';
import { resolvePermissionEnvelope } from '../src/permissions.mjs';
import { capabilityCatalog } from '../src/registry.mjs';
import { activateAttestedRelease, prepareMarkerTransition } from '../src/release-transition.mjs';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const pythonSignedHashDigest = (map) => {
  const quote = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => (
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
  const canonical = `{${Object.keys(map).sort().map((key) => `${quote(key)}: ${quote(map[key])}`).join(', ')}}`;
  return sha256(Buffer.from(canonical));
};
const report = JSON.stringify({
  schema: 'fixture.qa-report.v1',
  node_id: 'qa-a',
  auditVerdict: 'QA_GO',
  verified_source_allowlist: ['sample_vendor'],
  signed_source_and_test_hashes: { 'src/example.py': 'a'.repeat(64) }
}) + '\n';
const wrapper = (fields = {}) => JSON.stringify({
  status: 'PASS',
  evidence: { auditVerdict: 'QA_GO', node_id: 'qa-a', sourceSha256: 'b'.repeat(64), serialized_qa_report_json: report, ...fields }
});

test('QA report materializes exact bytes in a content-addressed artifact; downstream can read them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staged = await materializeQaEvidenceResult(wrapper(), { executionRoot: root, nodeId: 'qa-a' });
  assert.equal(staged.ok, true);
  assert.equal(staged.attested, true);
  const normalized = JSON.parse(staged.result);
  assert.equal(normalized.evidence.artifactDigest, sha256(Buffer.from(report)));
  assert.equal(normalized.evidence.qa_report_sha256, sha256(Buffer.from(report)));
  assert.ok(!Object.hasOwn(normalized.evidence, 'serialized_qa_report_json'));
  assert.equal(normalized.evidence.qa_report_ref, staged.artifact.path);
  const verified = await verifyAttestedArtifact(staged.artifact, { executionRoot: root });
  assert.equal(verified.ok, true);
  assert.equal(verified.bytes.toString(), report);
  const second = await materializeQaEvidenceResult(wrapper(), { executionRoot: root, nodeId: 'qa-a' });
  assert.equal(second.ok, true);
  assert.equal(second.artifact.sha256, staged.artifact.sha256);
});

test('required QA artifact auto-materializes read-only reviewer evidence without workspace writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-required-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = JSON.stringify({
    status: 'PASS',
    evidence: {
      schema: 'fixture.qa-review.v1',
      node_id: 'qa-a',
      auditVerdict: 'QA_GO',
      sourceSha256: 'b'.repeat(64),
      verified_source_allowlist: ['sample_vendor'],
      signed_source_and_test_hashes: { 'src/example.py': 'a'.repeat(64) }
    }
  });
  const staged = await materializeQaEvidenceResult(value, {
    executionRoot: root,
    nodeId: 'qa-a',
    requireArtifact: true
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.attested, true);
  const normalized = JSON.parse(staged.result);
  assert.ok(normalized.evidence.qa_report_ref);
  assert.equal(normalized.evidence.qa_report_sha256, staged.artifact.sha256);
  const verified = await verifyAttestedArtifact(staged.artifact, { executionRoot: root });
  assert.equal(verified.ok, true);
  const body = JSON.parse(verified.bytes.toString('utf8'));
  assert.equal(body.auditVerdict, 'QA_GO');
  assert.equal(body.node_id, 'qa-a');
  assert.deepEqual(body.verified_source_allowlist, ['sample_vendor']);
});

test('wrong model-transcribed report SHA is rejected before declaring QA PASS', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = await materializeQaEvidenceResult(
    wrapper({ artifactDigest: 'a1fd9af240a21fc47a24914a764af0b7e305fa590f83790ceeb8481904efbdd8' }),
    { executionRoot: root, nodeId: 'qa-a' }
  );
  assert.equal(candidate.ok, false);
  assert.equal(candidate.reasonCode, 'QA_ARTIFACT_SHA256_MISMATCH');
  assert.deepEqual(await fs.readdir(root), [], 'no artifact published on false SHA');
});

test('attested QA rejects an internally inconsistent signed hash map before release', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-signed-map-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/example.py'), 'print("current")\n');
  const fileSha = sha256(Buffer.from('print("current")\n'));
  const signed = { 'src/example.py': fileSha };
  const valid = JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a',
      signed_source_and_test_hashes: signed,
      signed_hashes_digest_sha256: pythonSignedHashDigest(signed)
    }
  });
  const staged = await materializeQaEvidenceResult(valid, {
    executionRoot: path.join(root, 'execution'), nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(staged.ok, true);

  const badDigest = JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a',
      signed_source_and_test_hashes: signed,
      signed_hashes_digest_sha256: 'f'.repeat(64)
    }
  });
  const digestRejected = await materializeQaEvidenceResult(badDigest, {
    executionRoot: path.join(root, 'bad-digest'), nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(digestRejected.reasonCode, 'QA_SIGNED_HASHES_DIGEST_MISMATCH');

  const stale = { 'src/example.py': 'a'.repeat(64) };
  const staleValue = JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a',
      signed_source_and_test_hashes: stale,
      signed_hashes_digest_sha256: pythonSignedHashDigest(stale)
    }
  });
  const fileRejected = await materializeQaEvidenceResult(staleValue, {
    executionRoot: path.join(root, 'stale'), nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(fileRejected.reasonCode, 'QA_SIGNED_FILE_DRIFT');
  assert.equal(fileRejected.detail.path, 'src/example.py');
});

test('attested QA can bind a physical domain hash manifest without copying its large map through the reviewer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const domain = path.join(root, 'domain');
  await fs.mkdir(path.join(domain, 'config'), { recursive: true });
  const sourceBytes = Buffer.from('physical-current-bytes\n');
  await fs.writeFile(path.join(domain, 'config/example.txt'), sourceBytes);
  const signed = { 'config/example.txt': sha256(sourceBytes) };
  const digest = pythonSignedHashDigest(signed);
  const manifestBody = JSON.stringify({
    schema: 'fixture.domain-qa.v1',
    auditVerdict: 'QA_GO',
    signed_source_and_test_hashes: signed,
    signed_hashes_digest_sha256: digest
  }, null, 2) + '\n';
  await fs.writeFile(path.join(domain, 'qa_report.json'), manifestBody);

  const concise = JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a',
      signed_hashes_manifest_path: 'domain/qa_report.json',
      verified_source_allowlist: ['sample_vendor']
    }
  });
  const staged = await materializeQaEvidenceResult(concise, {
    executionRoot: path.join(root, 'execution'),
    nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(staged.ok, true);
  const normalized = JSON.parse(staged.result).evidence;
  assert.equal(normalized.sourceSha256, digest);
  assert.equal(normalized.signed_hashes_digest_sha256, digest);
  assert.equal(normalized.signed_hashes_manifest_path, 'domain/qa_report.json');
  assert.equal(normalized.signed_hashes_manifest_sha256, sha256(Buffer.from(manifestBody)));
  assert.equal(Object.hasOwn(normalized, 'signed_source_and_test_hashes'), false);

  await fs.writeFile(path.join(domain, 'config/example.txt'), 'drifted\n');
  const drifted = await materializeQaEvidenceResult(concise, {
    executionRoot: path.join(root, 'drifted'),
    nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(drifted.reasonCode, 'QA_SIGNED_FILE_DRIFT');
  assert.equal(drifted.detail.path, 'config/example.txt');
});

test('signed hash manifest path and optional base remain confined to the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-manifest-safe-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-manifest-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  const outsideReport = path.join(outside, 'qa_report.json');
  await fs.writeFile(outsideReport, '{}\n');
  await fs.symlink(outsideReport, path.join(root, 'qa-link.json'));
  const symlinked = await materializeQaEvidenceResult(JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a', signed_hashes_manifest_path: 'qa-link.json'
    }
  }), {
    executionRoot: path.join(root, 'execution'), nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(symlinked.reasonCode, 'QA_SIGNED_HASHES_MANIFEST_MISSING_OR_UNSAFE');

  const invalidBase = await materializeQaEvidenceResult(JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a',
      signed_source_and_test_hashes: { 'x.txt': 'a'.repeat(64) },
      signed_hashes_digest_sha256: pythonSignedHashDigest({ 'x.txt': 'a'.repeat(64) }),
      signed_hashes_workspace_base: '../escape'
    }
  }), {
    executionRoot: path.join(root, 'base'), nodeId: 'qa-a', workspaceRoot: root, requireArtifact: true
  });
  assert.equal(invalidBase.reasonCode, 'QA_SIGNED_HASHES_BASE_OUTSIDE_WORKSPACE');
});

test('release cannot consume a modified report, path alias, or symlink', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staged = await materializeQaEvidenceResult(wrapper(), { executionRoot: root, nodeId: 'qa-a' });
  await fs.appendFile(staged.artifact.path, '\n');
  assert.equal((await verifyAttestedArtifact(staged.artifact, { executionRoot: root })).reasonCode, 'ATTESTED_ARTIFACT_DRIFT');
  const foreign = path.join(root, 'foreign.json');
  await fs.writeFile(foreign, report);
  assert.equal((await verifyAttestedArtifact({ ...staged.artifact, path: foreign }, { executionRoot: root })).reasonCode,
    'ATTESTED_ARTIFACT_OUTSIDE_ROOT');
  const alias = path.join(path.dirname(staged.artifact.path), 'link.json');
  await fs.symlink(foreign, alias);
  assert.equal((await verifyAttestedArtifact({ ...staged.artifact, path: alias }, { executionRoot: root })).reasonCode,
    'ATTESTED_ARTIFACT_NOT_REGULAR_FILE');
});

test('resume rehomes a physically verified QA artifact into the active execution root', async (t) => {
  const originalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-original-'));
  const intermediateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-intermediate-'));
  const resumedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-resumed-'));
  t.after(() => Promise.all([
    fs.rm(originalRoot, { recursive: true, force: true }),
    fs.rm(intermediateRoot, { recursive: true, force: true }),
    fs.rm(resumedRoot, { recursive: true, force: true })
  ]));
  const staged = await materializeQaEvidenceResult(wrapper(), {
    executionRoot: originalRoot,
    nodeId: 'qa-a'
  });
  assert.equal(staged.ok, true);
  const rehomed = await rehomeAttestedQaEvidenceResult(staged.result, {
    sourceExecutionRoots: [intermediateRoot, originalRoot],
    targetExecutionRoot: resumedRoot,
    nodeId: 'qa-a'
  });
  assert.equal(rehomed.ok, true);
  assert.equal(rehomed.changed, true);
  assert.equal(rehomed.artifact.sha256, staged.artifact.sha256);
  assert.notEqual(rehomed.artifact.path, staged.artifact.path);
  const normalized = JSON.parse(rehomed.result);
  assert.equal(normalized.evidence.qa_report_ref, rehomed.artifact.path);
  assert.equal((await verifyAttestedArtifact(rehomed.artifact, { executionRoot: resumedRoot })).ok, true);
  assert.equal((await verifyAttestedArtifact(rehomed.artifact, { executionRoot: originalRoot })).reasonCode,
    'ATTESTED_ARTIFACT_OUTSIDE_ROOT');
});

test('resume refuses to rehome a QA artifact that is not inside the declared execution lineage', async (t) => {
  const originalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-original-'));
  const unrelatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-unrelated-'));
  const resumedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-resumed-'));
  t.after(() => Promise.all([
    fs.rm(originalRoot, { recursive: true, force: true }),
    fs.rm(unrelatedRoot, { recursive: true, force: true }),
    fs.rm(resumedRoot, { recursive: true, force: true })
  ]));
  const staged = await materializeQaEvidenceResult(wrapper(), {
    executionRoot: originalRoot,
    nodeId: 'qa-a'
  });
  const rejected = await rehomeAttestedQaEvidenceResult(staged.result, {
    sourceExecutionRoots: [unrelatedRoot],
    targetExecutionRoot: resumedRoot,
    nodeId: 'qa-a'
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reasonCode, 'ATTESTED_ARTIFACT_OUTSIDE_ROOT');
});

test('domain mismatch, invalid report body, invalid JSON and oversize fail before staging', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await materializeQaEvidenceResult(wrapper({ releaseVerdict: 'PASS' }), { executionRoot: root, nodeId: 'qa-a' })).reasonCode, 'QA_ARTIFACT_DOMAIN_MISMATCH');
  assert.equal((await materializeQaEvidenceResult(wrapper({ serialized_qa_report_json: 'oops' }), { executionRoot: root, nodeId: 'qa-a' })).reasonCode, 'QA_ARTIFACT_INVALID_JSON');
  assert.equal((await materializeQaEvidenceResult(wrapper(), { executionRoot: root, nodeId: 'qa-a', maxBytes: 6 })).reasonCode, 'QA_ARTIFACT_TOO_LARGE');
  assert.equal((await materializeQaEvidenceResult(wrapper({ serialized_qa_report_json: '{"auditVerdict":"QA_BLOCK"}' }), { executionRoot: root, nodeId: 'qa-a' })).reasonCode, 'QA_ARTIFACT_BODY_MISMATCH');
});

async function executeQaReleaseGraph(t, { wrongQaSha = false, corruptArtifact = false, mixedVerdicts = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-qa-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = createWorkGraph({
    project: 'isolated-qa-artifact-fixture',
    task: 'test actual QA evidence handoff',
    mode: 'read-only',
    nodes: [
      { id: 'qa-a', logicalAgent: 'code-auditor', objective: 'Independent QA',
        expectedResult: 'Measured QA and physically reproducible report', validation: { type: 'qa-go' } },
      { id: 'release-a', logicalAgent: 'code-auditor', objective: 'Release',
        dependsOn: ['qa-a'], expectedResult: 'Release on upstream exact bytes',
        validation: { type: 'release-pass', requireArtifact: true } }
    ]
  });
  const capabilityCeiling = capabilityCatalog();
  const envelopeFor = ({ node }) => resolvePermissionEnvelope({
    agentId: node.logicalAgent,
    principal: 'owner', surface: 'private', mode: 'read-only',
    workspaceRoot: root,
    requestedCapabilities: ['context-routing'],
    callerPolicy: { allowedModes: ['read-only'], capabilityCeiling },
    projectPolicy: { allowedModes: ['read-only'], capabilityCeiling, workspaceRoot: root }
  });
  let downstreamArtifact = null;
  const output = await runWorkGraph(graph, {
    eventFile: path.join(root, 'events.jsonl'),
    stateFile: path.join(root, 'state.json'),
    heartbeatMs: 0,
    envelopeFor,
    dispatcher: async (input) => {
      if (input.nodeId === 'qa-a') {
        return { ok: true, provider: 'fixture',
          result: wrapper(wrongQaSha ? { qa_report_sha256: 'f'.repeat(64) } : {}) };
      }
      const upstream = JSON.parse(input.dependencyResults['qa-a'][0]);
      downstreamArtifact = upstream.evidence.qa_report_ref;
      if (corruptArtifact) await fs.appendFile(downstreamArtifact, 'external-writer');
      return { ok: true, provider: 'fixture',
        result: JSON.stringify({ status: 'PASS', evidence: {
          releaseVerdict: 'PASS',
          ...(mixedVerdicts ? { auditVerdict: 'RELEASE_GO' } : {}),
          sourceSha256: upstream.evidence.sourceSha256,
          artifactDigest: upstream.evidence.artifactDigest
        } }) };
    }
  });
  return { output, downstreamArtifact, root };
}

test('actual work graph materializes QA artifact BEFORE releasing a dependent reviewer', async (t) => {
  const { output, downstreamArtifact } = await executeQaReleaseGraph(t);
  assert.equal(output.state, 'PASS');
  assert.ok(downstreamArtifact.endsWith(sha256(Buffer.from(report)) + '.json'));
  assert.equal(output.nodes[0].instances[0].artifactRefs.length, 1);
});

test('legacy requireArtifact does not require a physical report for valid QA and release verdicts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-qa-required-auto-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = createWorkGraph({
    project: 'isolated-qa-required-auto',
    task: 'auto-materialize required QA artifact',
    mode: 'read-only',
    nodes: [
      { id: 'qa-a', logicalAgent: 'code-auditor', objective: 'Independent QA',
        expectedResult: 'Measured QA', validation: { type: 'qa-go', requireArtifact: true } },
      { id: 'release-a', logicalAgent: 'code-auditor', objective: 'Release',
        dependsOn: ['qa-a'], expectedResult: 'Release on physical QA bytes',
        validation: { type: 'release-pass', requireArtifact: true } }
    ]
  });
  const capabilityCeiling = capabilityCatalog();
  const envelopeFor = ({ node }) => resolvePermissionEnvelope({
    agentId: node.logicalAgent,
    principal: 'owner', surface: 'private', mode: 'read-only',
    workspaceRoot: root,
    requestedCapabilities: ['context-routing'],
    callerPolicy: { allowedModes: ['read-only'], capabilityCeiling },
    projectPolicy: { allowedModes: ['read-only'], capabilityCeiling, workspaceRoot: root }
  });
  let physicalQaRef = null;
  const output = await runWorkGraph(graph, {
    eventFile: path.join(root, 'events.jsonl'),
    stateFile: path.join(root, 'state.json'),
    heartbeatMs: 0,
    envelopeFor,
    dispatcher: async (input) => {
      if (input.nodeId === 'qa-a') {
        return { ok: true, provider: 'fixture', result: JSON.stringify({
          status: 'PASS', evidence: {
            schema: 'fixture.qa-review.v1', node_id: 'qa-a', auditVerdict: 'QA_GO',
            sourceSha256: 'b'.repeat(64), verified_source_allowlist: ['sample_vendor']
          }
        }) };
      }
      const upstream = JSON.parse(input.dependencyResults['qa-a'][0]);
      physicalQaRef = upstream.evidence.qa_report_ref;
      return { ok: true, provider: 'fixture', result: JSON.stringify({
        status: 'PASS', evidence: {
          releaseVerdict: 'PASS', sourceSha256: upstream.evidence.sourceSha256,
          artifactDigest: upstream.evidence.artifactDigest
        }
      }) };
    }
  });
  assert.equal(output.state, 'PASS');
  assert.equal(physicalQaRef, undefined);
  assert.equal(output.nodes[0].instances[0].artifactRefs.length, 0);
});

test('release-pass binds attested QA digest separately from a different domain QA report sha', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-dual-qa-digest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDigest = 'd'.repeat(64);
  const domainQaReportSha256 = 'e'.repeat(64);
  const graph = createWorkGraph({
    project: 'isolated-dual-qa-digest',
    task: 'bind control-plane QA artifact separately from domain QA report',
    mode: 'read-only',
    nodes: [
      { id: 'qa-a', logicalAgent: 'code-auditor', objective: 'Independent QA',
        expectedResult: 'Measured QA', validation: { type: 'qa-go', requireArtifact: true } },
      { id: 'release-a', logicalAgent: 'release-auditor', objective: 'Release',
        dependsOn: ['qa-a'], expectedResult: 'Release bound to exact attested QA',
        validation: { type: 'release-pass', requireArtifact: true } }
    ]
  });
  const capabilityCeiling = capabilityCatalog();
  const envelopeFor = ({ node }) => resolvePermissionEnvelope({
    agentId: node.logicalAgent,
    principal: 'owner', surface: 'private', mode: 'read-only',
    workspaceRoot: root,
    requestedCapabilities: [],
    callerPolicy: { allowedModes: ['read-only'], capabilityCeiling },
    projectPolicy: { allowedModes: ['read-only'], capabilityCeiling, workspaceRoot: root }
  });
  const output = await runWorkGraph(graph, {
    eventFile: path.join(root, 'events.jsonl'),
    stateFile: path.join(root, 'state.json'),
    heartbeatMs: 0,
    envelopeFor,
    dispatcher: async (input) => {
      if (input.nodeId === 'qa-a') {
        return { ok: true, provider: 'fixture', result: JSON.stringify({
          status: 'PASS', evidence: {
            node_id: 'qa-a', auditVerdict: 'QA_GO',
            signed_hashes_digest_sha256: sourceDigest,
            verified_source_allowlist: ['sample_vendor']
          }
        }) };
      }
      const upstream = JSON.parse(input.dependencyResults['qa-a'][0]).evidence;
      assert.notEqual(upstream.artifactDigest, domainQaReportSha256);
      return { ok: true, provider: 'fixture', result: JSON.stringify({
        status: 'PASS', evidence: {
          releaseVerdict: 'PASS',
          sourceSha256: upstream.signed_hashes_digest_sha256,
          artifactDigest: upstream.artifactDigest,
          qa_report_sha256: domainQaReportSha256
        }
      }) };
    }
  });
  assert.equal(output.state, 'PASS');
  assert.equal(output.nodes[1].state, 'PASS');
});

test('actual graph blocks a false SHA at the QA node rather than wasting a release review', async (t) => {
  const { output, downstreamArtifact } = await executeQaReleaseGraph(t, { wrongQaSha: true });
  assert.equal(output.state, 'FAIL');
  assert.equal(output.nodes[0].instances[0].reasonCode, 'QA_ARTIFACT_SHA256_MISMATCH');
  assert.equal(output.nodes[1].reasonCode, 'DEPENDENCY_NOT_PASS');
  assert.equal(downstreamArtifact, null);
});

test('release verdict is not vetoed by an optional QA artifact snapshot', async (t) => {
  const { output } = await executeQaReleaseGraph(t, { corruptArtifact: true });
  assert.equal(output.state, 'PASS');
  assert.equal(output.nodes[1].state, 'PASS');
});

test('actual graph rejects mixed RELEASE_GO and QA verdict fields before activation', async (t) => {
  const { output } = await executeQaReleaseGraph(t, { mixedVerdicts: true });
  assert.equal(output.state, 'BLOCKED');
  assert.equal(output.nodes[1].instances[0].reasonCode, 'REVIEW_DOMAIN_ROLE_CONFLICT');
});

test('attested transaction requires physical QA_GO, independent release PASS, exact host guard and postvalidation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-attested-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rawReport = JSON.stringify({ auditVerdict: 'QA_GO', node_id: 'qa-a', verified_source_allowlist: ['sample_vendor'] }) + '\n';
  const qa = await materializeQaEvidenceResult(JSON.stringify({
    status: 'PASS', evidence: {
      auditVerdict: 'QA_GO', node_id: 'qa-a', signed_hashes_digest_sha256: 'b'.repeat(64),
      serialized_qa_report_json: rawReport
    }
  }), { executionRoot: root, nodeId: 'qa-a' });
  assert.equal(qa.ok, true);
  const qaPayload = JSON.parse(qa.result).evidence;
  const releasePayload = JSON.stringify({
    status: 'PASS', evidence: {
      releaseVerdict: 'PASS', upstream_qa_verdict: 'QA_GO',
      sourceSha256: qaPayload.signed_hashes_digest_sha256, artifactDigest: qaPayload.artifactDigest
    }
  });
  const canonical = path.join(root, 'LIVE_COLLECTION_APPROVED');
  const alias = canonical + '.json';
  const marker = Buffer.from('approved-synthetic-marker');
  const invoke = (params = {}) => prepareMarkerTransition([canonical, alias])
    .then((manifest) => activateAttestedRelease({
      manifest, payload: marker, qaResult: qa.result, releaseResult: releasePayload,
      executionRoot: root, hostGuardMarker: canonical,
      validateActivated: async ({ expectedMarkerSha256 }) =>
        sha256(await fs.readFile(canonical)) === expectedMarkerSha256,
      ...params
    }));
  const badRelease = await invoke({ releaseResult: JSON.stringify({
    status: 'PASS', evidence: { releaseVerdict: 'FAIL',
      sourceSha256: qaPayload.signed_hashes_digest_sha256, artifactDigest: qaPayload.artifactDigest }
  }) });
  assert.equal(badRelease.reasonCode, 'RELEASE_REVIEW_NOT_APPROVED');
  assert.equal(await fs.access(canonical).then(() => true, () => false), false);
  const badHostPath = await invoke({ hostGuardMarker: alias + '.unexpected' });
  assert.equal(badHostPath.reasonCode, 'RELEASE_HOST_GUARD_PATH_MISMATCH');
  const rejectedAfterWrite = await invoke({ validateActivated: async () => false });
  assert.equal(rejectedAfterWrite.reasonCode, 'RELEASE_POSTVALIDATION_FAILED');
  assert.equal(await fs.access(canonical).then(() => true, () => false), false);
  assert.equal(await fs.access(alias).then(() => true, () => false), false);
  const good = await invoke();
  assert.equal(good.ok, true);
  assert.deepEqual(good.verifiedSourceAllowlist, ['sample_vendor']);
  assert.equal(good.qaArtifactSha256, qa.artifact.sha256);
  await fs.appendFile(qa.artifact.path, 'tamper');
  const reportDrift = await invoke();
  assert.equal(reportDrift.reasonCode, 'ATTESTED_ARTIFACT_DRIFT');
});

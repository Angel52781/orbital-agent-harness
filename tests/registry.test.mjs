import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bundleDefinition,
  expandedCapabilities,
  generatedWriteScopesForProject,
  isExecutableAgent,
  loadProjectRuntimePolicies,
  loadRegistry,
  protectedActionsForCapabilities,
  replaceableGeneratedWriteScopesForProject,
  runtimePolicyForProject
} from '../src/registry.mjs';

const ACTIVE_IDS = [
  'orbital-director',
  'director-assistant',
  'software-architect',
  'research-evidence',
  'software-builder',
  'frontend-ux-engineer',
  'code-auditor',
  'qa-e2e',
  'security-reviewer',
  'reliability-observability',
  'software-integrator',
  'release-auditor',
  'art-director',
  'product-ux-designer',
  'visual-systems-designer',
  'content-director',
  'editorial-producer',
  'social-content-producer',
  'video-editor',
  'growth-director',
  'data-acquisition-scraping'
];

test('logical agent ids are unique and project-agnostic', () => {
  const agents = loadRegistry().agents;
  assert.ok(agents.length >= 20);
  assert.equal(new Set(agents.map((a) => a.id)).size, agents.length);
  for (const agent of agents) {
    assert.ok(agent.displayName);
    assert.ok(agent.division);
    assert.ok(agent.level);
    assert.ok(agent.modelPolicy);
    assert.equal(Object.hasOwn(agent, 'project'), false);
  }
});

test('project runtime policy keeps generated outputs separate from source scopes', () => {
  const policies = loadProjectRuntimePolicies();
  assert.equal(policies.schemaVersion, 1);
  assert.deepEqual(generatedWriteScopesForProject('content-factory'), []);
  assert.deepEqual(replaceableGeneratedWriteScopesForProject('content-factory'), []);
  assert.deepEqual(generatedWriteScopesForProject('orbital-operations'), []);
  assert.deepEqual(runtimePolicyForProject('orbital-leads').fingerprintExcludedScopes, [
    '.firecrawl',
    'acquisition/opportunity-inbox/external',
    'acquisition/opportunity-inbox/quarantine'
  ]);
});

test('project-local runtime policy overrides the control-plane fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-project-runtime-'));
  fs.mkdirSync(path.join(root, '.orbital'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orbital', 'runtime-policy.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: 'content-factory',
    generatedWriteScopes: ['generated'],
    replaceableGeneratedWriteScopes: ['dist'],
    fingerprintExcludedScopes: ['runtime/live']
  }));
  assert.deepEqual(generatedWriteScopesForProject('content-factory', root), ['generated', 'dist']);
  assert.deepEqual(replaceableGeneratedWriteScopesForProject('content-factory', root), ['dist']);
  const policy = runtimePolicyForProject('content-factory', root);
  assert.equal(policy.source, '.orbital/runtime-policy.json');
  assert.deepEqual(policy.fingerprintExcludedScopes, ['runtime/live']);
});

test('software architect is read-oriented director and has architecture capabilities', () => {
  const agent = loadRegistry().agents.find((item) => item.id === 'software-architect');
  assert.equal(agent.level, 'domain-director');
  assert.equal(agent.status, 'ACTIVE');
  assert.ok(expandedCapabilities(agent).includes('graphify'));
  assert.ok(expandedCapabilities(agent).includes('ponytail'));
  assert.equal(expandedCapabilities(agent).includes('devspace-write'), false);
});

test('same logical agent explicitly supports parallel instances where appropriate', () => {
  const agents = loadRegistry().agents;
  assert.equal(agents.find((a) => a.id === 'research-evidence').parallelInstances, true);
  assert.equal(agents.find((a) => a.id === 'software-builder').parallelInstances, true);
  assert.equal(agents.find((a) => a.id === 'software-integrator').parallelInstances, false);
});

test('Wave 5 preserves prior runtime roles and promotes active production agents leaving two on-demand sales canaries', () => {
  const agents = loadRegistry().agents;
  assert.deepEqual(agents.filter((agent) => agent.status === 'ACTIVE').map((agent) => agent.id), ACTIVE_IDS);
  assert.deepEqual(
    agents.filter((agent) => agent.status === 'CANARY').map((agent) => agent.id),
    [
      'outbound-strategist',
      'sales-engineer'
    ]
  );
});

test('runtime provider routing follows role preferences', () => {
  const agents = loadRegistry().agents;
  const byId = (id) => agents.find((agent) => agent.id === id);
  for (const id of ['software-builder', 'frontend-ux-engineer', 'reliability-observability', 'software-integrator', 'social-content-producer', 'video-editor', 'growth-director', 'code-auditor', 'security-reviewer', 'release-auditor', 'art-director']) {
    assert.equal(byId(id).modelPolicy.providerPreference[0], 'antigravity', id);
  }
  assert.deepEqual(byId('research-evidence').modelPolicy.providerPreference, ['antigravity', 'codex']);
  assert.deepEqual(byId('editorial-producer').modelPolicy.providerPreference, ['antigravity', 'codex']);
  for (const id of ['orbital-director', 'software-architect']) {
    assert.equal(byId(id).modelPolicy.providerPreference[0], 'codex', id);
  }
  assert.equal(byId('content-director').modelPolicy.providerPreference[0], 'antigravity');
});

test('reviewers remain read-only while remediation stays with builders and integrator', () => {
  for (const id of ['code-auditor', 'security-reviewer', 'release-auditor']) {
    const agent = loadRegistry().agents.find((item) => item.id === id);
    assert.deepEqual(agent.runtimePolicy.allowedModes, ['read-only']);
    assert.equal(expandedCapabilities(agent).includes('devspace-write'), false);
  }
});

test('Wave 2 assurance roles are separated, read-only and least privilege', () => {
  const agents = loadRegistry().agents;
  const security = agents.find((agent) => agent.id === 'security-reviewer');
  const reliability = agents.find((agent) => agent.id === 'reliability-observability');
  const release = agents.find((agent) => agent.id === 'release-auditor');

  for (const agent of [security, reliability, release]) {
    assert.equal(agent.status, 'ACTIVE');
    assert.deepEqual(agent.runtimePolicy.allowedModes, ['read-only']);
    assert.equal(expandedCapabilities(agent).includes('devspace-write'), false);
  }
  assert.deepEqual(security.capabilityBundles, ['context-core', 'security', 'code-review']);
  assert.deepEqual(reliability.capabilityBundles, ['context-core', 'reliability', 'code-review', 'diagnostics']);
  assert.deepEqual(release.capabilityBundles, ['context-core', 'code-review', 'security', 'reliability', 'browser-qa', 'verification-runtime']);
  assert.equal(security.modelPolicy.preferIndependentProvider, true);
  assert.equal(release.modelPolicy.preferIndependentProvider, true);
});

test('read-only reliability review never grants rollback transitively', () => {
  const reliability = bundleDefinition('reliability');
  const rollbackAction = bundleDefinition('reliability-mutation');
  assert.equal(reliability.capabilities.includes('rollback'), false);
  assert.deepEqual(rollbackAction.capabilities, ['rollback']);
  assert.deepEqual(protectedActionsForCapabilities(reliability.capabilities), []);
  assert.deepEqual(protectedActionsForCapabilities(rollbackAction.capabilities), ['production-mutation']);

  const release = loadRegistry().agents.find((agent) => agent.id === 'release-auditor');
  assert.equal(expandedCapabilities(release).includes('rollback'), false);
});

test('Wave 5 leaves no planned roles', () => {
  const planned = loadRegistry().agents.filter((agent) => agent.status === 'PLANNED');
  assert.deepEqual(planned, []);
});

test('director is read-only, integrator is scoped-write capable, and status gates execution', () => {
  const agents = loadRegistry().agents;
  const director = agents.find((agent) => agent.id === 'orbital-director');
  const integrator = agents.find((agent) => agent.id === 'software-integrator');
  const plannedWithProfile = {
    ...agents.find((agent) => agent.id === 'growth-director'),
    status: 'PLANNED'
  };

  assert.deepEqual(director.runtimePolicy.allowedModes, ['read-only']);
  assert.equal(expandedCapabilities(director).includes('devspace-write'), false);
  assert.deepEqual(integrator.runtimePolicy.allowedModes, ['read-only', 'workspace-write']);
  assert.equal(expandedCapabilities(integrator).includes('devspace-write'), true);
  assert.equal(isExecutableAgent(plannedWithProfile), false);
});

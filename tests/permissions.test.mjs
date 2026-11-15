import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertResolvedPermissionEnvelope,
  isResolvedPermissionEnvelope,
  resolvePermissionEnvelope
} from '../src/permissions.mjs';
import { capabilityCatalog, expandedCapabilities, getAgent } from '../src/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_CAPABILITIES = capabilityCatalog();

function request(overrides = {}) {
  const requestedCapabilities = overrides.requestedCapabilities ?? ['context-routing', 'github-read'];
  return {
    agentId: 'software-architect',
    principal: 'owner',
    surface: 'private',
    mode: 'read-only',
    workspaceRoot: ROOT,
    requestedCapabilities,
    callerPolicy: {
      allowedModes: ['read-only', 'workspace-write'],
      capabilityCeiling: ALL_CAPABILITIES,
      ...overrides.callerPolicy
    },
    projectPolicy: {
      allowedModes: ['read-only', 'workspace-write'],
      capabilityCeiling: ALL_CAPABILITIES,
      workspaceRoot: ROOT,
      ...overrides.projectPolicy
    },
    ...overrides,
    callerPolicy: {
      allowedModes: ['read-only', 'workspace-write'],
      capabilityCeiling: ALL_CAPABILITIES,
      ...overrides.callerPolicy
    },
    projectPolicy: {
      allowedModes: ['read-only', 'workspace-write'],
      capabilityCeiling: ALL_CAPABILITIES,
      workspaceRoot: ROOT,
      ...overrides.projectPolicy
    }
  };
}

test('resolves an immutable, exact least-privilege intersection', () => {
  const envelope = resolvePermissionEnvelope(request({
    requestedCapabilities: ['github-read', 'web-search', 'security-review', 'terminal'],
    callerPolicy: { capabilityCeiling: ['github-read', 'web-search', 'terminal'] },
    projectPolicy: { capabilityCeiling: ['github-read', 'security-review', 'terminal'] }
  }));

  assert.deepEqual(envelope.effectiveCapabilities, ['github-read']);
  assert.deepEqual(envelope.deniedCapabilities, ['security-review', 'terminal', 'web-search']);
  assert.deepEqual(envelope.requestedCapabilities, ['github-read', 'security-review', 'terminal', 'web-search']);
  assert.equal(envelope.workspaceRoot, ROOT);
  assert.equal(isResolvedPermissionEnvelope(envelope), true);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.effectiveCapabilities), true);
  assert.equal(assertResolvedPermissionEnvelope(envelope), envelope);
});

test('owner can use either surface while team is confined to team', () => {
  assert.equal(resolvePermissionEnvelope(request({ surface: 'private' })).surface, 'private');
  assert.equal(resolvePermissionEnvelope(request({ surface: 'team' })).surface, 'team');
  assert.equal(resolvePermissionEnvelope(request({ principal: 'team', surface: 'team' })).principal, 'team');
  assert.throws(
    () => resolvePermissionEnvelope(request({ principal: 'team', surface: 'private' })),
    /permission-denied:surface-not-allowed/
  );
});

test('unknown principal, surface and mode fail closed', () => {
  assert.throws(() => resolvePermissionEnvelope(request({ principal: 'admin' })), /invalid-principal/);
  assert.throws(() => resolvePermissionEnvelope(request({ surface: 'public' })), /surface-not-allowed/);
  assert.throws(() => resolvePermissionEnvelope(request({ mode: 'full-access' })), /invalid-mode/);
  assert.throws(
    () => resolvePermissionEnvelope(request({ mode: 'read-only', requestedMode: 'workspace-write' })),
    /conflicting-requested-mode/
  );
});

test('mode must be allowed by caller, project and logical-agent ceilings', () => {
  assert.throws(
    () => resolvePermissionEnvelope(request({ callerPolicy: { allowedModes: ['workspace-write'] } })),
    /mode-exceeds-ceiling/
  );
  assert.throws(
    () => resolvePermissionEnvelope(request({ projectPolicy: { allowedModes: ['workspace-write'] } })),
    /mode-exceeds-ceiling/
  );
  assert.throws(
    () => resolvePermissionEnvelope(request({ mode: 'workspace-write' })),
    /mode-exceeds-ceiling/
  );

  const builder = resolvePermissionEnvelope(request({
    agentId: 'software-builder',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write', 'tests']
  }));
  assert.deepEqual(builder.effectiveCapabilities, ['devspace-write', 'tests']);
});

test('read-only mode never grants the explicit workspace-write capability', () => {
  const envelope = resolvePermissionEnvelope(request({
    agentId: 'software-builder',
    requestedCapabilities: ['devspace-write', 'github-read']
  }));
  assert.deepEqual(envelope.effectiveCapabilities, ['github-read']);
  assert.deepEqual(envelope.deniedCapabilities, ['devspace-write']);
});

test('orbital director remains a read-only coordinator and cannot absorb worker implementation', () => {
  const director = getAgent('orbital-director');
  assert.deepEqual(director.runtimePolicy.allowedModes, ['read-only']);
  assert.equal(expandedCapabilities(director).includes('devspace-write'), false);
  assert.throws(
    () => resolvePermissionEnvelope(request({
      agentId: 'orbital-director',
      mode: 'workspace-write',
      requestedCapabilities: ['devspace-write']
    })),
    /mode-exceeds-ceiling/
  );
});

test('read-only QA and assurance roles can execute deterministic verification without write authority', () => {
  for (const agentId of ['code-auditor', 'qa-e2e', 'release-auditor']) {
    const envelope = resolvePermissionEnvelope(request({
      agentId,
      requestedCapabilities: ['devspace-write', 'terminal', 'tests']
    }));
    assert.deepEqual(envelope.effectiveCapabilities, ['terminal', 'tests']);
    assert.deepEqual(envelope.deniedCapabilities, ['devspace-write']);
  }
});

test('Wave 2 assurance roles reject write mode and never receive devspace-write', () => {
  for (const agentId of ['security-reviewer', 'reliability-observability', 'release-auditor']) {
    assert.throws(
      () => resolvePermissionEnvelope(request({
        agentId,
        mode: 'workspace-write',
        requestedCapabilities: ['devspace-write']
      })),
      /mode-exceeds-ceiling/
    );
    const envelope = resolvePermissionEnvelope(request({
      agentId,
      requestedCapabilities: ['devspace-write', 'github-read']
    }));
    assert.deepEqual(envelope.effectiveCapabilities, ['github-read']);
    assert.deepEqual(envelope.deniedCapabilities, ['devspace-write']);
  }
});

test('Wave 3 design roles are read-only except scoped frontend implementation', () => {
  for (const agentId of ['art-director', 'product-ux-designer', 'visual-systems-designer']) {
    assert.throws(
      () => resolvePermissionEnvelope(request({ agentId, mode: 'workspace-write' })),
      /mode-exceeds-ceiling/
    );
    assert.equal(expandedCapabilities(getAgent(agentId)).includes('devspace-write'), false);
  }

  assert.throws(
    () => resolvePermissionEnvelope(request({
      agentId: 'frontend-ux-engineer',
      mode: 'workspace-write',
      requestedCapabilities: ['devspace-write']
    })),
    /explicit-write-scopes-required/
  );
  const frontend = resolvePermissionEnvelope(request({
    agentId: 'frontend-ux-engineer',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write', 'tests'],
    writeScopes: ['src/ui', 'tests/ui']
  }));
  assert.deepEqual(frontend.writeScopes, ['src/ui', 'tests/ui']);
  assert.deepEqual(frontend.effectiveCapabilities, ['devspace-write', 'tests']);
});

test('director cannot gain write mode or capability while integrator requires a write envelope', () => {
  assert.throws(
    () => resolvePermissionEnvelope(request({
      agentId: 'orbital-director',
      mode: 'workspace-write',
      requestedCapabilities: ['devspace-write']
    })),
    /mode-exceeds-ceiling/
  );
  const director = resolvePermissionEnvelope(request({
    agentId: 'orbital-director',
    requestedCapabilities: ['devspace-write', 'github-read']
  }));
  assert.deepEqual(director.effectiveCapabilities, ['github-read']);
  assert.deepEqual(director.deniedCapabilities, ['devspace-write']);

  const readonlyIntegrator = resolvePermissionEnvelope(request({
    agentId: 'software-integrator',
    requestedCapabilities: ['devspace-write']
  }));
  assert.deepEqual(readonlyIntegrator.effectiveCapabilities, []);
  const writingIntegrator = resolvePermissionEnvelope(request({
    agentId: 'software-integrator',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write', 'tests']
  }));
  assert.deepEqual(writingIntegrator.effectiveCapabilities, ['devspace-write', 'tests']);
});

test('workspace root must be absolute, existing, a directory and equal to project root', () => {
  assert.throws(() => resolvePermissionEnvelope(request({ workspaceRoot: '.' })), /workspace-root-must-be-absolute/);
  assert.throws(
    () => resolvePermissionEnvelope(request({ workspaceRoot: path.join(ROOT, 'missing-directory') })),
    /workspace-root-not-found/
  );
  assert.throws(
    () => resolvePermissionEnvelope(request({ workspaceRoot: path.join(ROOT, 'package.json') })),
    /workspace-root-not-directory/
  );
  assert.throws(
    () => resolvePermissionEnvelope(request({ projectPolicy: { workspaceRoot: path.dirname(ROOT) } })),
    /workspace-root-outside-project/
  );
});

test('replaceable write scopes must be a subset of granted write scopes', () => {
  const catalog = capabilityCatalog();
  const policy = { allowedModes: ['workspace-write'], capabilityCeiling: catalog };
  assert.throws(() => resolvePermissionEnvelope({
    agentId: 'software-builder',
    principal: 'owner',
    surface: 'private',
    mode: 'workspace-write',
    workspaceRoot: ROOT,
    requestedCapabilities: [],
    writeScopes: ['src'],
    replaceableWriteScopes: ['tests'],
    callerPolicy: policy,
    projectPolicy: { ...policy, workspaceRoot: ROOT }
  }), /replaceable-write-scope-not-granted/);

  const resolved = resolvePermissionEnvelope({
    agentId: 'software-builder',
    principal: 'owner',
    surface: 'private',
    mode: 'workspace-write',
    workspaceRoot: ROOT,
    requestedCapabilities: [],
    writeScopes: ['src', 'tests'],
    replaceableWriteScopes: ['tests'],
    callerPolicy: policy,
    projectPolicy: { ...policy, workspaceRoot: ROOT }
  });
  assert.deepEqual(resolved.replaceableWriteScopes, ['tests']);
});

test('missing or malformed capability ceilings fail closed', () => {
  assert.throws(
    () => resolvePermissionEnvelope(request({ callerPolicy: { capabilityCeiling: undefined } })),
    /invalid-caller-capability-ceiling/
  );
  assert.throws(
    () => resolvePermissionEnvelope(request({ projectPolicy: { capabilityCeiling: ['not-a-capability'] } })),
    /unknown-project-capability-ceiling/
  );
  assert.throws(
    () => resolvePermissionEnvelope(request({ requestedCapabilities: ['not-a-capability'] })),
    /unknown-requested-capability/
  );
});

test('fabricated envelopes are rejected', () => {
  const fabricated = {
    schemaVersion: 1,
    resolved: true,
    agentId: 'software-builder',
    principal: 'owner',
    surface: 'private',
    mode: 'workspace-write',
    workspaceRoot: ROOT,
    requestedCapabilities: ['devspace-write'],
    effectiveCapabilities: ['devspace-write'],
    deniedCapabilities: []
  };
  assert.equal(isResolvedPermissionEnvelope(fabricated), false);
  assert.throws(() => assertResolvedPermissionEnvelope(fabricated), /unresolved-envelope/);
});

test('global discovery is separate from an agent runtime ceiling', () => {
  const global = capabilityCatalog();
  const architect = expandedCapabilities(getAgent('software-architect'));
  assert.ok(global.includes('devspace-write'));
  assert.equal(architect.includes('devspace-write'), false);
});

test('credentialed and approval-gated capabilities require caller and project approval', () => {
  const denied = resolvePermissionEnvelope(request({
    agentId: 'data-acquisition-scraping',
    requestedCapabilities: ['apify-api', 'web-search']
  }));
  assert.deepEqual(denied.effectiveCapabilities, ['web-search']);
  assert.deepEqual(denied.deniedCapabilities, ['apify-api']);
  assert.deepEqual(
    denied.capabilityDecisions.find((item) => item.capability === 'apify-api'),
    { capability: 'apify-api', status: 'DENIED', reason: 'authorization-required' }
  );

  const granted = resolvePermissionEnvelope(request({
    agentId: 'data-acquisition-scraping',
    requestedCapabilities: ['apify-api'],
    callerPolicy: {
      capabilityCeiling: ALL_CAPABILITIES,
      approvedCapabilities: ['apify-api']
    },
    projectPolicy: {
      capabilityCeiling: ALL_CAPABILITIES,
      approvedCapabilities: ['apify-api']
    }
  }));
  assert.deepEqual(granted.effectiveCapabilities, ['apify-api']);
});

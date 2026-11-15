import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArchitectOutput } from '../src/architect-output.mjs';

function output(overrides = {}) {
  return JSON.stringify({
    current_state: ['bounded state'],
    decisions: ['delegate implementation'],
    non_goals: ['no unrelated refactor'],
    open_gaps: [],
    pre_mortem: ['worker could exceed scope'],
    work_graph: {
      nodes: [{
        id: 'research',
        logicalAgent: 'research-evidence',
        objective: 'Collect bounded evidence.',
        dependsOn: [],
        expectedResult: 'Evidence summary.',
        validation: { type: 'non-empty-result' },
        retryPolicy: { maxAttempts: 1 },
        replicaCount: 1,
        mode: 'read-only',
        requestedCapabilities: ['web-search']
      }]
    },
    acceptance: ['Evidence is explicit.'],
    build_order: ['research: Do / Done when / Verify'],
    ...overrides
  });
}

test('architect output becomes a validated external work graph', () => {
  const parsed = parseArchitectOutput(output(), {
    project: 'orbital-operations',
    task: 'bounded task',
    surface: 'private'
  });
  assert.equal(parsed.schema, 'orbital.architect-output.v1');
  assert.equal(parsed.work_graph.schema, 'orbital.work-graph.v1');
  assert.equal(parsed.work_graph.nodes.length, 1);
  assert.equal(parsed.work_graph.nodes[0].logicalAgent, 'research-evidence');
  assert.deepEqual(parsed.work_graph.nodes[0].requestedCapabilities, ['web-search']);
});

test('parallel replicas use Antigravity exclusively, without introducing parallel Codex calls', () => {
  const plan = JSON.parse(output());
  plan.work_graph.nodes[0].replicaCount = 3;
  plan.work_graph.nodes[0].replicaObjectives = [
    'Research pricing in source A.', 'Research pricing in source B.', 'Research pricing in source C.'
  ];
  const parsed = parseArchitectOutput(JSON.stringify(plan));
  assert.equal(parsed.work_graph.nodes[0].replicaCount, 3);
  assert.deepEqual(parsed.work_graph.nodes[0].allowedProviders, ['antigravity']);
  assert.deepEqual(parsed.work_graph.nodes[0].replicaObjectives, plan.work_graph.nodes[0].replicaObjectives);

  plan.work_graph.nodes[0].allowedProviders = ['codex'];
  assert.throws(() => parseArchitectOutput(JSON.stringify(plan)), /node-replicas-require-antigravity/);
  plan.work_graph.nodes[0].allowedProviders = ['antigravity', 'codex'];
  assert.throws(() => parseArchitectOutput(JSON.stringify(plan)), /node-replicas-require-antigravity/);
});

test('independent nodes can explicitly select Antigravity while serial tasks retain Codex compatibility', () => {
  const plan = JSON.parse(output());
  plan.work_graph.nodes[0].allowedProviders = ['antigravity'];
  plan.work_graph.nodes.push({
    ...plan.work_graph.nodes[0], id: 'second', objective: 'Verify independent evidence.',
    allowedProviders: ['antigravity']
  });
  const parallel = parseArchitectOutput(JSON.stringify(plan));
  assert.deepEqual(parallel.work_graph.nodes.map((node) => node.allowedProviders), [
    ['antigravity'], ['antigravity']
  ]);

  const sequential = JSON.parse(output());
  sequential.work_graph.nodes[0].allowedProviders = ['codex'];
  assert.deepEqual(parseArchitectOutput(JSON.stringify(sequential)).work_graph.nodes[0].allowedProviders, ['codex']);
  sequential.work_graph.nodes[0].allowedProviders = ['other-provider'];
  assert.throws(() => parseArchitectOutput(JSON.stringify(sequential)), /node-providers/);
});

test('architect output supports evidence-result for executed evidence nodes', () => {
  const executed = JSON.parse(output());
  executed.work_graph.nodes[0].validation = { type: 'evidence-result' };
  const parsed = parseArchitectOutput(JSON.stringify(executed));
  assert.equal(parsed.work_graph.nodes[0].validation.type, 'evidence-result');
});

test('architect can encode binding QA and release validation without adding extra node keys', () => {
  for (const type of ['qa-go', 'release-pass']) {
    const graph = JSON.parse(output());
    graph.work_graph.nodes[0].validation = { type };
    assert.equal(parseArchitectOutput(JSON.stringify(graph)).work_graph.nodes[0].validation.type, type);
  }
});

test('architect may raise a node model class while lower requests clamp to the logical-role minimum and max stays forbidden', () => {
  const raised = parseArchitectOutput(JSON.stringify({
    current_state: ['ready'],
    decisions: ['use stronger worker model for this node'],
    non_goals: ['no max'],
    open_gaps: [],
    pre_mortem: ['quality'],
    work_graph: {
      nodes: [{
        id: 'build',
        logicalAgent: 'software-builder',
        objective: 'Implement a bounded difficult change.',
        expectedResult: 'working code',
        validation: { type: 'evidence-result' },
        retryPolicy: { maxAttempts: 1 },
        replicaCount: 1,
        mode: 'workspace-write',
        requestedCapabilities: [],
        specializations: [],
        writeScopes: ['tests'],
        modelClass: 'strong'
      }]
    },
    acceptance: ['code exists'],
    build_order: ['build: Do / Done / Verify']
  }), { project: 'orbital-operations', task: 'fixture', surface: 'private' });
  assert.equal(raised.work_graph.nodes[0].modelClass, 'strong');

  const base = JSON.parse(JSON.stringify({
    current_state: ['ready'], decisions: ['x'], non_goals: ['x'], open_gaps: [], pre_mortem: ['x'],
    work_graph: { nodes: [{
      id: 'review', logicalAgent: 'security-reviewer', objective: 'Review.',
      expectedResult: 'report', validation: { type: 'non-empty-result' },
      retryPolicy: { maxAttempts: 1 }, replicaCount: 1, mode: 'read-only',
      requestedCapabilities: [], specializations: [], modelClass: 'balanced'
    }]},
    acceptance: ['report'], build_order: ['review: Do / Done / Verify']
  }));
  const clamped = parseArchitectOutput(JSON.stringify(base), { project: 'orbital-operations', task: 'fixture' });
  assert.equal(clamped.work_graph.nodes[0].modelClass, 'strong');
  base.work_graph.nodes[0].modelClass = 'max';
  assert.throws(
    () => parseArchitectOutput(JSON.stringify(base), { project: 'orbital-operations', task: 'fixture' }),
    /node-model-class/
  );
});

test('architect output carries PROFILE_ONLY specializations only on compatible base roles', () => {
  const specialized = JSON.parse(output());
  specialized.work_graph.nodes[0] = {
    ...specialized.work_graph.nodes[0],
    logicalAgent: 'release-auditor',
    requestedCapabilities: ['screenshots'],
    specializations: ['video-frame-critic']
  };
  const parsed = parseArchitectOutput(JSON.stringify(specialized));
  assert.deepEqual(parsed.work_graph.nodes[0].specializations, ['video-frame-critic']);

  specialized.work_graph.nodes[0].logicalAgent = 'research-evidence';
  specialized.work_graph.nodes[0].requestedCapabilities = [];
  assert.throws(
    () => parseArchitectOutput(JSON.stringify(specialized)),
    /node-specialization-not-allowed-research:video-frame-critic/
  );
});

test('architect output accepts only the exact declared schema identifier when supplied', () => {
  const withSchema = JSON.parse(output());
  withSchema.schema = 'orbital.architect-output.v1';
  const parsed = parseArchitectOutput(JSON.stringify(withSchema));
  assert.equal(parsed.schema, 'orbital.architect-output.v1');

  withSchema.schema = 'orbital.architect-output.v999';
  assert.throws(() => parseArchitectOutput(JSON.stringify(withSchema)), /architect-output-invalid:schema/);
});

test('architect output rejects planner-only self delegation', () => {
  const self = JSON.parse(output());
  self.work_graph.nodes[0].logicalAgent = 'software-architect';
  assert.throws(() => parseArchitectOutput(JSON.stringify(self)), /worker-not-allowed-software-architect/);

  const director = JSON.parse(output());
  director.work_graph.nodes[0].logicalAgent = 'orbital-director';
  assert.throws(() => parseArchitectOutput(JSON.stringify(director)), /worker-not-allowed-orbital-director/);
});

test('architect output can route to every executable non-planner specialist', () => {
  const agents = [
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
    'data-acquisition-scraping',
    'outbound-strategist',
    'sales-engineer'
  ];
  for (const logicalAgent of agents) {
    const planned = JSON.parse(output());
    planned.work_graph.nodes[0] = {
      ...planned.work_graph.nodes[0],
      logicalAgent,
      mode: 'read-only',
      requestedCapabilities: [],
      writeScopes: []
    };
    const parsed = parseArchitectOutput(JSON.stringify(planned));
    assert.equal(parsed.work_graph.nodes[0].logicalAgent, logicalAgent);
  }
});

test('architect output permits social content production only with explicit write scopes', () => {
  const invalid = JSON.parse(output());
  invalid.work_graph.nodes[0] = {
    ...invalid.work_graph.nodes[0],
    logicalAgent: 'social-content-producer',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write'],
    writeScopes: []
  };
  assert.throws(() => parseArchitectOutput(JSON.stringify(invalid)), /node-write-scope-required/);

  invalid.work_graph.nodes[0].writeScopes = ['artifacts/social'];
  const parsed = parseArchitectOutput(JSON.stringify(invalid));
  assert.equal(parsed.work_graph.nodes[0].logicalAgent, 'social-content-producer');
  assert.deepEqual(parsed.work_graph.nodes[0].writeScopes, ['artifacts/social']);
});

test('architect output rejects capabilities outside the worker ceiling', () => {
  const invalid = JSON.parse(output());
  invalid.work_graph.nodes[0].requestedCapabilities = ['devspace-write'];
  assert.throws(() => parseArchitectOutput(JSON.stringify(invalid)), /node-capability-exceeds-agent/);
});

test('architect output enforces graph size, replica and retry ceilings', () => {
  const tooMany = JSON.parse(output());
  tooMany.work_graph.nodes = Array.from({ length: 13 }, (_, index) => ({
    ...tooMany.work_graph.nodes[0],
    id: 'node-' + index
  }));
  assert.throws(() => parseArchitectOutput(JSON.stringify(tooMany)), /work-graph-nodes/);

  const replicas = JSON.parse(output());
  replicas.work_graph.nodes[0].replicaCount = 4;
  assert.throws(() => parseArchitectOutput(JSON.stringify(replicas)), /node-replicas/);

  const retries = JSON.parse(output());
  retries.work_graph.nodes[0].retryPolicy.maxAttempts = 3;
  assert.throws(() => parseArchitectOutput(JSON.stringify(retries)), /node-retry/);
});

test('architect output rejects workspace-write for non-builder workers', () => {
  const invalid = JSON.parse(output());
  invalid.work_graph.nodes[0].mode = 'workspace-write';
  assert.throws(() => parseArchitectOutput(JSON.stringify(invalid)), /node-mode/);
});

test('architect output requires explicit write scopes for workspace-write builder nodes', () => {
  const invalid = JSON.parse(output());
  invalid.work_graph.nodes[0] = {
    ...invalid.work_graph.nodes[0],
    logicalAgent: 'software-builder',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write'],
    writeScopes: []
  };
  assert.throws(() => parseArchitectOutput(JSON.stringify(invalid)), /node-write-scope-required/);
});

test('architect output permits integrator writes only with explicit scopes', () => {
  const scoped = JSON.parse(output());
  scoped.work_graph.nodes[0] = {
    ...scoped.work_graph.nodes[0],
    logicalAgent: 'software-integrator',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write', 'tests'],
    writeScopes: ['src']
  };
  const parsed = parseArchitectOutput(JSON.stringify(scoped));
  assert.equal(parsed.work_graph.nodes[0].logicalAgent, 'software-integrator');
  assert.deepEqual(parsed.work_graph.nodes[0].replicaWriteScopes, [['src']]);

  scoped.work_graph.nodes[0].writeScopes = [];
  assert.throws(() => parseArchitectOutput(JSON.stringify(scoped)), /node-write-scope-required/);
});

test('architect output permits bounded frontend-ux-engineer writes with explicit scopes', () => {
  const scoped = JSON.parse(output());
  scoped.work_graph.nodes[0] = {
    ...scoped.work_graph.nodes[0],
    logicalAgent: 'frontend-ux-engineer',
    mode: 'workspace-write',
    requestedCapabilities: ['devspace-write', 'frontend-design'],
    writeScopes: ['src/ui']
  };
  const parsed = parseArchitectOutput(JSON.stringify(scoped));
  assert.equal(parsed.work_graph.nodes[0].logicalAgent, 'frontend-ux-engineer');
  assert.deepEqual(parsed.work_graph.nodes[0].replicaWriteScopes, [['src/ui']]);

  scoped.work_graph.nodes[0].writeScopes = [];
  assert.throws(() => parseArchitectOutput(JSON.stringify(scoped)), /node-write-scope-required/);
});

test('architect output permits bounded video-editor writes with explicit scopes', () => {
  const scoped = JSON.parse(output());
  scoped.work_graph.nodes[0] = {
    ...scoped.work_graph.nodes[0],
    logicalAgent: 'video-editor',
    mode: 'workspace-write',
    requestedCapabilities: ['remotion', 'ffmpeg'],
    writeScopes: ['content-factory/workspaces/autonomy-canary']
  };
  const parsed = parseArchitectOutput(JSON.stringify(scoped));
  assert.equal(parsed.work_graph.nodes[0].logicalAgent, 'video-editor');
  assert.equal(parsed.work_graph.nodes[0].mode, 'workspace-write');
  assert.deepEqual(
    parsed.work_graph.nodes[0].replicaWriteScopes,
    [['content-factory/workspaces/autonomy-canary']]
  );

  scoped.work_graph.nodes[0].writeScopes = [];
  assert.throws(() => parseArchitectOutput(JSON.stringify(scoped)), /node-write-scope-required/);
});

test('content and art directors remain read-only in external work graphs', () => {
  for (const logicalAgent of ['content-director', 'art-director']) {
    const valid = JSON.parse(output());
    valid.work_graph.nodes[0] = {
      ...valid.work_graph.nodes[0],
      logicalAgent,
      mode: 'read-only',
      requestedCapabilities: []
    };
    assert.equal(parseArchitectOutput(JSON.stringify(valid)).work_graph.nodes[0].mode, 'read-only');

    valid.work_graph.nodes[0].mode = 'workspace-write';
    valid.work_graph.nodes[0].writeScopes = ['content-factory/workspaces/autonomy-canary'];
    assert.throws(() => parseArchitectOutput(JSON.stringify(valid)), /node-mode/);
  }
});

test('architect output rejects unknown root and node fields', () => {
  const unknownRoot = JSON.parse(output());
  unknownRoot.debug_notes = ['must not pass through'];
  assert.throws(() => parseArchitectOutput(JSON.stringify(unknownRoot)), /root-unknown-fields/);

  const unknownNode = JSON.parse(output());
  unknownNode.work_graph.nodes[0].provider = 'codex';
  assert.throws(() => parseArchitectOutput(JSON.stringify(unknownNode)), /node-0-unknown-fields/);
});

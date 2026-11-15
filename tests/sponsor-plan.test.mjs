import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMissionBudget, sponsorPlanAllowedWriteScopes, validateSponsorPlan } from '../src/sponsor-plan.mjs';

function fixture() {
  return {
    schema: 'orbital.sponsor-plan.v1',
    objective: 'Build and verify a bounded feature.',
    summary: 'The Sponsor already resolved the intended feature and its acceptance criteria.',
    acceptance: ['Feature works.', 'Verification passes.'],
    constraints: ['Do not publish externally.'],
    nonGoals: ['No unrelated refactor.'],
    references: ['PROJECT_CONTEXT.md'],
    workPackages: [
      {
        id: 'build',
        objective: 'Implement the feature in the approved scope.',
        dependsOn: [],
        expectedResult: 'Working implementation.',
        validation: 'evidence-result',
        modeHint: 'workspace-write',
        writeScopes: ['src'],
        requestedCapabilities: []
      },
      {
        id: 'verify',
        objective: 'Verify the implemented feature.',
        dependsOn: ['build'],
        expectedResult: 'Observed verification evidence.',
        validation: 'evidence-result',
        modeHint: 'read-only',
        writeScopes: [],
        requestedCapabilities: [],
        preferredRole: 'qa-e2e'
      }
    ]
  };
}

test('Sponsor plan validates a bounded immutable work-package contract', () => {
  const plan = validateSponsorPlan(fixture());
  assert.equal(plan.schema, 'orbital.sponsor-plan.v1');
  assert.equal(plan.routingMode, 'legacy-auto');
  assert.equal(plan.workPackages.length, 2);
  assert.deepEqual(plan.workPackages[1].dependsOn, ['build']);
  assert.deepEqual(sponsorPlanAllowedWriteScopes(plan), ['src']);
});

test('Sponsor plan makes routing ownership explicit without breaking historical plans', () => {
  const directorLed = fixture();
  directorLed.routingMode = 'director-led';
  assert.equal(validateSponsorPlan(directorLed).routingMode, 'director-led');

  const sponsorBoundIncomplete = fixture();
  sponsorBoundIncomplete.routingMode = 'sponsor-bound';
  assert.throws(
    () => validateSponsorPlan(sponsorBoundIncomplete),
    /sponsor-bound-package-not-fully-bound/
  );

  const sponsorBound = fixture();
  sponsorBound.routingMode = 'sponsor-bound';
  sponsorBound.workPackages[0].preferredRole = 'software-builder';
  sponsorBound.workPackages[1].preferredRole = 'qa-e2e';
  assert.equal(validateSponsorPlan(sponsorBound).routingMode, 'sponsor-bound');

  const invalid = fixture();
  invalid.routingMode = 'director-ish';
  assert.throws(() => validateSponsorPlan(invalid), /routing-mode/);
});

test('Sponsor plan can tighten mission recovery/time budgets without widening global ceilings', () => {
  const input = fixture();
  input.budget = {
    maxSteerRounds: 4,
    maxReplanRounds: 6,
    maxDirectorReviews: 12,
    maxProviderWaitCycles: 8,
    maxProviderWaitAgeMs: 3_600_000
  };
  assert.deepEqual(validateSponsorPlan(input).budget, input.budget);
  assert.deepEqual(normalizeMissionBudget({ maxReplanRounds: 2 }), { maxReplanRounds: 2 });
  assert.throws(() => normalizeMissionBudget({ maxReplanRounds: 33 }), /budget-maxReplanRounds/);
  assert.throws(() => normalizeMissionBudget({ maxProviderWaitAgeMs: 691200001 }), /budget-maxProviderWaitAgeMs/);
  assert.throws(() => normalizeMissionBudget({}), /budget-empty/);
});

test('Sponsor can require typed signed QA and release verdicts on exact packages', () => {
  const input = fixture();
  input.workPackages[1].validation = 'qa-go';
  assert.equal(validateSponsorPlan(input).workPackages[1].validation, 'qa-go');
  input.workPackages[1].validation = 'release-pass';
  assert.equal(validateSponsorPlan(input).workPackages[1].validation, 'release-pass');
});

test('Sponsor can declare a non-binding pre-final review-result package', () => {
  const input = fixture();
  input.workPackages[1].validation = 'review-result';
  input.workPackages[1].preferredRole = 'release-auditor';
  input.workPackages[1].specializations = ['video-frame-critic'];
  const plan = validateSponsorPlan(input);
  assert.equal(plan.workPackages[1].validation, 'review-result');
  assert.deepEqual(plan.workPackages[1].specializations, ['video-frame-critic']);
});

test('Sponsor can request explicit worker-vs-host preflight without inventing permission grants', () => {
  const plan = fixture();
  plan.workPackages[0].capabilityRequirements = {
    workerPublicHttps: true, ownerHostPublicHttps: true
  };
  assert.equal(validateSponsorPlan(plan).workPackages[0].capabilityRequirements.workerPublicHttps, true);
  plan.workPackages[0].capabilityRequirements.ownerHostPublicHttps = 'AVAILABLE';
  assert.throws(() => validateSponsorPlan(plan), /package-capability-requirements/);
  plan.workPackages[0].capabilityRequirements = { unauthorizedRootShell: true };
  assert.throws(() => validateSponsorPlan(plan), /package-capability-requirements/);
});



test('Sponsor can hash-bind one bounded host runtime request without embedding secrets', () => {
  const input = fixture();
  input.workPackages[1].requestedCapabilities = ['playwright'];
  input.workPackages[1].runtimeRequest = {
    action: 'flow-read-inspect',
    profile: 'google-pro-01',
    operation: 'character-list',
    project: '80e5ce29-1334-487d-bbe9-8fcbf14913dc'
  };
  const plan = validateSponsorPlan(input);
  assert.deepEqual(plan.workPackages[1].runtimeRequest, input.workPackages[1].runtimeRequest);

  const secret = fixture();
  secret.workPackages[1].runtimeRequest = {
    action: 'flow-read-inspect',
    cookie: 'must-never-enter-a-plan'
  };
  assert.throws(() => validateSponsorPlan(secret), /package-runtime-request-secret-key-verify:cookie/);

  const malformed = fixture();
  malformed.workPackages[1].runtimeRequest = 'flow-read-inspect';
  assert.throws(() => validateSponsorPlan(malformed), /package-runtime-request-verify/);
});
test('protected marker/state writes require sole integrator after physically attested QA and independent release', () => {
  const input = fixture();
  input.workPackages[0].writeScopes = ['docs/research/study/data/state'];
  input.workPackages[0].preferredRole = 'software-builder';
  assert.throws(() => validateSponsorPlan(input), /protected-state-integrator-only/);
  input.workPackages = [
    { id: 'qa', objective: 'Independent QA', dependsOn: [], expectedResult: 'QA report',
      validation: 'qa-go', requireArtifact: true, modeHint: 'read-only',
      writeScopes: [], requestedCapabilities: [], preferredRole: 'code-auditor' },
    { id: 'release', objective: 'Independent release', dependsOn: ['qa'], expectedResult: 'Release verdict',
      validation: 'release-pass', requireArtifact: true, modeHint: 'read-only',
      writeScopes: [], requestedCapabilities: [], preferredRole: 'code-auditor' },
    { id: 'promote', objective: 'Atomically activate marker', dependsOn: ['release'], expectedResult: 'Valid host marker',
      validation: 'evidence-result', modeHint: 'workspace-write',
      writeScopes: ['docs/research/study/data/state'], requestedCapabilities: [], preferredRole: 'software-integrator' }
  ];
  assert.deepEqual(validateSponsorPlan(input).workPackages[0].requireArtifact, true);
  input.workPackages[1].requireArtifact = false;
  assert.throws(() => validateSponsorPlan(input), /protected-state-dual-attested-gate-required/);
  input.workPackages[1].requireArtifact = true;
  input.workPackages[2].dependsOn = ['qa'];
  assert.throws(() => validateSponsorPlan(input), /protected-state-dual-attested-gate-required/);
});

test('Sponsor plan rejects missing dependencies and unsafe write hints', () => {
  const missingDependency = fixture();
  missingDependency.workPackages[1].dependsOn = ['unknown'];
  assert.throws(() => validateSponsorPlan(missingDependency), /package-dependency-missing/);

  const readonlyWrite = fixture();
  readonlyWrite.workPackages[1].writeScopes = ['src'];
  assert.throws(() => validateSponsorPlan(readonlyWrite), /package-readonly-write-scopes/);

  const writerWithoutScope = fixture();
  writerWithoutScope.workPackages[0].writeScopes = [];
  assert.throws(() => validateSponsorPlan(writerWithoutScope), /package-write-scopes/);
});

test('Sponsor plan can delegate capability selection while preserving explicit capability contracts', () => {
  const input = fixture();
  delete input.workPackages[1].requestedCapabilities;
  const delegated = validateSponsorPlan(input);
  assert.equal(delegated.workPackages[1].requestedCapabilities, null);
  assert.equal(validateSponsorPlan(delegated).workPackages[1].requestedCapabilities, null);

  const explicit = fixture();
  explicit.workPackages[1].requestedCapabilities = [];
  assert.deepEqual(validateSponsorPlan(explicit).workPackages[1].requestedCapabilities, []);
});

test('Sponsor plan rejects unknown fields instead of silently widening the contract', () => {
  const plan = fixture();
  plan.allowProductionMutation = true;
  assert.throws(() => validateSponsorPlan(plan), /root-field-allowProductionMutation/);
});

test('Sponsor plan can pin providers and exact package capability grants', () => {
  const input = fixture();
  input.allowedProviders = ['antigravity'];
  input.providerConstraintReason = 'This canary explicitly validates the Antigravity runtime path.';
  input.workPackages[0].requestedCapabilities = [];
  input.workPackages[0].specializations = ['video-frame-critic'];
  input.workPackages[1].allowedProviders = ['antigravity'];
  input.workPackages[1].providerConstraintReason = 'The verification package exercises the same provider-specific canary path.';
  const plan = validateSponsorPlan(input);
  assert.deepEqual(plan.allowedProviders, ['antigravity']);
  assert.match(plan.providerConstraintReason, /canary/i);
  assert.deepEqual(plan.workPackages[0].requestedCapabilities, []);
  assert.deepEqual(plan.workPackages[0].specializations, ['video-frame-critic']);
  assert.deepEqual(plan.workPackages[1].allowedProviders, ['antigravity']);
});

test('Sponsor plan schema remains backwards-compatible with historical singleton provider restrictions', () => {
  const rootPin = fixture();
  rootPin.allowedProviders = ['codex'];
  assert.deepEqual(validateSponsorPlan(rootPin).allowedProviders, ['codex']);

  const packagePin = fixture();
  packagePin.workPackages[1].allowedProviders = ['codex'];
  assert.deepEqual(validateSponsorPlan(packagePin).workPackages[1].allowedProviders, ['codex']);
});

test('Sponsor plan rejects unknown provider ids', () => {
  const input = fixture();
  input.allowedProviders = ['mystery-provider'];
  assert.throws(() => validateSponsorPlan(input), /allowed-providers/);
});

test('Sponsor plan rejects bundle aliases presented as capability ids before dispatch', () => {
  const input = fixture();
  input.workPackages[1].requestedCapabilities = ['browser-qa'];
  assert.throws(
    () => validateSponsorPlan(input),
    /package-requested-capability-unknown-verify:browser-qa/
  );
});

test('Sponsor plan rejects a fixed role whose runtime mode cannot satisfy the package', () => {
  const input = fixture();
  input.workPackages[0].preferredRole = 'qa-e2e';
  assert.throws(
    () => validateSponsorPlan(input),
    /package-preferred-role-mode-incompatible-build:qa-e2e:workspace-write/
  );
});

test('Sponsor plan rejects planner-only roles before deterministic compilation can fail later', () => {
  const input = fixture();
  input.workPackages[1].preferredRole = 'software-architect';
  assert.throws(
    () => validateSponsorPlan(input),
    /package-preferred-role-not-executable-verify:software-architect/
  );
});

test('Sponsor plan rejects absolute or parent-traversal writeScopes at submit preflight', () => {
  for (const invalidScope of ['/srv/orbital/workspaces/example-mobile-audit-evidence', '../outside', 'src/../escape']) {
    const input = fixture();
    input.workPackages[0].writeScopes = [invalidScope];
    assert.throws(
      () => validateSponsorPlan(input),
      /package-write-scope-invalid-build:/
    );
  }
});

test('Sponsor plan rejects read-only validation gates (qa-go, release-pass, review-result) combined with workspace-write even when preferredRole is omitted', () => {
  for (const validation of ['qa-go', 'release-pass', 'review-result']) {
    const input = fixture();
    delete input.workPackages[1].preferredRole;
    input.workPackages[1].validation = validation;
    input.workPackages[1].modeHint = 'workspace-write';
    input.workPackages[1].writeScopes = ['reports/audit'];
    assert.throws(
      () => validateSponsorPlan(input),
      new RegExp(`package-validation-mode-incompatible-verify:${validation}:workspace-write`)
    );
  }
});

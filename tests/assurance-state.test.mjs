import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAssuranceState } from '../src/assurance-state.mjs';

test('green graph with QA_BLOCK or inner release FAIL never becomes operational', () => {
  const base = { graphState: 'PASS', controllerTerminal: 'BLOCKED',
    qaVerdicts: [{ verdict: 'QA_BLOCK' }], markerAuthorization: 'AUTHORIZED' };
  const v = summarizeAssuranceState(base);
  assert.equal(v.workerExecution, 'PASS');
  assert.equal(v.innerQa, 'QA_BLOCK');
  assert.equal(v.overall, 'BLOCKED');
  assert.equal(v.firstRealSample, 'UNOBSERVED');
  const release = summarizeAssuranceState({
    graphState: 'PASS', controllerTerminal: 'PASS',
    qaVerdicts: [{ verdict: 'QA_GO' }],
    releaseVerdicts: [{ verdict: 'FAIL' }],
    markerAuthorization: 'AUTHORIZED', firstVerifiedSampleCount: 0
  });
  assert.equal(release.overall, 'BLOCKED');
});

test('a real approved marker arms bootstrap but does not prove a real sample or entire study', () => {
  const base = { graphState: 'PASS', controllerTerminal: 'PASS',
    qaVerdicts: [{ verdict: 'QA_GO' }], releaseVerdicts: [{ verdict: 'PASS' }],
    markerAuthorization: 'AUTHORIZED', firstVerifiedSampleCount: 0,
    totalSlots: 102, completedSlots: 0 };
  assert.equal(summarizeAssuranceState(base).overall, 'ARMED_BOOTSTRAP');
  assert.equal(summarizeAssuranceState({
    ...base, firstVerifiedSampleCount: 1, completedSlots: 1, explicitStudyComplete: true
  }).overall, 'FIRST_VERIFIED_REAL_SAMPLE');
  const done = summarizeAssuranceState({
    ...base, firstVerifiedSampleCount: 102, completedSlots: 102, explicitStudyComplete: true
  });
  assert.equal(done.overall, 'STUDY_COMPLETED_WITH_VERIFIED_SAMPLES');
  assert.equal(done.studyComplete, true);
  assert.equal(summarizeAssuranceState({
    ...base, firstVerifiedSampleCount: 102, completedSlots: 102
  }).studyComplete, false, 'time/count alone cannot attest study completed');
});

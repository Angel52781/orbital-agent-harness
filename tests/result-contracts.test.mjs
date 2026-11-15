test("evidence-result normalizes root auditVerdict QA_GO into status PASS and substantive evidence", () => {
  const result = validateEvidenceResult(JSON.stringify({
    auditVerdict: "QA_GO",
    scope: "local-ci-readiness",
    targetCommit: "4dee5fdeef727ed7a3af10fd779cb930c0e059f2",
    branch: "ci/preview-28-candidate"
  }));
  assert.equal(result.ok, true);
  assert.equal(result.parsed.status, "PASS");
  assert.equal(result.parsed.evidence.auditVerdict, "QA_GO");
  assert.equal(result.parsed.evidence.targetCommit, "4dee5fdeef727ed7a3af10fd779cb930c0e059f2");
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEvidenceResult, validateReviewResult } from '../src/result-contracts.mjs';

test('evidence-result rejects prose plans and empty evidence', () => {
  assert.equal(validateEvidenceResult('# Implementation Plan\nAwaiting confirmation.').ok, false);
  assert.equal(validateEvidenceResult(JSON.stringify({ status: 'PASS', evidence: {} })).ok, false);
});

test('evidence-result accepts only structured PASS with substantive evidence', () => {
  const result = validateEvidenceResult(JSON.stringify({
    status: 'PASS',
    evidence: { observed: true, digest: 'abc123' }
  }));
  assert.equal(result.ok, true);
  assert.equal(result.parsed.status, 'PASS');
});

test('evidence-result recovers one balanced JSON object surrounded by provider prose', () => {
  const result = validateEvidenceResult([
    'Audit complete.',
    JSON.stringify({ status: 'PASS', evidence: { observed: true } }),
    'End of response.'
  ].join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.parsed.status, 'PASS');
});

test('evidence-result can normalize an explicit audit verdict without masking execution failure', () => {
  const normalized = validateEvidenceResult(JSON.stringify({
    status: 'FAIL',
    evidence: { auditVerdict: 'FAIL', findings: ['P0 backup missing'] }
  }), { verdictAsEvidence: true });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.parsed.status, 'PASS');
  assert.equal(normalized.parsed.workerReportedStatus, 'FAIL');
  assert.equal(normalized.normalization.kind, 'AUDIT_VERDICT_STATUS');

  const realFailure = validateEvidenceResult(JSON.stringify({
    status: 'FAIL',
    evidence: { reason: 'could not inspect repository' }
  }), { verdictAsEvidence: true });
  assert.equal(realFailure.ok, false);
  assert.equal(realFailure.reasonCode, 'EVIDENCE_RESULT_STATUS_FAIL');
});

test('review-result accepts non-binding REVIEW_PASS and REVISE verdicts', () => {
  for (const reviewVerdict of ['REVIEW_PASS', 'REVISE', 'ACCEPT_FOR_USER_REVIEW']) {
    const result = validateReviewResult(JSON.stringify({
      status: 'PASS',
      evidence: { reviewVerdict, findings: reviewVerdict === 'REVISE' ? ['tighten scene'] : [] }
    }));
    assert.equal(result.ok, true);
    assert.equal(result.reviewVerdict, reviewVerdict);
  }
});

test('review-result rejects binding QA/release verdict fields and missing review verdicts', () => {
  const release = validateReviewResult(JSON.stringify({
    status: 'PASS',
    evidence: { reviewVerdict: 'REVISE', releaseVerdict: 'REVISE', findings: ['fixture'] }
  }));
  assert.equal(release.ok, false);
  assert.equal(release.reasonCode, 'REVIEW_RESULT_BINDING_VERDICT_FORBIDDEN');

  const missing = validateReviewResult(JSON.stringify({
    status: 'PASS',
    evidence: { findings: ['fixture'] }
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, 'REVIEW_RESULT_VERDICT_MISSING_OR_INVALID');
});

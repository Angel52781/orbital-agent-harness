import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOCIAL_RELEASE_SCHEMA,
  VIDEO_REVIEW_CATEGORIES,
  validateSocialReleaseContract,
  validateVideoFinalReviewGate
} from '../examples/social-media-bridges/social-release-gate.mjs';

test('social release contract enforces explicit hash binding and bounded publish window', () => {
  const job = {
    schema: SOCIAL_RELEASE_SCHEMA,
    slug: 'deterministic-agent-harness-launch',
    approval: { explicit: true, reference: 'docs/social/launch-approval.md' },
    mediaSha256: 'a'.repeat(64),
    copySha256: 'b'.repeat(64),
    scheduledAt: '2026-11-15T12:00:00Z',
    expiresAt: '2026-11-16T12:00:00Z'
  };
  const due = validateSocialReleaseContract(job, { now: new Date('2026-11-15T18:00:00Z') });
  assert.equal(due.ok, true);
  assert.equal(due.action, 'DUE');

  assert.throws(
    () => validateSocialReleaseContract({ ...job, approval: { explicit: false } }),
    /EXPLICIT_APPROVAL_MISSING/
  );
});

test('video final review gate blocks unverified pixels or drifted MP4 SHA-256 across YouTube/TikTok/Instagram pipelines', () => {
  const categories = Object.fromEntries(VIDEO_REVIEW_CATEGORIES.map((c) => [c, 'PASS']));
  const validReview = {
    schemaVersion: 1,
    contentId: 'short-001',
    master: { path: 'renders/master.mp4', sha256: 'c'.repeat(64), audioMode: 'voice' },
    review: {
      exactMasterReviewed: true,
      fullTemporalCoverageReviewed: true,
      renderedPixelsReviewed: true,
      independentReviewer: true,
      reviewer: 'release-auditor',
      categories,
      openCounts: { P0: 0, P1: 0, P2: 0 },
      verdict: 'PASS'
    },
    delivery: { ready: true }
  };

  assert.equal(validateVideoFinalReviewGate(validReview, { actualMasterSha256: 'c'.repeat(64) }).ok, true);
  assert.equal(validateVideoFinalReviewGate(validReview, { actualMasterSha256: 'd'.repeat(64) }).reasonCode, 'MASTER_SHA256_DRIFT');
});

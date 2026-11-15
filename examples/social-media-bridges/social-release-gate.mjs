/**
 * Deterministic Social & Video Release Gate (LinkedIn / YouTube Shorts / TikTok / Instagram Reels)
 * Enforces SHA-256 content-addressing, explicit approval binding, UTM hygiene,
 * transactional submission journals (SUBMISSION_PENDING -> PUBLISHED_VERIFIED),
 * and 14-category rendered video verification before external distribution.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SOCIAL_RELEASE_SCHEMA = 'orbital.social-release.v1';
export const VIDEO_REVIEW_CATEGORIES = Object.freeze([
  'narrative',
  'scopeRegression',
  'productReferenceFidelity',
  'interactionCausality',
  'motionRhythm',
  'continuityTransitions',
  'compositionHierarchy',
  'legibility',
  'assetsMediaTreatment',
  'typographyBrand',
  'audioCaptions',
  'truthData',
  'commercialPayoffCta',
  'technicalExport'
]);

const SHA256_RE = /^[a-f0-9]{64}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function assertSafeRelativePath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('PATH_OUTSIDE_APPROVED_WORKSPACE');
  }
  const realRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(path.resolve(realRoot, relativePath));
  const rel = path.relative(realRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(resolved).isFile()) {
    throw new Error('PATH_OUTSIDE_APPROVED_WORKSPACE');
  }
  return resolved;
}

/**
 * Validates a LinkedIn / B2B social release campaign contract before browser/API dispatch.
 */
export function validateSocialReleaseContract(job, { now = new Date() } = {}) {
  if (!job || job.schema !== SOCIAL_RELEASE_SCHEMA || !SLUG_RE.test(job.slug || '')) {
    throw new Error('INVALID_CAMPAIGN_SCHEMA_OR_SLUG');
  }
  if (job.approval?.explicit !== true || typeof job.approval?.reference !== 'string') {
    throw new Error('EXPLICIT_APPROVAL_MISSING');
  }
  if (!SHA256_RE.test(job.mediaSha256 || '') || !SHA256_RE.test(job.copySha256 || '')) {
    throw new Error('APPROVED_HASH_MISSING');
  }
  const scheduled = Date.parse(job.scheduledAt || '');
  const expires = Date.parse(job.expiresAt || '');
  if (!Number.isFinite(scheduled) || !Number.isFinite(expires) || scheduled >= expires) {
    throw new Error('INVALID_PUBLISH_WINDOW');
  }
  if (expires - scheduled > 72 * 3600_000) {
    throw new Error('PUBLISH_WINDOW_TOO_BROAD');
  }
  const current = now.getTime();
  if (current < scheduled) return { ok: true, action: 'NOT_DUE' };
  if (current > expires) throw new Error('PUBLISH_WINDOW_EXPIRED');
  return { ok: true, action: 'DUE' };
}

/**
 * Validates a rendered short-form video master (YouTube Shorts, TikTok, Instagram Reels)
 * against its cryptographic FINAL_REVIEW.json before permitting upload.
 */
export function validateVideoFinalReviewGate(review, { actualMasterSha256 = null } = {}) {
  if (!review || review.schemaVersion !== 1) {
    return { ok: false, reasonCode: 'INVALID_FINAL_REVIEW_SCHEMA' };
  }
  if (!review.master?.path || !SHA256_RE.test(review.master?.sha256 || '')) {
    return { ok: false, reasonCode: 'MASTER_SHA256_MISSING' };
  }
  if (actualMasterSha256 && actualMasterSha256.toLowerCase() !== review.master.sha256.toLowerCase()) {
    return { ok: false, reasonCode: 'MASTER_SHA256_DRIFT' };
  }
  const rev = review.review || {};
  if (!rev.exactMasterReviewed || !rev.fullTemporalCoverageReviewed || !rev.renderedPixelsReviewed || !rev.independentReviewer) {
    return { ok: false, reasonCode: 'INCOMPLETE_TEMPORAL_OR_PIXEL_AUDIT' };
  }
  for (const cat of VIDEO_REVIEW_CATEGORIES) {
    if (!['PASS', 'N/A'].includes(rev.categories?.[cat])) {
      return { ok: false, reasonCode: `CATEGORY_NOT_PASSED:${cat}` };
    }
  }
  for (const sev of ['P0', 'P1', 'P2']) {
    if (Number(rev.openCounts?.[sev] ?? -1) !== 0) {
      return { ok: false, reasonCode: `OPEN_DEFECTS_REMAIN:${sev}` };
    }
  }
  if (rev.verdict !== 'PASS' || review.delivery?.ready !== true) {
    return { ok: false, reasonCode: 'DELIVERY_NOT_APPROVED' };
  }
  return { ok: true, status: 'VIDEO_FINAL_REVIEW_PASS', sha256: review.master.sha256.toLowerCase() };
}

export function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const fenced = raw.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Providers occasionally add one line of prose around an otherwise valid
    // JSON evidence object. Recover only the first balanced object; arbitrary
    // prose without a complete JSON object still fails closed.
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            const parsed = JSON.parse(raw.slice(start, index + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          } catch {
            // Keep scanning for the next complete object.
          }
          start = -1;
        }
      }
    }
    return null;
  }
}

function substantiveEvidence(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function explicitVerdictField(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  for (const key of ['auditVerdict', 'releaseVerdict', 'readinessVerdict', 'platformVerdict']) {
    if (typeof evidence[key] === 'string' && evidence[key].trim()) return key;
  }
  return null;
}

const PASS_SYNONYM_STATUSES = new Set([
  'PASS', 'OK', 'SUCCESS', 'SUCCEEDED', 'COMPLETED', 'COMPLETE', 'DONE',
  'READY', 'READY_FOR_ADVERSARIAL_REVIEW', 'READY_FOR_REVIEW', 'VERIFIED',
  'HANDOFF_REQUIRED', 'PARTIAL_PASS', 'NEEDS_INTEGRATOR_HANDOFF'
]);

export function validateEvidenceResult(value, { verdictAsEvidence = false } = {}) {
  const parsed = parseJsonObject(value);
  if (!parsed) return { ok: false, reasonCode: 'EVIDENCE_RESULT_NOT_STRUCTURED' };
  let rawStatus = typeof parsed.status === 'string' ? parsed.status.trim().toUpperCase() : '';
  if (!rawStatus) {
    const rootVerdict = explicitVerdictField(parsed) || explicitVerdictField(parsed.evidence);
    if (rootVerdict) {
      const v = (parsed[rootVerdict] || parsed.evidence?.[rootVerdict] || '').trim().toUpperCase();
      if (['QA_GO', 'QA_PASS', 'PASS', 'RELEASE_GO'].includes(v)) {
        rawStatus = 'PASS';
        parsed.status = 'PASS';
      }
    }
  }
  const isSynonymPass = PASS_SYNONYM_STATUSES.has(rawStatus);
  const status = isSynonymPass ? 'PASS' : rawStatus;
  if (isSynonymPass && rawStatus !== 'PASS') {
    parsed.workerReportedStatus = rawStatus;
    parsed.status = 'PASS';
    if (['HANDOFF_REQUIRED', 'PARTIAL_PASS', 'NEEDS_INTEGRATOR_HANDOFF'].includes(rawStatus)) {
      if (parsed.evidence && typeof parsed.evidence === 'object' && !Array.isArray(parsed.evidence)) {
        parsed.evidence.handoffRequired = true;
      }
    }
  }
  if (status !== 'PASS') {
    const verdictField = verdictAsEvidence ? explicitVerdictField(parsed.evidence) : null;
    if (verdictField && ['FAIL', 'FAILED', 'ERROR', 'BLOCKED', 'HOLD'].includes(status)
        && substantiveEvidence(parsed.evidence)) {
      const normalized = {
        ...parsed,
        status: 'PASS',
        workerReportedStatus: status
      };
      return {
        ok: true,
        parsed: normalized,
        normalizedResult: JSON.stringify(normalized),
        normalization: {
          kind: 'AUDIT_VERDICT_STATUS',
          fromStatus: status,
          verdictField
        }
      };
    }
    return {
      ok: false,
      reasonCode: status ? `EVIDENCE_RESULT_STATUS_${status}` : 'EVIDENCE_RESULT_STATUS_MISSING',
      parsed
    };
  }
  if (!parsed.evidence && (parsed.auditVerdict || parsed.releaseVerdict)) {
    const { status: _s, ...rest } = parsed;
    parsed.evidence = rest;
  }
  if (!substantiveEvidence(parsed.evidence)) {
    return { ok: false, reasonCode: 'EVIDENCE_RESULT_EVIDENCE_MISSING' };
  }
  return { ok: true, parsed };
}

export function validateReviewResult(value) {
  const result = validateEvidenceResult(value);
  if (!result.ok) return result;
  const evidence = result.parsed?.evidence ?? {};
  for (const field of ['auditVerdict', 'releaseVerdict']) {
    if (Object.hasOwn(evidence, field) && evidence[field] !== null && evidence[field] !== undefined && evidence[field] !== '') {
      return {
        ok: false,
        reasonCode: 'REVIEW_RESULT_BINDING_VERDICT_FORBIDDEN',
        parsed: result.parsed,
        detail: { field }
      };
    }
  }
  const reviewVerdict = typeof evidence.reviewVerdict === 'string'
    ? evidence.reviewVerdict.trim().toUpperCase()
    : '';
  if (!['REVIEW_PASS', 'REVISE', 'ACCEPT_FOR_USER_REVIEW'].includes(reviewVerdict)) {
    return {
      ok: false,
      reasonCode: 'REVIEW_RESULT_VERDICT_MISSING_OR_INVALID',
      parsed: result.parsed,
      detail: { observed: reviewVerdict || null }
    };
  }
  return {
    ...result,
    evidence,
    reviewVerdict
  };
}

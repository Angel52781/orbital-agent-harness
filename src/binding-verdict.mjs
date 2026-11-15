import { validateEvidenceResult } from './result-contracts.mjs';

const SAFE_VERDICT_ALIASES = Object.freeze({
  auditVerdict: Object.freeze({
    QA_PASS: 'QA_GO'
  }),
  releaseVerdict: Object.freeze({
    RELEASE_GO: 'PASS',
    RELEASE_PASS: 'PASS'
  })
});

function parse(value) {
  const result = validateEvidenceResult(value, { verdictAsEvidence: true });
  if (!result.ok) return result;
  let evidence = result.parsed?.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return result;

  let normalized = null;
  if (result.parsed?.auditVerdict && !evidence.auditVerdict) {
    evidence = { ...evidence, auditVerdict: result.parsed.auditVerdict };
    normalized = { ...result.parsed, evidence };
  }
  if (result.parsed?.releaseVerdict && !evidence.releaseVerdict) {
    evidence = { ...evidence, releaseVerdict: result.parsed.releaseVerdict };
    normalized = { ...result.parsed, evidence };
  }

  const aliases = [];
  for (const [field, mapping] of Object.entries(SAFE_VERDICT_ALIASES)) {
    if (typeof evidence[field] !== 'string') continue;
    const observed = evidence[field].trim().toUpperCase();
    const canonical = mapping[observed];
    if (!canonical) continue;
    normalized ??= {
      ...result.parsed,
      evidence: { ...evidence }
    };
    normalized.evidence[field] = canonical;
    aliases.push({ field, observed, canonical });
  }
  if (!normalized) return result;
  return {
    ...result,
    parsed: normalized,
    normalizedResult: JSON.stringify(normalized),
    normalization: {
      ...(result.normalization ?? {}),
      kind: 'SAFE_DOMAIN_VERDICT_ALIAS',
      aliases
    }
  };
}

// An auditor successfully executing its review is not the same as approving
// the inspected work. Enforce every domain verdict that a worker actually
// declares even for ordinary evidence-result nodes, without requiring legacy
// non-audit workers to invent an approval field.
export function validateDeclaredDomainVerdicts(value) {
  const result = parse(value);
  if (!result.ok) return result;
  const evidence = result.parsed?.evidence ?? {};
  // The release reviewer may REFER to an upstream QA decision but must not
  // reissue it in the QA-owned field. This exact ambiguity caused the
  // historical RELEASE_GO/QA_GO contract failure.
  if (Object.hasOwn(evidence, 'auditVerdict') && Object.hasOwn(evidence, 'releaseVerdict')) {
    return {
      ok: false, reasonCode: 'REVIEW_DOMAIN_ROLE_CONFLICT', parsed: result.parsed,
      detail: { fields: ['auditVerdict', 'releaseVerdict'] }
    };
  }
  for (const [field, approved] of [
    ['auditVerdict', 'QA_GO'],
    ['releaseVerdict', 'PASS']
  ]) {
    if (evidence[field] === null || evidence[field] === undefined || evidence[field] === '') {
      continue;
    }
    if (Object.hasOwn(evidence, field) && evidence[field] !== approved) {
      return {
        ok: false,
        reasonCode: field === 'auditVerdict' ? 'INNER_QA_BLOCK' : 'INNER_RELEASE_FAIL',
        parsed: result.parsed,
        detail: { field, observed: evidence[field], expected: approved }
      };
    }
  }
  return result;
}

// Sponsor plans can demand a binding gate instead of merely accepting any
// nonempty evidence-result. Missing verdicts and unattested claims are not
// an implicit approval. Legacy evidence-result workers remain compatible.
export function validateRequiredDomainVerdict(value, field, accepted) {
  const result = validateDeclaredDomainVerdicts(value);
  if (!result.ok) return result;
  const evidence = result.parsed?.evidence ?? {};
  if (evidence[field] !== accepted) {
    return {
      ok: false,
      reasonCode: 'BINDING_VERDICT_MISSING_OR_REJECTED',
      detail: { field, expected: accepted, observed: evidence[field] ?? null },
      parsed: result.parsed
    };
  }
  return { ...result, evidence };
}

export function validateBindingVerdict(value, { field, accepted } = {}) {
  return validateRequiredDomainVerdict(value, field, accepted);
}

export const validateQaGate = (value, options) => validateBindingVerdict(value, { ...options, field: 'auditVerdict', accepted: 'QA_GO' });
export const validateReleaseGate = (value, options) => validateBindingVerdict(value, { ...options, field: 'releaseVerdict', accepted: 'PASS' });

export function lockDownstreamActivation({ qaResult, releaseResult, snapshot } = {}) {
  const qaGate = validateQaGate(qaResult, { snapshot });
  if (!qaGate.ok) {
    return { ok: false, reasonCode: 'ACTIVATION_LOCKED_QA_GATE', detail: qaGate };
  }
  const releaseGate = validateReleaseGate(releaseResult, { snapshot });
  if (!releaseGate.ok) {
    return { ok: false, reasonCode: 'ACTIVATION_LOCKED_RELEASE_GATE', detail: releaseGate };
  }
  return {
    ok: true,
    activationUnlocked: true,
    qaVerdict: qaGate.evidence.auditVerdict,
    releaseVerdict: releaseGate.evidence.releaseVerdict,
    snapshot
  };
}

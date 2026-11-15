const ECONOMIC_WORDS = /\b(cash|money|revenue|usd|dollars?|dinero|cobrad[oa]s?|cobrar|collected|received|settled|recaudad[oa]s?)\b/i;
const COLLECTION_WORDS = /\b(collected|received|settled|cobrad[oa]s?|cobrar|cash|money|recaudad[oa]s?|recaudar)\b/i;

const PAYMENT_EVIDENCE_CAPABILITIES = new Set([
  'payment-evidence',
  'payments-read',
  'payment-transactions-read',
  'account-transactions-read',
  'banking-read',
  'finance-read',
  'commerce-payments-read'
]);

function numericAmount(raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!value) return null;
  let normalized = value;
  const comma = normalized.lastIndexOf(',');
  const dot = normalized.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) normalized = normalized.replaceAll('.', '').replace(',', '.');
    else normalized = normalized.replaceAll(',', '');
  } else if (comma >= 0) {
    const decimals = normalized.length - comma - 1;
    normalized = decimals === 2 ? normalized.replace(',', '.') : normalized.replaceAll(',', '');
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
function economicCorpus({ objective = '', acceptance = [] } = {}) {
  return [objective, ...(Array.isArray(acceptance) ? acceptance : [])]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
}
export function deriveEconomicAcceptanceContract(input = {}) {
  const corpus = economicCorpus(input);
  if (!ECONOMIC_WORDS.test(corpus) || !COLLECTION_WORDS.test(corpus)) return null;

  const candidates = [];
  const minimumPatterns = [
    /(?:at\s+least|minimum(?:\s+of)?|min(?:imum)?\.?|al\s+menos|m[ií]nimo(?:\s+de)?|>=)\s*(?:usd|us\$|\$)?\s*([0-9][0-9.,]*)/gi,
    /(?:collect(?:ed)?|receive(?:d)?|settle(?:d)?|cobrar|cobrad[oa]|recaudar|recaudad[oa])[^0-9]{0,48}(?:usd|us\$|\$)\s*([0-9][0-9.,]*)/gi,
    /(?:usd|us\$|\$)\s*([0-9][0-9.,]*)[^.]{0,64}(?:collect(?:ed)?|receive(?:d)?|settle(?:d)?|cobrar|cobrad[oa]|recaudar|recaudad[oa])/gi
  ];
  for (const pattern of minimumPatterns) {
    for (const match of corpus.matchAll(pattern)) {
      const amount = numericAmount(match[1]);
      if (amount !== null) candidates.push(amount);
    }
  }

  const minimumAmount = candidates.length > 0 ? Math.max(...candidates) : null;
  return Object.freeze({
    schema: 'orbital.mission-acceptance.economic-cash.v1',
    kind: 'economic-cash-collected',
    currency: /\b(?:usd|us\$|dollars?)\b|\$/i.test(corpus) ? 'USD' : null,
    minimumAmount,
    evidenceType: 'authoritative-payment-event',
    independentlyVerified: true
  });
}
function parsedResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const fenced = raw.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  try {
    const parsed = JSON.parse(fenced ? fenced[1].trim() : raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
export function economicCashEvidenceSatisfied(graph, requirement) {
  if (!requirement || requirement.kind !== 'economic-cash-collected') return false;
  if (!Number.isFinite(requirement.minimumAmount) || requirement.minimumAmount <= 0) return false;
  if (requirement.currency && requirement.currency !== 'USD') return false;

  for (const node of graph?.nodes ?? []) {
    if (!['review-result', 'release-pass'].includes(node.validation?.type)) continue;
    for (const value of (Array.isArray(node.result) ? node.result : [node.result])) {
      const parsed = parsedResult(value);
      const audit = parsed?.evidence?.economic_audit ?? parsed?.evidence?.economicAudit ?? null;
      if (!audit || typeof audit !== 'object') continue;
      const amount = Number(
        audit.verified_cash_collected_usd
        ?? audit.verifiedCashCollectedUsd
        ?? audit.verified_cash_collected
        ?? audit.verifiedCashCollected
      );
      const transactions = Number(
        audit.authoritative_transactions_observed
        ?? audit.authoritativeTransactionsObserved
        ?? 0
      );
      const acceptanceMet = audit.acceptance_met === true || audit.acceptanceMet === true;
      if (acceptanceMet && Number.isFinite(amount)
          && amount >= requirement.minimumAmount && transactions > 0) return true;
    }
  }
  return false;
}
export function missionFeasibilityForSponsorPlan(plan, { capabilityMatrix = null } = {}) {
  const economicAcceptance = deriveEconomicAcceptanceContract({
    objective: plan?.objective ?? '',
    acceptance: plan?.acceptance ?? []
  });
  if (!economicAcceptance) {
    return Object.freeze({
      schema: 'orbital.mission-feasibility.v1',
      status: 'PASS',
      requirements: [],
      boundary: null
    });
  }

  // An economic mission can use any commercial strategy, but terminal
  // acceptance cannot be proven without an authoritative payment/account
  // evidence rail. Treat that verification surface as an unavoidable mission
  // capability rather than spending a graph that can only produce proxies.
  const requested = new Set(
    (plan?.workPackages ?? []).flatMap((pkg) => pkg.requestedCapabilities ?? [])
  );
  const paymentEvidenceRequested = [...PAYMENT_EVIDENCE_CAPABILITIES]
    .some((capability) => requested.has(capability));
  const hasPaymentEvidenceRail = paymentEvidenceRequested
    && (capabilityMatrix?.paymentEvidence === 'AVAILABLE'
      || capabilityMatrix?.['payment-evidence'] === 'AVAILABLE');
  if (hasPaymentEvidenceRail) {
    return Object.freeze({
      schema: 'orbital.mission-feasibility.v1',
      status: 'PASS',
      requirements: ['authoritative-payment-evidence'],
      economicAcceptance,
      boundary: null
    });
  }

  return Object.freeze({
    schema: 'orbital.mission-feasibility.v1',
    status: 'NEEDS_HUMAN',
    reasonCode: 'PAYMENT_EVIDENCE_RAIL_UNAVAILABLE',
    requirements: ['authoritative-payment-evidence'],
    economicAcceptance,
    boundary: {
      schema: 'orbital.human-boundary.v1',
      reasonCode: 'PAYMENT_RAIL_UNAVAILABLE',
      kind: 'external-rail',
      requirement: 'authoritative-payment-evidence',
      detail: 'Mission acceptance requires independently verifiable collected cash, but the Sponsor authority contains no registered payment/account evidence capability.'
    }
  });
}

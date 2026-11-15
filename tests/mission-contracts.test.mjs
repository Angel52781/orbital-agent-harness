import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveEconomicAcceptanceContract,
  economicCashEvidenceSatisfied,
  missionFeasibilityForSponsorPlan
} from '../src/mission-contracts.mjs';

const economicRequirement = deriveEconomicAcceptanceContract({
  objective: 'Generate at least USD 100 of new money actually collected.',
  acceptance: ['Aggregate at least USD 100 of genuinely new money collected.']
});
function auditedCash(amount, transactions = 1, acceptanceMet = true) {
  return {
    nodes: [{
      validation: { type: 'review-result' },
      result: [JSON.stringify({
        status: 'PASS',
        evidence: {
          reviewVerdict: 'ACCEPT_FOR_USER_REVIEW',
          economic_audit: {
            verified_cash_collected_usd: amount,
            authoritative_transactions_observed: transactions,
            acceptance_met: acceptanceMet
          }
        }
      })]
    }]
  };
}

test('economic acceptance is typed from the immutable cash threshold', () => {
  assert.deepEqual(economicRequirement, {
    schema: 'orbital.mission-acceptance.economic-cash.v1',
    kind: 'economic-cash-collected',
    currency: 'USD',
    minimumAmount: 100,
    evidenceType: 'authoritative-payment-event',
    independentlyVerified: true
  });
});
test('economic gate rejects USD 1 against USD 100 even when a reviewer says acceptance_met', () => {
  assert.equal(economicCashEvidenceSatisfied(auditedCash(1), economicRequirement), false);
  assert.equal(economicCashEvidenceSatisfied(auditedCash(99.99), economicRequirement), false);
  assert.equal(economicCashEvidenceSatisfied(auditedCash(100), economicRequirement), true);
  assert.equal(economicCashEvidenceSatisfied(auditedCash(125), economicRequirement), true);
});
test('economic gate requires an authoritative transaction and explicit acceptance', () => {
  assert.equal(economicCashEvidenceSatisfied(auditedCash(125, 0, true), economicRequirement), false);
  assert.equal(economicCashEvidenceSatisfied(auditedCash(125, 1, false), economicRequirement), false);
});
test('economic mission fails feasibility before graph execution without a payment evidence rail', () => {
  const result = missionFeasibilityForSponsorPlan({
    objective: 'Collect at least USD 100 in new money.',
    acceptance: ['At least USD 100 collected with authoritative payment evidence.'],
    workPackages: [{ requestedCapabilities: ['web-search', 'sales-discovery'] }]
  });
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.equal(result.reasonCode, 'PAYMENT_EVIDENCE_RAIL_UNAVAILABLE');
  assert.equal(result.boundary.reasonCode, 'PAYMENT_RAIL_UNAVAILABLE');
});
test('economic mission requires a live observed payment evidence rail', () => {
  const plan = {
    objective: 'Collect at least USD 100 in new money.',
    acceptance: ['At least USD 100 collected with authoritative payment evidence.'],
    workPackages: [{ requestedCapabilities: ['payment-evidence'] }]
  };
  assert.equal(
    missionFeasibilityForSponsorPlan(plan, { capabilityMatrix: { paymentEvidence: 'UNAVAILABLE' } }).status,
    'NEEDS_HUMAN'
  );
  assert.equal(
    missionFeasibilityForSponsorPlan(plan, { capabilityMatrix: { paymentEvidence: 'AVAILABLE' } }).status,
    'PASS'
  );
});
test('non-economic mission does not invent an external payment boundary', () => {
  const result = missionFeasibilityForSponsorPlan({
    objective: 'Audit the autonomous run controller.',
    acceptance: ['All deterministic tests pass.'],
    workPackages: [{ requestedCapabilities: ['tests'] }]
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.boundary, null);
});


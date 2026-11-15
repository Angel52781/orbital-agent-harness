import { redactSecrets } from './events.mjs';
import crypto from 'node:crypto';
import { recoveryActionForReason } from './recovery-policy.mjs';

const patterns = [
  ['SANDBOX_EGRESS_DENIED', /PROXY_TUNNEL_403|HTTPS CONNECT.*403|sandbox.*(?:egress|network).*forbid/i, 'HOST_CANARY_REQUIRED'],
  ['DOMAIN_VERDICT_REJECTED', /INNER_QA_BLOCK|INNER_RELEASE_FAIL|REVIEW_DOMAIN_ROLE_CONFLICT/i, 'FIX_UPSTREAM_CONTRACT'],
  ['ARTIFACT_INTEGRITY', /QA_ARTIFACT.*(?:SHA|DRIFT)|ATTESTED_ARTIFACT_DRIFT|QA_REPORT.*(?:HASH|SHA).*MISMATCH/i, 'MATERIALIZE_AND_REATTEST'],
  ['PROFILE_MATERIALIZATION_FAILURE', /profile.*(?:materializ|required|invalid)|specialization.*(?:materializ|invalid)/i, 'REPLAN'],
  ['SECRET_FIELD_FALSE_POSITIVE', /secret-field|credential-field/i, 'SERIALIZE_VALUE_NOT_KEY'],
  ['POLICY_DENIED', /permission|denied|unauthoriz|forbidden|policy.*block/i, 'EVIDENCE_PACKET_REQUIRED'],
  ['SHARED_QUOTA', /quota|rate.?limit|usage limit|exhausted/i, 'WAIT_SHARED_BUCKET'],
  ['OUTPUT_BUDGET', /output.*(?:limit|budget)|truncat/i, 'RETRY_NODE'],
  ['INPUT_DRIFT', /(?:input|sha|hash|snapshot).*drift|workspace.*drift|fingerprint/i, 'REPLAN'],
  ['TRANSIENT_RUNTIME', /timeout|network|econn|temporar|socket|hang up/i, 'RETRY_NODE'],
  ['SOURCE_OR_TEST_FAILURE', /test|assert|syntax|compile|failure/i, 'FIX_NODE']
];

const deterministic = [
  /PROXY_TUNNEL_403|HOST_CANARY_REQUIRED|SANDBOX_EGRESS_DENIED/i,
  /PERMISSION|POLICY_BLOCKED|FORBIDDEN|DENIED/i,
  /QUOTA_EXHAUSTED|SHARED_QUOTA/i,
  /INNER_QA_BLOCK|INNER_RELEASE_FAIL|DOMAIN_VERDICT|BINDING_VERDICT/i,
  /QA_ARTIFACT|ATTESTED_ARTIFACT|QA_SNAPSHOT_DRIFT|INPUT_DRIFT|SNAPSHOT_CONFLICT/i,
  /RESULT_CONTRACT_FAILED|OUTPUT_SCHEMA_INVALID|EVIDENCE_RESULT_NOT_STRUCTURED/i
];

/** Do not turn deterministic permission, network-surface or QA rejections into
 * repeated provider calls. A genuinely transient retry is bounded by its
 * causal signature; changes of model never reset an exhausted shared bucket. */
export function causalRetryDecision({ reasonCode, diagnostic = null, priorSignatures = [] } = {}) {
  const reason = String(reasonCode ?? 'UNKNOWN').toUpperCase();
  const observed = typeof diagnostic === 'string' ? diagnostic
    : String(diagnostic?.cause ?? diagnostic?.reasonCode ?? diagnostic?.message ?? '');
  const cause = classifyExecutionFailure(observed || reason).cause;
  const signature = crypto.createHash('sha256').update(reason + ':' + cause).digest('hex');
  const seen = priorSignatures.filter((item) => item === signature).length;
  const sharedRecoveryAction = recoveryActionForReason(reason);
  if (['STEER', 'REPLAN', 'BLOCK', 'WAITING_PROVIDER'].includes(sharedRecoveryAction) ||
      deterministic.some((expression) => expression.test(reason)) ||
      ['SANDBOX_EGRESS_DENIED', 'DOMAIN_VERDICT_REJECTED', 'ARTIFACT_INTEGRITY',
        'POLICY_DENIED', 'SHARED_QUOTA', 'SECRET_FIELD_FALSE_POSITIVE'].includes(cause)) {
    return { retry: false, reasonCode: 'DETERMINISTIC_FAILURE_REQUIRES_CHANGED_INPUT',
      primaryCause: cause, recoveryAction: sharedRecoveryAction, signature, repeated: seen };
  }
  if (seen >= 1) {
    return { retry: false, reasonCode: 'REPEATED_CAUSAL_SIGNATURE',
      primaryCause: cause, signature, repeated: seen + 1 };
  }
  return { retry: true, reasonCode: 'BOUNDED_RETRY_WITH_CAUSAL_SIGNATURE',
    primaryCause: cause, recoveryAction: sharedRecoveryAction, signature, repeated: seen };
}

export function classifyExecutionFailure(error, { phase = 'dispatch', nodeId = null, dependents = [] } = {}) {
  const message = String(error?.message ?? error ?? 'unknown failure');
  const match = patterns.find(([, expression]) => expression.test(message));
  const cause = match?.[0] ?? 'DISPATCH_EXCEPTION';
  const recovery = match?.[2] ?? 'ESCALATE';

  const recoveryScope = (recovery === 'RETRY_NODE' || recovery === 'FIX_NODE')
    ? { targetNode: nodeId, recoverableNodes: [nodeId, ...dependents].filter(Boolean) }
    : (recovery === 'REPLAN' ? { targetNode: nodeId, action: 'REPLAN_FROM_CHECKPOINT' } : null);

  return redactSecrets({
    schema: 'orbital.execution-failure.v1',
    cause,
    phase,
    nodeId,
    recovery,
    recoveryScope,
    message,
    stackHint: String(error?.stack ?? '').split('\n').slice(0, 3).join('\n') || null
  });
}

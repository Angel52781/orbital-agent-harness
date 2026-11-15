/**
 * An explicit host capability is different from a capability inside a
 * restricted worker sandbox. Unknown is never promoted to available.
 * The caller supplies a real observation (not a model's assumption).
 */
export function preflightNodeCapabilities(requirements = {}, matrix = null) {
  const needed = Object.entries(requirements).filter(([, value]) => value === true).map(([key]) => key);
  if (!needed.length) return { ok: true, status: 'NO_SPECIAL_CAPABILITIES_REQUIRED' };
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, reasonCode: 'CAPABILITY_PREFLIGHT_MISSING', needed };
  }
  if (requirements.workerPublicHttps && matrix.workerPublicHttps !== 'AVAILABLE') {
    return matrix.ownerHostPublicHttps === 'AVAILABLE'
      ? { ok: false, reasonCode: 'HOST_CANARY_REQUIRED', requiredSurface: 'owner-host',
        primaryFailure: matrix.workerPublicHttps ?? 'UNVERIFIED', retrySameWorker: false }
      : { ok: false, reasonCode: 'NETWORK_CAPABILITY_UNVERIFIED', retrySameWorker: false };
  }
  if (requirements.ownerHostPublicHttps && matrix.ownerHostPublicHttps !== 'AVAILABLE') {
    return { ok: false, reasonCode: 'HOST_HTTPS_REQUIRED', retrySameWorker: false };
  }
  if (requirements.hostSystemdMutation && matrix.hostSystemdMutation !== 'AUTHORIZED') {
    return { ok: false, reasonCode: 'HOST_ACTION_APPROVAL_REQUIRED', retrySameWorker: false };
  }
  if (requirements.browserTools && matrix.browserTools !== 'AUTHORIZED') {
    return { ok: false, reasonCode: 'BROWSER_CAPABILITY_REQUIRED', retrySameWorker: false };
  }
  if (requirements.providerToolCalls && matrix.providerToolCalls !== 'AVAILABLE') {
    return { ok: false, reasonCode: 'PROVIDER_TOOL_CAPABILITY_REQUIRED', retrySameWorker: false };
  }
  if (requirements.sharedProviderQuota && matrix.sharedProviderQuota !== 'AVAILABLE') {
    return { ok: false, reasonCode: matrix.sharedProviderQuota === 'EXHAUSTED'
      ? 'PROVIDER_SHARED_QUOTA_EXHAUSTED' : 'PROVIDER_QUOTA_UNVERIFIED', retrySameWorker: false };
  }
  if ((requirements.paymentEvidence || requirements['payment-evidence'])
      && matrix.paymentEvidence !== 'AVAILABLE' && matrix['payment-evidence'] !== 'AVAILABLE') {
    return { ok: false, reasonCode: 'PAYMENT_EVIDENCE_RAIL_UNAVAILABLE', retrySameWorker: false };
  }
  return { ok: true, status: 'CAPABILITY_PREFLIGHT_PASS', needed };
}
/**
 * Fail-closed verification helper for payment-evidence capability.
 * Verifies that the deployed service, state directory and secret receiver
 * are truly healthy before certifying the capability as AVAILABLE.
 * Repository or code presence alone never self-certifies the rail.
 */
export function verifyPaymentEvidenceCapability({
  secretConfigured = false,
  stateDirWritable = false,
  daemonHealthy = false,
  aggregateSchemaValid = false
} = {}) {
  const isHealthy = Boolean(secretConfigured && stateDirWritable && daemonHealthy && aggregateSchemaValid);
  return {
    ok: isHealthy,
    status: isHealthy ? 'AVAILABLE' : 'UNAVAILABLE',
    reasonCode: isHealthy ? null : 'PAYMENT_EVIDENCE_RAIL_NOT_HEALTHY',
    checks: {
      secretConfigured,
      stateDirWritable,
      daemonHealthy,
      aggregateSchemaValid
    }
  };
}

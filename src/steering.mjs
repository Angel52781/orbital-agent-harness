const MAX_DIRECTIVE_CHARS = 4000;
const PLAN_FIELDS = new Set([
  'objective',
  'acceptance',
  'permissions',
  'writeScopes',
  'dependencies',
  'project',
  'surface',
  'capabilities'
]);

export function evaluateSteering(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, classification: 'INVALID', reasonCode: 'STEERING_REQUEST_INVALID' };
  }
  const nodeId = typeof request.nodeId === 'string' ? request.nodeId.trim() : '';
  const directive = typeof request.directive === 'string' ? request.directive.trim() : '';
  if (!nodeId) return { ok: false, classification: 'INVALID', reasonCode: 'STEERING_NODE_REQUIRED' };
  if (!directive || directive.length > MAX_DIRECTIVE_CHARS) {
    return { ok: false, classification: 'INVALID', reasonCode: 'STEERING_DIRECTIVE_INVALID' };
  }
  const changes = Array.isArray(request.changes)
    ? [...new Set(request.changes.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
  const structuralChanges = changes.filter((item) => PLAN_FIELDS.has(item));
  if (request.structural === true || structuralChanges.length) {
    return {
      ok: false,
      classification: 'PLAN_INVALIDATION',
      reasonCode: 'STEERING_REQUIRES_REPLAN',
      nodeId,
      directive,
      structuralChanges
    };
  }
  return {
    ok: true,
    classification: 'NODE_STEER',
    reasonCode: null,
    nodeId,
    directive,
    structuralChanges: []
  };
}

export const steeringPolicy = Object.freeze({
  localClassification: 'NODE_STEER',
  structuralClassification: 'PLAN_INVALIDATION',
  maxDirectiveChars: MAX_DIRECTIVE_CHARS,
  structuralFields: [...PLAN_FIELDS],
  preservesPlanHash: true,
  rerunScope: 'target-node-and-dependents'
});

const GLOBAL_IMMUTABLE_MISSION_FIELDS = new Set([
  'objective',
  'acceptance',
  'permissions',
  'project',
  'surface'
]);

export function evaluatePackageRework(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, classification: 'INVALID', reasonCode: 'PACKAGE_REWORK_REQUEST_INVALID' };
  }
  const packageId = typeof (request.packageId ?? request.nodeId) === 'string'
    ? String(request.packageId ?? request.nodeId).trim()
    : '';
  const directive = typeof request.directive === 'string' ? request.directive.trim() : '';
  if (!packageId) {
    return { ok: false, classification: 'INVALID', reasonCode: 'PACKAGE_REWORK_TARGET_REQUIRED' };
  }
  if (!directive || directive.length > MAX_DIRECTIVE_CHARS) {
    return { ok: false, classification: 'INVALID', reasonCode: 'PACKAGE_REWORK_DIRECTIVE_INVALID' };
  }
  const changes = Array.isArray(request.changes)
    ? [...new Set(request.changes.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
  const missionChanges = changes.filter((item) => GLOBAL_IMMUTABLE_MISSION_FIELDS.has(item));
  if (request.globalReplan === true || missionChanges.length > 0) {
    return {
      ok: false,
      classification: 'PLAN_INVALIDATION',
      reasonCode: 'PACKAGE_REWORK_REQUIRES_FULL_REPLAN',
      packageId,
      directive,
      missionChanges
    };
  }
  return {
    ok: true,
    classification: 'PACKAGE_REWORK',
    reasonCode: null,
    packageId,
    directive,
    localChanges: changes
  };
}

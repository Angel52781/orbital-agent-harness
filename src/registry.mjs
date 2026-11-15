import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTABLE_STATUSES = new Set(['CANARY', 'ACTIVE']);
const RUNTIME_MODES = new Set(['read-only', 'workspace-write']);
const SECRET_FIELD = /api.?key|access.?token|refresh.?token|authorization|password|passwd|secret|credential|private.?key|cookie/i;

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

export function loadRegistry() {
  const data = readJson('registry/agents.json');
  assertNoSecretFields(data);
  const capabilityConfig = loadCapabilities();
  const bundles = capabilityConfig.bundles || {};
  const capabilityCatalogSet = new Set(Object.values(bundles).flat());
  const ids = new Set();
  for (const agent of data.agents || []) {
    if (!agent.id || ids.has(agent.id)) throw new Error(`invalid-or-duplicate-agent:${agent.id || 'missing'}`);
    ids.add(agent.id);
    for (const bundle of agent.capabilityBundles || []) {
      if (!Object.hasOwn(bundles, bundle)) throw new Error(`unknown-capability-bundle:${agent.id}:${bundle}`);
    }
    validateCapabilityPolicy(agent, bundles, capabilityCatalogSet);
    if (EXECUTABLE_STATUSES.has(agent.status)) validateExecutableAgent(agent);
  }
  const specializationNames = new Set();
  for (const specialization of data.profileSpecializations || []) {
    if (!specialization.name || specializationNames.has(specialization.name) || ids.has(specialization.name)) {
      throw new Error(`invalid-or-duplicate-specialization:${specialization.name || 'missing'}`);
    }
    specializationNames.add(specialization.name);
    resolveConfinedFile(
      specialization.profileFile,
      'agents/specializations',
      `invalid-specialization-profile:${specialization.name}`
    );
    if (!Array.isArray(specialization.baseRoles) || specialization.baseRoles.length === 0
        || specialization.baseRoles.some((id) => !ids.has(id))) {
      throw new Error(`invalid-specialization-base-role:${specialization.name}`);
    }
    if (!Array.isArray(specialization.validators)
        || specialization.validators.some((validator) => typeof validator !== 'string' || !validator)) {
      throw new Error(`invalid-specialization-validators:${specialization.name}`);
    }
  }
  return data;
}

function assertNoSecretFields(value, location = 'registry') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`secret-field-forbidden:${location}.${key}`);
    assertNoSecretFields(item, `${location}.${key}`);
  }
}

export function loadCapabilities() {
  const data = readJson('config/capabilities.json');
  const bundles = data.bundles || {};
  const bundleNames = new Set(Object.keys(bundles));
  const catalog = new Set(Object.values(bundles).flat());
  for (const [name, policy] of Object.entries(data.bundlePolicies || {})) {
    if (!bundleNames.has(name)) throw new Error(`unknown-bundle-policy:${name}`);
    if (!policy || !Array.isArray(policy.providerClasses) || policy.providerClasses.length === 0) {
      throw new Error(`invalid-bundle-policy:${name}`);
    }
  }
  for (const bundle of bundleNames) {
    if (!Object.hasOwn(data.bundlePolicies || {}, bundle)) {
      throw new Error(`missing-bundle-policy:${bundle}`);
    }
  }
  for (const capability of Object.keys(data.capabilityPolicies || {})) {
    if (!catalog.has(capability)) throw new Error(`unknown-capability-policy:${capability}`);
  }
  return data;
}

export function loadOrganization() {
  return readJson('config/organization.json');
}

export function loadProjectRuntimePolicies() {
  const data = readJson('config/project-runtime.json');
  if (data.schemaVersion !== 1 || !data.projects || typeof data.projects !== 'object') {
    throw new Error('invalid-project-runtime-policy');
  }
  for (const [project, policy] of Object.entries(data.projects)) {
    if (!project || !policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error(`invalid-project-runtime-policy:${project || 'missing'}`);
    }
    for (const [field, scopes] of [
      ['generatedWriteScopes', policy.generatedWriteScopes ?? []],
      ['replaceableGeneratedWriteScopes', policy.replaceableGeneratedWriteScopes ?? []],
      ['fingerprintExcludedScopes', policy.fingerprintExcludedScopes ?? []]
    ]) {
      if (!Array.isArray(scopes)) throw new Error(`invalid-${field}:${project}`);
      for (const scope of scopes) {
        if (typeof scope !== 'string' || !scope.trim() || path.isAbsolute(scope)) {
          throw new Error(`invalid-${field}-scope:${project}`);
        }
        const normalized = path.normalize(scope);
        if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
          throw new Error(`${field}-scope-escapes-project:${project}:${scope}`);
        }
      }
    }
  }
  assertNoSecretFields(data, 'project-runtime');
  return data;
}

function validateRuntimePolicy(policy, project, source = 'project-runtime') {
  if (!project || !policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`invalid-project-runtime-policy:${project || 'missing'}`);
  }
  for (const [field, scopes] of [
    ['generatedWriteScopes', policy.generatedWriteScopes ?? []],
    ['replaceableGeneratedWriteScopes', policy.replaceableGeneratedWriteScopes ?? []],
    ['fingerprintExcludedScopes', policy.fingerprintExcludedScopes ?? []]
  ]) {
    if (!Array.isArray(scopes)) throw new Error(`invalid-${field}:${project}`);
    for (const scope of scopes) {
      if (typeof scope !== 'string' || !scope.trim() || path.isAbsolute(scope)) {
        throw new Error(`invalid-${field}-scope:${project}`);
      }
      const normalized = path.normalize(scope);
      if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new Error(`${field}-scope-escapes-project:${project}:${scope}`);
      }
    }
  }
  assertNoSecretFields(policy, source);
  return {
    generatedWriteScopes: [...new Set(policy.generatedWriteScopes ?? [])],
    replaceableGeneratedWriteScopes: [...new Set(policy.replaceableGeneratedWriteScopes ?? [])],
    fingerprintExcludedScopes: [...new Set(policy.fingerprintExcludedScopes ?? [])]
  };
}

export function runtimePolicyForProject(project, workspaceRoot = null) {
  if (typeof project !== 'string' || !project) {
    return { source: 'none', generatedWriteScopes: [], replaceableGeneratedWriteScopes: [], fingerprintExcludedScopes: [] };
  }
  if (workspaceRoot) {
    const localFile = path.join(workspaceRoot, '.orbital', 'runtime-policy.json');
    if (fs.existsSync(localFile)) {
      let local;
      try {
        local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      } catch {
        throw new Error(`invalid-project-runtime-policy-json:${project}`);
      }
      if (local.schemaVersion !== 1) throw new Error(`invalid-project-runtime-policy-schema:${project}`);
      if (local.projectId && local.projectId !== project) throw new Error(`project-runtime-policy-id-mismatch:${project}`);
      return {
        source: '.orbital/runtime-policy.json',
        ...validateRuntimePolicy(local, project, 'project-local-runtime')
      };
    }
  }
  const policy = loadProjectRuntimePolicies().projects[project];
  if (!policy) return { source: 'none', generatedWriteScopes: [], replaceableGeneratedWriteScopes: [], fingerprintExcludedScopes: [] };
  return { source: 'control-plane-fallback', ...validateRuntimePolicy(policy, project) };
}

export function generatedWriteScopesForProject(project, workspaceRoot = null) {
  if (typeof project !== 'string' || !project) return [];
  const policy = runtimePolicyForProject(project, workspaceRoot);
  return [...new Set([
    ...(policy?.generatedWriteScopes ?? []),
    ...(policy?.replaceableGeneratedWriteScopes ?? [])
  ])];
}

export function replaceableGeneratedWriteScopesForProject(project, workspaceRoot = null) {
  if (typeof project !== 'string' || !project) return [];
  const policy = runtimePolicyForProject(project, workspaceRoot);
  return [...new Set(policy?.replaceableGeneratedWriteScopes ?? [])];
}

export function getAgent(id) {
  const agent = loadRegistry().agents.find((item) => item.id === id);
  if (!agent) throw new Error(`unknown-agent:${id}`);
  return agent;
}

export function getProfileSpecialization(name, { agentId } = {}) {
  const specialization = (loadRegistry().profileSpecializations || [])
    .find((item) => item.name === name);
  if (!specialization) throw new Error(`unknown-profile-specialization:${name}`);
  if (agentId && !specialization.baseRoles.includes(agentId)) {
    throw new Error(`profile-specialization-not-allowed:${name}:${agentId}`);
  }
  return specialization;
}

export function expandedCapabilities(agent) {
  const catalog = loadCapabilities().bundles || {};
  return [...new Set((agent.capabilityBundles || []).flatMap((bundle) => catalog[bundle] || []))].sort();
}

export function capabilityCatalog() {
  const bundles = loadCapabilities().bundles || {};
  return [...new Set(Object.values(bundles).flat())].sort();
}

export function capabilityDefinition(capability) {
  if (!capabilityCatalog().includes(capability)) throw new Error(`unknown-capability:${capability}`);
  return loadCapabilities().capabilityPolicies?.[capability] || {
    enforcement: 'declared-policy'
  };
}

export function protectedActionsForCapabilities(capabilities = [], { mode = 'read-only' } = {}) {
  if (!Array.isArray(capabilities)) throw new Error('invalid-capabilities');
  const actions = new Set();
  if (mode === 'workspace-write') actions.add('workspace-mutation');
  for (const capability of capabilities) {
    const definition = capabilityDefinition(capability);
    for (const action of definition.protectedActions ?? []) {
      if (typeof action !== 'string' || !action.trim()) {
        throw new Error(`invalid-protected-action:${capability}`);
      }
      actions.add(action);
    }
  }
  return [...actions].sort();
}

export function bundleDefinition(bundle) {
  const capabilities = loadCapabilities();
  if (!Object.hasOwn(capabilities.bundles || {}, bundle)) throw new Error(`unknown-capability-bundle:${bundle}`);
  return {
    id: bundle,
    capabilities: capabilities.bundles[bundle],
    ...(capabilities.bundlePolicies?.[bundle] || {})
  };
}

export function isExecutableAgent(agent) {
  return Boolean(agent && EXECUTABLE_STATUSES.has(agent.status));
}

function validateExecutableAgent(agent) {
  if (typeof agent.profileFile !== 'string' || !agent.profileFile) {
    throw new Error(`missing-agent-profile:${agent.id}`);
  }
  resolveConfinedFile(agent.profileFile, 'agents', `invalid-agent-profile:${agent.id}`);

  const policy = agent.runtimePolicy;
  if (!policy || policy.capabilityCeiling !== 'declared-bundles') {
    throw new Error(`invalid-runtime-policy:${agent.id}`);
  }
  if (!Array.isArray(policy.allowedModes) || policy.allowedModes.length === 0) {
    throw new Error(`invalid-runtime-modes:${agent.id}`);
  }
  for (const mode of policy.allowedModes) {
    if (!RUNTIME_MODES.has(mode)) throw new Error(`invalid-runtime-mode:${agent.id}:${mode}`);
  }
  if (policy.requireWriteScopes !== undefined && policy.requireWriteScopes !== true) {
    throw new Error(`invalid-write-scope-policy:${agent.id}`);
  }
  if (policy.requireWriteScopes && !policy.allowedModes.includes('workspace-write')) {
    throw new Error(`invalid-write-scope-policy:${agent.id}`);
  }
}

function validateCapabilityPolicy(agent, bundles, catalog) {
  const policy = agent.capabilityPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`missing-capability-policy:${agent.id}`);
  }
  const tierFields = ['requiredBundles', 'usefulBundles', 'optionalBundles'];
  const seen = new Set();
  for (const field of tierFields) {
    if (!Array.isArray(policy[field])) throw new Error(`invalid-capability-policy:${agent.id}:${field}`);
    for (const bundle of policy[field]) {
      if (typeof bundle !== 'string' || !Object.hasOwn(bundles, bundle)) {
        throw new Error(`invalid-capability-policy-bundle:${agent.id}:${field}`);
      }
      if (seen.has(bundle)) throw new Error(`duplicate-capability-policy-bundle:${agent.id}:${bundle}`);
      seen.add(bundle);
    }
  }
  const ceiling = new Set(agent.capabilityBundles || []);
  if (seen.size !== ceiling.size || [...seen].some((bundle) => !ceiling.has(bundle))) {
    throw new Error(`capability-policy-does-not-cover-ceiling:${agent.id}`);
  }
  if (!Array.isArray(policy.forbiddenCapabilities)) {
    throw new Error(`invalid-capability-policy:${agent.id}:forbiddenCapabilities`);
  }
  const expanded = new Set((agent.capabilityBundles || []).flatMap((bundle) => bundles[bundle] || []));
  for (const capability of policy.forbiddenCapabilities) {
    if (typeof capability !== 'string' || !catalog.has(capability)) {
      throw new Error(`invalid-forbidden-capability:${agent.id}`);
    }
    if (expanded.has(capability)) throw new Error(`forbidden-capability-in-ceiling:${agent.id}:${capability}`);
  }
  if (!Array.isArray(policy.escalationPath)
      || policy.escalationPath.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`invalid-capability-policy:${agent.id}:escalationPath`);
  }
}

export function resolveConfinedFile(relativeFile, confinedDirectory, errorCode = 'path-not-confined') {
  if (typeof relativeFile !== 'string' || !relativeFile || path.isAbsolute(relativeFile)) {
    throw new Error(errorCode);
  }
  const base = fs.realpathSync(path.join(ROOT, confinedDirectory));
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(ROOT, relativeFile));
  } catch {
    throw new Error(errorCode);
  }
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(errorCode);
  if (!fs.statSync(resolved).isFile()) throw new Error(errorCode);
  return resolved;
}

export { ROOT };

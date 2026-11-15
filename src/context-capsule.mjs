import crypto from 'node:crypto';

const MAX_ITEMS = 12;
const MAX_TEXT = 2400;

function text(value, max = MAX_TEXT) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function list(value, maxItems = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => text(item, 480)).filter(Boolean);
}

export function createContextCapsule(input = {}) {
  const capsule = {
    schema: 'orbital.context-capsule.v1',
    objective: text(input.objective, 1200),
    current_state: list(input.current_state),
    relevant_decisions: list(input.relevant_decisions),
    constraints: list(input.constraints),
    relevant_surfaces: list(input.relevant_surfaces),
    evidence_refs: list(input.evidence_refs),
    delta: list(input.delta),
    unknowns: list(input.unknowns),
    recommended_capabilities: list(input.recommended_capabilities, 10),
    risk: text(input.risk, 240) || 'unknown'
  };
  capsule.context_hash = crypto.createHash('sha256').update(JSON.stringify(capsule)).digest('hex');
  return Object.freeze(capsule);
}

export function contextCapsuleSize(capsule) {
  return Buffer.byteLength(JSON.stringify(capsule), 'utf8');
}

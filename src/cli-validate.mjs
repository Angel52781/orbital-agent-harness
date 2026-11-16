#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSponsorPlan, sponsorPlanAllowedWriteScopes } from './sponsor-plan.mjs';
import { missionFeasibilityForSponsorPlan } from './mission-contracts.mjs';

const [, , cmd = 'help', arg] = process.argv;
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function printHelp() {
  console.log(`orbital-agent-harness v1.0.0 — Deterministic Execution Harness CLI

Usage:
  npx github:Angel52781/orbital-agent-harness init [out-file]     Create & validate a starter sponsor-plan.json
  npx github:Angel52781/orbital-agent-harness validate-plan <file> Validate an orbital.sponsor-plan.v1 contract
  npx github:Angel52781/orbital-agent-harness demo                Validate the bundled sample contract
`);
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

if (cmd === 'init') {
  const target = path.resolve(arg || 'sponsor-plan.json');
  if (fs.existsSync(target)) {
    console.error(JSON.stringify({ ok: false, error: `File already exists: ${target}` }));
    process.exit(1);
  }
  const sample = fs.readFileSync(path.join(PKG_ROOT, 'examples', 'sample-sponsor-plan.json'), 'utf8');
  fs.writeFileSync(target, sample, 'utf8');
  const plan = validateSponsorPlan(JSON.parse(sample));
  console.log(JSON.stringify({
    ok: true,
    created: target,
    schema: plan.schema,
    routingMode: plan.routingMode,
    packages: plan.workPackages.length
  }, null, 2));
  process.exit(0);
}

const targetFile = cmd === 'demo'
  ? path.join(PKG_ROOT, 'examples', 'sample-sponsor-plan.json')
  : cmd === 'validate-plan' && arg
    ? path.resolve(arg)
    : null;

if (!targetFile) {
  printHelp();
  process.exit(2);
}

try {
  const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const plan = validateSponsorPlan(raw);
  const feasibility = missionFeasibilityForSponsorPlan(plan);
  console.log(JSON.stringify({
    ok: true,
    schema: plan.schema,
    routingMode: plan.routingMode,
    packageCount: plan.workPackages.length,
    allowedWriteScopes: sponsorPlanAllowedWriteScopes(plan),
    feasibility: feasibility.status
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err)
  }, null, 2));
  process.exit(1);
}

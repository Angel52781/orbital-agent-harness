#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateSponsorPlan, sponsorPlanAllowedWriteScopes } from './sponsor-plan.mjs';
import { missionFeasibilityForSponsorPlan } from './mission-contracts.mjs';

const [, , cmd, file] = process.argv;

if (cmd !== 'validate-plan' || !file) {
  console.error('Usage: orbital-harness validate-plan <plan.json>');
  process.exit(2);
}

try {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
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

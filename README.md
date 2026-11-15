# Orbital Agent Harness (`orbital-agent-harness`)

**A deterministic, friction-governed execution harness and permission contract engine for multi-agent coding systems running over non-API subscription CLIs.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests: 149 Passing](https://img.shields.io/badge/tests-149%20passing-brightgreen.svg)](#running-the-test-suite)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](./package.json)

## Why This Exists

Recent multi-harness evaluations (such as Hugging Face's OpenEnv benchmarks) proved what production engineers already experience daily: **the LLM is a commodity, and the surrounding execution harness dictates whether an agent system succeeds or collapses.**

Most multi-agent frameworks fail in production for three structural reasons:
1. **Unbounded Write Mutations:** Reviewers, QA agents, or builders accidentally widen their scope, mutate outside their worktree, or overwrite each other's files.
2. **Full-Graph Replan Loops (Token Incineration):** When a single local test or UI assertion fails, naive orchestrators trigger a full architectural replan—destroying already-verified upstream packages and burning hundreds of dollars in pay-per-token API calls.
3. **Unattested "PASS" Claims:** Agents report `"status": "PASS"` in prose without cryptographic binding to physical artifacts, source-tree SHA-256 digests, or independent domain verdicts.

`orbital-agent-harness` solves these three problems in pure, zero-dependency Node.js ES modules, designed specifically to orchestrate **flat-rate, non-API CLI coding subscriptions** (Claude Code CLI, Codex CLI, Gemini/Antigravity CLI pools) and deterministic browser/media bridges at near-zero marginal cost.

---

## Core Architectural Pillars

### 1. Preflight Permission Envelopes & Scope Isolation (`src/sponsor-plan.mjs`, `src/permissions.mjs`, `src/execution-isolation.mjs`)
- **Strict Sponsor Plan Contract (`orbital.sponsor-plan.v1`):** Validates DAG topology, bounds package counts, strips any secret-like keys at preflight, and enforces explicit `routingMode` (`director-led` vs. `sponsor-bound`).
- **Relative Write-Scope Confinement:** Rejects absolute paths (`/srv/...`, `C:\...`) and parent traversals (`../`) at `submit` preflight before any LLM token is spent.
- **Read-Only Assurance Invariant:** Any package with validation in `['qa-go', 'release-pass', 'review-result']` (`qa-e2e`, `release-auditor`, `code-auditor`) is mathematically forced to `modeHint: "read-only"` and `writeScopes: []`—even when `preferredRole` is omitted for dynamic Director routing.
- **Fenced Execution Leases:** Concurrent workers acquire atomic filesystem leases (`orbital.execution-lease.v1`) verified against `/proc/<pid>/stat` start ticks to prevent PID-recycling races and overlapping directory writes.

### 2. Proportional Recovery (`6 / 3 / 2`) & Causal Retry (`src/recovery-policy.mjs`, `src/steering.mjs`, `src/failure-classifier.mjs`)
Instead of re-running an entire multi-agent graph on failure, the harness classifies every failure signature into a strict hierarchy:
- **`NODE_STEER` (Local Delta Correction — max 6 rounds):** Freezes upstream verified packages in `PASS_LOCKED` and dispatches a surgical delta directive to the owning builder and its dependent verifier, preserving the plan SHA-256 hash.
- **`PACKAGE_REWORK` (Bounded Subgraph Rework — max 3 rounds):** Recomputes only the affected package when its local contract is incomplete without invalidating global mission state.
- **`REPLAN` (Structural Replan — max 2 rounds):** Reserved strictly for global architectural invalidation.
- **Causal Retry Signatures:** Prevents burning `maxAttempts` on deterministic failures (`PROXY_TUNNEL_403`, `PERMISSION_DENIED`, `QA_ARTIFACT_SHA256_MISMATCH`, `SHARED_QUOTA_EXHAUSTED`).

### 3. Content-Addressed QA Attestation & Atomic Release Transitions (`src/attested-artifacts.mjs`, `src/binding-verdict.mjs`, `src/release-transition.mjs`)
- **Model JSON is a Proposal, Not Authority:** When a read-only `qa-e2e` reviewer emits `QA_GO` with `requireArtifact: true`, the runner materializes the exact UTF-8 report bytes into a content-addressed store (`attested-artifacts/<nodeHash>/<sha256>.json`), verifies symlinks and source-file hash maps, and binds `qa_report_sha256` before unlocking downstream `release-pass` or `software-integrator` nodes.
- **Reversible Marker Transitions:** Production or live-state markers are updated via compare-and-swap SHA-256 manifests with automatic rollback compensation (`ROLLBACK_COMPENSATED`) if post-validation fails.

### 4. Multi-Channel & Multimodal Release Gates (`examples/social-media-bridges/social-release-gate.mjs`)
Built to govern automated publishing pipelines across **LinkedIn (Company & Personal Unified API)**, **YouTube Shorts (Data API v3 OAuth2)**, **TikTok Studio**, and **Instagram Reels**:
- Binds approved copy and media SHA-256 hashes to explicit human approval references before dispatch.
- Enforces a 14-category pixel, audio-stream, and temporal coverage gate (`VIDEO_FINAL_REVIEW_GATE`) on rendered MP4 masters before any social upload can execute.

---

## Companion Open-Source Projects in the Ecosystem

- **[`google-flow-bridge`](https://github.com/Angel52781/google-flow-bridge):** Agent-friendly durable control plane and browser bridge for Google Flow, built on `gflow-cli`.
- **[`tizentube-windows`](https://github.com/Angel52781/tizentube-windows):** Lightweight Windows desktop client with WebView2, SponsorBlock, AdBlock, and DeArrow integration.
- **[`streamflix-desktop`](https://github.com/OrbitalFrameworks/streamflix-desktop):** Native JVM desktop media client with embedded `mpv` playback and automated GitHub release updates.

---

## Quick Start & CLI Validation

Requires **Node.js 20+** (zero `npm install` needed—uses only Node.js built-in modules).

```bash
git clone https://github.com/Angel52781/orbital-agent-harness.git
cd orbital-agent-harness

# Run the full 149-test deterministic verification suite
npm test

# Validate a Sponsor Plan contract before submitting to the controller
node src/cli-validate.mjs validate-plan examples/sample-sponsor-plan.json
```

### Example `orbital.sponsor-plan.v1` Contract

```json
{
  "schema": "orbital.sponsor-plan.v1",
  "routingMode": "director-led",
  "complexity": "normal",
  "objective": "Implement and verify adaptive checkout validation.",
  "acceptance": [
    "Checkout module validates inputs deterministically.",
    "Independent QA and Release gates pass with attested artifacts."
  ],
  "constraints": [
    "Keep writeScopes strictly relative to the isolated worktree."
  ],
  "nonGoals": [
    "Do not mutate unrelated payment or auth modules."
  ],
  "budget": {
    "maxSteerRounds": 6,
    "maxPackageReworkRounds": 3,
    "maxReplanRounds": 2
  },
  "workPackages": [
    {
      "id": "PKG-01-implement-checkout",
      "objective": "Implement checkout validation inside src/checkout.",
      "dependsOn": [],
      "expectedResult": "Passing unit tests and implementation.",
      "validation": "evidence-result",
      "modeHint": "workspace-write",
      "writeScopes": ["src/checkout", "tests/checkout"],
      "preferredRole": "software-builder"
    },
    {
      "id": "PKG-02-independent-qa",
      "objective": "Run end-to-end verification and attest QA report.",
      "dependsOn": ["PKG-01-implement-checkout"],
      "expectedResult": "Attested QA_GO verdict.",
      "validation": "qa-go",
      "requireArtifact": true,
      "modeHint": "read-only",
      "writeScopes": [],
      "preferredRole": "qa-e2e"
    },
    {
      "id": "PKG-03-release-gate",
      "objective": "Audit attested QA evidence and sign release verdict.",
      "dependsOn": ["PKG-02-independent-qa"],
      "expectedResult": "Binding releaseVerdict PASS.",
      "validation": "release-pass",
      "requireArtifact": true,
      "modeHint": "read-only",
      "writeScopes": [],
      "preferredRole": "release-auditor"
    }
  ]
}
```

## License

Released under the [MIT License](./LICENSE). Created by **Angel Eduardo Reaño Vásquez** ([Orbital Frameworks](https://github.com/Angel52781)).

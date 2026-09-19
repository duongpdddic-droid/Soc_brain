#!/usr/bin/env node
// create-final-review-smoke.mjs — thin CLI over the canonical smoke creator.
//
// This is the ONE official entry point that mints a FINAL_REVIEW_TRANSPORT_SMOKE
// transaction. It performs no lifecycle mutation itself; all artifact creation
// happens inside createFinalReviewSmoke() (canonical code path).
//
// Usage:
//   node scripts/create-final-review-smoke.mjs [--repo owner/name]
//     [--ttl-ms <ms>] [--client-request-id <>=8>] [--smoke-root <dir>] [--json]
// Stdout: one JSON object (the transaction value, or { ok:false, code, detail }).

import { parseArgs } from 'node:util';
import {
  createFinalReviewSmoke,
  defaultSmokeRoot,
  SMOKE_REPO,
} from '../packages/control-loop/final-review-smoke.mjs';

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    repo: { type: 'string' },
    'ttl-ms': { type: 'string' },
    'client-request-id': { type: 'string' },
    'smoke-root': { type: 'string' },
    json: { type: 'boolean', default: true },
  },
  strict: true,
});

const ttlMs = args.values['ttl-ms'] !== undefined ? Number(args.values['ttl-ms']) : undefined;
const res = createFinalReviewSmoke({
  repo: args.values.repo ?? SMOKE_REPO,
  ...(ttlMs !== undefined ? { ttlMs } : {}),
  smokeRoot: args.values['smoke-root'] ?? defaultSmokeRoot(),
  ...(args.values['client-request-id'] !== undefined ? { clientRequestId: args.values['client-request-id'] } : {}),
});

if (res.ok === true) {
  console.log(JSON.stringify({ ok: true, ...res.value, ...(res.idempotent ? { idempotent: true } : {}) }, null, 2));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, code: res.code, detail: res.detail ?? null }, null, 2));
process.exit(1);

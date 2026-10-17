import { loadManifest } from "./run-tier.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { spawnSync } from "node:child_process";

const rawTier = (process.argv[2] || "t1").toLowerCase();
const { m } = loadManifest();
const suites = {
  tier0_smoke: m.smoke,
  tier1_fast: m.tiers.t1.files.map(f => `tests/${f}`),
  tier2_integration: m.tiers.t2.files.map(f => `tests/${f}`),
  tier3_heavy: m.tiers.t3.files.map(f => `tests/${f}`),
  mcp: m.tiers.mcp.files.map(f => `tests/${f}`),
};
suites.tier0_smoke = suites.tier0_smoke.map(f => `tests/${f}`);
suites.all = [...suites.tier1_fast, ...suites.tier2_integration, ...suites.tier3_heavy];
let targets = [];
let tierLabel = rawTier;

if (rawTier === "t0" || rawTier === "tier0" || rawTier === "smoke") {
  targets = suites.tier0_smoke || [];
  tierLabel = "TIER 0 (SMOKE)";
} else if (rawTier === "t1" || rawTier === "tier1" || rawTier === "fast") {
  targets = suites.tier1_fast || [];
  tierLabel = "TIER 1 (PRE-COMMIT)";
} else if (rawTier === "t2" || rawTier === "tier2" || rawTier === "integration") {
  targets = suites.tier2_integration || [];
  tierLabel = "TIER 2 (PRE-PUSH / CONTRACT)";
} else if (rawTier === "t3" || rawTier === "tier3" || rawTier === "heavy") {
  targets = suites.tier3_heavy || [];
  tierLabel = "TIER 3 (PRE-RELEASE / SURVIVAL)";
} else if (rawTier === "all") {
  targets = suites.all || [];
  tierLabel = "ALL NON-MCP TIERS";
} else if (rawTier === "mcp") {
  targets = suites.mcp;
  tierLabel = "MCP (EXPLICIT / MCP-RELATED TASK)";
} else {
  console.error(`Tham so tier khong hop le: ${rawTier}. Dung: t0 | t1 | t2 | t3 | all | mcp`);
  process.exit(1);
}

if (!targets.length) {
  console.error(`FAIL-CLOSED: Danh sach test cho ${tierLabel} rong!`);
  process.exit(1);
}

const concurrency = Math.max(2, (typeof os.availableParallelism === "function" ? os.availableParallelism() : (os.cpus() || []).length || 4) - 1);

console.log(`=== RUNNER: ${tierLabel} (${targets.length} files | concurrency: ${concurrency}) ===`);
const startTotal = Date.now();

const args = [
  "--test",
  `--test-concurrency=${concurrency}`,
  "--test-reporter=spec",
  ...targets
];

const cleanEnv = { ...process.env };
delete cleanEnv.NODE_TEST_CONTEXT;
const res = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: "inherit",
  env: cleanEnv
});

const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log("\n==================================================");
console.log(`KET QUA ${tierLabel}: exit code ${res.status ?? 1} (${totalElapsed}s)`);

process.exit(res.status ?? 1);

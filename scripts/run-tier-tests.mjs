import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const rawTier = (process.argv[2] || "t1").toLowerCase();
const suitesFile = "tests/test-suites.json";

if (!fs.existsSync(suitesFile)) {
  console.error("FAIL-CLOSED: Khong tim thay tests/test-suites.json");
  process.exit(1);
}

const suites = JSON.parse(fs.readFileSync(suitesFile, "utf8"));
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
  tierLabel = "ALL TIERS";
} else {
  console.error(`Tham so tier khong hop le: ${rawTier}. Dung: t0 | t1 | t2 | t3 | all`);
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

const res = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: process.env
});

const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log("\n==================================================");
console.log(`KET QUA ${tierLabel}: exit code ${res.status ?? 1} (${totalElapsed}s)`);

process.exit(res.status ?? 1);

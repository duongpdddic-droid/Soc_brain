import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReviewVia } from '../packages/control-loop/mcp-final-review.mjs';
import { selectGptTransport } from '../packages/control-loop/chatgpt-web-cwa.mjs';
import { ROUTER_ENGINES, resolveRouteForSession } from '../packages/control-loop/router.mjs';
import { loadManifest, selectGate } from '../scripts/run-tier.mjs';

test('retired Web2API final channel is rejected; default final channel is manual MCP', () => {
  assert.deepEqual(resolveReviewVia({}), {ok:true,via:'mcp'});
  assert.equal(resolveReviewVia({SOC_FINAL_REVIEW_VIA:'web2api'}).ok,false);
});
test('legacy CDP opt-in cannot create a browser transport',()=>{
  let calls=0;
  const selection=selectGptTransport({env:{SOC_GPT_TRANSPORT_LEGACY_CDP:'1',SOC_GPT_CDP_PORT:'9222'},cdpTransportFactory:()=>{calls++;return {};}});
  assert.equal(selection.transport,null); assert.equal(calls,0);
});
test('router cannot select the retired Web2API engines',()=>{
  for(const name of ['gemini-web2api','gpt-web2api-copy','gpt-cdp-legacy']) assert.equal(ROUTER_ENGINES[name].available,false,name);
});
// PR #285 (main) superseded the PR #296 "separate MCP tier" design: ONE inventory,
// no conditional tier, and an unprovable/unmapped change falls back to the FULL
// inventory ("Unprovable change -> the FULL inventory, never a silent T1+T2 subset").
// This pins the surviving intent — retiring Web2API must never let the MCP contract
// tests silently drop out of the gate — against the canonical design.
test('MCP contract tests stay reachable through the single inventory (no conditional tier)',()=>{
  const manifest=loadManifest();
  assert.equal(manifest.m.tiers.mcp,undefined,'PR #285 keeps ONE inventory; no conditional mcp tier');
  const mcpTests=manifest.onDisk.filter(f=>f.includes('mcp'));
  assert.ok(mcpTests.length>0);
  for(const f of mcpTests) assert.ok(manifest.owner.has(f),`${f} must be tier-owned`);
  const selection=selectGate(manifest,['packages/unrelated-new-feature/new.mjs']);
  assert.equal(selection.fallback,true);
  for(const f of manifest.onDisk) assert.ok(selection.files.includes(f),f);
});

test('mandatory control-plane gate remains executable under the existing gate contract',async()=>{
  const {resolveTestGateCommand}=await import('../packages/executor-launcher/test-run-evidence.mjs');
  const {fileURLToPath}=await import('node:url');
  const root=fileURLToPath(new URL('..',import.meta.url));
  const gate=resolveTestGateCommand({cwd:root});
  assert.equal(gate.ok,true,JSON.stringify(gate));
  assert.ok(gate.tokens.every(f=>!f.includes('mcp')&&!f.includes('web2api')&&!f.includes('cdp')));
});

test('pure routing uses explicit review adapter seams and rejects legacy stored routes',()=>{
  const session={state:'SESSION_ACTIVE'};
  assert.equal(resolveRouteForSession({session,phase:'PRE_REVIEW'}).value.engine,'subagent-review');
  assert.equal(resolveRouteForSession({session,phase:'FINAL_REVIEW'}).value.engine,'independent-final');
  for(const [phase,field,engine] of [['PRE_REVIEW','preReview','gemini-web2api'],['FINAL_REVIEW','finalReview','gpt-web2api-copy'],['FINAL_REVIEW','finalReview','gpt-cdp-legacy']]){
    const result=resolveRouteForSession({session,phase,routeMeta:{[field]:engine}});
    assert.equal(result.ok,false);assert.equal(result.code,'ROUTER_ENGINE_UNAVAILABLE');
  }
});

// Retiring CDP/Web2API removed the resolver import from the CLI, but one call site
// survived and killed the whole entry point with a ReferenceError (empty stdout)
// before any admission/transport work. Nothing else spawns this CLI, so the crash
// was invisible to the fast gate. Pin it here: the run path must stay executable
// and must fail CLOSED with a JSON result.
test('retired CDP/Web2API removal leaves the control-loop CLI executable (no undefined retired symbol)',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {mkdtempSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const path=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const root=fileURLToPath(new URL('..',import.meta.url));
  const stateDir=mkdtempSync(path.join(tmpdir(),'soc-cli-retirement-'));
  const out=spawnSync(process.execPath,[path.join(root,'bin','soc-control-loop.mjs'),'--repo','owner/name','--issue','9001','--state-dir',stateDir],{
    cwd:root,encoding:'utf8',timeout:60000,
    env:{...process.env,SOC_SESSION_ADMISSION:'required'},
  });
  assert.equal(out.error,undefined,`CLI must reach an exit, not be killed: ${out.error&&out.error.message}`);
  assert.doesNotMatch(out.stderr||'',/is not defined|ReferenceError/,`the CLI still references a retired symbol:\n${out.stderr}`);
  let parsed=null;
  try{parsed=JSON.parse(out.stdout);}catch{/* fall through to the assertion */ }
  assert.ok(parsed&&parsed.ok===false,`CLI must emit a fail-closed JSON result, got stdout=${(out.stdout||'').slice(0,400)}`);
  assert.equal(typeof parsed.code,'string','a fail-closed CLI result carries a machine-readable code');
});

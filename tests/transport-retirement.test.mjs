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
test('unrelated unmapped fallback does not pull MCP tests',()=>{
  const manifest=loadManifest();
  const selection=selectGate(manifest,['packages/unrelated-new-feature/new.mjs']);
  assert.ok(selection.files.length>0);
  assert.ok(selection.files.every(f=>!f.includes('mcp')),selection.files.filter(f=>f.includes('mcp')).join(','));
});
test('MCP change selects the complete separate MCP suite',()=>{
  const manifest=loadManifest();
  const selection=selectGate(manifest,['packages/client-mcp/gateway-mcp.mjs']);
  assert.ok(manifest.m.tiers.mcp?.files.length>0);
  for(const f of manifest.m.tiers.mcp.files) assert.ok(selection.files.includes(f),f);
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

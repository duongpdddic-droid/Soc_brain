import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../plugins/open-code-review.ts', import.meta.url), 'utf8');
const plugin = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('V2 setup registers the OCR review and health tools', async () => {
  const tools = [];
  await plugin.default.setup({tool:{transform:async fn=>fn({add:t=>tools.push(t)})}, command:{list:async()=>({data:[]}),transform:async()=>{} }});
  assert.deepEqual(tools.map(t=>t.name), ['ocr_review','ocr_health']);
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cwd = process.cwd();
const invoke = script => ({command:process.execPath,prefixArgs:['-e',script]});
const run = (script, options={}) => plugin.runOcr([], {cwd,invocation:invoke(script),timeoutMs:2000,...options});
async function setup(runOverride, overrides={}) {
  const tools = new Map(), commands = [];
  const ctx = {session:{get:async()=>({location:{directory:cwd}})},tool:{transform:async f=>f({add:t=>tools.set(t.name,t)})},command:{list:async()=>({data:[]}),transform:async f=>f({add:t=>commands.push(t)})},...overrides};
  await plugin.createPlugin(runOverride).setup(ctx);
  return {tools,commands};
}
test('successful real process preserves stdout/stderr and elapsed time', async()=>{
  const result = await run('console.log(JSON.stringify({findings:[]}));console.error("warning")');
  assert.deepEqual(plugin.formatReviewResult(result,false),{findings:[]});
  assert.equal(result.stderr,'warning'); assert.ok(result.elapsedMs>=0);
});
test('empty, malformed, null and scalar JSON never mean a clean review',()=>{
  for (const stdout of ['', 'broken', 'null', 'true', '3', '"ok"']) assert.throws(()=>plugin.formatReviewResult({stdout},false));
});
test('preview preserves non-JSON scope without claiming review',()=>assert.equal(plugin.formatReviewResult({stdout:'a.mjs'},true),'a.mjs'));
test('nonzero exit is a failure with diagnostics',async()=>{
  await assert.rejects(run('console.error("missing provider model");process.exitCode=1'),error=>error.exitCode===1 && error.stderr==='missing provider model' && /missing provider model/.test(error.message));
});
test('spawn failure settles without waiting for wall-clock timeout',async()=>{
  await assert.rejects(plugin.runOcr([],{cwd,invocation:{command:join(cwd,'absent-ocr-executable'),prefixArgs:[]},timeoutMs:2000}),/spawn failed/);
});
test('output cap stops the owned child and confirms closure',async()=>{
  await assert.rejects(run('process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)',{maxOutputBytes:100}),error=>/output exceeded/.test(error.message)&&error.cleanupConfirmed);
});
test('timeout kills the owned process group before rejecting',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ocr-child-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const pidPath=join(dir,'pid');
  const code=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000);`;
  await assert.rejects(run(code,{timeoutMs:1500}),error=>/timed out/.test(error.message)&&error.cleanupConfirmed);
  const pid=Number(await readFile(pidPath,'utf8'));
  if(process.platform==='linux') {
    try {const stat=await readFile(`/proc/${pid}/stat`,'utf8');assert.match(stat,/\) Z /);} catch(error){if(error.code!=='ENOENT')throw error;}
  } else assert.throws(()=>process.kill(pid,0));
});
test('abort is forwarded and waits for child close',async()=>{
  const controller=new AbortController();
  const promise=run('setInterval(()=>{},1000)',{signal:controller.signal});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(promise,error=>/cancelled/.test(error.message)&&error.cleanupConfirmed);
});
test('pre-aborted invocation never starts a process',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(run('process.exit(0)',{signal:controller.signal}),{name:'AbortError'});
});
test('bad session fails closed without using global project directory',async()=>{
  const {tools}=await setup(()=>assert.fail('must not launch'),{location:{directory:cwd},session:{get:async()=>{throw new Error('session unavailable');}}});
  await assert.rejects(tools.get('ocr_review').execute({}, {sessionID:'bad'}),/session unavailable/);
});
test('V2 review forwards cancellation, exact range, deadline and warnings',async()=>{
  const controller=new AbortController();let call;
  const {tools}=await setup(async(args,options)=>{call={args,options};return {stdout:'{"findings":[]}',stderr:'warning',elapsedMs:12};});
  const from='1'.repeat(40),to='2'.repeat(40);
  const response=await tools.get('ocr_review').execute({from,to},{sessionID:'s',signal:controller.signal});
  assert.equal(call.options.signal,controller.signal);assert.equal(call.options.timeoutMs,180000);
  assert.deepEqual(call.args.slice(0,4),['review','--audience','agent','--format']);
  assert.equal(call.args[call.args.indexOf('--from')+1],from);
  const payload=JSON.parse(response.content);assert.equal(payload.target.to,to);assert.equal(payload.stderr,'warning');assert.equal(payload.kind,'OCR_REVIEW_EVIDENCE');
});
test('explicit overall deadline differs from per-file timeout',async()=>{
  let call;const {tools}=await setup(async(args,options)=>{call={args,options};return {stdout:'{}'};});
  await tools.get('ocr_review').execute({timeoutMinutes:1,overallTimeoutMinutes:5},{sessionID:'s'});
  assert.equal(call.options.timeoutMs,300000);assert.equal(call.args[call.args.indexOf('--timeout')+1],'1');
  for(const minutes of [0,31,NaN,Infinity]) await assert.rejects(tools.get('ocr_review').execute({overallTimeoutMinutes:minutes},{sessionID:'s'}),/1..30/);
});
test('invalid target combinations are rejected before process launch',async()=>{
  const {tools}=await setup(()=>assert.fail('must not launch'));
  for(const input of [{from:'a'},{commit:'a',from:'b',to:'c'},{resume:'s',commit:'a'},{background:'a',backgroundFile:'b'},{resume:'s',preview:true}]) await assert.rejects(tools.get('ocr_review').execute(input,{sessionID:'s'}));
});
test('health waits for both probes and fails on a model/config failure',async()=>{
  let completed=false;const {tools}=await setup(async args=>{
    if(args[0]==='version'){await new Promise(r=>setTimeout(r,30));completed=true;return {stdout:'1.13.0'};}
    throw new Error('OpenRouter model missing');
  });
  await assert.rejects(tools.get('ocr_health').execute({},{sessionID:'s'}),/model missing/);assert.ok(completed);
});
test('existing slash commands are preserved',async()=>{
  const {commands}=await setup(async()=>({stdout:'{}'}),{command:{list:async()=>({data:[{name:'ocr-review'},{name:'ocr-health'}]}),transform:async f=>f({add:()=>assert.fail('duplicate command')})}});
  assert.equal(commands.length,0);
});
test('Windows wrapper resolution avoids the cmd/PowerShell shim',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ocr-path-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {mkdir}=await import('node:fs/promises');const folder=join(dir,'node_modules','@alibaba-group','open-code-review','bin');await mkdir(folder,{recursive:true});
  await writeFile(join(dir,'node.exe'),'');await writeFile(join(folder,'ocr.js'),'');await writeFile(join(dir,'ocr.cmd'),'shim');
  assert.deepEqual(plugin.resolveInvocation({PATH:dir},'win32'),{command:join(dir,'node.exe'),prefixArgs:[join(folder,'ocr.js')]});
});

test('health does not accept empty successful probes',async()=>{
  const {tools}=await setup(async()=>({stdout:'',stderr:''}));
  await assert.rejects(tools.get('ocr_health').execute({},{sessionID:'s'}),/health is UNKNOWN/);
});

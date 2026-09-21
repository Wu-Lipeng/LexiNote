const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../addon/core.js');
const base = { ...C.defaults, endpoint: 'https://example.org/lookup?q={{word}}' };
test('Unicode single words; reject sentences and oversized selection', () => {
  assert.equal(C.defaults.autoHighlight, true);
  assert.equal(C.defaults.highlightColor, '#c0c0c0');
  for (const word of ['apple', 'café', 'naïve', "don't", 'well-being', '中文']) assert.equal(C.wordFrom(word), word);
  assert.equal(C.wordFrom('“apple,”'), 'apple');
  assert.equal(C.wordFrom('two words'), '');
  assert.equal(C.wordFrom('a'.repeat(81)), '');
  assert.equal(C.wordFrom('<script>'), '');
});
test('title-case English words include a lower-case lookup candidate', () => {
  assert.deepEqual(C.wordCandidates('Present'), ['Present', 'present']);
  assert.deepEqual(C.wordCandidates('present'), ['present']);
  assert.deepEqual(C.wordCandidates('USA'), ['USA']);
  assert.deepEqual(C.wordCandidates("Can't"), ["Can't", "can't"]);
  assert.deepEqual(C.wordCandidates("O'Reilly"), ["O'Reilly"]);
});
test('JSON substitution escapes quotes/newlines and preserves numeric types', () => {
  const c = C.validate({ ...base, method: 'POST', body: '{"q":"{{word}}","secret":"{{apiKey}}","n":2}' });
  const r = C.request(c, 'a"\\b', 'secret"\nvalue');
  assert.deepEqual(JSON.parse(r.body), {q:'a"\\b', secret:'secret"\nvalue', n:2});
  assert.ok(r.url.includes('a%22%5Cb'));
  assert.equal(r.headers['Content-Type'], 'application/json');
});
test('nested wildcard response arrays and absent optional fields', () => {
  const c = { ...base, meaningPath: '[*].meanings[*].definitions[*].definition', phoneticPath: '[0].phonetic' };
  const value = C.response([{phonetic:'/a/', meanings:[{definitions:[{definition:'一'},{definition:'二'}]},{definitions:[{definition:'一'}]}]}], c);
  assert.deepEqual(value, {meaning:'一\n二',phonetic:'/a/',example:''});
  assert.throws(() => C.response({},c), /没有找到释义/);
  assert.deepEqual(C.valuesAt('hello','$'), ['hello']);
});
test('reject dangerous/misconfigured endpoints and templates', () => {
  for(const endpoint of ['file:///tmp/{{word}}','http://remote.example/{{word}}','https://user:pass@example.org/{{word}}','https://{{word}}.example.org/','https://example.org/?key={{apiKey}}&q={{word}}']) {
    assert.throws(() => C.validate({...base, endpoint}));
  }
  assert.throws(() => C.validate({...base, headers:'{"x":"a\\nb"}'}));
  assert.throws(() => C.validate({...base, meaningPath:'__proto__.evil'}));
  assert.throws(() => C.validate({...base, headers:'{"x":"{{oops}}"}'}));
  assert.throws(() => C.validate({...base, endpoint:'https://example.org/'}));
  assert.doesNotThrow(() => C.validate({...base, endpoint:'http://127.0.0.1:18271/{{word}}'}));
});
test('required key validation', () => {
  const c = C.validate({...base,headers:'{"Authorization":"Bearer {{apiKey}}"}'});
  assert.throws(() => C.request(c,'hello',''),/密钥/);
  assert.equal(C.request(c,'hello','s').headers.Authorization, 'Bearer s');
});
test('Baidu general mode accepts own credentials or local trial mode', () => {
  assert.doesNotThrow(() => C.validate({ ...C.defaults, provider: 'baidu-general', baiduApiKey: 'key', baiduSecretKey: 'secret' }));
  assert.doesNotThrow(() => C.validate({ ...C.defaults, provider: 'baidu-general', useBaiduTrial: true }));
  assert.throws(() => C.validate({ ...C.defaults, provider: 'baidu-general' }), /百度 API Key/);
});
function runtime(initialConfig = base, credentials = {}) {
  let sent = 0;
  const requests = [];
  const prefs = { 'extensions.lexinote.config': JSON.stringify(initialConfig) };
  class FakeXHR {
    open(method,url) { this.method=method; this.url=url; }
    setRequestHeader() {}
    send(body) { this.body=body; requests.push(this); sent++; }
    abort() { this.aborted = true; this.onabort?.(); }
    respond(status, value) { this.status=status; this.responseText=JSON.stringify(value); this.onload?.(); }
  }
  const context = vm.createContext({ LexiNoteCore:C, LexiNoteTrialCredentials:{baiduApiKey:'trial-key',baiduSecretKey:'trial-secret'}, XMLHttpRequest:FakeXHR, URL, setTimeout,clearTimeout,
    Zotero:{Prefs:{get:key=>prefs[key] || '',set:(key,value)=>{prefs[key]=value;}}}, Services:{logins:{findLogins:(_,__,name)=>credentials[name] ? [{password:credentials[name]}] : []}} });
  vm.runInContext(fs.readFileSync(require.resolve('../addon/runtime.js'),'utf8'),context);
  const app = vm.runInContext('new LexiNoteRuntime({id:"test",rootURI:""})',context);
  return {app,requests,prefs,sent:()=>sent};
}
test('local trial quota resets daily and stops after 50 requests', () => {
  const {app}=runtime(); app.trialDate=()=> '2026-09-16';
  for(let i=0;i<50;i++) app.consumeTrialQuota();
  assert.deepEqual({...app.trialStatus()},{configured:true,used:50,limit:50,remaining:0});
  assert.throws(()=>app.consumeTrialQuota(),/50\/50/);
  app.trialDate=()=> '2026-09-17';
  assert.deepEqual({...app.trialStatus()},{configured:true,used:0,limit:50,remaining:50});
});
test('provider credentials are stored separately and removed from configuration JSON', async () => {
  const {app,prefs}=runtime(); const stored={};
  app.setCredential=async(name,value)=>{stored[name]=value;};
  app.setKey=async value=>{stored['Generic API Key']=value;};
  await app.saveConfig({...C.defaults,provider:'baidu-general',baiduApiKey:'baidu-key',baiduSecretKey:'baidu-secret'},'ignored');
  assert.deepEqual(stored,{'Baidu General API Key':'baidu-key','Baidu General Secret Key':'baidu-secret'});
  assert.equal(app.config.baiduApiKey,'baidu-key'); assert.equal(app.config.baiduSecretKey,'baidu-secret');
  const persisted = JSON.parse(prefs['extensions.lexinote.config']);
  assert.equal(persisted.baiduApiKey,''); assert.equal(persisted.baiduSecretKey,'');
  await app.saveConfig({...C.defaults,provider:'baidu',baiduApiKey:'dictionary-key',baiduSecretKey:'dictionary-secret'},'ignored');
  assert.equal(stored['Baidu Dictionary API Key'],'dictionary-key');
  assert.equal(stored['Baidu Dictionary Secret Key'],'dictionary-secret');
  await app.saveConfig({...C.defaults,endpoint:'https://example.org/?q={{word}}'},'generic-key');
  assert.equal(stored['Generic API Key'],'generic-key');
});
test('saved Baidu credentials keep the dictionary provider configured', () => {
  const {app}=runtime();
  app.config={...C.defaults,provider:'baidu'};
  app.getCredential=name=>({
    'Baidu Dictionary API Key':'dictionary-key',
    'Baidu Dictionary Secret Key':'dictionary-secret'
  })[name] || '';
  assert.equal(app.isConfigured(),true);
});
test('startup restores saved Baidu credentials into the runtime configuration', () => {
  const {app,prefs}=runtime({...C.defaults,provider:'baidu'}, {
    'Baidu Dictionary API Key':'dictionary-key',
    'Baidu Dictionary Secret Key':'dictionary-secret'
  });
  assert.equal(app.config.baiduApiKey,'dictionary-key');
  assert.equal(app.config.baiduSecretKey,'dictionary-secret');
  const persisted = JSON.parse(prefs['extensions.lexinote.config']);
  assert.equal(persisted.baiduApiKey,''); assert.equal(persisted.baiduSecretKey,'');
});
test('candidate lookup keeps successful spellings and reports no usable result', async () => {
  const {app}=runtime();
  app.lookup=async word=>{
    if (word === 'Present') return {meaning:'礼物',phonetic:'',example:''};
    if (word === 'present') return {meaning:'现在',phonetic:'',example:''};
    throw new Error('响应中没有找到释义，请检查释义字段路径或接口返回内容。');
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await app.lookupCandidates('Present'))), [
    {word:'Present',result:{meaning:'礼物',phonetic:'',example:''}},
    {word:'present',result:{meaning:'现在',phonetic:'',example:''}}
  ]);
  app.lookup=async()=>{ throw new Error('百度词典没有返回结果。'); };
  await assert.rejects(app.lookupCandidates('Absent'), /未找到可用释义/);
});
test('cache hit; configuration changes invalidate; secrets not part of cache keys', async () => {
  const {app,requests,sent}=runtime();
  const first=app.lookup('hello'); requests[0].respond(200,{translation:'你好'});
  assert.equal((await first).meaning,'你好');
  await app.lookup('hello'); assert.equal(sent(),1);
  app.clearCache();
  const second=app.lookup('hello'); requests[1].respond(200,{translation:'新释义'});
  assert.equal((await second).meaning,'新释义');
  assert.deepEqual([...app.cache.keys()],['hello']);
});
test('cancellation settles promise and frees request slot', async () => {
  const {app,requests}=runtime(); const owner={};
  const pending=app.lookup('one',app.config,undefined,owner);
  owner.cancel();
  await assert.rejects(pending,/取消/);
  assert.equal(app.requests.size,0); assert.equal(requests[0].aborted,true);
  assert.equal(app.cache.size,0);
});
test('timeouts, non-JSON and rate limits produce readable errors', async () => {
  const {app,requests}=runtime();
  let pending=app.lookup('one'); requests[0].ontimeout(); await assert.rejects(pending,/超时/);
  pending=app.lookup('two'); requests[1].respond(429,{}); await assert.rejects(pending,/频繁/);
  pending=app.lookup('three'); requests[2].status=200; requests[2].responseText='<html>'; requests[2].onload();
  await assert.rejects(pending,/JSON/); assert.equal(app.requests.size,0);
});
test('bounded concurrency and response size', async () => {
  const {app,requests}=runtime();
  const all=['a','b','c'].map(w => app.lookup(w));
  await assert.rejects(app.lookup('d'),/其他单词/);
  requests[0].onprogress({loaded:1024*1024+1});
  await assert.rejects(all[0],/1 MB/);
  requests[1].respond(200,{translation:'B'}); requests[2].respond(200,{translation:'C'});
  await Promise.all(all.slice(1)); assert.equal(app.requests.size,0);
});
test('concurrent note saves are serialized and a failed save does not block later saves', async () => {
  const {app}=runtime(); const order=[]; let release;
  app.writeWord=async n=>{ order.push('start'+n); if(n===1) await new Promise(r=>release=r); if(n===2) throw new Error('fail'); order.push('end'+n); return n; };
  const p1=app.saveWord(1), p2=app.saveWord(2), p3=app.saveWord(3);
  const rejected=assert.rejects(p2,/fail/);
  await new Promise(r=>setImmediate(r)); assert.deepEqual(order,['start1']);
  release(); await Promise.all([p1,rejected,p3]);
  assert.deepEqual(order,['start1','end1','start2','start3','end3']);
});
test('LRU cache stays bounded and expired entries are fetched again', async () => {
  const {app,requests,sent}=runtime();
  for(let i=0;i<201;i++){const promise=app.lookup('word'+i);requests.at(-1).respond(200,{translation:'value'+i});await promise;}
  assert.equal(app.cache.size,200);assert.equal(app.cache.has('word0'),false);
  app.cache.get('word1').time=0;
  const promise=app.lookup('word1');requests.at(-1).respond(200,{translation:'refreshed'});
  assert.equal((await promise).meaning,'refreshed');assert.equal(sent(),202);
});
test('install manifest contains Zotero-required HTTPS update URL and bootstrap', () => {
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../addon/manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,2);
  assert.equal(manifest.applications.zotero.id,'lexinote@local.tools');
  assert.equal(new URL(manifest.applications.zotero.update_url).protocol,'https:');
  assert.ok(manifest.applications.zotero.strict_max_version);
  assert.ok(fs.existsSync(require.resolve('../addon/bootstrap.js')));
});

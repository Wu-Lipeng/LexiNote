// Browser DOM tests with a simulated Zotero data layer, not desktop compatibility certification.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
test('DOM note integrity, popup interaction and settings round trip',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({path:path.resolve(__dirname,'../addon/core.js')});
    await page.addScriptTag({path:path.resolve(__dirname,'../addon/runtime.js')});
    const results=await page.evaluate(async()=>{
      const results=[];const check=(v,msg)=>{if(!v)throw Error(msg);results.push(msg);};
      const store=new Map();let nextID=1;
      class Item {
        constructor(type){this.type=type;this.libraryID=1;this.tags=[];this.text='';this.deleted=false;this.key='KEY'+nextID;}
        isAttachment(){return this.type==='attachment';} isRegularItem(){return this.type==='journalArticle';}
        isEditable(){return !this.readOnly;} hasTag(tag){return this.tags.includes(tag);} addTag(tag){this.tags.push(tag);}
        getNote(){return this.text;} setNote(text){this.text=text;}
        getNotes(){return [...store.values()].filter(n=>n.type==='note'&&n.parentID===this.id&&!n.deleted).map(n=>n.id);}
        async saveTx(){await new Promise(r=>setTimeout(r,1));if(!this.id)this.id=nextID++;store.set(this.id,this);return this.id;}
      }
      let pref='{}';
      window.Zotero={Prefs:{get:()=>pref,set:(k,v)=>pref=v},Item,Items:{getAsync:async id=>Array.isArray(id)?id.map(x=>store.get(x)):store.get(id)},Libraries:{get:()=>({libraryType:'user'})},Reader:{unregisterEventListener(){}}};
      const app=new LexiNoteRuntime({id:'test',rootURI:''});window.Zotero.LexiNote=app;
      app.getKey=()=>'';app.setKey=async()=>{};
      const p=new Item('journalArticle');await p.saveTx();
      const a=new Item('attachment');a.parentID=p.id;await a.saveTx();
      const a2=new Item('attachment');a2.parentID=p.id;await a2.saveTx();
      const entry=(word,id=a.id)=>({attachmentID:id,word,result:{meaning:'释义 '+word,phonetic:'/test/',example:'An example.'},pageLabel:'3',pageIndex:2});
      const saved=await Promise.all([app.saveWord(entry('alpha')),app.saveWord(entry('beta',a2.id)),app.saveWord(entry('alpha'))]);
      check(saved.every(x=>x.noteID===saved[0].noteID)&&p.getNotes().length===1,'Concurrent saves and multiple attachments use one note');
      check(saved[2].duplicate,'Duplicate word detected');
      const note=store.get(saved[0].noteID);
      check(note.getNote().includes('alpha')&&note.getNote().includes('beta'),'Concurrent words preserved');
      check(note.getNote().includes('?page=3'),'Source page link preserved');
      note.setNote(note.getNote().replace('</h1>','</h1><p>Manual text</p>'));
      const evil=entry('gamma');evil.result.meaning='<script>alert(1)</script>';
      await app.saveWord(evil);
      check(note.getNote().includes('Manual text'),'User edits preserved');
      check(note.getNote().includes('&lt;script&gt;')&&!note.getNote().includes('<script>'),'API text cannot inject HTML');
      const parent2=new Item('journalArticle');await parent2.saveTx();const att2=new Item('attachment');att2.parentID=parent2.id;await att2.saveTx();
      const other=await app.saveWord(entry('alpha',att2.id));check(other.noteID!==note.id,'Different documents have separate notes');
      p.readOnly=true;let rejected=false;try{await app.saveWord(entry('no'));}catch(e){rejected=e.message.includes('只读');}check(rejected,'Read-only library rejected');p.readOnly=false;
      const orphan=new Item('attachment');await orphan.saveTx();rejected=false;try{await app.saveWord(entry('no',orphan.id));}catch(e){rejected=e.message.includes('父条目');}check(rejected,'Standalone attachment explained');
      app.config={...LexiNoteCore.defaults,endpoint:'https://example.org/?q={{word}}',delay:150};
      app.lookup=async word=>({meaning:'释义 '+word,phonetic:'/test/',example:'Example.'});
      const reader={itemID:a.id};let popup;
      const event=word=>({reader,doc:document,params:{annotation:{text:word,pageLabel:'4',position:{pageIndex:3}}},append:node=>{popup=node;document.body.append(node);}});
      app.selection(event('delta'));
      popup=document.querySelector('.lexinote-popup');
      await new Promise(r=>setTimeout(r,180));
      check(popup.textContent.includes('释义 delta'),'Popup displays lookup result');
      const queryInput=popup.querySelector('input[aria-label="查询单词"]');
      check(queryInput.value==='delta','Popup query input starts with selected word');
      queryInput.value='gamma';[...popup.querySelectorAll('button')].find(b=>b.textContent==='查询').click();
      await new Promise(r=>setTimeout(r,10));
      check(popup.textContent.includes('释义 delta')&&popup.textContent.includes('释义 gamma')&&queryInput.value==='gamma','Manual query appends a result and updates the input');
      [...popup.querySelectorAll('button')].find(b=>b.textContent==='保存 delta').click();await app.noteQueue;await new Promise(r=>setTimeout(r,10));
      check(note.getNote().includes('delta')&&popup.textContent.includes('已追加'),'Popup save writes to originating note');
      const old=popup;app.selection(event('epsilon'));popup=document.querySelector('.lexinote-popup');check(!old.isConnected,'New selection removes old popup');
      await new Promise(r=>setTimeout(r,180));popup.remove();await new Promise(r=>setTimeout(r,10));check(app.popups.size===0,'Disconnected popup cleans up');
      note.deleted=true;const replacement=await app.saveWord(entry('zeta'));check(replacement.noteID!==note.id,'Trashed note is not reused');
      return results;
    });
    assert.equal(results.length,16);
    const markup=fs.readFileSync(path.resolve(__dirname,'../addon/preferences.xhtml'),'utf8');
    await page.evaluate(markup=>{
      const parsed=new DOMParser().parseFromString(markup,'application/xml');
      if(parsed.querySelector('parsererror'))throw Error(parsed.querySelector('parsererror').textContent);
      document.body.append(document.importNode(parsed.documentElement,true));
    },markup);
    await page.addScriptTag({path:path.resolve(__dirname,'../addon/preferences.js')});
    await page.evaluate(()=>LexiNotePreferences.init());
    const restored=await page.evaluate(()=>{
      const $=id=>document.getElementById('lexinote-'+id);
      let confirmation='';window.confirm=message=>{confirmation=message;return true;};
      $('enabled').checked=false;$('autoHighlight').checked=true;$('highlightColor').value='#123456';$('highlightType').value='underline';$('delay').value='900';$('timeout').value='2000';
      $('restoreFeatures').click();
      let closeConfirmation='';window.confirm=message=>{closeConfirmation=message;return false;};
      const closeEvent=new Event('close',{cancelable:true});window.dispatchEvent(closeEvent);
      return {
        featureHeading:$('feature-settings').querySelector('h2').textContent,
        interfaceHeading:$('interface-settings').querySelector('h2').textContent,
        enabled:$('enabled').checked,autoHighlight:$('autoHighlight').checked,color:$('highlightColor').value,type:$('highlightType').value,delay:$('delay').value,timeout:$('timeout').value,
        status:$('status').textContent,confirmation,closeConfirmation,closePrevented:closeEvent.defaultPrevented
      };
    });
    assert.deepEqual(restored,{featureHeading:'功能设置',interfaceHeading:'接口设置',enabled:true,autoHighlight:true,color:'#c0c0c0',type:'highlight',delay:'350',timeout:'12000',status:'已恢复功能默认设置。请点击“保存设置”以应用。',confirmation:'确定恢复功能默认设置吗？接口设置和已保存凭据不会改变。',closeConfirmation:'设置尚未保存，确定关闭设置窗口吗？',closePrevented:true});
    await page.evaluate(()=>{document.getElementById('lexinote-delay').value='300';document.getElementById('lexinote-save').click();});
    await page.waitForFunction(()=>document.getElementById('lexinote-status').textContent.includes('设置已保存'));
    assert.equal(await page.evaluate(()=>Zotero.LexiNote.config.delay),300);
    assert.equal(await page.evaluate(()=>{const event=new Event('close',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false);
    await page.evaluate(()=>document.getElementById('lexinote-test').click());
    await page.waitForFunction(()=>document.getElementById('lexinote-status').textContent.includes('测试成功'));
    console.log('16 DOM/data assertions plus settings save and test passed (simulated Zotero).');
  } finally {await browser.close();}
});

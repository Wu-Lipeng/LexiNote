/* Runs ONLY in an explicitly isolated profile; copied into test extension. */
async function lexinoteIntegration() {
  const output = Zotero.Prefs.get('extensions.lexinote.testOutput',true);
  const expectedData = Zotero.Prefs.get('extensions.lexinote.testData',true);
  if (!output || !expectedData || Zotero.DataDirectory.dir !== expectedData) throw new Error('Refusing integration tests outside isolated data directory');
  const report = {version:Zotero.version, tests:[], started:new Date().toISOString()};
  const ok=(condition,message)=>{if(!condition)throw new Error(message);};
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(fn,timeout=15000)=>{const start=Date.now();while(!fn()){if(Date.now()-start>timeout)throw new Error('Timed out');await wait(100);}};
  const test=async(name,fn)=>{try{await fn();report.tests.push({name,passed:true});}catch(e){report.tests.push({name,passed:false,error:String(e),stack:e.stack});}};
  try {
    await Zotero.uiReadyPromise;
    const app = Zotero.LexiNote;
    const config={...LexiNoteCore.defaults,endpoint:'http://127.0.0.1:18271/?word={{word}}',phoneticPath:'phonetic',examplePath:'examples',delay:150};
    await test('Plugin registered and configuration/credential round trip',async()=>{
      ok(Zotero.PreferencePanes.pluginPanes.some(p=>p.id==='lexinote-preferences'),'pane missing');
      await app.saveConfig(config,'fixture-secret');
      ok(app.getKey()==='fixture-secret','key not persisted');
      ok(!Zotero.Prefs.get(app.pref,true).includes('fixture-secret'),'key leaked to preference');
      await app.setKey(''); ok(app.getKey()==='','key not removed');
    });
    await test('Actual HTTP request and response extraction',async()=>{
      const result=await app.lookup('example');
      ok(result.meaning==='释义：example','response mismatch');
      ok(result.phonetic==='/test/','phonetic mismatch');
      ok(result.example==='This is example.','example mismatch');
      const post={...config,method:'POST',endpoint:'http://127.0.0.1:18271/',body:'{"word":"{{word}}"}'};
      ok((await app.lookup('post',post,'')).meaning==='释义：post','POST mismatch');
    });
    let parent,attachment,secondAttachment,noteID;
    await test('Concurrent words and duplicate save use one child note',async()=>{
      parent=new Zotero.Item('journalArticle');parent.setField('title','LexiNote integration fixture');await parent.saveTx();
      attachment=new Zotero.Item('attachment');attachment.parentID=parent.id;attachment.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_URL;attachment.setField('url','https://example.org/paper.pdf');await attachment.saveTx();
      secondAttachment=new Zotero.Item('attachment');secondAttachment.parentID=parent.id;secondAttachment.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_URL;secondAttachment.setField('url','https://example.org/other.pdf');await secondAttachment.saveTx();
      const [a,b,c]=await Promise.all([
        app.saveWord({attachmentID:attachment.id,word:'alpha',result:{meaning:'A',phonetic:'',example:''},pageLabel:'3',pageIndex:2}),
        app.saveWord({attachmentID:secondAttachment.id,word:'beta',result:{meaning:'B',phonetic:'',example:''}}),
        app.saveWord({attachmentID:attachment.id,word:'alpha',result:{meaning:'A',phonetic:'',example:''}})
      ]);
      ok(a.noteID===b.noteID && a.noteID===c.noteID,'multiple notes');ok(c.duplicate,'duplicate not detected');
      noteID=a.noteID;
      ok(parent.getNotes().length===1,'parent has multiple notes');
      const text=Zotero.Items.get(noteID).getNote();ok(text.includes('alpha')&&text.includes('beta'),'lost word');ok(text.includes('?page=3'),'page link lost');
    });
    await test('Preserves edited content and escapes API HTML',async()=>{
      const note=Zotero.Items.get(noteID);note.setNote(note.getNote().replace('</h1>','</h1><p>手工补充内容</p>'));await note.saveTx();
      await app.saveWord({attachmentID:attachment.id,word:'gamma',result:{meaning:'<img src=x onerror=evil()>',phonetic:'',example:''}});
      const text=note.getNote();ok(text.includes('手工补充内容'),'manual text lost');ok(text.includes('&lt;img'),'unescaped API result');
    });
    await test('Real DOM popup lookup and save button',async()=>{
      const win=Zotero.getMainWindow();const doc=win.document;
      const reader={itemID:attachment.id};let box;
      app.selection({reader,doc,params:{annotation:{text:'delta',pageLabel:'5',position:{pageIndex:4}}},append:node=>{box=node;doc.documentElement.append(node);}});
      await until(()=>box?.textContent.includes('释义：delta'));
      const save=box.querySelector('button');ok(!save.disabled,'save disabled');save.click();
      await until(()=>box.textContent.includes('已追加'));
      ok(Zotero.Items.get(noteID).getNote().includes('delta'),'popup did not save');
      app.byReader.get(reader).dispose();ok(app.popups.size===0,'popup not removed');
    });
    await test('Rapid selection cancels stale popup and close cleans up',async()=>{
      const doc=Zotero.getMainWindow().document;const reader={itemID:attachment.id};let first,second;
      const event=text=>({reader,doc,params:{annotation:{text}},append:node=>{doc.documentElement.append(node);if(!first)first=node;else second=node;}});
      app.selection(event('first'));app.selection(event('second'));
      ok(!first.isConnected,'stale popup remained');
      await until(()=>second.textContent.includes('释义：second'));
      second.querySelectorAll('button')[2].click();ok(!second.isConnected,'close failed');
    });
    await test('Settings page loads and save button works',async()=>{
      Zotero.Utilities.Internal.openPreferences('lexinote-preferences');
      let win;
      await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('lexinote-settings')?.dataset.initialized;});
      const doc=win.document;ok(doc.getElementById('lexinote-endpoint').value===config.endpoint,'settings not populated');
      doc.getElementById('lexinote-delay').value='250';doc.getElementById('lexinote-save').click();
      await until(()=>doc.getElementById('lexinote-status').textContent.includes('设置已保存'));
      ok(app.config.delay===250,'settings not saved');
      doc.getElementById('lexinote-test').click();await until(()=>doc.getElementById('lexinote-status').textContent.includes('测试成功'));
      win.close();
    });
    await test('PDF reader mouse selection triggers dictionary popup',async()=>{
      const stream='BT /F1 18 Tf 72 720 Td (hello science example) Tj ET';
      const objects=[
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'
      ];
      let pdf='%PDF-1.4\n',offsets=[0];
      objects.forEach((obj,i)=>{offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';});
      const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
      const file=PathUtils.join(expectedData,'lexinote-fixture.pdf');await IOUtils.writeUTF8(file,pdf);
      const item=await Zotero.Attachments.importFromFile({file,parentItemID:parent.id});
      const reader=await Zotero.Reader.open(item.id);await reader._initPromise;
      let frame,span;
      await until(()=>{frame=reader._internalReader?._primaryView?._iframeWindow;span=frame?.document.querySelector('.textLayer span');return span?.textContent.includes('hello');},30000);
      const rect=span.getBoundingClientRect();const x=rect.left+8,y=rect.top+rect.height/2;
      const observed=[];
      const trace=event=>{if(event.reader===reader)observed.push({text:event.params?.annotation?.text});};
      Zotero.Reader.registerEventListener('renderTextSelectionPopup',trace,'lexinote-test-trace');
      const utils=Components.utils.unwaiveXrays(frame).windowUtils;
      utils.sendMouseEvent('mousedown',x,y,0,2,0);
      utils.sendMouseEvent('mouseup',x,y,0,2,0);
      await wait(800);
      report.pdfDebug={rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},target:frame.document.elementFromPoint(x,y)?.outerHTML?.slice(0,300),observed,ranges:JSON.parse(JSON.stringify(reader._internalReader._primaryView._selectionRanges)),popups:app.popups.size,popup:reader._iframeWindow.document.querySelector('.lexinote-popup')?.textContent,stateKeys:Object.keys(reader._internalReader._state).filter(k=>/selection/i.test(k))};
      Zotero.Reader.unregisterEventListener('renderTextSelectionPopup',trace);
      let popup;
      await until(()=>{popup=reader._iframeWindow.document.querySelector('.lexinote-popup');return popup?.textContent.includes('释义：hello');});
      popup.querySelector('button').click();
      await until(()=>popup.textContent.includes('已追加'));
      ok(Zotero.Items.get(noteID).getNote().includes('hello'),'PDF selection not saved to parent note');
      reader.close();
    });
    await test('Standalone attachment returns actionable error',async()=>{
      const orphan=new Zotero.Item('attachment');orphan.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_URL;orphan.setField('url','https://example.org/orphan.pdf');await orphan.saveTx();
      let rejected=false;try{await app.saveWord({attachmentID:orphan.id,word:'x',result:{meaning:'X'}});}catch(e){rejected=e.message.includes('父条目');}ok(rejected,'orphan not rejected');
    });
    await test('Trashed vocabulary note creates a replacement',async()=>{
      const note=Zotero.Items.get(noteID);note.deleted=true;await note.saveTx();
      const result=await app.saveWord({attachmentID:attachment.id,word:'new',result:{meaning:'新',phonetic:'',example:''}});
      ok(result.noteID!==noteID,'saved into trash');ok(parent.getNotes().length===1,'wrong replacement count');
    });
    await test('Shutdown cancels requests, clears cache and removes popups',async()=>{
      const owner={};const pending=app.lookup('shutdown',app.config,undefined,owner).catch(e=>e);
      app.stop();await pending;ok(app.requests.size===0 && app.cache.size===0 && app.popups.size===0,'shutdown residue');
    });
  } catch(e) {report.fatal=String(e);report.stack=e.stack;}
  report.finished=new Date().toISOString();
  await IOUtils.writeUTF8(output,JSON.stringify(report,null,2));
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}

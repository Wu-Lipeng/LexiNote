/* global Zotero, Services */
var LexiNote;
function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}
async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "core.js", globalThis);
  Services.scriptloader.loadSubScript(rootURI + "runtime.js", globalThis);
  LexiNote = new LexiNoteRuntime({ id, rootURI });
  Zotero.LexiNote = LexiNote;
  await LexiNote.start();
}
function shutdown() {
  LexiNote?.stop();
  if (Zotero.LexiNote === LexiNote) delete Zotero.LexiNote;
  LexiNote = undefined;
}

/* global Zotero, Services, ChromeUtils */
var LexiNote;
function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}
async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  // Zotero 7+ exposes the native save dialog through this module, rather than
  // a Zotero.FilePicker global.
  globalThis.LexiNoteFilePicker = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs").FilePicker;
  Services.scriptloader.loadSubScript(rootURI + "core.js", globalThis);
  Services.scriptloader.loadSubScript(rootURI + "trial-credentials.js", globalThis);
  Services.scriptloader.loadSubScript(rootURI + "runtime.js", globalThis);
  LexiNote = new LexiNoteRuntime({ id, rootURI });
  Zotero.LexiNote = LexiNote;
  await LexiNote.start();
}
function shutdown() {
  LexiNote?.stop();
  if (Zotero.LexiNote === LexiNote) delete Zotero.LexiNote;
  LexiNote = undefined;
  delete globalThis.LexiNoteFilePicker;
}

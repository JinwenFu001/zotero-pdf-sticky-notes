var chromeHandle;
var pluginContext;

function install(_data, _reason) {}

async function startup({ rootURI }, reason) {
  var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Components.interfaces.amIAddonManagerStartup,
  );
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);
  var hiddenDOMWindow = Services.appShell.hiddenDOMWindow;

  pluginContext = {
    Zotero,
    Services,
    Components,
    ChromeUtils,
    IOUtils,
    PathUtils,
    // AbortController is not one of Zotero 9.0.6's bootstrap-sandbox
    // globals. Use the platform DOM constructor for lifecycle cancellation.
    AbortController: hiddenDOMWindow.AbortController,
    rootURI,
    setTimeout,
    clearTimeout,
  };
  pluginContext._globalThis = pluginContext;

  Services.scriptloader.loadSubScript(rootURI + "content/scripts/__addonRef__.js", pluginContext);
  await pluginContext.ZoteroPDFStickyNotes.startup(reason);
}

async function onMainWindowLoad({ window }) {
  await pluginContext?.ZoteroPDFStickyNotes?.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  await pluginContext?.ZoteroPDFStickyNotes?.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  try {
    await pluginContext?.ZoteroPDFStickyNotes?.shutdown();
  } catch (error) {
    Zotero.logError(error);
  } finally {
    delete Zotero.ZoteroPDFStickyNotes;
    pluginContext = null;

    if (chromeHandle) {
      chromeHandle.destruct();
      chromeHandle = null;
    }
  }
}

function uninstall(_data, _reason) {}

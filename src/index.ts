import { StickyNotesPlugin } from "./plugin";

const plugin = new StickyNotesPlugin();
_globalThis.ZoteroPDFStickyNotes = plugin;
(Zotero as any).ZoteroPDFStickyNotes = plugin;

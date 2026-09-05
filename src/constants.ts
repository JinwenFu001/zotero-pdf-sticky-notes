export const PLUGIN_ID = "zotero-pdf-sticky-notes@jinwenfu001.github.io";
export const PLUGIN_NAME = "Zotero PDF Sticky Notes";

export const RELATION_PREDICATE = "dc:relation";
export const STICKY_TAG = "zotero-pdf-sticky-notes:sticky:v1";
export const NOTE_TAG = "zotero-pdf-sticky-notes:note:v1";
export const MARKER_TAG_TYPE = 0;
export const STICKY_COLOR = "#2ea8e5";

export const DEFAULT_PAGE_SIZE: readonly [number, number] = [595.28, 841.89];
export const NOTE_WINDOW_SIZE = { width: 760, height: 680 } as const;
export const PLACEMENT_TIMEOUT_MS = 60_000;

export const TESTED_ZOTERO_VERSION = "9.0.6";

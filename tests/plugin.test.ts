import { afterEach, describe, expect, it, vi } from "vitest";

import { NOTE_TAG, RELATION_PREDICATE, STICKY_TAG } from "../src/constants";
import { StickyNotesPlugin } from "../src/plugin";
import type { ReaderEvent, ReaderLike, ZoteroItemLike } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installDeleteFixture(choice: number) {
  const source = {
    id: 10,
    key: "SOURCE01",
    libraryID: 1,
    parentID: 100,
  } as unknown as ZoteroItemLike;
  const annotationURI = "http://zotero.org/users/1/items/STICKY01";
  const noteURI = "http://zotero.org/users/1/items/NOTEPDF1";
  const annotation = {
    id: 11,
    key: "STICKY01",
    libraryID: 1,
    parentID: source.id,
    annotationType: "note",
    isAnnotation: () => true,
    getTags: () => [{ tag: STICKY_TAG }],
    getRelationsByPredicate: (predicate: string) =>
      predicate === RELATION_PREDICATE ? [noteURI] : [],
    loadDataType: vi.fn(async () => undefined),
  } as unknown as ZoteroItemLike;
  let noteItemDataLoaded = false;
  const note = {
    id: 12,
    key: "NOTEPDF1",
    libraryID: 1,
    parentID: 100,
    attachmentContentType: "application/pdf",
    isPDFAttachment: () => true,
    isStoredFileAttachment: () => true,
    getField: () => {
      if (!noteItemDataLoaded) throw new Error("itemData is not loaded");
      return "Sticky Notes 1.pdf";
    },
    getTags: () => [{ tag: NOTE_TAG }],
    getRelationsByPredicate: (predicate: string) =>
      predicate === RELATION_PREDICATE ? [annotationURI] : [],
    loadDataType: vi.fn(async (type: string) => {
      if (type === "itemData") noteItemDataLoaded = true;
    }),
  } as unknown as ZoteroItemLike;
  const confirmEx = vi.fn(
    (
      _parent: unknown,
      _dialogTitle: string,
      _text: string,
      _buttonFlags: number,
      _button0Title: string,
      _button1Title: string,
      _button2Title: string,
      _checkMessage: string,
      _checkState: { value: boolean },
    ) => choice,
  );
  vi.stubGlobal("Services", {
    locale: { appLocaleAsBCP47: "en-US" },
    prompt: {
      BUTTON_POS_0: 1,
      BUTTON_POS_1: 256,
      BUTTON_TITLE_CANCEL: 2,
      BUTTON_TITLE_IS_STRING: 127,
      BUTTON_POS_1_DEFAULT: 16_777_216,
      confirmEx,
    },
  });
  vi.stubGlobal("Zotero", {
    locale: "en-US",
    logError: vi.fn(),
    debug: vi.fn(),
    alert: vi.fn(),
    Items: {
      get: vi.fn(() => annotation),
      getByLibraryAndKey: vi.fn(() => annotation),
      getAsync: vi.fn(async (id: number) => (id === source.id ? source : false)),
    },
    URI: {
      getURIItem: vi.fn(async (uri: string) => (uri === noteURI ? note : false)),
      getItemURI: vi.fn(() => annotationURI),
    },
  });
  return { annotation, confirmEx, note };
}

describe("sticky annotation actions", () => {
  it("offers both open and explicit paired-delete actions on a plugin sticky", () => {
    const { annotation } = installDeleteFixture(1);
    const plugin = new StickyNotesPlugin();
    plugin.data.initialized = true;
    const items: Array<{ label: string; onCommand: () => void }> = [];
    const event = {
      reader: { itemID: 10, _item: { libraryID: 1 } } as ReaderLike,
      params: { ids: [annotation.key] },
      append: (item: { label: string; onCommand: () => void }) => items.push(item),
    } as ReaderEvent;

    (plugin as any).createAnnotationContextMenu(event);

    expect(items.map(({ label }) => label)).toEqual([
      "Open handwritten notes",
      "Delete sticky and move notes PDF to Trash…",
    ]);
  });

  it("defaults the destructive confirmation to Cancel and honors cancellation", async () => {
    const { annotation, confirmEx, note } = installDeleteFixture(1);
    const plugin = new StickyNotesPlugin();
    plugin.data.initialized = true;
    const deleteForAnnotation = vi.fn(async () => undefined);
    (plugin as any).noteService = { deleteForAnnotation };

    await (plugin as any).confirmAndDeletePair(annotation, {
      itemID: 10,
      _window: {},
    } as ReaderLike);

    expect(deleteForAnnotation).not.toHaveBeenCalled();
    expect(confirmEx).toHaveBeenCalledOnce();
    expect(confirmEx.mock.calls[0][2]).toContain("Sticky Notes 1.pdf");
    expect(confirmEx.mock.calls[0][3] & 16_777_216).toBe(16_777_216);
    expect(confirmEx.mock.calls[0][4]).toBe("Delete both");
    expect(note.id).toBe(12);
  });

  it("runs paired deletion only after explicit confirmation", async () => {
    const { annotation, note } = installDeleteFixture(0);
    const plugin = new StickyNotesPlugin();
    plugin.data.initialized = true;
    const deleteForAnnotation = vi.fn(async () => undefined);
    (plugin as any).noteService = { deleteForAnnotation };

    await (plugin as any).confirmAndDeletePair(annotation, {
      itemID: 10,
      _window: {},
    } as ReaderLike);

    expect(deleteForAnnotation).toHaveBeenCalledWith(annotation, note);
  });
});

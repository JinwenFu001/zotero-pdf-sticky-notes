import { afterEach, describe, expect, it, vi } from "vitest";

import { MARKER_TAG_TYPE, NOTE_TAG, RELATION_PREDICATE, STICKY_TAG } from "../src/constants";
import { linkStickyAndNote, resolveLinkedNote } from "../src/relations";
import type { ZoteroItemLike } from "../src/types";

type FakeItem = ZoteroItemLike & {
  relationMap: Map<string, string[]>;
  tagMap: Map<string, number>;
  _clearChanged: ReturnType<typeof vi.fn>;
};

const itemURI = (item: Pick<ZoteroItemLike, "libraryID" | "key">) =>
  `http://zotero.org/users/${item.libraryID}/items/${item.key}`;

function makeItem(
  options: Partial<ZoteroItemLike> & Pick<ZoteroItemLike, "id" | "key" | "libraryID">,
  initialRelations: Record<string, string[]> = {},
  initialTags: Array<{ tag: string; type?: number }> = [],
): FakeItem {
  const relationMap = new Map(
    Object.entries(initialRelations).map(([predicate, values]) => [predicate, [...values]]),
  );
  const tagMap = new Map(initialTags.map(({ tag, type = 0 }) => [tag, type]));
  const save = vi.fn(async () => true);
  return {
    parentID: false,
    getField: vi.fn(),
    setField: vi.fn(),
    getRelationsByPredicate: (predicate) => [...(relationMap.get(predicate) ?? [])],
    addRelation: (predicate, object) => {
      const values = relationMap.get(predicate) ?? [];
      if (values.includes(object)) return false;
      relationMap.set(predicate, [...values, object]);
      return true;
    },
    removeRelation: (predicate, object) => {
      const values = relationMap.get(predicate) ?? [];
      const remaining = values.filter((value) => value !== object);
      relationMap.set(predicate, remaining);
      return remaining.length !== values.length;
    },
    getTags: () => [...tagMap].map(([tag, type]) => ({ tag, type })),
    addTag: (tag, type = 0) => {
      if (tagMap.get(tag) === type) return false;
      tagMap.set(tag, type);
      return true;
    },
    removeTag: (tag) => tagMap.delete(tag),
    save,
    saveTx: vi.fn(async () => true),
    loadDataType: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    _clearChanged: vi.fn(),
    relationMap,
    tagMap,
    ...options,
  };
}

function makeLinkedFixture(overrides?: {
  annotation?: Partial<ZoteroItemLike>;
  note?: Partial<ZoteroItemLike>;
  noteRelations?: Record<string, string[]>;
  stickyRelations?: Record<string, string[]>;
  noteTags?: Array<{ tag: string; type?: number }>;
  stickyTags?: Array<{ tag: string; type?: number }>;
}) {
  const source = makeItem({ id: 10, key: "SOURCE", libraryID: 1, parentID: 100 });
  const annotationBase = { id: 11, key: "STICKY", libraryID: 1, parentID: source.id };
  const noteBase = { id: 12, key: "NOTE", libraryID: 1, parentID: source.parentID };
  const annotationURI = itemURI(annotationBase);
  const noteURI = itemURI(noteBase);
  const annotation = makeItem(
    {
      ...annotationBase,
      annotationType: "note",
      isAnnotation: () => true,
      ...overrides?.annotation,
    },
    overrides?.stickyRelations ?? {
      [RELATION_PREDICATE]: [noteURI],
    },
    overrides?.stickyTags ?? [{ tag: STICKY_TAG, type: MARKER_TAG_TYPE }],
  );
  const note = makeItem(
    {
      ...noteBase,
      attachmentContentType: "application/pdf",
      isPDFAttachment: () => true,
      isStoredFileAttachment: () => true,
      ...overrides?.note,
    },
    overrides?.noteRelations ?? {
      [RELATION_PREDICATE]: [annotationURI],
    },
    overrides?.noteTags ?? [{ tag: NOTE_TAG, type: MARKER_TAG_TYPE }],
  );
  return { annotation, annotationURI, note, noteURI, source };
}

function installZoteroMock(items: FakeItem[]) {
  const byURI = new Map(items.map((item) => [itemURI(item), item]));
  const byID = new Map(items.map((item) => [item.id, item]));
  const executeTransaction = vi.fn(async (callback: () => Promise<void>) => callback());
  vi.stubGlobal("Zotero", {
    logError: vi.fn(),
    URI: {
      getItemURI: itemURI,
      getURIItem: vi.fn(async (uri: string) => byURI.get(uri) ?? false),
    },
    Relations: { unregister: vi.fn() },
    Items: {
      getAsync: vi.fn(async (id: number) => byID.get(id) ?? false),
    },
    DB: { executeTransaction },
  });
  return { executeTransaction };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sticky-note relationships", () => {
  it("resolves one reciprocal PDF relation in the same library and parent item", async () => {
    const fixture = makeLinkedFixture();
    installZoteroMock([fixture.source, fixture.annotation, fixture.note]);

    await expect(resolveLinkedNote(fixture.annotation)).resolves.toEqual({
      status: "ok",
      item: fixture.note,
    });
  });

  it("rejects missing and ambiguous outgoing relations", async () => {
    const missing = makeLinkedFixture({
      stickyRelations: {},
    });
    installZoteroMock([missing.source, missing.annotation, missing.note]);
    await expect(resolveLinkedNote(missing.annotation)).resolves.toEqual({
      status: "missing-relation",
    });

    vi.unstubAllGlobals();
    const ambiguous = makeLinkedFixture({
      stickyRelations: {
        [RELATION_PREDICATE]: [
          "http://zotero.org/users/1/items/ONE",
          "http://zotero.org/users/1/items/TWO",
        ],
      },
    });
    installZoteroMock([ambiguous.source, ambiguous.annotation, ambiguous.note]);
    await expect(resolveLinkedNote(ambiguous.annotation)).resolves.toEqual({
      status: "invalid-target",
    });
  });

  it("rejects cross-library and cross-parent targets", async () => {
    const crossLibrary = makeLinkedFixture({ note: { libraryID: 2 } });
    crossLibrary.annotation.relationMap.set(RELATION_PREDICATE, [itemURI(crossLibrary.note)]);
    installZoteroMock([crossLibrary.source, crossLibrary.annotation, crossLibrary.note]);
    await expect(resolveLinkedNote(crossLibrary.annotation)).resolves.toEqual({
      status: "wrong-library",
    });

    vi.unstubAllGlobals();
    const crossParent = makeLinkedFixture({ note: { parentID: 999 } });
    installZoteroMock([crossParent.source, crossParent.annotation, crossParent.note]);
    await expect(resolveLinkedNote(crossParent.annotation)).resolves.toEqual({
      status: "wrong-parent",
    });
  });

  it("requires a stored plugin-note PDF with a reciprocal link", async () => {
    const notStored = makeLinkedFixture({ note: { isStoredFileAttachment: () => false } });
    installZoteroMock([notStored.source, notStored.annotation, notStored.note]);
    await expect(resolveLinkedNote(notStored.annotation)).resolves.toEqual({
      status: "invalid-target",
    });

    vi.unstubAllGlobals();
    const noReciprocalLink = makeLinkedFixture({
      noteRelations: {},
    });
    installZoteroMock([
      noReciprocalLink.source,
      noReciprocalLink.annotation,
      noReciprocalLink.note,
    ]);
    await expect(resolveLinkedNote(noReciprocalLink.annotation)).resolves.toEqual({
      status: "invalid-target",
    });

    vi.unstubAllGlobals();
    const noMarkerTag = makeLinkedFixture({ noteTags: [] });
    installZoteroMock([noMarkerTag.source, noMarkerTag.annotation, noMarkerTag.note]);
    await expect(resolveLinkedNote(noMarkerTag.annotation)).resolves.toEqual({
      status: "invalid-target",
    });
  });

  it("distinguishes a deleted target", async () => {
    const fixture = makeLinkedFixture({ note: { deleted: true } });
    installZoteroMock([fixture.source, fixture.annotation, fixture.note]);
    await expect(resolveLinkedNote(fixture.annotation)).resolves.toEqual({ status: "deleted" });
  });

  it("classifies a malformed Zotero item URI as an invalid relation", async () => {
    const fixture = makeLinkedFixture({
      stickyRelations: {
        [RELATION_PREDICATE]: ["not-a-zotero-item-uri"],
      },
    });
    installZoteroMock([fixture.source, fixture.annotation, fixture.note]);
    (Zotero.URI.getURIItem as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Malformed item URI"),
    );

    await expect(resolveLinkedNote(fixture.annotation)).resolves.toEqual({
      status: "invalid-target",
    });
    expect(Zotero.logError).toHaveBeenCalledOnce();
  });

  it("writes both directions atomically for items in the same library", async () => {
    const annotation = makeItem({
      id: 1,
      key: "ANNOTATION",
      libraryID: 7,
      parentID: 10,
      annotationType: "note",
      isAnnotation: () => true,
    });
    const note = makeItem({
      id: 2,
      key: "NOTE",
      libraryID: 7,
      parentID: 20,
      isPDFAttachment: () => true,
      isStoredFileAttachment: () => true,
    });
    const { executeTransaction } = installZoteroMock([annotation, note]);

    await linkStickyAndNote(annotation, note);

    expect(annotation.tagMap.get(STICKY_TAG)).toBe(MARKER_TAG_TYPE);
    expect(annotation.relationMap.get(RELATION_PREDICATE)).toEqual([itemURI(note)]);
    expect(note.tagMap.get(NOTE_TAG)).toBe(MARKER_TAG_TYPE);
    expect(note.relationMap.get(RELATION_PREDICATE)).toEqual([itemURI(annotation)]);
    expect(executeTransaction).toHaveBeenCalledOnce();
    expect(annotation.save).toHaveBeenCalledOnce();
    expect(note.save).toHaveBeenCalledOnce();
  });

  it("reloads cached relations when the linking transaction rolls back", async () => {
    const annotation = makeItem(
      {
        id: 21,
        key: "ANNOTATION",
        libraryID: 7,
        annotationType: "note",
        isAnnotation: () => true,
      },
      {},
      [{ tag: STICKY_TAG, type: 1 }],
    );
    const note = makeItem({ id: 22, key: "NOTE", libraryID: 7 });
    installZoteroMock([annotation, note]);
    (note.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("transaction failed"));

    await expect(linkStickyAndNote(annotation, note)).rejects.toThrow("transaction failed");

    expect(annotation.reload).toHaveBeenCalledWith(["relations", "tags"], true);
    expect(note.reload).toHaveBeenCalledWith(["relations", "tags"], true);
    expect(annotation._clearChanged).toHaveBeenCalledWith("tags");
    expect(note._clearChanged).toHaveBeenCalledWith("tags");
    expect((Zotero as any).Relations.unregister).toHaveBeenCalledTimes(2);
    expect(annotation.tagMap.get(STICKY_TAG)).toBe(1);
    expect(note.tagMap.size).toBe(0);
  });

  it("refuses to create cross-library links before starting a transaction", async () => {
    const annotation = makeItem({ id: 1, key: "ANNOTATION", libraryID: 1 });
    const note = makeItem({ id: 2, key: "NOTE", libraryID: 2 });
    const { executeTransaction } = installZoteroMock([annotation, note]);

    await expect(linkStickyAndNote(annotation, note)).rejects.toThrow("same library");
    expect(executeTransaction).not.toHaveBeenCalled();
    expect(annotation.relationMap.size).toBe(0);
    expect(note.relationMap.size).toBe(0);
  });
});

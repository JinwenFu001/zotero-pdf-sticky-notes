import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeReaderHooks, unregisterReaderHooks } from "../src/compat/zotero-9-reader";
import { NOTE_TAG, RELATION_PREDICATE, STICKY_TAG } from "../src/constants";
import {
  AttachmentUnavailableError,
  nextAttachmentTitle,
  NoteService,
} from "../src/notes/note-service";
import type { ReaderLike, ZoteroItemLike } from "../src/types";

afterEach(() => {
  unregisterReaderHooks();
  vi.unstubAllGlobals();
});

describe("NoteService attachment download", () => {
  it("returns an abort promptly but blocks later file access until the request settles", async () => {
    let finishDownload!: (value: unknown) => void;
    const download = new Promise((resolve) => {
      finishDownload = resolve;
    });
    const transferRequest = { stop: vi.fn() };
    const downloadFile = vi.fn(
      (
        _item: ZoteroItemLike,
        callbacks: { onStart: (request: { stop: (force?: boolean) => void }) => unknown },
      ) => {
        callbacks.onStart(transferRequest);
        return download;
      },
    );
    class StorageResult {}

    vi.stubGlobal("IOUtils", { exists: vi.fn(async () => false) });
    vi.stubGlobal("Zotero", {
      logError: vi.fn(),
      Sync: {
        Runner: { downloadFile },
        Storage: {
          Result: StorageResult,
          Local: { getEnabledForLibrary: vi.fn(async () => true) },
        },
      },
    });

    const item = {
      id: 1,
      key: "ABCD2345",
      libraryID: 1,
      getFilePathAsync: vi.fn(async () => false),
    } as unknown as ZoteroItemLike;
    const controller = new AbortController();
    const service = new NoteService();
    let finished = false;
    const outcome = service.ensureLocalFile(item, true, controller.signal).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledOnce());
    controller.abort();
    await vi.waitFor(() => expect(transferRequest.stop).toHaveBeenCalled());
    const result = await outcome;
    expect(result).toHaveProperty("error");
    expect((result as { error: unknown }).error).toBeInstanceOf(AttachmentUnavailableError);
    expect((result as { error: AttachmentUnavailableError }).error.problem).toBe("download-failed");
    expect(service.hasPendingFileOperation(item)).toBe(true);

    const laterAccess = service.ensureLocalFile(item, false).finally(() => {
      finished = true;
    });
    let shutdownBarrierFinished = false;
    const shutdownBarrier = service.waitForAllPendingFileOperations().then(() => {
      shutdownBarrierFinished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(shutdownBarrierFinished).toBe(false);

    finishDownload(false);
    await expect(laterAccess).rejects.toMatchObject({ problem: "not-downloaded" });
    await shutdownBarrier;
    expect(finished).toBe(true);
    expect(shutdownBarrierFinished).toBe(true);
    expect(service.hasPendingFileOperation(item)).toBe(false);
  });
});

describe("note attachment numbering", () => {
  it("uses the first gap among active attachments and ignores trashed children", async () => {
    const loadedItemData = new Set<number>();
    const children = new Map<number, ZoteroItemLike>([
      [
        1,
        {
          id: 1,
          deleted: false,
          loadDataType: vi.fn(async (type: string) => {
            if (type === "itemData") loadedItemData.add(1);
          }),
          getField: () => {
            if (!loadedItemData.has(1)) throw new Error("itemData is not loaded");
            return "Sticky Notes 1.pdf";
          },
        } as unknown as ZoteroItemLike,
      ],
      [
        2,
        {
          id: 2,
          deleted: true,
          getField: () => "Sticky Notes 2.pdf",
        } as unknown as ZoteroItemLike,
      ],
      [
        3,
        {
          id: 3,
          deleted: false,
          loadDataType: vi.fn(async (type: string) => {
            if (type === "itemData") loadedItemData.add(3);
          }),
          getField: () => {
            if (!loadedItemData.has(3)) throw new Error("itemData is not loaded");
            return "Sticky Notes 3.pdf";
          },
        } as unknown as ZoteroItemLike,
      ],
    ]);
    const getAttachments = vi.fn((_includeTrashed: boolean) => [1, 2, 3]);
    const loadDataType = vi.fn(async (dataType: string) => {
      expect(dataType).toBe("childItems");
      expect(getAttachments).not.toHaveBeenCalled();
    });
    vi.stubGlobal("Zotero", {
      logError: vi.fn(),
      Reader: {},
      Items: { getAsync: vi.fn(async (id: number) => children.get(id) ?? false) },
    });
    const parent = { getAttachments, loadDataType } as unknown as ZoteroItemLike;

    await expect(nextAttachmentTitle(parent)).resolves.toBe("Sticky Notes 2.pdf");
    expect(getAttachments).toHaveBeenCalledWith(false);
    expect(loadDataType).toHaveBeenCalledOnce();
    expect(loadedItemData).toEqual(new Set([1, 3]));
  });

  it("removes the just-created sticky if cold parent metadata cannot be loaded", async () => {
    const annotation = {
      id: 21,
      key: "STICKY21",
      libraryID: 1,
      eraseTx: vi.fn(async () => true),
    } as unknown as ZoteroItemLike;
    const parent = {
      id: 100,
      key: "PARENT01",
      libraryID: 1,
      deleted: false,
      loadDataType: vi.fn(async () => {
        throw new Error("cold childItems load failed");
      }),
    } as unknown as ZoteroItemLike;
    const source = {
      id: 20,
      key: "SOURCE20",
      libraryID: 1,
      parentID: parent.id,
      isEditable: () => true,
    } as unknown as ZoteroItemLike;
    vi.stubGlobal("Zotero", {
      logError: vi.fn(),
      Reader: {},
      Items: {
        getAsync: vi.fn(async () => parent),
        getByLibraryAndKeyAsync: vi.fn(async () => parent),
      },
      Libraries: { get: vi.fn(() => ({ editable: true, filesEditable: true })) },
    });

    await expect(new NoteService().createForAnnotation(source, annotation)).rejects.toThrow(
      "cold childItems load failed",
    );

    expect(annotation.eraseTx).toHaveBeenCalledOnce();
  });

  it("preserves a created PDF when the failed sticky cannot be cleaned up", async () => {
    const annotation = {
      id: 31,
      key: "STICKY31",
      libraryID: 1,
      parentID: 30,
      loadDataType: vi.fn(async () => undefined),
      eraseTx: vi.fn(async () => {
        throw new Error("sticky cleanup denied");
      }),
    } as unknown as ZoteroItemLike;
    const note = {
      id: 32,
      key: "NOTEPDF2",
      libraryID: 1,
      parentID: 100,
      loadDataType: vi.fn(async () => undefined),
      eraseTx: vi.fn(async () => true),
    } as unknown as ZoteroItemLike;
    const parent = {
      id: 100,
      key: "PARENT01",
      libraryID: 1,
      deleted: false,
      loadDataType: vi.fn(async () => undefined),
      getAttachments: vi.fn(() => []),
    } as unknown as ZoteroItemLike;
    const source = {
      id: 30,
      key: "SOURCE30",
      libraryID: 1,
      parentID: parent.id,
      isEditable: () => true,
    } as unknown as ZoteroItemLike;
    const importFromFile = vi.fn(async () => note);
    vi.stubGlobal("PathUtils", {
      tempDir: "/tmp",
      join: (...parts: string[]) => parts.join("/"),
    });
    vi.stubGlobal("IOUtils", {
      write: vi.fn(async () => undefined),
      exists: vi.fn(async () => false),
      remove: vi.fn(async () => undefined),
    });
    vi.stubGlobal("Zotero", {
      logError: vi.fn(),
      Reader: {},
      Utilities: { randomString: vi.fn(() => "TOKEN123") },
      Attachments: { importFromFile },
      Items: {
        getAsync: vi.fn(async (id: number) => (id === parent.id ? parent : false)),
        getByLibraryAndKeyAsync: vi.fn(async () => parent),
      },
      Libraries: { get: vi.fn(() => ({ editable: true, filesEditable: true })) },
    });

    await expect(new NoteService().createForAnnotation(source, annotation)).rejects.toThrow(
      /notes attachment was preserved.*1\/NOTEPDF2/,
    );

    expect(importFromFile).toHaveBeenCalledOnce();
    expect(annotation.eraseTx).toHaveBeenCalledOnce();
    expect(note.eraseTx).not.toHaveBeenCalled();
  });
});

describe("paired sticky-note deletion", () => {
  it("deletes the annotation and trashes the PDF in one transaction", async () => {
    const operationOrder: string[] = [];
    const itemURI = (item: ZoteroItemLike) =>
      `http://zotero.org/users/${item.libraryID}/items/${item.key}`;
    const parent = {
      id: 100,
      key: "PARENT01",
      libraryID: 1,
      deleted: false,
      reload: vi.fn(async () => undefined),
    } as unknown as ZoteroItemLike;
    const source = {
      id: 10,
      key: "SOURCE01",
      libraryID: 1,
      parentID: parent.id,
      reload: vi.fn(async () => undefined),
    } as unknown as ZoteroItemLike;
    const annotation = {
      id: 11,
      key: "STICKY01",
      libraryID: 1,
      parentID: source.id,
      annotationType: "note",
      isAnnotation: () => true,
      isEditable: () => true,
      getTags: () => [{ tag: STICKY_TAG }],
      getRelationsByPredicate: (predicate: string) =>
        predicate === RELATION_PREDICATE ? [itemURI(note)] : [],
      loadDataType: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      erase: vi.fn(async () => {
        operationOrder.push("erase");
        return true;
      }),
    } as unknown as ZoteroItemLike;
    const note = {
      id: 12,
      key: "NOTEPDF1",
      libraryID: 1,
      parentID: parent.id,
      deleted: false,
      isEditable: () => true,
      isPDFAttachment: () => true,
      isStoredFileAttachment: () => true,
      getTags: () => [{ tag: NOTE_TAG }],
      getRelationsByPredicate: (predicate: string) =>
        predicate === RELATION_PREDICATE ? [itemURI(annotation)] : [],
      loadDataType: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
    } as unknown as ZoteroItemLike;
    const byID = new Map([
      [parent.id, parent],
      [source.id, source],
      [annotation.id, annotation],
      [note.id, note],
    ]);
    const byKey = new Map(
      [...byID.values()].map((item) => [`${item.libraryID}:${item.key}`, item] as const),
    );
    const trash = vi.fn(async () => {
      operationOrder.push("trash");
    });
    let transactionCallbacks:
      | { commit: Array<() => unknown>; rollback: Array<() => unknown> }
      | undefined;
    const addCurrentCallback = vi.fn((type: "commit" | "rollback", callback: () => unknown) => {
      if (!transactionCallbacks) throw new Error("No transaction is active");
      transactionCallbacks[type].push(callback);
    });
    const executeTransaction = vi.fn(async (callback: () => Promise<void>) => {
      transactionCallbacks = { commit: [], rollback: [] };
      try {
        await callback();
      } catch (error) {
        for (const rollback of transactionCallbacks.rollback.splice(0)) await rollback();
        transactionCallbacks = undefined;
        throw error;
      }
      const commits = transactionCallbacks.commit.splice(0);
      transactionCallbacks.rollback = [];
      for (const commit of commits) await commit();
      transactionCallbacks = undefined;
    });
    const unsavedAnnotations = new Set(["fresh-ink"]);
    const triggerSaving = vi.fn(async () => {
      operationOrder.push("flush");
      unsavedAnnotations.clear();
    });
    const noteWindow = new EventTarget() as unknown as Window & { closed: boolean };
    noteWindow.closed = false;
    const noteReader = {
      itemID: note.id,
      _window: noteWindow,
      _internalReader: {
        _state: { readOnly: false },
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: unsavedAnnotations,
          _triggerSaving: triggerSaving,
        },
        freeze: vi.fn(),
        unfreeze: vi.fn(),
      },
    } as unknown as ReaderLike;
    vi.stubGlobal("Zotero", {
      version: "9.0.6",
      logError: vi.fn(),
      Reader: { _readers: [noteReader], open: vi.fn(async () => undefined) },
      Items: {
        getAsync: vi.fn(async (id: number) => byID.get(id) ?? false),
        getByLibraryAndKeyAsync: vi.fn(
          async (libraryID: number, key: string) => byKey.get(`${libraryID}:${key}`) ?? false,
        ),
        trash,
      },
      URI: {
        getItemURI: itemURI,
        getURIItem: vi.fn(async (uri: string) =>
          [...byID.values()].find((item) => itemURI(item) === uri),
        ),
      },
      Libraries: { get: vi.fn(() => ({ editable: true, filesEditable: true })) },
      DB: { addCurrentCallback, executeTransaction },
    });
    initializeReaderHooks();

    const service = new NoteService();
    await service.deleteForAnnotation(annotation, note);

    expect(executeTransaction).toHaveBeenCalledOnce();
    expect(annotation.erase).toHaveBeenCalledOnce();
    expect(trash).toHaveBeenCalledWith(note.id);
    expect(operationOrder).toEqual(["flush", "erase", "trash"]);
    expect(note.reload).not.toHaveBeenCalled();
    expect(source.reload).not.toHaveBeenCalled();
    expect(parent.reload).not.toHaveBeenCalled();

    trash.mockRejectedValueOnce(new Error("trash failed"));
    await expect(service.deleteForAnnotation(annotation, note)).rejects.toThrow("trash failed");
    expect(source.reload).toHaveBeenCalledWith(["primaryData", "childItems"], true);
    expect(parent.reload).toHaveBeenCalledWith(["primaryData", "childItems"], true);

    const eraseCallsBeforeFlushFailure = vi.mocked(annotation.erase!).mock.calls.length;
    const trashCallsBeforeFlushFailure = trash.mock.calls.length;
    unsavedAnnotations.add("new-ink");
    triggerSaving.mockRejectedValueOnce(new Error("flush failed"));

    await expect(service.deleteForAnnotation(annotation, note)).rejects.toThrow("flush failed");
    expect(annotation.erase).toHaveBeenCalledTimes(eraseCallsBeforeFlushFailure);
    expect(trash).toHaveBeenCalledTimes(trashCallsBeforeFlushFailure);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginReaderNotePlacement,
  enableImmediateAnnotationSaving,
  flushReaderAnnotations,
  initializeReaderHooks,
  installCloseSaveGuard,
  setReaderTool,
  unregisterReaderHooks,
  waitForPendingCloseSaveGuards,
  withPDFWorkerSerialized,
  withReaderOpeningPaused,
} from "../src/compat/zotero-9-reader";
import type { ReaderLike } from "../src/types";

function makeWindow(): Window {
  const window = new EventTarget() as unknown as Window & Record<string, unknown>;
  Object.assign(window, {
    closed: false,
    document: { getElementById: () => null },
    close: vi.fn(),
    focus: vi.fn(),
  });
  return window;
}

function installZoteroMock(readers: ReaderLike[]) {
  vi.stubGlobal("Zotero", {
    Reader: {
      _readers: readers,
      _unregisterEventListenerByPluginID: vi.fn(),
    },
    logError: vi.fn(),
    version: "9.0.6",
  });
  vi.stubGlobal("Components", {
    utils: {
      cloneInto: (value: unknown) => value,
      exportFunction: (fn: (...args: any[]) => any) => fn,
    },
  });
}

beforeEach(() => {
  installZoteroMock([]);
  initializeReaderHooks();
});

afterEach(() => {
  unregisterReaderHooks();
  vi.unstubAllGlobals();
});

describe("Zotero 9 reader compatibility", () => {
  it("detects when Zotero silently refuses a read-only annotation tool", () => {
    const refused = {
      _iframeWindow: makeWindow(),
      _internalReader: {
        _state: { tool: { type: "pointer" } },
        setTool: vi.fn(),
      },
    } as unknown as ReaderLike;
    expect(setReaderTool(refused, { type: "note" })).toBe(false);

    const accepted = {
      _iframeWindow: makeWindow(),
      _internalReader: {
        _state: { tool: { type: "pointer" } },
        setTool(params: { type: string }) {
          this._state.tool = { type: params.type };
        },
      },
    } as unknown as ReaderLike;
    expect(setReaderTool(accepted, { type: "note" })).toBe(true);
  });

  it("captures the exact native note key created by plugin placement", () => {
    const captured = vi.fn();
    const cancelled = vi.fn();
    const manager = {
      addAnnotation(annotation: Record<string, unknown>) {
        return { ...annotation, id: "ABCD2345" };
      },
    };
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      setTool(tool: { type: string; [key: string]: unknown }) {
        this._state.tool = tool;
      },
    };
    const reader = {
      itemID: 4,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    const cancel = beginReaderNotePlacement(reader, "#2ea8e5", captured, cancelled);
    expect(cancel).toBeTypeOf("function");
    manager.addAnnotation({ type: "note", color: "#2ea8e5", sortIndex: "1" });

    expect(captured).toHaveBeenCalledWith("ABCD2345");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("cancels plugin placement when the user changes tools", () => {
    const captured = vi.fn();
    const cancelled = vi.fn();
    const manager = {
      addAnnotation(annotation: Record<string, unknown>) {
        return { ...annotation, id: "UNRELATED" };
      },
    };
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      setTool(tool: { type: string; [key: string]: unknown }) {
        this._state.tool = tool;
      },
    };
    const reader = {
      itemID: 5,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    beginReaderNotePlacement(reader, "#2ea8e5", captured, cancelled);
    internal.setTool({ type: "ink" });
    manager.addAnnotation({ type: "note", color: "#ffd400", sortIndex: "2" });

    expect(cancelled).toHaveBeenCalledOnce();
    expect(captured).not.toHaveBeenCalled();
  });

  it("latches a host save failure that Zotero only reports by becoming read-only", async () => {
    const manager = {
      _skipAnnotationSavingDebounce: false,
      _savingInProgress: false,
      _unsavedAnnotations: new Set<string>(),
      _triggerSaving: vi.fn(async () => undefined),
    };
    const internal = {
      _state: { readOnly: false },
      _annotationManager: manager,
      setReadOnly(readOnly: boolean) {
        this._state.readOnly = readOnly;
      },
      _onDeleteAnnotations: vi.fn(async () => undefined),
    };
    const reader = {
      itemID: 6,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    enableImmediateAnnotationSaving(reader);
    manager._savingInProgress = true;
    internal.setReadOnly(true);
    manager._savingInProgress = false;

    await expect(flushReaderAnnotations(reader)).rejects.toThrow(/failed to save handwritten/);
  });

  it("latches an unexpected read-only state that predates toolbar initialization", async () => {
    const item = {
      id: 16,
      libraryID: 1,
      isEditable: () => true,
    };
    Object.assign(Zotero, {
      Items: { get: vi.fn(() => item) },
      Libraries: { get: vi.fn(() => ({ editable: true, filesEditable: true })) },
    });
    const reader = {
      itemID: item.id,
      _item: item,
      _iframeWindow: makeWindow(),
      _internalReader: {
        _state: { readOnly: true },
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: new Set<string>(),
          _triggerSaving: vi.fn(async () => undefined),
        },
        setReadOnly: vi.fn(),
        _onDeleteAnnotations: vi.fn(async () => undefined),
      },
    } as unknown as ReaderLike;

    enableImmediateAnnotationSaving(reader);

    await expect(flushReaderAnnotations(reader)).rejects.toThrow(/failed to save handwritten/);
  });

  it("waits for Zotero's unawaited erase transaction", async () => {
    let release!: () => void;
    const deletion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const internal = {
      _state: { readOnly: false },
      _annotationManager: {
        _skipAnnotationSavingDebounce: false,
        _savingInProgress: false,
        _unsavedAnnotations: new Set<string>(),
        _triggerSaving: vi.fn(async () => undefined),
      },
      setReadOnly: vi.fn(),
      _onDeleteAnnotations: vi.fn((_ids: string[]) => deletion),
    };
    const reader = {
      itemID: 7,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;
    enableImmediateAnnotationSaving(reader);
    internal._onDeleteAnnotations(["erased-ink"]);

    let flushed = false;
    const flush = flushReaderAnnotations(reader).then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it("propagates a failed erase transaction instead of treating it as saved", async () => {
    const internal = {
      _state: { readOnly: false },
      _annotationManager: {
        _skipAnnotationSavingDebounce: false,
        _savingInProgress: false,
        _unsavedAnnotations: new Set<string>(),
        _triggerSaving: vi.fn(async () => undefined),
      },
      setReadOnly: vi.fn(),
      _onDeleteAnnotations: vi.fn((_ids: string[]) =>
        Promise.reject(new Error("erase transaction failed")),
      ),
    };
    const reader = {
      itemID: 8,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;
    enableImmediateAnnotationSaving(reader);
    internal._onDeleteAnnotations(["erased-ink"]);

    await expect(flushReaderAnnotations(reader)).rejects.toThrow(/failed to save an erased/);
  });

  it("times out a stalled erase transaction instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const internal = {
        _state: { readOnly: false },
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: new Set<string>(),
          _triggerSaving: vi.fn(async () => undefined),
        },
        setReadOnly: vi.fn(),
        _onDeleteAnnotations: vi.fn((_ids: string[]) => new Promise<void>(() => undefined)),
      };
      const reader = {
        itemID: 18,
        _iframeWindow: makeWindow(),
        _internalReader: internal,
      } as unknown as ReaderLike;
      enableImmediateAnnotationSaving(reader);
      internal._onDeleteAnnotations(["stalled-erase"]);

      const flush = flushReaderAnnotations(reader);
      const assertion = expect(flush).rejects.toThrow(/Timed out while waiting.*erased/);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_001);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebinds save hooks without leaving nested wrappers after a reader reload", () => {
    const firstManager = {
      _skipAnnotationSavingDebounce: false,
      _savingInProgress: false,
      _unsavedAnnotations: new Set<string>(),
      _triggerSaving: vi.fn(async () => undefined),
    };
    const secondManager = { ...firstManager, _unsavedAnnotations: new Set<string>() };
    const originalSetReadOnly = vi.fn();
    const originalDelete = vi.fn(async (_ids: string[]) => undefined);
    const internal = {
      _state: { readOnly: false },
      _annotationManager: firstManager,
      setReadOnly: originalSetReadOnly,
      _onDeleteAnnotations: originalDelete,
    };
    const reader = {
      itemID: 9,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    enableImmediateAnnotationSaving(reader);
    internal._annotationManager = secondManager;
    enableImmediateAnnotationSaving(reader);
    unregisterReaderHooks();

    expect(internal.setReadOnly).toBe(originalSetReadOnly);
    expect(internal._onDeleteAnnotations).toBe(originalDelete);
    expect(firstManager._skipAnnotationSavingDebounce).toBe(false);
    expect(secondManager._skipAnnotationSavingDebounce).toBe(false);
  });

  it("flushes unsaved ink before closing a standalone notes window", async () => {
    const readers: ReaderLike[] = [];
    installZoteroMock(readers);
    const unsaved = new Set(["ink"]);
    const originalClose = vi.fn();
    const triggerSaving = vi.fn(async () => unsaved.clear());
    const reader = {
      itemID: 1,
      _window: makeWindow(),
      _internalReader: {
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: unsaved,
          _triggerSaving: triggerSaving,
        },
        freeze: vi.fn(),
        unfreeze: vi.fn(),
      },
      close: originalClose,
    } as unknown as ReaderLike;
    readers.push(reader);
    const onFailure = vi.fn();

    installCloseSaveGuard(
      reader,
      { hasPending: () => false, waitForPending: async () => undefined },
      onFailure,
    );
    (reader as any).close();
    expect(originalClose).not.toHaveBeenCalled();

    await waitForPendingCloseSaveGuards();
    expect(triggerSaving).toHaveBeenCalledOnce();
    expect(originalClose).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the window open and reports a failed close-time save", async () => {
    const readers: ReaderLike[] = [];
    installZoteroMock(readers);
    const originalClose = vi.fn();
    const reader = {
      itemID: 2,
      _window: makeWindow(),
      _internalReader: {
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: new Set(["ink"]),
          _triggerSaving: vi.fn(async () => {
            throw new Error("database unavailable");
          }),
        },
        freeze: vi.fn(),
        unfreeze: vi.fn(),
      },
      close: originalClose,
    } as unknown as ReaderLike;
    readers.push(reader);
    const onFailure = vi.fn();

    installCloseSaveGuard(
      reader,
      { hasPending: () => false, waitForPending: async () => undefined },
      onFailure,
    );
    (reader as any).close();
    await waitForPendingCloseSaveGuards();

    expect(originalClose).not.toHaveBeenCalled();
    expect(reader._internalReader.unfreeze).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("does not unload a tab selected while its save barrier is draining", async () => {
    const readers: ReaderLike[] = [];
    installZoteroMock(readers);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending = true;
    const tab = { id: "note-tab", type: "reader" };
    const originalClose = vi.fn();
    const tabs = {
      selectedID: "other-tab",
      canUnload: (id: string) => id !== tabs.selectedID,
      _getTab: (id: string) => ({ tab: id === tab.id ? tab : undefined }),
      close: originalClose,
      unload: vi.fn(function (this: typeof tabs, id: string) {
        if (!this.canUnload(id)) return;
        this.close(id);
        tab.type = "reader-unloaded";
      }),
    };
    const originalUnload = tabs.unload;
    const window = makeWindow() as Window & { Zotero_Tabs: typeof tabs };
    window.Zotero_Tabs = tabs;
    const reader = {
      itemID: 3,
      tabID: tab.id,
      _window: window,
      close: vi.fn(),
      _internalReader: {
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: new Set(),
          _triggerSaving: vi.fn(async () => undefined),
        },
        freeze: vi.fn(),
        unfreeze: vi.fn(),
      },
    } as unknown as ReaderLike;
    readers.push(reader);

    installCloseSaveGuard(
      reader,
      {
        hasPending: () => pending,
        waitForPending: async () => gate,
      },
      vi.fn(),
    );
    tabs.unload(tab.id);
    tabs.selectedID = tab.id;
    pending = false;
    release();
    await waitForPendingCloseSaveGuards();

    expect(originalUnload).not.toHaveBeenCalled();
    expect(originalClose).not.toHaveBeenCalled();
    expect(tab.type).toBe("reader");
    expect(reader._internalReader.unfreeze).toHaveBeenCalledOnce();
  });

  it("guards ReaderTab.close before Zotero removes host reader listeners", async () => {
    const readers: ReaderLike[] = [];
    installZoteroMock(readers);
    const originalTabsClose = vi.fn();
    const tabs = {
      selectedID: "note-tab",
      close: originalTabsClose,
      unload: vi.fn(),
      _getTab: vi.fn(() => ({ tab: { id: "note-tab", type: "reader" } })),
    };
    const window = makeWindow() as Window & { Zotero_Tabs: typeof tabs };
    window.Zotero_Tabs = tabs;
    const removeHostListeners = vi.fn();
    const originalClose = vi.fn(() => {
      removeHostListeners();
      tabs.close("note-tab");
    });
    const reader = {
      itemID: 13,
      tabID: "note-tab",
      _window: window,
      _internalReader: {
        _annotationManager: {
          _skipAnnotationSavingDebounce: false,
          _savingInProgress: false,
          _unsavedAnnotations: new Set(["ink"]),
          _triggerSaving: vi.fn(async () => {
            throw new Error("save failed");
          }),
        },
        freeze: vi.fn(),
        unfreeze: vi.fn(),
      },
      close: originalClose,
    } as unknown as ReaderLike;
    readers.push(reader);
    const onFailure = vi.fn();

    installCloseSaveGuard(
      reader,
      { hasPending: () => false, waitForPending: async () => undefined },
      onFailure,
    );
    (reader as any).close();
    await waitForPendingCloseSaveGuards();

    expect(originalClose).not.toHaveBeenCalled();
    expect(removeHostListeners).not.toHaveBeenCalled();
    expect(originalTabsClose).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("blocks new opens and drains an already active open before a PDF file operation", async () => {
    unregisterReaderHooks();
    let releaseExisting!: () => void;
    const existingOpen = new Promise<number>((resolve) => {
      releaseExisting = () => resolve(14);
    });
    let firstMatchingOpen = true;
    const originalOpen = vi.fn((itemID: number) => {
      if (itemID === 14 && firstMatchingOpen) {
        firstMatchingOpen = false;
        return existingOpen;
      }
      return Promise.resolve(itemID);
    });
    (Zotero.Reader as any).open = originalOpen;
    initializeReaderHooks();

    const activeOpen = (Zotero.Reader as any).open(14);
    let releaseTask!: () => void;
    const taskBarrier = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let taskStarted = false;
    const operation = withReaderOpeningPaused(14, async () => {
      taskStarted = true;
      await taskBarrier;
      return "done";
    });
    await Promise.resolve();
    expect(taskStarted).toBe(false);

    await expect((Zotero.Reader as any).open(15)).resolves.toBe(15);
    const blockedOpen = (Zotero.Reader as any).open(14);
    expect(originalOpen).toHaveBeenCalledTimes(2);

    releaseExisting();
    await activeOpen;
    await vi.waitFor(() => expect(taskStarted).toBe(true));
    expect(originalOpen).toHaveBeenCalledTimes(2);

    releaseTask();
    await expect(operation).resolves.toBe("done");
    await expect(blockedOpen).resolves.toBe(14);
    expect(originalOpen).toHaveBeenCalledTimes(3);
  });

  it("fails safely when an already active reader open never settles", async () => {
    vi.useFakeTimers();
    try {
      unregisterReaderHooks();
      const originalOpen = vi.fn(() => new Promise<never>(() => undefined));
      (Zotero.Reader as any).open = originalOpen;
      initializeReaderHooks();
      void (Zotero.Reader as any).open(17);
      const task = vi.fn(async () => undefined);

      const operation = withReaderOpeningPaused(17, task);
      const assertion = expect(operation).rejects.toThrow(/existing Zotero reader to open/);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_001);

      await assertion;
      expect(task).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes page append work behind Zotero's native PDF worker operations", async () => {
    let releaseNative!: () => void;
    const nativeOperation = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    let tail = nativeOperation;
    const enqueue = vi.fn((task: () => Promise<unknown>) => {
      const result = tail.then(task);
      tail = result.then(() => undefined);
      return result;
    });
    (Zotero as any).PDFWorker = { _enqueue: enqueue };
    const pluginOperation = vi.fn(async () => "appended");

    const result = withPDFWorkerSerialized(pluginOperation);
    await Promise.resolve();
    expect(pluginOperation).not.toHaveBeenCalled();

    releaseNative();
    await expect(result).resolves.toBe("appended");
    expect(enqueue).toHaveBeenCalledWith(pluginOperation, true);
    expect(pluginOperation).toHaveBeenCalledOnce();
  });
});

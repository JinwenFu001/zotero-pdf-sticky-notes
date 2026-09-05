import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginReaderNotePlacement,
  bindStickyActivation,
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
import { STICKY_TAG } from "../src/constants";
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

function inputEvent(
  type: "pointerdown" | "mousedown" | "pointerup",
  pointerType?: string,
  annotationID?: string,
): Event {
  const event = new Event(type);
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: 48 },
    clientY: { value: 64 },
    pointerType: { value: pointerType },
  });
  if (annotationID) {
    const marker = {
      dataset: { annotationId: annotationID },
      getAttribute: (name: string) => (name === "data-annotation-id" ? annotationID : undefined),
    };
    Object.defineProperty(event, "composedPath", { value: () => [marker] });
  }
  return event;
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

  it("activates the exact sticky ID exposed by Zotero's annotation DOM", async () => {
    const annotation = {
      id: 31,
      key: "STICKY31",
      libraryID: 1,
      annotationType: "note",
      isAnnotation: () => true,
      getTags: () => [{ tag: STICKY_TAG, type: 0 }],
      loadDataType: vi.fn(async () => undefined),
    };
    Object.assign(Zotero, {
      Items: {
        getByLibraryAndKey: vi.fn((_libraryID: number, key: string) =>
          key === annotation.key ? annotation : false,
        ),
        get: vi.fn(() => false),
      },
    });

    const viewWindow = makeWindow();
    const view = {
      initializedPromise: Promise.resolve(),
      _iframeWindow: viewWindow,
      _selectedAnnotationIDs: ["SOMEONEELSE"],
      pointerEventToPosition: vi.fn(() => null),
      getSelectableAnnotations: vi.fn(() => []),
    };
    const internal = {
      _primaryView: view,
      _createView: vi.fn(),
      _updateState: vi.fn(),
    };
    const outerWindow = makeWindow() as Window & { wrappedJSObject: { _reader: typeof internal } };
    outerWindow.wrappedJSObject = { _reader: internal };
    const reader = {
      itemID: 7,
      _item: { libraryID: 1 },
      _window: makeWindow(),
      _iframeWindow: outerWindow,
    } as unknown as ReaderLike;
    const activated = vi.fn();

    await bindStickyActivation(reader, activated);
    viewWindow.dispatchEvent(inputEvent("mousedown", undefined, annotation.key));
    viewWindow.dispatchEvent(inputEvent("pointerup"));

    await vi.waitFor(() => expect(activated).toHaveBeenCalledWith(annotation, reader));
    expect(view.pointerEventToPosition).not.toHaveBeenCalled();
    expect(view.getSelectableAnnotations).not.toHaveBeenCalled();
    expect(internal._updateState).toHaveBeenCalledWith({
      primaryViewAnnotationPopup: null,
      secondaryViewAnnotationPopup: null,
    });
  });

  it("does not reuse a previously selected sticky when the click has no annotation DOM ID", async () => {
    const annotation = {
      id: 32,
      key: "STICKY32",
      libraryID: 1,
      annotationType: "note",
      isAnnotation: () => true,
      getTags: () => [{ tag: STICKY_TAG, type: 0 }],
      loadDataType: vi.fn(async () => undefined),
    };
    Object.assign(Zotero, {
      Items: {
        getByLibraryAndKey: vi.fn((_libraryID: number, key: string) =>
          key === annotation.key ? annotation : false,
        ),
        get: vi.fn(() => false),
      },
    });

    const viewWindow = makeWindow();
    const view = {
      initializedPromise: Promise.resolve(),
      _iframeWindow: viewWindow,
      _selectedAnnotationIDs: [annotation.key],
      pointerEventToPosition: vi.fn(() => null),
      getSelectableAnnotations: vi.fn(() => []),
    };
    const internal = {
      _primaryView: view,
      _createView: vi.fn(),
      _updateState: vi.fn(),
    };
    const outerWindow = makeWindow() as Window & { wrappedJSObject: { _reader: typeof internal } };
    outerWindow.wrappedJSObject = { _reader: internal };
    const reader = {
      itemID: 8,
      _item: { libraryID: 1 },
      _window: makeWindow(),
      _iframeWindow: outerWindow,
    } as unknown as ReaderLike;
    const activated = vi.fn();

    await bindStickyActivation(reader, activated);
    viewWindow.dispatchEvent(inputEvent("mousedown"));
    viewWindow.dispatchEvent(inputEvent("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(activated).not.toHaveBeenCalled();
    expect(view.pointerEventToPosition).not.toHaveBeenCalled();
    expect(view.getSelectableAnnotations).not.toHaveBeenCalled();
  });

  it("leaves an ordinary Zotero note's native click behavior untouched", async () => {
    const annotation = {
      id: 33,
      key: "ORDINARY",
      libraryID: 1,
      annotationType: "note",
      isAnnotation: () => true,
      getTags: () => [],
      loadDataType: vi.fn(async () => undefined),
    };
    Object.assign(Zotero, {
      Items: {
        getByLibraryAndKey: vi.fn(() => annotation),
        get: vi.fn(() => false),
      },
    });

    const viewWindow = makeWindow();
    const view = {
      initializedPromise: Promise.resolve(),
      _iframeWindow: viewWindow,
      _selectedAnnotationIDs: [annotation.key],
    };
    const internal = {
      _primaryView: view,
      _createView: vi.fn(),
      _updateState: vi.fn(),
    };
    const outerWindow = makeWindow() as Window & { wrappedJSObject: { _reader: typeof internal } };
    outerWindow.wrappedJSObject = { _reader: internal };
    const reader = {
      itemID: 9,
      _item: { libraryID: 1 },
      _window: makeWindow(),
      _iframeWindow: outerWindow,
    } as unknown as ReaderLike;
    const activated = vi.fn();

    await bindStickyActivation(reader, activated);
    viewWindow.dispatchEvent(inputEvent("mousedown", undefined, annotation.key));
    viewWindow.dispatchEvent(inputEvent("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(activated).not.toHaveBeenCalled();
    expect(internal._updateState).not.toHaveBeenCalled();
  });

  it("uses the iframe reader and captures the exact native mouse-note key", () => {
    const captured = vi.fn();
    const cancelled = vi.fn();
    const manager = { _annotations: [] as Array<Record<string, unknown>> };
    const viewWindow = makeWindow();
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      _primaryView: { _iframeWindow: viewWindow },
      setTool(tool: { type: string; [key: string]: unknown }) {
        this._state.tool = tool;
      },
    };
    viewWindow.addEventListener(
      "mousedown",
      () => {
        if (internal._state.tool.type !== "note") return;
        manager._annotations.push({ type: "note", color: "#2ea8e5", id: "ABCD2345" });
        internal._state.tool = { type: "pointer" };
      },
      true,
    );
    const outerWindow = makeWindow() as Window & { wrappedJSObject: { _reader: typeof internal } };
    outerWindow.wrappedJSObject = { _reader: internal };
    const reader = {
      itemID: 4,
      _iframeWindow: outerWindow,
    } as unknown as ReaderLike;
    Object.defineProperty(reader, "_internalReader", {
      get: () => {
        throw new Error("Xray-filtered property");
      },
    });

    const cancel = beginReaderNotePlacement(reader, "#2ea8e5", captured, cancelled);
    expect(cancel).toBeTypeOf("function");
    viewWindow.dispatchEvent(inputEvent("pointerdown", "mouse"));
    expect(captured).not.toHaveBeenCalled();
    viewWindow.dispatchEvent(inputEvent("mousedown"));

    expect(captured).toHaveBeenCalledWith("ABCD2345");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("cancels plugin placement when the user changes tools", async () => {
    const captured = vi.fn();
    const cancelled = vi.fn();
    const manager = { _annotations: [] as Array<Record<string, unknown>> };
    const viewWindow = makeWindow();
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      _primaryView: { _iframeWindow: viewWindow },
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
    viewWindow.dispatchEvent(inputEvent("mousedown"));
    await Promise.resolve();

    expect(cancelled).toHaveBeenCalledOnce();
    expect(captured).not.toHaveBeenCalled();
  });

  it("captures a pen note even when Zotero immediately auto-disables the note tool", () => {
    const captured = vi.fn();
    const manager = { _annotations: [] as Array<Record<string, unknown>> };
    const viewWindow = makeWindow();
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      _primaryView: { _iframeWindow: viewWindow },
      setTool(tool: { type: string; [key: string]: unknown }) {
        this._state.tool = tool;
      },
    };
    viewWindow.addEventListener(
      "pointerdown",
      (event) => {
        if ((event as PointerEvent).pointerType === "mouse") return;
        manager._annotations.push({ type: "note", color: "#2EA8E5", id: "PENCIL01" });
        internal._state.tool = { type: "pointer" };
      },
      true,
    );
    const reader = {
      itemID: 15,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    beginReaderNotePlacement(reader, "#2ea8e5", captured, vi.fn());
    viewWindow.dispatchEvent(inputEvent("pointerdown", "pen"));

    expect(captured).toHaveBeenCalledWith("PENCIL01");
  });

  it("fails closed instead of guessing when one event creates multiple matching notes", () => {
    const captured = vi.fn();
    const cancelled = vi.fn();
    const manager = { _annotations: [] as Array<Record<string, unknown>> };
    const viewWindow = makeWindow();
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      _primaryView: { _iframeWindow: viewWindow },
      setTool(tool: { type: string; [key: string]: unknown }) {
        this._state.tool = tool;
      },
    };
    viewWindow.addEventListener(
      "pointerdown",
      () => {
        manager._annotations.push(
          { type: "note", color: "#2ea8e5", id: "FIRST001" },
          { type: "note", color: "#2ea8e5", id: "SECOND01" },
        );
      },
      true,
    );
    const reader = {
      itemID: 17,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    beginReaderNotePlacement(reader, "#2ea8e5", captured, cancelled);
    viewWindow.dispatchEvent(inputEvent("pointerdown", "pen"));
    viewWindow.dispatchEvent(inputEvent("pointerdown", "pen"));

    expect(captured).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(Zotero.logError).toHaveBeenCalledOnce();
  });

  it("captures after event dispatch when an early plugin listener runs before the native one", async () => {
    const captured = vi.fn();
    const cancelled = vi.fn();
    const manager = { _annotations: [] as Array<Record<string, unknown>> };
    const viewWindow = makeWindow();
    const internal = {
      _state: { tool: { type: "pointer" } },
      _annotationManager: manager,
      _primaryView: { _iframeWindow: viewWindow },
      setTool(tool: { type: string; [key: string]: unknown }) {
        this._state.tool = tool;
      },
    };
    const reader = {
      itemID: 19,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    beginReaderNotePlacement(reader, "#2ea8e5", captured, cancelled);
    viewWindow.addEventListener(
      "pointerdown",
      () => {
        manager._annotations.push({ type: "note", color: "#2ea8e5", id: "EARLY001" });
        internal._state.tool = { type: "pointer" };
      },
      true,
    );
    viewWindow.dispatchEvent(inputEvent("pointerdown", "pen"));
    expect(captured).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(captured).toHaveBeenCalledWith("EARLY001");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("does not claim a same-color note that appears without a placement event", async () => {
    vi.useFakeTimers();
    try {
      const captured = vi.fn();
      const cancelled = vi.fn();
      const manager = { _annotations: [] as Array<Record<string, unknown>> };
      const viewWindow = makeWindow();
      const internal = {
        _state: { tool: { type: "pointer" } },
        _annotationManager: manager,
        _primaryView: { _iframeWindow: viewWindow },
        setTool(tool: { type: string; [key: string]: unknown }) {
          this._state.tool = tool;
        },
      };
      const reader = {
        itemID: 20,
        _iframeWindow: makeWindow(),
        _internalReader: internal,
      } as unknown as ReaderLike;

      const cancel = beginReaderNotePlacement(reader, "#2ea8e5", captured, cancelled);
      manager._annotations.push({ type: "note", color: "#2ea8e5", id: "EXTERNAL" });
      await vi.advanceTimersByTimeAsync(100);

      expect(captured).not.toHaveBeenCalled();
      expect(cancelled).not.toHaveBeenCalled();
      cancel?.();
    } finally {
      vi.useRealTimers();
    }
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

  it("ignores empty delete batches without assimilating the host callback result", async () => {
    const thenAccess = vi.fn(() => {
      throw new Error("Permission denied to access cross-compartment promise");
    });
    const opaqueResult = {};
    Object.defineProperty(opaqueResult, "then", { get: thenAccess });
    const originalDelete = vi.fn((_ids: string[]) => opaqueResult);
    const manager = {
      _skipAnnotationSavingDebounce: false,
      _savingInProgress: false,
      _unsavedAnnotations: new Set<string>(),
      _triggerSaving: vi.fn(async () => undefined),
      _onDelete: originalDelete,
    };
    const internal = {
      _state: { readOnly: false },
      _annotationManager: manager,
      setReadOnly: vi.fn(),
    };
    const reader = {
      itemID: 7,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;
    enableImmediateAnnotationSaving(reader);

    expect(manager._onDelete([])).toBe(opaqueResult);
    await expect(flushReaderAnnotations(reader)).resolves.toBeUndefined();

    expect(originalDelete).toHaveBeenCalledWith([]);
    expect(thenAccess).not.toHaveBeenCalled();
  });

  it("accepts complete erase of ink that had no saved database row", async () => {
    const attachment = { id: 71, libraryID: 1 };
    const getAsync = vi.fn(async () => {
      throw new Error("No item ID should be polled when the lookup returned no row");
    });
    Object.assign(Zotero, {
      DB: { valueQueryAsync: vi.fn(async () => false) },
      Items: { get: vi.fn(() => false), getAsync },
    });
    const manager = {
      _skipAnnotationSavingDebounce: false,
      _savingInProgress: false,
      _unsavedAnnotations: new Set<string>(),
      _triggerSaving: vi.fn(async () => undefined),
      _onDelete: vi.fn((_ids: string[]) => undefined),
    };
    const reader = {
      itemID: attachment.id,
      _item: attachment,
      _iframeWindow: makeWindow(),
      _internalReader: {
        _state: { readOnly: false },
        _annotationManager: manager,
        setReadOnly: vi.fn(),
      },
    } as unknown as ReaderLike;
    enableImmediateAnnotationSaving(reader);

    manager._onDelete(["UNSAVED1"]);
    await expect(flushReaderAnnotations(reader)).resolves.toBeUndefined();

    expect(Zotero.DB.valueQueryAsync).toHaveBeenCalledOnce();
    expect(getAsync).not.toHaveBeenCalled();
  });

  it("waits for erased annotation items to disappear without awaiting the host promise", async () => {
    vi.useFakeTimers();
    try {
      const attachment = { id: 7, libraryID: 1 };
      const annotation = { id: 70, key: "ERASED1", libraryID: 1, parentID: attachment.id };
      let annotationExists = true;
      const thenAccess = vi.fn(() => {
        throw new Error("Permission denied to access cross-compartment promise");
      });
      const opaqueResult = {};
      Object.defineProperty(opaqueResult, "then", { get: thenAccess });
      Object.assign(Zotero, {
        DB: { valueQueryAsync: vi.fn(async () => annotation.id) },
        Items: {
          // Simulate a valid database annotation that another code path has
          // unloaded from the synchronous item cache.
          get: vi.fn(() => false),
          getAsync: vi.fn(async (id: number) =>
            id === annotation.id && annotationExists ? annotation : false,
          ),
          getByLibraryAndKey: vi.fn(() => false),
        },
      });
      const originalDelete = vi.fn((_ids: string[]) => opaqueResult);
      const manager = {
        _skipAnnotationSavingDebounce: false,
        _savingInProgress: false,
        _unsavedAnnotations: new Set<string>(),
        _triggerSaving: vi.fn(async () => undefined),
        _onDelete: originalDelete,
      };
      const internal = {
        _state: { readOnly: false },
        _annotationManager: manager,
        setReadOnly: vi.fn(),
      };
      const reader = {
        itemID: attachment.id,
        _item: attachment,
        _iframeWindow: makeWindow(),
        _internalReader: internal,
      } as unknown as ReaderLike;
      enableImmediateAnnotationSaving(reader);

      expect(manager._onDelete([annotation.key])).toBe(opaqueResult);

      let flushed = false;
      const flush = flushReaderAnnotations(reader).then(() => {
        flushed = true;
      });
      await Promise.resolve();
      expect(flushed).toBe(false);
      annotationExists = false;
      await vi.advanceTimersByTimeAsync(25);
      await flush;
      expect(flushed).toBe(true);
      expect(thenAccess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when an erased annotation item never disappears", async () => {
    vi.useFakeTimers();
    try {
      const attachment = { id: 18, libraryID: 1 };
      const annotation = { id: 180, key: "STALLED1", libraryID: 1, parentID: attachment.id };
      Object.assign(Zotero, {
        DB: { valueQueryAsync: vi.fn(async () => annotation.id) },
        Items: {
          get: vi.fn((id: number) => (id === annotation.id ? annotation : false)),
          getAsync: vi.fn(async (id: number) => (id === annotation.id ? annotation : false)),
          getByLibraryAndKey: vi.fn((_libraryID: number, key: string) =>
            key === annotation.key ? annotation : false,
          ),
        },
      });
      const originalDelete = vi.fn((_ids: string[]) => undefined);
      const manager = {
        _skipAnnotationSavingDebounce: false,
        _savingInProgress: false,
        _unsavedAnnotations: new Set<string>(),
        _triggerSaving: vi.fn(async () => undefined),
        _onDelete: originalDelete,
      };
      const internal = {
        _state: { readOnly: false },
        _annotationManager: manager,
        setReadOnly: vi.fn(),
      };
      const reader = {
        itemID: attachment.id,
        _item: attachment,
        _iframeWindow: makeWindow(),
        _internalReader: internal,
      } as unknown as ReaderLike;
      enableImmediateAnnotationSaving(reader);
      manager._onDelete([annotation.key]);

      const flush = flushReaderAnnotations(reader);
      const assertion = expect(flush).rejects.toThrow(/Timed out while waiting.*erased/);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_001);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebinds save hooks and resets stale deletion state after manager replacement", async () => {
    const firstManager = {
      _skipAnnotationSavingDebounce: false,
      _savingInProgress: false,
      _unsavedAnnotations: new Set<string>(),
      _triggerSaving: vi.fn(async () => undefined),
      _onDelete: vi.fn((_ids: string[]) => {
        throw new Error("old manager deletion failure");
      }),
    };
    const secondManager = {
      _skipAnnotationSavingDebounce: false,
      _savingInProgress: false,
      _unsavedAnnotations: new Set<string>(),
      _triggerSaving: vi.fn(async () => undefined),
      _onDelete: vi.fn((_ids: string[]) => undefined),
    };
    const originalSetReadOnly = vi.fn();
    const originalFirstDelete = firstManager._onDelete;
    const originalSecondDelete = secondManager._onDelete;
    const internal: {
      _state: { readOnly: boolean };
      _annotationManager: any;
      setReadOnly: ReturnType<typeof vi.fn>;
    } = {
      _state: { readOnly: false },
      _annotationManager: firstManager,
      setReadOnly: originalSetReadOnly,
    };
    const reader = {
      itemID: 9,
      _iframeWindow: makeWindow(),
      _internalReader: internal,
    } as unknown as ReaderLike;

    enableImmediateAnnotationSaving(reader);
    firstManager._onDelete([]);
    await expect(flushReaderAnnotations(reader)).rejects.toThrow(/failed to save an erased/);
    internal._annotationManager = secondManager;
    enableImmediateAnnotationSaving(reader);
    await expect(flushReaderAnnotations(reader)).resolves.toBeUndefined();
    unregisterReaderHooks();

    expect(internal.setReadOnly).toBe(originalSetReadOnly);
    expect(firstManager._onDelete).toBe(originalFirstDelete);
    expect(secondManager._onDelete).toBe(originalSecondDelete);
    expect(firstManager._skipAnnotationSavingDebounce).toBe(false);
    expect(secondManager._skipAnnotationSavingDebounce).toBe(false);
  });

  it("drops a previous manager's pending deletion barrier after manager replacement", async () => {
    vi.useFakeTimers();
    try {
      const attachment = { id: 19, libraryID: 1 };
      const annotation = { id: 190, key: "OLDMGR01", libraryID: 1, parentID: attachment.id };
      Object.assign(Zotero, {
        DB: { valueQueryAsync: vi.fn(async () => annotation.id) },
        Items: {
          get: vi.fn((id: number) => (id === annotation.id ? annotation : false)),
          getAsync: vi.fn(async (id: number) => (id === annotation.id ? annotation : false)),
          getByLibraryAndKey: vi.fn((_libraryID: number, key: string) =>
            key === annotation.key ? annotation : false,
          ),
        },
      });
      const firstDelete = vi.fn((_ids: string[]) => undefined);
      const secondDelete = vi.fn((_ids: string[]) => undefined);
      const firstManager = {
        _skipAnnotationSavingDebounce: false,
        _savingInProgress: false,
        _unsavedAnnotations: new Set<string>(),
        _triggerSaving: vi.fn(async () => undefined),
        _onDelete: firstDelete,
      };
      const secondManager = {
        ...firstManager,
        _unsavedAnnotations: new Set<string>(),
        _onDelete: secondDelete,
      };
      const internal: { _state: { readOnly: boolean }; _annotationManager: any } = {
        _state: { readOnly: false },
        _annotationManager: firstManager,
      };
      const reader = {
        itemID: attachment.id,
        _item: attachment,
        _iframeWindow: makeWindow(),
        _internalReader: internal,
      } as unknown as ReaderLike;

      enableImmediateAnnotationSaving(reader);
      firstManager._onDelete([annotation.key]);
      internal._annotationManager = secondManager;
      enableImmediateAnnotationSaving(reader);

      await expect(flushReaderAnnotations(reader)).resolves.toBeUndefined();
      expect(firstManager._onDelete).toBe(firstDelete);
      await vi.advanceTimersByTimeAsync(25);
    } finally {
      vi.useRealTimers();
    }
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

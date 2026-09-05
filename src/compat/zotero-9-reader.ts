import { NOTE_WINDOW_SIZE, PLUGIN_ID, TESTED_ZOTERO_VERSION } from "../constants";
import { isPluginSticky } from "../relations";
import type { ReaderLike, ZoteroItemLike } from "../types";

type StickyActivationHandler = (annotation: ZoteroItemLike, sourceReader: ReaderLike) => void;

interface PointerBinding {
  reader: ReaderLike;
  window: Window;
  view: any;
  pointerDown: (event: Event) => void;
  pointerUp: (event: Event) => void;
  unload: () => void;
}

interface PendingWorkBarrier {
  hasPending: () => boolean;
  waitForPending: () => Promise<void>;
}

interface CloseGuard {
  reader: ReaderLike;
  pendingWork: PendingWorkBarrier;
  onFailure: (error: unknown) => void;
  closing: boolean;
  bypass: boolean;
  originalReaderClose?: (...args: any[]) => any;
  wrappedReaderClose?: (...args: any[]) => any;
  windowCloseListener?: (event: Event) => void;
  windowUnloadListener?: () => void;
  tabHook?: TabCloseHook;
  tabID?: string;
}

interface TabCloseHook {
  window: Window;
  tabs: any;
  container?: Element;
  originalClose: (ids?: string | string[]) => void;
  wrappedClose: (ids?: string | string[]) => void;
  originalUnload?: (id: string) => void;
  wrappedUnload?: (id: string) => void;
  guards: Map<string, CloseGuard>;
  clickListener: (event: Event) => void;
  auxClickListener: (event: Event) => void;
  unloadListener: () => void;
}

interface ViewLifecycleHook {
  internal: any;
  originalCreateView: (...args: any[]) => any;
  wrappedCreateView: (...args: any[]) => any;
  reader: ReaderLike;
  onActivate: StickyActivationHandler;
}

interface PlacementCapture {
  reader: ReaderLike;
  internal: any;
  manager: any;
  active: boolean;
  settingInitialTool: boolean;
  originalSetTool: (...args: any[]) => any;
  wrappedSetTool: (...args: any[]) => any;
  originalAddAnnotation: (...args: any[]) => any;
  wrappedAddAnnotation: (...args: any[]) => any;
  onCaptured: (key: string) => void;
  onCancelled: () => void;
}

interface ImmediateSaveState {
  reader: ReaderLike;
  internal: any;
  manager: any;
  previousValue: boolean | undefined;
  saveFailureDetected: boolean;
  deleteFailureDetected: boolean;
  deleteFailure?: unknown;
  pendingDeletionTransactions: Set<Promise<void>>;
  originalSetReadOnly?: (...args: any[]) => any;
  wrappedSetReadOnly?: (...args: any[]) => any;
  originalOnDeleteAnnotations?: (...args: any[]) => any;
  wrappedOnDeleteAnnotations?: (...args: any[]) => any;
}

interface ReaderOpenMonitor {
  manager: any;
  originalOpen: (...args: any[]) => any;
  wrappedOpen: (...args: any[]) => any;
  blockers: Map<number, { promise: Promise<void>; release: () => void }>;
  active: Map<number, Set<Promise<unknown>>>;
}

const READER_INIT_TIMEOUT_MS = 15_000;
const POINTER_LISTENER_CAPTURE = true;
const pointerBindings: PointerBinding[] = [];
const viewLifecycleHooks: ViewLifecycleHook[] = [];
const placementCaptures: PlacementCapture[] = [];
const immediateSaveStates = new Map<ReaderLike, ImmediateSaveState>();
const closeGuards: CloseGuard[] = [];
const pendingCloseTasks = new Set<Promise<void>>();
const tabCloseHooks: TabCloseHook[] = [];
const readerCleanupBindings: Array<{
  reader: ReaderLike;
  window: Window;
  listener: () => void;
}> = [];
const focusReturnBindings: Array<{
  window: Window;
  sourceReader: ReaderLike;
  listener: () => void;
}> = [];
const initializedNoteWindows = new WeakSet<Window>();
let hookSession = 0;
let hooksEnabled = false;
let readerOpenMonitor: ReaderOpenMonitor | undefined;

export function initializeReaderHooks(): void {
  hookSession += 1;
  hooksEnabled = true;
  installReaderOpenMonitor();
}

export function invalidateReaderHooks(): void {
  if (!hooksEnabled) return;
  hooksEnabled = false;
  hookSession += 1;
}

function isCurrentHookSession(session: number): boolean {
  return hooksEnabled && hookSession === session;
}

function installReaderOpenMonitor(): void {
  const manager = Zotero.Reader as any;
  if (readerOpenMonitor) return;
  if (typeof manager?.open !== "function") return;

  const monitor = {
    manager,
    originalOpen: manager.open,
    wrappedOpen: undefined as unknown as (...args: any[]) => any,
    blockers: new Map<number, { promise: Promise<void>; release: () => void }>(),
    active: new Map<number, Set<Promise<unknown>>>(),
  } satisfies ReaderOpenMonitor;
  monitor.wrappedOpen = function (this: any, ...args: any[]) {
    const itemID = Number(args[0]);
    const start = () => {
      let result: unknown;
      try {
        result = monitor.originalOpen.apply(this, args);
      } catch (error) {
        throw error;
      }
      const tracked = Promise.resolve(result).finally(() => {
        const itemPromises = monitor.active.get(itemID);
        itemPromises?.delete(tracked);
        if (itemPromises?.size === 0) monitor.active.delete(itemID);
      });
      const itemPromises = monitor.active.get(itemID) ?? new Set<Promise<unknown>>();
      itemPromises.add(tracked);
      monitor.active.set(itemID, itemPromises);
      return tracked;
    };
    const blocker = monitor.blockers.get(itemID);
    return blocker ? blocker.promise.then(start) : start();
  };
  manager.open = monitor.wrappedOpen;
  readerOpenMonitor = monitor;
}

function readerViews(reader: ReaderLike): any[] {
  try {
    const internal = reader._internalReader;
    return [internal?._primaryView, internal?._secondaryView].filter(Boolean);
  } catch (error) {
    logError(error);
    return [];
  }
}

function getLiveReaderWindow(reader: ReaderLike): ReaderLike["_window"] | undefined {
  try {
    const window = reader._window;
    return window && !window.closed ? window : undefined;
  } catch {
    return undefined;
  }
}

function isReaderLive(reader: ReaderLike): boolean {
  try {
    const readers = ((Zotero.Reader as any)._readers ?? []) as ReaderLike[];
    return readers.includes(reader) && !reader._window?.closed && Boolean(reader._internalReader);
  } catch {
    return false;
  }
}

function annotationByKey(reader: ReaderLike, annotationID: string): ZoteroItemLike | undefined {
  const libraryID = reader._item?.libraryID;
  if (!libraryID) return undefined;

  const byKey = Zotero.Items.getByLibraryAndKey(libraryID, annotationID) as ZoteroItemLike | false;
  if (byKey) return byKey;

  const numericID = Number(annotationID);
  return Number.isInteger(numericID)
    ? (Zotero.Items.get(numericID) as ZoteroItemLike | false) || undefined
    : undefined;
}

function selectedAnnotationAtPointer(
  reader: ReaderLike,
  view: any,
  event: PointerEvent,
): ZoteroItemLike | undefined {
  const position = view.pointerEventToPosition?.(event);
  if (!position) return undefined;
  const selectable = view.getSelectableAnnotations?.(position) ?? [];
  const selectedIDs = reader._internalReader?._state?.selectedAnnotationIDs ?? [];
  if (selectedIDs.length !== 1) return undefined;
  const selectedID = selectedIDs[0];
  if (!selectable.some((annotation: { id?: string }) => annotation.id === selectedID)) {
    return undefined;
  }
  return annotationByKey(reader, selectedID);
}

function removePointerBinding(binding: PointerBinding): void {
  binding.window.removeEventListener("pointerdown", binding.pointerDown, POINTER_LISTENER_CAPTURE);
  binding.window.removeEventListener("mousedown", binding.pointerDown, POINTER_LISTENER_CAPTURE);
  binding.window.removeEventListener("pointerup", binding.pointerUp, POINTER_LISTENER_CAPTURE);
  binding.window.removeEventListener("unload", binding.unload, false);
}

function logError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}

function cloneIntoReader<T>(reader: ReaderLike, value: T): T {
  const target = reader._iframeWindow;
  if (!target) throw new Error("Zotero reader iframe is unavailable");
  return Components.utils.cloneInto(value, target) as T;
}

function exportIntoReader<T extends (...args: any[]) => any>(reader: ReaderLike, fn: T): T {
  const target = reader._iframeWindow;
  if (!target) throw new Error("Zotero reader iframe is unavailable");
  return Components.utils.exportFunction(fn, target) as T;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("The plugin operation was cancelled");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const onAbort = () => {
      cleanup();
      const error = new Error("The plugin operation was cancelled");
      error.name = "AbortError";
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, milliseconds);
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function bindStickyActivationToView(
  reader: ReaderLike,
  view: any,
  onActivate: StickyActivationHandler,
  session: number,
): Promise<void> {
  if (!isCurrentHookSession(session)) return;
  const initialized = Promise.resolve(view.initializedPromise);
  try {
    await withTimeout(
      initialized,
      READER_INIT_TIMEOUT_MS,
      "Timed out while initializing a Zotero PDF view",
    );
  } catch (error) {
    // A slow PDF view can legitimately initialize after the diagnostic
    // timeout. Retry once it does so the required single-click hook is not
    // permanently absent for that view.
    void initialized.then(
      () => {
        if (isCurrentHookSession(session)) {
          void bindStickyActivationToView(reader, view, onActivate, session).catch(logError);
        }
      },
      (lateError) => logError(lateError),
    );
    throw error;
  }
  if (!isCurrentHookSession(session)) return;
  const viewWindow = view._iframeWindow as Window | undefined;
  if (!viewWindow || viewWindow.closed) return;
  const existing = pointerBindings.find((binding) => binding.window === viewWindow);
  if (existing?.view === view) return;
  if (existing) {
    removePointerBinding(existing);
    pointerBindings.splice(pointerBindings.indexOf(existing), 1);
  }

  let start: { x: number; y: number } | undefined;
  let lastActivation = "";
  let lastActivationTime = 0;
  const pointerDown = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    start = { x: pointer.clientX, y: pointer.clientY };
  };
  const pointerUp = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    if (!start || Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) > 5) {
      start = undefined;
      return;
    }
    start = undefined;

    const activateIfMatched = async () => {
      if (!isCurrentHookSession(session)) return;
      const annotation = selectedAnnotationAtPointer(reader, view, pointer);
      if (!annotation) return;
      await annotation.loadDataType?.("relations");
      if (!isCurrentHookSession(session)) return;
      if (!isPluginSticky(annotation)) return;
      const now = Date.now();
      if (annotation.key === lastActivation && now - lastActivationTime < 300) return;
      lastActivation = annotation.key;
      lastActivationTime = now;
      reader._internalReader?._updateState?.(
        cloneIntoReader(reader, {
          primaryViewAnnotationPopup: null,
          secondaryViewAnnotationPopup: null,
        }),
      );
      onActivate(annotation, reader);
    };

    // Let Zotero's own handler finish selecting the canvas annotation first.
    setTimeout(() => void activateIfMatched().catch(logError), 0);
  };
  const unload = () => {
    const binding = pointerBindings.find((candidate) => candidate.window === viewWindow);
    if (!binding) return;
    removePointerBinding(binding);
    pointerBindings.splice(pointerBindings.indexOf(binding), 1);
  };

  // Zotero's annotation overlay stops pointer-event bubbling. Capture at the
  // iframe window, then defer activation until Zotero has updated selection.
  viewWindow.addEventListener("pointerdown", pointerDown, POINTER_LISTENER_CAPTURE);
  viewWindow.addEventListener("mousedown", pointerDown, POINTER_LISTENER_CAPTURE);
  viewWindow.addEventListener("pointerup", pointerUp, POINTER_LISTENER_CAPTURE);
  viewWindow.addEventListener("unload", unload, false);
  pointerBindings.push({ reader, window: viewWindow, view, pointerDown, pointerUp, unload });
}

function installViewLifecycleHook(
  reader: ReaderLike,
  onActivate: StickyActivationHandler,
  session: number,
): void {
  if (!isCurrentHookSession(session)) return;
  const internal = reader._internalReader;
  if (!internal?._createView) return;
  const existing = viewLifecycleHooks.find((hook) => hook.internal === internal);
  if (existing) {
    existing.reader = reader;
    existing.onActivate = onActivate;
    return;
  }

  const hook = {
    internal,
    originalCreateView: internal._createView,
    wrappedCreateView: undefined as unknown as (...args: any[]) => any,
    reader,
    onActivate,
  } satisfies ViewLifecycleHook;
  const wrappedCreateView = function (this: any, ...args: any[]) {
    const view = hook.originalCreateView.apply(this, args);
    if (isCurrentHookSession(session)) {
      void bindStickyActivationToView(hook.reader, view, hook.onActivate, session).catch(logError);
    }
    return view;
  };
  hook.wrappedCreateView = exportIntoReader(reader, wrappedCreateView);
  internal._createView = hook.wrappedCreateView;
  viewLifecycleHooks.push(hook);
}

export async function bindStickyActivation(
  reader: ReaderLike,
  onActivate: StickyActivationHandler,
): Promise<void> {
  if (!hooksEnabled) return;
  const session = hookSession;
  await waitForReader(reader);
  if (!isCurrentHookSession(session)) return;
  ensureReaderCleanupBinding(reader);
  installViewLifecycleHook(reader, onActivate, session);
  await Promise.all(
    readerViews(reader).map((view) =>
      bindStickyActivationToView(reader, view, onActivate, session),
    ),
  );
}

function removePlacementCapture(capture: PlacementCapture, notifyCancellation: boolean): void {
  if (!capture.active) return;
  capture.active = false;
  try {
    if (capture.internal.setTool === capture.wrappedSetTool) {
      capture.internal.setTool = capture.originalSetTool;
    }
    if (capture.manager.addAnnotation === capture.wrappedAddAnnotation) {
      capture.manager.addAnnotation = capture.originalAddAnnotation;
    }
  } catch (error) {
    logError(error);
  }
  const index = placementCaptures.indexOf(capture);
  if (index >= 0) placementCaptures.splice(index, 1);
  if (notifyCancellation) {
    try {
      capture.onCancelled();
    } catch (error) {
      logError(error);
    }
  }
}

/**
 * Select Zotero's native note tool and capture the exact annotation key it
 * creates. Any later tool change cancels the one-shot capture, preventing an
 * unrelated native note from being claimed by the plugin.
 */
export function beginReaderNotePlacement(
  reader: ReaderLike,
  color: string,
  onCaptured: (key: string) => void,
  onCancelled: () => void,
): (() => void) | undefined {
  try {
    const internal = reader._internalReader;
    const manager = internal?._annotationManager;
    if (typeof internal?.setTool !== "function" || typeof manager?.addAnnotation !== "function") {
      return undefined;
    }
    for (const existing of [...placementCaptures]) {
      if (existing.reader === reader) removePlacementCapture(existing, true);
    }

    const capture: PlacementCapture = {
      reader,
      internal,
      manager,
      active: true,
      settingInitialTool: false,
      originalSetTool: internal.setTool,
      wrappedSetTool: undefined as unknown as (...args: any[]) => any,
      originalAddAnnotation: manager.addAnnotation,
      wrappedAddAnnotation: undefined as unknown as (...args: any[]) => any,
      onCaptured,
      onCancelled,
    };

    const wrappedSetTool = function (this: any, ...args: any[]) {
      const result = capture.originalSetTool.apply(this, args);
      if (capture.active && !capture.settingInitialTool) {
        removePlacementCapture(capture, true);
      }
      return result;
    };
    capture.wrappedSetTool = exportIntoReader(reader, wrappedSetTool);

    const wrappedAddAnnotation = function (this: any, ...args: any[]) {
      const result = capture.originalAddAnnotation.apply(this, args);
      if (!capture.active) return result;
      const annotation = result ?? args[0];
      if (result && annotation?.type === "note" && annotation?.id) {
        const key = String(annotation.id);
        removePlacementCapture(capture, false);
        try {
          capture.onCaptured(key);
        } catch (error) {
          logError(error);
        }
      } else {
        removePlacementCapture(capture, true);
      }
      return result;
    };
    capture.wrappedAddAnnotation = exportIntoReader(reader, wrappedAddAnnotation);

    internal.setTool = capture.wrappedSetTool;
    manager.addAnnotation = capture.wrappedAddAnnotation;
    placementCaptures.push(capture);
    capture.settingInitialTool = true;
    try {
      internal.setTool(cloneIntoReader(reader, { type: "note", color }));
    } catch (error) {
      removePlacementCapture(capture, false);
      throw error;
    } finally {
      capture.settingInitialTool = false;
    }
    if (internal._state?.tool?.type !== "note") {
      removePlacementCapture(capture, false);
      return undefined;
    }
    return () => removePlacementCapture(capture, false);
  } catch (error) {
    logError(error);
    return undefined;
  }
}

export function enableImmediateAnnotationSaving(reader: ReaderLike): void {
  try {
    const internal = reader._internalReader;
    const manager = internal?._annotationManager;
    if (!manager) return;

    let state = immediateSaveStates.get(reader);
    if (state && state.internal === internal && state.manager === manager) {
      manager._skipAnnotationSavingDebounce = true;
      return;
    }
    if (state) {
      restoreImmediateSaveBindings(state);
      state.internal = internal;
      state.manager = manager;
      state.previousValue = manager._skipAnnotationSavingDebounce;
    } else {
      state = {
        reader,
        internal,
        manager,
        previousValue: manager._skipAnnotationSavingDebounce,
        saveFailureDetected: false,
        deleteFailureDetected: false,
        pendingDeletionTransactions: new Set(),
      };
      immediateSaveStates.set(reader, state);
    }

    try {
      const item = reader._item ?? (Zotero.Items.get(reader.itemID) as ZoteroItemLike | false);
      const library = item && Zotero.Libraries.get(item.libraryID);
      if (
        internal._state?.readOnly &&
        item &&
        item.isEditable?.() &&
        library &&
        library.editable &&
        library.filesEditable
      ) {
        // If toolbar initialization arrives after the host save bridge already
        // failed, the only remaining signal is the unexpected read-only state.
        state.saveFailureDetected = true;
      }
    } catch (error) {
      logError(error);
    }

    if (typeof internal.setReadOnly === "function") {
      state.originalSetReadOnly = internal.setReadOnly;
      const wrappedSetReadOnly = function (this: any, readOnly: boolean, ...args: any[]) {
        // Zotero's host save bridge reports failure by switching the reader to
        // read-only while the iframe manager is still saving. The bridge does
        // not propagate that rejection, so latch it here before the manager
        // clears its only remaining failure signal.
        if (readOnly && state.manager?._savingInProgress) state.saveFailureDetected = true;
        return state.originalSetReadOnly?.call(this, readOnly, ...args);
      };
      state.wrappedSetReadOnly = exportIntoReader(reader, wrappedSetReadOnly);
      internal.setReadOnly = state.wrappedSetReadOnly;
    }

    if (typeof internal._onDeleteAnnotations === "function") {
      state.originalOnDeleteAnnotations = internal._onDeleteAnnotations;
      const wrappedOnDeleteAnnotations = function (this: any, ...args: any[]) {
        let result: any;
        try {
          result = state.originalOnDeleteAnnotations?.apply(this, args);
          const tracked = Promise.resolve(result).then(
            () => undefined,
            (error) => {
              state.deleteFailureDetected = true;
              state.deleteFailure = error;
            },
          );
          state.pendingDeletionTransactions.add(tracked);
          void tracked.finally(() => state.pendingDeletionTransactions.delete(tracked));
        } catch (error) {
          state.deleteFailureDetected = true;
          state.deleteFailure = error;
        }
        return result;
      };
      state.wrappedOnDeleteAnnotations = exportIntoReader(reader, wrappedOnDeleteAnnotations);
      internal._onDeleteAnnotations = state.wrappedOnDeleteAnnotations;
    }

    manager._skipAnnotationSavingDebounce = true;
    ensureReaderCleanupBinding(reader);
  } catch (error) {
    logError(error);
  }
}

function readerSaveFailureDetected(reader: ReaderLike): boolean {
  return Boolean(immediateSaveStates.get(reader)?.saveFailureDetected);
}

function markReaderSaveFailure(reader: ReaderLike): void {
  const state = immediateSaveStates.get(reader);
  if (state) state.saveFailureDetected = true;
}

function readerDeleteFailureDetected(reader: ReaderLike): boolean {
  return Boolean(immediateSaveStates.get(reader)?.deleteFailureDetected);
}

function readerHasPendingDeletions(reader: ReaderLike): boolean {
  return Boolean(immediateSaveStates.get(reader)?.pendingDeletionTransactions.size);
}

async function waitForReaderDeletionTransactions(reader: ReaderLike): Promise<void> {
  const state = immediateSaveStates.get(reader);
  if (!state) return;
  while (state.pendingDeletionTransactions.size > 0) {
    await withTimeout(
      Promise.all([...state.pendingDeletionTransactions]).then(() => undefined),
      READER_INIT_TIMEOUT_MS,
      "Timed out while waiting for Zotero to save an erased handwritten annotation",
    );
  }
  if (state.deleteFailureDetected) {
    throw new Error("Zotero failed to save an erased handwritten annotation", {
      cause: state.deleteFailure,
    });
  }
}

function restoreImmediateSaveBindings(state: ImmediateSaveState): void {
  try {
    state.manager._skipAnnotationSavingDebounce = state.previousValue;
  } catch (error) {
    logError(error);
  }
  try {
    if (
      state.wrappedSetReadOnly &&
      state.originalSetReadOnly &&
      state.internal.setReadOnly === state.wrappedSetReadOnly
    ) {
      state.internal.setReadOnly = state.originalSetReadOnly;
    }
  } catch (error) {
    logError(error);
  }
  try {
    if (
      state.wrappedOnDeleteAnnotations &&
      state.originalOnDeleteAnnotations &&
      state.internal._onDeleteAnnotations === state.wrappedOnDeleteAnnotations
    ) {
      state.internal._onDeleteAnnotations = state.originalOnDeleteAnnotations;
    }
  } catch (error) {
    logError(error);
  }
  state.originalSetReadOnly = undefined;
  state.wrappedSetReadOnly = undefined;
  state.originalOnDeleteAnnotations = undefined;
  state.wrappedOnDeleteAnnotations = undefined;
}

function removeImmediateSaveState(state: ImmediateSaveState): void {
  restoreImmediateSaveBindings(state);
  immediateSaveStates.delete(state.reader);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForReader(reader: ReaderLike, signal?: AbortSignal): Promise<void> {
  if (reader._initPromise) {
    await withTimeout(
      reader._initPromise,
      READER_INIT_TIMEOUT_MS,
      "Timed out while initializing the Zotero reader",
      signal,
    );
  }
  const deadline = Date.now() + READER_INIT_TIMEOUT_MS;
  while (!reader._internalReader && Date.now() < deadline) {
    if (signal?.aborted) {
      const error = new Error("The plugin operation was cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (reader._window?.closed) throw new Error("The Zotero reader window closed during startup");
    await delay(25);
  }
  if (!reader._internalReader) {
    throw new Error("Zotero reader did not initialize");
  }
}

/** Zotero 9 exposes tool selection only on the bundled reader implementation. */
export function setReaderTool(reader: ReaderLike, tool: Record<string, unknown>): boolean {
  try {
    const internal = reader._internalReader;
    if (!internal?.setTool || typeof tool.type !== "string") return false;
    internal.setTool(cloneIntoReader(reader, tool));
    // Zotero silently ignores non-navigation tools when the reader is read-only.
    return internal._state?.tool?.type === tool.type;
  } catch (error) {
    logError(error);
    return false;
  }
}

function ensureReaderCleanupBinding(reader: ReaderLike): void {
  if (readerCleanupBindings.some((binding) => binding.reader === reader)) return;
  try {
    const window = reader._window;
    if (!window) return;
    const binding = {
      reader,
      window,
      listener: () => cleanupReaderHooksForReader(reader),
    };
    window.addEventListener("unload", binding.listener, { once: true });
    readerCleanupBindings.push(binding);
  } catch (error) {
    logError(error);
  }
}

function cleanupReaderHooksForReader(reader: ReaderLike, preserveFocusReturn = false): void {
  for (const binding of [...pointerBindings]) {
    if (binding.reader !== reader) continue;
    try {
      removePointerBinding(binding);
    } catch (error) {
      logError(error);
    } finally {
      const index = pointerBindings.indexOf(binding);
      if (index >= 0) pointerBindings.splice(index, 1);
    }
  }

  for (const hook of [...viewLifecycleHooks]) {
    if (hook.reader !== reader) continue;
    try {
      if (hook.internal._createView === hook.wrappedCreateView) {
        hook.internal._createView = hook.originalCreateView;
      }
    } catch (error) {
      logError(error);
    } finally {
      const index = viewLifecycleHooks.indexOf(hook);
      if (index >= 0) viewLifecycleHooks.splice(index, 1);
    }
  }

  for (const capture of [...placementCaptures]) {
    if (capture.reader === reader) removePlacementCapture(capture, false);
  }

  const immediateSaveState = immediateSaveStates.get(reader);
  if (immediateSaveState) removeImmediateSaveState(immediateSaveState);

  for (const guard of [...closeGuards]) {
    if (guard.reader === reader) removeCloseGuard(guard);
  }

  for (const binding of [...readerCleanupBindings]) {
    if (binding.reader !== reader) continue;
    try {
      binding.window.removeEventListener("unload", binding.listener);
    } catch (error) {
      logError(error);
    } finally {
      const index = readerCleanupBindings.indexOf(binding);
      if (index >= 0) readerCleanupBindings.splice(index, 1);
    }
  }

  if (preserveFocusReturn) return;
  for (const binding of [...focusReturnBindings]) {
    let matches = binding.sourceReader === reader;
    try {
      matches ||= binding.window === reader._window;
    } catch {
      matches = true;
    }
    if (!matches) continue;
    try {
      binding.window.removeEventListener("unload", binding.listener);
    } catch (error) {
      logError(error);
    } finally {
      const index = focusReturnBindings.indexOf(binding);
      if (index >= 0) focusReturnBindings.splice(index, 1);
    }
  }
}

function flattenTabIDs(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) result.push(...flattenTabIDs(value));
    else if (value !== undefined && value !== null) result.push(String(value));
  }
  return result;
}

export function cleanupReaderHooksForTabIDs(ids: unknown[]): void {
  const wanted = new Set(flattenTabIDs(ids));
  const readers = new Set<ReaderLike>();
  for (const binding of readerCleanupBindings) {
    try {
      if (binding.reader.tabID && wanted.has(binding.reader.tabID)) readers.add(binding.reader);
    } catch (error) {
      logError(error);
    }
  }
  for (const guard of closeGuards) {
    if (guard.tabID && wanted.has(guard.tabID)) readers.add(guard.reader);
  }
  for (const reader of readers) cleanupReaderHooksForReader(reader);
}

export async function flushReaderAnnotations(reader: ReaderLike): Promise<void> {
  await waitForReader(reader);
  if (readerDeleteFailureDetected(reader)) {
    await waitForReaderDeletionTransactions(reader);
  }
  if (readerSaveFailureDetected(reader)) {
    throw new Error(
      "Zotero failed to save handwritten annotations and switched the reader to read-only mode",
    );
  }
  const manager = reader._internalReader?._annotationManager;
  if (!manager?._triggerSaving || !manager?._unsavedAnnotations) {
    throw new Error(
      `Annotation save barrier is unavailable in Zotero ${Zotero.version}; tested with ${TESTED_ZOTERO_VERSION}`,
    );
  }

  const previousSkip = manager._skipAnnotationSavingDebounce;
  const initiallyReadOnly = Boolean(reader._internalReader?._state?.readOnly);
  manager._skipAnnotationSavingDebounce = true;
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      if (!manager._savingInProgress && manager._unsavedAnnotations.size > 0) {
        await manager._triggerSaving();
      }
      if (
        readerSaveFailureDetected(reader) ||
        (!initiallyReadOnly && reader._internalReader?._state?.readOnly)
      ) {
        markReaderSaveFailure(reader);
        throw new Error(
          "Zotero failed to save handwritten annotations and switched the reader to read-only mode",
        );
      }
      if (!manager._savingInProgress && manager._unsavedAnnotations.size === 0) {
        await waitForReaderDeletionTransactions(reader);
        if (
          !manager._savingInProgress &&
          manager._unsavedAnnotations.size === 0 &&
          !readerHasPendingDeletions(reader)
        ) {
          return;
        }
      }
      await delay(25);
    }
    throw new Error("Timed out while waiting for Zotero to save handwritten annotations");
  } finally {
    if (immediateSaveStates.get(reader)?.manager !== manager) {
      manager._skipAnnotationSavingDebounce = previousSkip;
    }
  }
}

export function openReadersForItem(itemID: number): ReaderLike[] {
  return (((Zotero.Reader as any)._readers ?? []) as ReaderLike[]).filter((reader) => {
    try {
      return reader.itemID === itemID && isReaderLive(reader);
    } catch {
      return false;
    }
  });
}

export function readerInstancesForItem(itemID: number): ReaderLike[] {
  return (((Zotero.Reader as any)._readers ?? []) as ReaderLike[]).filter((reader) => {
    try {
      return reader.itemID === itemID && !reader._window?.closed;
    } catch {
      return false;
    }
  });
}

export async function withReaderOpeningPaused<T>(
  itemID: number,
  task: () => Promise<T>,
): Promise<T> {
  installReaderOpenMonitor();
  const monitor = readerOpenMonitor;
  if (!monitor || monitor.manager.open !== monitor.wrappedOpen) {
    throw new Error(
      `Reader open barrier is unavailable in Zotero ${Zotero.version}; tested with ${TESTED_ZOTERO_VERSION}`,
    );
  }
  const prior = monitor.blockers.get(itemID);
  if (prior) {
    await prior.promise;
    return withReaderOpeningPaused(itemID, task);
  }
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  monitor.blockers.set(itemID, { promise, release });
  try {
    // The monitor is installed at plugin startup, before any plugin work. Once
    // this blocker is present no new open for this item can start, so waiting
    // this snapshot also drains opens that began before the append request.
    await withTimeout(
      Promise.allSettled([...(monitor.active.get(itemID) ?? [])]).then(() => undefined),
      READER_INIT_TIMEOUT_MS,
      "Timed out while waiting for an existing Zotero reader to open before updating its PDF",
    );
    return await task();
  } finally {
    const current = monitor.blockers.get(itemID);
    if (current?.promise === promise) monitor.blockers.delete(itemID);
    release();
  }
}

export async function flushAllReadersForItem(itemID: number): Promise<ReaderLike[]> {
  const readers = openReadersForItem(itemID);
  for (const reader of readers) {
    await flushReaderAnnotations(reader);
  }
  return readers;
}

export function withPDFWorkerSerialized<T>(task: () => Promise<T>): Promise<T> {
  const worker = (Zotero as any).PDFWorker;
  if (typeof worker?._enqueue !== "function") {
    return Promise.reject(
      new Error(
        `PDF worker serialization is unavailable in Zotero ${Zotero.version}; tested with ${TESTED_ZOTERO_VERSION}`,
      ),
    );
  }
  // Zotero's native rotate/delete/import operations all use this one queue.
  // Joining it prevents a worker based on stale bytes from overwriting a page
  // appended by this plugin after our own replacement has reported success.
  return worker._enqueue(task, true) as Promise<T>;
}

export async function withSyncPaused<T>(task: () => Promise<T>): Promise<T> {
  const runner = (Zotero.Sync as any).Runner;
  if (!runner?.delayIndefinite) return task();

  const waitForCurrentSync = async () => {
    const deadline = Date.now() + 60_000;
    while (runner.syncInProgress) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for Zotero sync before updating the notes PDF");
      }
      await delay(100);
    }
  };

  for (;;) {
    await waitForCurrentSync();
    const release = runner.delayIndefinite();
    if (runner.syncInProgress) {
      release();
      await waitForCurrentSync();
      continue;
    }
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export function freezeReaders(readers: ReaderLike[]): void {
  for (const reader of readers) {
    if (!isReaderLive(reader)) continue;
    try {
      reader._internalReader?.freeze?.();
    } catch (error) {
      logError(error);
    }
  }
}

export function unfreezeReaders(readers: ReaderLike[]): void {
  for (const reader of readers) {
    if (!isReaderLive(reader)) continue;
    try {
      reader._internalReader?.unfreeze?.();
    } catch (error) {
      logError(error);
    }
  }
}

export async function reloadReaders(
  readers: ReaderLike[],
  activeReader: ReaderLike | undefined,
  pageIndex: number,
): Promise<void> {
  let liveReaders = readers.filter(isReaderLive);
  for (const reader of liveReaders) {
    await reader.reload?.();
  }
  liveReaders = liveReaders.filter(isReaderLive);
  for (const reader of liveReaders) {
    const views = readerViews(reader);
    await Promise.all(
      views.map((view) =>
        withTimeout(
          Promise.resolve(view.initializedPromise),
          READER_INIT_TIMEOUT_MS,
          "Timed out while refreshing a Zotero PDF view",
        ),
      ),
    );
    // reload() can replace the annotation manager. Reapply the immediate-save
    // setting explicitly instead of relying on a toolbar re-render side effect.
    enableImmediateAnnotationSaving(reader);
  }
  if (
    activeReader &&
    isReaderLive(activeReader) &&
    activeReader._internalReader?.navigate &&
    activeReader._iframeWindow
  ) {
    const location = Components.utils.cloneInto({ pageIndex }, activeReader._iframeWindow);
    await activeReader._internalReader.navigate(location);
  }
}

function closeGuardHasPending(guard: CloseGuard): boolean {
  try {
    const manager = guard.reader._internalReader?._annotationManager;
    return Boolean(
      readerSaveFailureDetected(guard.reader) ||
      readerDeleteFailureDetected(guard.reader) ||
      readerHasPendingDeletions(guard.reader) ||
      manager?._savingInProgress ||
      manager?._unsavedAnnotations?.size ||
      guard.pendingWork.hasPending(),
    );
  } catch (error) {
    logError(error);
    return guard.pendingWork.hasPending();
  }
}

async function drainCloseGuard(guard: CloseGuard): Promise<void> {
  await guard.pendingWork.waitForPending();
  if (isReaderLive(guard.reader)) await flushReaderAnnotations(guard.reader);
}

function requestGuardedClose(guard: CloseGuard, closeNow: () => void): void {
  if (guard.closing) return;
  if (!closeGuardHasPending(guard)) {
    closeNow();
    return;
  }

  guard.closing = true;
  freezeReaders([guard.reader]);
  const task = drainCloseGuard(guard)
    .then(() => closeNow())
    .catch((error) => {
      guard.closing = false;
      unfreezeReaders([guard.reader]);
      try {
        guard.onFailure(error);
      } catch (alertError) {
        logError(alertError);
      }
    });
  pendingCloseTasks.add(task);
  void task.finally(() => pendingCloseTasks.delete(task));
}

export async function waitForPendingCloseSaveGuards(): Promise<void> {
  while (pendingCloseTasks.size > 0) {
    await Promise.all([...pendingCloseTasks]);
  }
}

function removeTabCloseHook(hook: TabCloseHook): void {
  const index = tabCloseHooks.indexOf(hook);
  if (index >= 0) tabCloseHooks.splice(index, 1);
  try {
    if (hook.tabs.close === hook.wrappedClose) hook.tabs.close = hook.originalClose;
    if (hook.wrappedUnload && hook.tabs.unload === hook.wrappedUnload) {
      hook.tabs.unload = hook.originalUnload;
    }
  } catch (error) {
    logError(error);
  }
  try {
    hook.container?.removeEventListener("click", hook.clickListener, true);
    hook.container?.removeEventListener("auxclick", hook.auxClickListener, true);
    hook.window.removeEventListener("unload", hook.unloadListener);
  } catch (error) {
    logError(error);
  }
}

function removeCloseGuard(guard: CloseGuard): void {
  const index = closeGuards.indexOf(guard);
  if (index >= 0) closeGuards.splice(index, 1);

  try {
    if (guard.windowCloseListener) {
      guard.reader._window?.removeEventListener("close", guard.windowCloseListener, true);
    }
    if (
      guard.wrappedReaderClose &&
      guard.originalReaderClose &&
      (guard.reader as any).close === guard.wrappedReaderClose
    ) {
      (guard.reader as any).close = guard.originalReaderClose;
    }
  } catch (error) {
    logError(error);
  }

  if (guard.tabHook && guard.tabID) {
    guard.tabHook.guards.delete(guard.tabID);
    if (guard.tabHook.guards.size === 0) removeTabCloseHook(guard.tabHook);
  }
}

function tabIDFromCloseEvent(event: Event): string | undefined {
  const target = event.target as Element | null;
  const tab = target?.closest?.(".tab") as HTMLElement | null;
  return tab?.dataset.id;
}

function ensureTabCloseHook(window: Window): TabCloseHook | undefined {
  const tabs = (window as any).Zotero_Tabs;
  if (!tabs?.close) return undefined;
  const existing = tabCloseHooks.find((hook) => hook.tabs === tabs);
  if (existing) return existing;

  const hook: TabCloseHook = {
    window,
    tabs,
    container: window.document.getElementById("tab-bar-container") ?? undefined,
    originalClose: tabs.close,
    wrappedClose: undefined as unknown as (ids?: string | string[]) => void,
    originalUnload: typeof tabs.unload === "function" ? tabs.unload : undefined,
    wrappedUnload: undefined,
    guards: new Map<string, CloseGuard>(),
    clickListener: undefined as unknown as (event: Event) => void,
    auxClickListener: undefined as unknown as (event: Event) => void,
    unloadListener: undefined as unknown as () => void,
  };

  const closeOne = (guard: CloseGuard) => {
    if (!guard.tabID) return;
    const tabID = guard.tabID;
    guard.bypass = true;
    cleanupReaderHooksForReader(guard.reader);
    hook.originalClose.call(hook.tabs, tabID);
  };
  hook.wrappedClose = (ids?: string | string[]) => {
    const requested = ids ? (Array.isArray(ids) ? ids : [ids]) : [String(hook.tabs.selectedID)];
    const immediate: string[] = [];
    for (const id of requested) {
      const guard = hook.guards.get(id);
      if (!guard || guard.bypass) {
        immediate.push(id);
      } else if (closeGuardHasPending(guard)) {
        requestGuardedClose(guard, () => closeOne(guard));
      } else {
        cleanupReaderHooksForReader(guard.reader);
        immediate.push(id);
      }
    }
    if (immediate.length) hook.originalClose.call(hook.tabs, immediate);
  };
  if (hook.originalUnload) {
    hook.wrappedUnload = (id: string) => {
      const guard = hook.guards.get(id);
      if (!guard || guard.bypass) {
        hook.originalUnload?.call(hook.tabs, id);
        return;
      }
      const unloadNow = () => {
        // Zotero rechecks this inside unload(). Recheck immediately before the
        // synchronous call so selecting the tab while the save barrier drains
        // does not remove a still-live reader's hooks.
        if (hook.tabs.canUnload && !hook.tabs.canUnload(id)) {
          guard.closing = false;
          guard.bypass = false;
          unfreezeReaders([guard.reader]);
          return;
        }
        guard.bypass = true;
        hook.originalUnload?.call(hook.tabs, id);
        const tab = hook.tabs._getTab?.(id)?.tab;
        if (tab && !String(tab.type).endsWith("-unloaded")) {
          guard.closing = false;
          guard.bypass = false;
          unfreezeReaders([guard.reader]);
        } else if (closeGuards.includes(guard)) {
          cleanupReaderHooksForReader(guard.reader);
        }
      };
      if (!closeGuardHasPending(guard)) {
        unloadNow();
        return;
      }
      requestGuardedClose(guard, unloadNow);
    };
  }

  const captureClose = (event: Event) => {
    const mouseEvent = event as MouseEvent;
    const target = event.target as Element | null;
    const isCloseButton = Boolean(target?.closest?.(".tab-close"));
    if (!isCloseButton && mouseEvent.button !== 1) return;
    const tabID = tabIDFromCloseEvent(event);
    const guard = tabID ? hook.guards.get(tabID) : undefined;
    if (!guard || guard.bypass || !closeGuardHasPending(guard)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requestGuardedClose(guard, () => closeOne(guard));
  };
  hook.clickListener = captureClose;
  hook.auxClickListener = captureClose;
  hook.unloadListener = () => removeTabCloseHook(hook);

  tabs.close = hook.wrappedClose;
  if (hook.wrappedUnload) tabs.unload = hook.wrappedUnload;
  hook.container?.addEventListener("click", hook.clickListener, true);
  hook.container?.addEventListener("auxclick", hook.auxClickListener, true);
  window.addEventListener("unload", hook.unloadListener, { once: true });
  tabCloseHooks.push(hook);
  return hook;
}

export function installCloseSaveGuard(
  reader: ReaderLike,
  pendingWork: PendingWorkBarrier,
  onFailure: (error: unknown) => void,
): void {
  const existing = closeGuards.find((guard) => guard.reader === reader);
  if (existing) {
    existing.pendingWork = pendingWork;
    existing.onFailure = onFailure;
    return;
  }

  const window = reader._window;
  if (!window) return;
  const guard: CloseGuard = {
    reader,
    pendingWork,
    onFailure,
    closing: false,
    bypass: false,
  };
  closeGuards.push(guard);
  ensureReaderCleanupBinding(reader);

  const originalClose = (reader as any).close as ((...args: any[]) => any) | undefined;
  if (!originalClose) {
    removeCloseGuard(guard);
    throw new Error("Zotero reader close hook is unavailable");
  }
  guard.originalReaderClose = originalClose;
  const closeNow = (...args: any[]) => {
    guard.bypass = true;
    cleanupReaderHooksForReader(reader, true);
    originalClose.apply(reader, args);
  };
  guard.wrappedReaderClose = (...args: any[]) => {
    if (guard.bypass) return originalClose.apply(reader, args);
    if (!closeGuardHasPending(guard)) return closeNow(...args);
    requestGuardedClose(guard, () => closeNow(...args));
  };
  (reader as any).close = guard.wrappedReaderClose;

  if (reader.tabID) {
    const hook = ensureTabCloseHook(window);
    if (!hook) {
      removeCloseGuard(guard);
      throw new Error("Zotero tab close hook is unavailable");
    }
    guard.tabID = reader.tabID;
    guard.tabHook = hook;
    hook.guards.set(reader.tabID, guard);
    return;
  }
  guard.windowCloseListener = (event: Event) => {
    if (guard.bypass || !closeGuardHasPending(guard)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requestGuardedClose(guard, () => closeNow());
  };
  window.addEventListener("close", guard.windowCloseListener, true);
}

export async function openNoteReaderWindow(
  noteItemID: number,
  sourceReader: ReaderLike,
  signal?: AbortSignal,
): Promise<ReaderLike> {
  if (!hooksEnabled) throw new Error("Reader hooks are not active");
  const session = hookSession;
  // Include initializing readers in the ownership snapshot. openReadersForItem
  // intentionally filters those out, but a user-owned ReaderWindow may not
  // have _internalReader yet and must never be closed as plugin-created.
  const readersBeforeOpen = new Set<ReaderLike>(
    (((Zotero.Reader as any)._readers ?? []) as ReaderLike[]).filter(
      (candidate) => candidate.itemID === noteItemID,
    ),
  );
  // Once Zotero.Reader.open() starts, wait for it to return the owned reader so
  // an abort can close a newly created window instead of orphaning it.
  const reader = (await Zotero.Reader.open(noteItemID, undefined, {
    openInWindow: true,
    allowDuplicate: true,
  })) as unknown as ReaderLike;
  if (!reader) throw new Error("Zotero did not return a reader window");
  const readerOwnedByThisCall = !readersBeforeOpen.has(reader);
  try {
    await waitForReader(reader, signal);
    if (!isCurrentHookSession(session) || signal?.aborted) {
      throw new Error("The plugin was disabled while opening the notes reader");
    }
  } catch (error) {
    if (readerOwnedByThisCall) {
      try {
        getLiveReaderWindow(reader)?.close();
      } catch (closeError) {
        logError(closeError);
      }
    }
    throw error;
  }

  const noteWindow = getLiveReaderWindow(reader);
  if (!noteWindow) throw new Error("The notes reader window closed during startup");
  if (!initializedNoteWindows.has(noteWindow)) {
    initializedNoteWindows.add(noteWindow);
    try {
      const sourceWindow = getLiveReaderWindow(sourceReader);
      const display = sourceWindow?.screen ?? noteWindow.screen;
      const availableLeft = Number((display as any).availLeft ?? 0);
      const availableTop = Number((display as any).availTop ?? 0);
      const width = Math.min(NOTE_WINDOW_SIZE.width, Math.max(480, display.availWidth - 80));
      const height = Math.min(NOTE_WINDOW_SIZE.height, Math.max(420, display.availHeight - 80));
      noteWindow.document.documentElement?.removeAttribute("persist");
      noteWindow.resizeTo?.(width, height);
      if (sourceWindow) {
        const x = Math.min(
          availableLeft + display.availWidth - width,
          Math.max(availableLeft, (sourceWindow.screenX ?? availableLeft) + 80),
        );
        const y = Math.min(
          availableTop + display.availHeight - height,
          Math.max(availableTop, (sourceWindow.screenY ?? availableTop) + 70),
        );
        noteWindow.moveTo?.(x, y);
      }
    } catch (error) {
      // Window positioning is best-effort and must not strand an otherwise
      // usable notes reader if the source window closes concurrently.
      logError(error);
    }
  }

  try {
    const existingFocusBinding = focusReturnBindings.find(
      (binding) => binding.window === noteWindow,
    );
    if (existingFocusBinding) {
      existingFocusBinding.sourceReader = sourceReader;
    } else {
      const binding = {
        window: noteWindow,
        sourceReader,
        listener: () => undefined,
      };
      binding.listener = () => {
        try {
          const sourceWindow = getLiveReaderWindow(binding.sourceReader) as any;
          if (binding.sourceReader.tabID) {
            sourceWindow?.Zotero_Tabs?.select(binding.sourceReader.tabID);
          }
          sourceWindow?.focus();
          void Promise.resolve(binding.sourceReader.focus?.()).catch(logError);
        } catch (error) {
          logError(error);
        }
        const index = focusReturnBindings.indexOf(binding);
        if (index >= 0) focusReturnBindings.splice(index, 1);
      };
      noteWindow.addEventListener("unload", binding.listener, { once: true });
      focusReturnBindings.push(binding);
    }
  } catch (error) {
    logError(error);
  }

  enableImmediateAnnotationSaving(reader);
  noteWindow.focus();
  try {
    await withTimeout(
      Promise.resolve(reader.focus?.()),
      READER_INIT_TIMEOUT_MS,
      "Timed out while focusing the notes reader",
      signal,
    );
    if (!isCurrentHookSession(session) || signal?.aborted) {
      const error = new Error("The plugin was disabled while focusing the notes reader");
      error.name = "AbortError";
      throw error;
    }
  } catch (error) {
    if (readerOwnedByThisCall) {
      try {
        cleanupReaderHooksForReader(reader);
        getLiveReaderWindow(reader)?.close();
      } catch (closeError) {
        logError(closeError);
      }
    }
    throw error;
  }
  return reader;
}

export function unregisterReaderHooks(): void {
  invalidateReaderHooks();
  if (readerOpenMonitor) {
    const monitor = readerOpenMonitor;
    for (const blocker of monitor.blockers.values()) blocker.release();
    monitor.blockers.clear();
    try {
      if (monitor.manager.open === monitor.wrappedOpen) {
        monitor.manager.open = monitor.originalOpen;
      }
    } catch (error) {
      logError(error);
    }
    readerOpenMonitor = undefined;
  }
  const readers = new Set<ReaderLike>();
  for (const binding of readerCleanupBindings) readers.add(binding.reader);
  for (const hook of viewLifecycleHooks) readers.add(hook.reader);
  for (const capture of placementCaptures) readers.add(capture.reader);
  for (const state of immediateSaveStates.values()) readers.add(state.reader);
  for (const guard of closeGuards) readers.add(guard.reader);
  for (const reader of readers) {
    try {
      cleanupReaderHooksForReader(reader);
    } catch (error) {
      logError(error);
    }
  }

  for (const binding of pointerBindings.splice(0)) {
    try {
      removePointerBinding(binding);
    } catch (error) {
      logError(error);
    }
  }
  for (const hook of viewLifecycleHooks.splice(0)) {
    try {
      if (hook.internal._createView === hook.wrappedCreateView) {
        hook.internal._createView = hook.originalCreateView;
      }
    } catch (error) {
      logError(error);
    }
  }
  for (const capture of [...placementCaptures]) removePlacementCapture(capture, false);
  for (const state of [...immediateSaveStates.values()]) removeImmediateSaveState(state);
  for (const guard of [...closeGuards]) {
    try {
      removeCloseGuard(guard);
    } catch (error) {
      logError(error);
    }
  }
  for (const hook of [...tabCloseHooks]) {
    try {
      removeTabCloseHook(hook);
    } catch (error) {
      logError(error);
    }
  }
  for (const binding of readerCleanupBindings.splice(0)) {
    try {
      binding.window.removeEventListener("unload", binding.listener);
    } catch (error) {
      logError(error);
    }
  }
  for (const binding of focusReturnBindings.splice(0)) {
    try {
      binding.window.removeEventListener("unload", binding.listener);
    } catch (error) {
      logError(error);
    }
  }
  try {
    (Zotero.Reader as any)._unregisterEventListenerByPluginID?.(PLUGIN_ID);
  } catch (error) {
    logError(error);
  }
}

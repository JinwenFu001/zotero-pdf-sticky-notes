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

interface PointerStart {
  x: number;
  y: number;
  annotationID?: string;
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
  color: string;
  initialAnnotationIDs: Set<string>;
  bindings: Array<{ window: Window; pointerDown: (event: Event) => void }>;
  checkScheduled: boolean;
  toolPoll?: ReturnType<typeof setInterval>;
  onCaptured: (key: string) => void;
  onCancelled: () => void;
}

interface ImmediateSaveState {
  reader: ReaderLike;
  internal: any;
  manager: any;
  active: boolean;
  previousValue: boolean | undefined;
  saveFailureDetected: boolean;
  deleteFailureDetected: boolean;
  deleteFailure?: unknown;
  pendingDeletionTransactions: Set<Promise<void>>;
  originalSetReadOnly?: (...args: any[]) => any;
  wrappedSetReadOnly?: (...args: any[]) => any;
  annotationItemIDsDescriptor?: PropertyDescriptor;
  annotationItemIDsValue?: unknown;
  annotationItemIDsGetter?: () => unknown;
  annotationItemIDsSetter?: (value: unknown) => void;
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

/**
 * Zotero's ReaderEvent exposes a chrome-side ReaderInstance. Its bundled
 * reader lives in the iframe global and is intentionally reached through
 * wrappedJSObject. `_internalReader` is retained only as a test/older-build
 * fallback; direct access can be filtered by Gecko's Xray wrapper.
 */
function getInternalReader(reader: ReaderLike): any | undefined {
  let wrappedError: unknown;
  try {
    const internal = (reader._iframeWindow as any)?.wrappedJSObject?._reader;
    if (internal) return internal;
  } catch (error) {
    wrappedError = error;
  }
  try {
    const internal = reader._internalReader;
    if (internal) return internal;
  } catch (error) {
    logError(error);
    return undefined;
  }
  if (wrappedError) logError(wrappedError);
  return undefined;
}

function readerViews(reader: ReaderLike): any[] {
  try {
    const internal = getInternalReader(reader);
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
    return (
      readers.includes(reader) && !reader._window?.closed && Boolean(getInternalReader(reader))
    );
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

function nodeAnnotationID(node: unknown): string | undefined {
  try {
    const element = node as {
      dataset?: { annotationId?: unknown };
      getAttribute?: (name: string) => unknown;
      closest?: (selector: string) => unknown;
    };
    const value = element.dataset?.annotationId ?? element.getAttribute?.("data-annotation-id");
    if (value !== undefined && value !== null && String(value)) return String(value);

    const closest = element.closest?.("[data-annotation-id]");
    if (closest && closest !== node) return nodeAnnotationID(closest);
  } catch {
    // Some nodes in the composed path are cross-compartment wrappers. Keep
    // looking for Zotero's exact annotation marker.
  }
  return undefined;
}

function annotationIDFromEventPath(event: Event): string | undefined {
  let path: unknown[] = [];
  try {
    path = typeof event.composedPath === "function" ? event.composedPath() : [];
  } catch {
    // Fall through to the event target, which is available on older Gecko
    // event wrappers even when composedPath() is not callable.
  }
  if (!path.length && event.target) path = [event.target];
  for (const node of path) {
    const annotationID = nodeAnnotationID(node);
    if (annotationID) return annotationID;
  }
  return undefined;
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

  let start: PointerStart | undefined;
  let lastActivation = "";
  let lastActivationTime = 0;
  const pointerDown = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    start = {
      x: pointer.clientX,
      y: pointer.clientY,
      annotationID: annotationIDFromEventPath(event),
    };
  };
  const pointerUp = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    if (!start || Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) > 5) {
      start = undefined;
      return;
    }
    const completed = start;
    start = undefined;
    if (!completed.annotationID) return;

    const activateIfMatched = async () => {
      if (!isCurrentHookSession(session)) return;
      const annotation = annotationByKey(reader, completed.annotationID as string);
      if (!annotation) return;
      await Promise.all([
        annotation.loadDataType?.("relations"),
        annotation.loadDataType?.("tags"),
      ]);
      if (!isCurrentHookSession(session)) return;
      if (!isPluginSticky(annotation)) return;
      const now = Date.now();
      if (annotation.key === lastActivation && now - lastActivationTime < 300) return;
      lastActivation = annotation.key;
      lastActivationTime = now;
      getInternalReader(reader)?._updateState?.(
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
  const internal = getInternalReader(reader);
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
  if (capture.toolPoll) clearInterval(capture.toolPoll);
  for (const binding of capture.bindings) {
    try {
      binding.window.removeEventListener(
        "pointerdown",
        binding.pointerDown,
        POINTER_LISTENER_CAPTURE,
      );
      binding.window.removeEventListener(
        "mousedown",
        binding.pointerDown,
        POINTER_LISTENER_CAPTURE,
      );
    } catch (error) {
      logError(error);
    }
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

function annotationIDs(manager: any): Set<string> {
  if (!Array.isArray(manager?._annotations)) {
    throw new Error("Zotero reader annotation state is unavailable");
  }
  const ids = new Set<string>();
  for (let index = 0; index < manager._annotations.length; index += 1) {
    const id = manager._annotations[index]?.id;
    if (id !== undefined && id !== null) ids.add(String(id));
  }
  return ids;
}

function normalizeColor(color: unknown): string {
  return typeof color === "string" ? color.toLowerCase() : "";
}

function captureNewPlacedNote(capture: PlacementCapture): boolean {
  if (!capture.active || !Array.isArray(capture.manager?._annotations)) return false;
  const notes: Array<{ id: unknown }> = [];
  for (let index = 0; index < capture.manager._annotations.length; index += 1) {
    const annotation = capture.manager._annotations[index] as
      | { id?: unknown; type?: unknown; color?: unknown }
      | undefined;
    if (
      annotation?.id !== undefined &&
      annotation.id !== null &&
      !capture.initialAnnotationIDs.has(String(annotation.id)) &&
      annotation.type === "note" &&
      normalizeColor(annotation.color) === normalizeColor(capture.color)
    ) {
      notes.push({ id: annotation.id });
    }
  }
  if (notes.length !== 1) {
    if (notes.length > 1) {
      logError(new Error("Zotero created multiple matching notes during one placement"));
      removePlacementCapture(capture, true);
    }
    return false;
  }

  const key = String(notes[0].id);
  removePlacementCapture(capture, false);
  try {
    capture.onCaptured(key);
  } catch (error) {
    logError(error);
  }
  return true;
}

function placementToolChanged(capture: PlacementCapture): boolean {
  const tool = capture.internal?._state?.tool;
  return tool?.type !== "note" || normalizeColor(tool.color) !== normalizeColor(capture.color);
}

function schedulePlacementCheck(capture: PlacementCapture): void {
  if (!capture.active || capture.checkScheduled) return;
  capture.checkScheduled = true;
  void Promise.resolve().then(() => {
    capture.checkScheduled = false;
    if (!capture.active || captureNewPlacedNote(capture)) return;
    if (placementToolChanged(capture)) removePlacementCapture(capture, true);
  });
}

/**
 * Select Zotero's native note tool and capture the exact annotation key it
 * creates. Zotero's view listener is installed first and synchronously adds a
 * note to the annotation manager during pointerdown/mousedown. Diffing that
 * state from a later listener on the same event avoids mutating reader methods
 * across Gecko compartments.
 */
export function beginReaderNotePlacement(
  reader: ReaderLike,
  color: string,
  onCaptured: (key: string) => void,
  onCancelled: () => void,
): (() => void) | undefined {
  try {
    const internal = getInternalReader(reader);
    const manager = internal?._annotationManager;
    const viewWindows = [
      ...new Set(
        readerViews(reader)
          .map((view) => view?._iframeWindow as Window | undefined)
          .filter((window): window is Window => Boolean(window && !window.closed)),
      ),
    ];
    if (
      typeof internal?.setTool !== "function" ||
      !Array.isArray(manager?._annotations) ||
      !viewWindows.length
    ) {
      logError(
        new Error(
          `Reader placement interface unavailable in Zotero ${Zotero.version} ` +
            `(internal=${Boolean(internal)}, setTool=${typeof internal?.setTool}, ` +
            `annotations=${Array.isArray(manager?._annotations)}, views=${viewWindows.length})`,
        ),
      );
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
      color,
      initialAnnotationIDs: annotationIDs(manager),
      bindings: [],
      checkScheduled: false,
      onCaptured,
      onCancelled,
    };

    placementCaptures.push(capture);
    for (const window of viewWindows) {
      const pointerDown = (event: Event) => {
        if (!capture.active) return;
        const pointer = event as PointerEvent;
        // Zotero intentionally ignores mouse pointerdown and creates the note
        // from the following mousedown so it can use MouseEvent.detail.
        if (event.type === "pointerdown" && pointer.pointerType === "mouse") return;
        if (typeof pointer.button === "number" && pointer.button !== 0) return;
        if (captureNewPlacedNote(capture)) return;
        // The initialized 9.0.6 view installs its native capture listener
        // first. Keep a microtask fallback for an unusually early toolbar
        // click where this listener may run first; the native handler still
        // creates the note synchronously before the event dispatch completes.
        schedulePlacementCheck(capture);
      };
      window.addEventListener("pointerdown", pointerDown, POINTER_LISTENER_CAPTURE);
      window.addEventListener("mousedown", pointerDown, POINTER_LISTENER_CAPTURE);
      capture.bindings.push({ window, pointerDown });
    }
    try {
      internal.setTool(cloneIntoReader(reader, { type: "note", color }));
    } catch (error) {
      removePlacementCapture(capture, false);
      throw error;
    }
    if (
      internal._state?.tool?.type !== "note" ||
      normalizeColor(internal._state?.tool?.color) !== normalizeColor(color)
    ) {
      logError(
        new Error(
          `Zotero ${Zotero.version} refused the requested note tool ` +
            `(readOnly=${Boolean(internal._state?.readOnly)})`,
        ),
      );
      removePlacementCapture(capture, false);
      return undefined;
    }
    capture.toolPoll = setInterval(() => {
      if (!capture.active) return;
      if (placementToolChanged(capture)) removePlacementCapture(capture, true);
    }, 50);
    ensureReaderCleanupBinding(reader);
    return () => removePlacementCapture(capture, false);
  } catch (error) {
    logError(error);
    return undefined;
  }
}

export function enableImmediateAnnotationSaving(reader: ReaderLike): void {
  try {
    const internal = getInternalReader(reader);
    const manager = internal?._annotationManager;
    if (!manager) return;

    let state = immediateSaveStates.get(reader);
    if (state && state.internal === internal && state.manager === manager) {
      manager._skipAnnotationSavingDebounce = true;
      return;
    }
    if (state) {
      restoreImmediateSaveBindings(state);
      immediateSaveStates.delete(reader);
    }
    state = {
      reader,
      internal,
      manager,
      active: true,
      previousValue: manager._skipAnnotationSavingDebounce,
      saveFailureDetected: false,
      deleteFailureDetected: false,
      pendingDeletionTransactions: new Set(),
    };
    immediateSaveStates.set(reader, state);

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

    installDeletedAnnotationObserver(state);

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

function numericItemIDs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const result: number[] = [];
  for (const candidate of value) {
    const itemID = Number(candidate);
    if (Number.isInteger(itemID) && itemID > 0) result.push(itemID);
  }
  return [...new Set(result)];
}

function trackDeletedItems(state: ImmediateSaveState, itemIDs: number[]): void {
  if (!itemIDs.length) return;
  const tracked = waitForDeletedItems(state, itemIDs).then(
    () => undefined,
    (error) => {
      state.deleteFailureDetected = true;
      state.deleteFailure = error;
    },
  );
  state.pendingDeletionTransactions.add(tracked);
  void tracked.finally(() => state.pendingDeletionTransactions.delete(tracked));
}

function installDeletedAnnotationObserver(state: ImmediateSaveState): void {
  try {
    const reader = state.reader as ReaderLike & Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(reader, "annotationItemIDs");
    // Zotero 9.0.6 creates this as a normal writable own data property. Do not
    // interfere if a future release changes that contract.
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.configurable !== true ||
      descriptor.writable !== true ||
      !Array.isArray(descriptor.value)
    ) {
      return;
    }
    state.annotationItemIDsDescriptor = descriptor;
    state.annotationItemIDsValue = descriptor.value;
    state.annotationItemIDsGetter = () => state.annotationItemIDsValue;
    state.annotationItemIDsSetter = (nextValue: unknown) => {
      const previousValue = state.annotationItemIDsValue;
      state.annotationItemIDsValue = nextValue;
      if (!state.active) return;
      try {
        const previousIDs = numericItemIDs(previousValue);
        const nextIDs = new Set(numericItemIDs(nextValue));
        trackDeletedItems(
          state,
          previousIDs.filter((itemID) => !nextIDs.has(itemID)),
        );
      } catch (error) {
        // Observation must never disrupt Zotero's native annotation save path.
        logError(error);
      }
    };
    Object.defineProperty(reader, "annotationItemIDs", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: state.annotationItemIDsGetter,
      set: state.annotationItemIDsSetter,
    });
  } catch (error) {
    // This is a version-pinned verification hook. Zotero's native saving must
    // continue unchanged if the host property cannot be observed.
    logError(error);
  }
}

async function waitForDeletedItems(state: ImmediateSaveState, itemIDs: number[]): Promise<void> {
  const timeoutMessage = "Timed out while waiting for Zotero to save an erased annotation";
  const deadline = Date.now() + READER_INIT_TIMEOUT_MS;
  while (state.active) {
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) throw new Error(timeoutMessage);
    const remaining = await withTimeout(
      Promise.all(
        itemIDs.map((itemID) => (Zotero.Items.getAsync as any)(itemID, { noCache: true })),
      ),
      remainingTime,
      timeoutMessage,
    );
    if (remaining.every((item) => !item)) return;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function waitForReaderDeletionTransactions(reader: ReaderLike): Promise<void> {
  const state = immediateSaveStates.get(reader);
  if (!state) return;
  while (state.pendingDeletionTransactions.size > 0) {
    await Promise.all([...state.pendingDeletionTransactions]);
  }
  if (!state.active || immediateSaveStates.get(reader) !== state) return;
  if (state.deleteFailureDetected) {
    throw new Error("Zotero failed to save an erased handwritten annotation", {
      cause: state.deleteFailure,
    });
  }
}

function restoreImmediateSaveBindings(state: ImmediateSaveState): void {
  state.active = false;
  state.pendingDeletionTransactions.clear();
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
    const reader = state.reader as ReaderLike & Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(reader, "annotationItemIDs");
    if (
      state.annotationItemIDsDescriptor &&
      descriptor?.get === state.annotationItemIDsGetter &&
      descriptor?.set === state.annotationItemIDsSetter
    ) {
      Object.defineProperty(reader, "annotationItemIDs", {
        ...state.annotationItemIDsDescriptor,
        value: state.annotationItemIDsValue,
      });
    }
  } catch (error) {
    logError(error);
  }
  state.originalSetReadOnly = undefined;
  state.wrappedSetReadOnly = undefined;
  state.annotationItemIDsDescriptor = undefined;
  state.annotationItemIDsValue = undefined;
  state.annotationItemIDsGetter = undefined;
  state.annotationItemIDsSetter = undefined;
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
  while (!getInternalReader(reader) && Date.now() < deadline) {
    if (signal?.aborted) {
      const error = new Error("The plugin operation was cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (reader._window?.closed) throw new Error("The Zotero reader window closed during startup");
    await delay(25);
  }
  if (!getInternalReader(reader)) {
    throw new Error("Zotero reader did not initialize");
  }
}

/** Zotero 9 exposes tool selection only on the bundled reader implementation. */
export function setReaderTool(reader: ReaderLike, tool: Record<string, unknown>): boolean {
  try {
    const internal = getInternalReader(reader);
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
  const internal = getInternalReader(reader);
  const manager = internal?._annotationManager;
  if (!manager?._triggerSaving || !manager?._unsavedAnnotations) {
    throw new Error(
      `Annotation save barrier is unavailable in Zotero ${Zotero.version}; tested with ${TESTED_ZOTERO_VERSION}`,
    );
  }

  const previousSkip = manager._skipAnnotationSavingDebounce;
  const initiallyReadOnly = Boolean(internal?._state?.readOnly);
  manager._skipAnnotationSavingDebounce = true;
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      if (!manager._savingInProgress && manager._unsavedAnnotations.size > 0) {
        await manager._triggerSaving();
      }
      if (readerSaveFailureDetected(reader) || (!initiallyReadOnly && internal?._state?.readOnly)) {
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

/**
 * Reconcile a committed annotation deletion with every open source reader.
 *
 * Zotero 9.0.6 delivers the notes attachment's modify notification before the
 * annotation's delete notification. The modify handler refreshes
 * annotationItemIDs from the database after the row is gone, so the later
 * delete handler no longer finds the key to remove from the rendered PDF. A
 * targeted unset preserves the source reader's page, zoom, and scroll state.
 * This function intentionally never throws because the database deletion has
 * already committed.
 */
export async function reconcileDeletedAnnotationInReaders(
  sourceItemID: number,
  annotationID: number,
  annotationKey: string,
): Promise<void> {
  const safelyLog = (error: unknown): void => {
    try {
      logError(error);
    } catch {
      // UI reconciliation must not turn a committed database deletion into a
      // reported operation failure, even if host logging is unavailable.
    }
  };

  let readers: ReaderLike[];
  try {
    readers = readerInstancesForItem(sourceItemID);
  } catch (error) {
    safelyLog(error);
    return;
  }

  await Promise.allSettled(
    readers.map(async (reader) => {
      try {
        await waitForReader(reader);
        if (!readerInstancesForItem(sourceItemID).includes(reader)) return;
        if (typeof reader.unsetAnnotations !== "function") {
          throw new Error("The Zotero reader annotation removal API is unavailable");
        }
        await reader.unsetAnnotations([annotationKey]);
      } catch (error) {
        safelyLog(error);
        return;
      }

      // Only retire the numeric ID after the rendered annotation was removed.
      // Keeping it on failure allows a later native delete notification to
      // retry instead of hiding the annotation from Zotero's own handler.
      try {
        if (Array.isArray(reader.annotationItemIDs)) {
          reader.annotationItemIDs = reader.annotationItemIDs.filter(
            (itemID) => itemID !== annotationID,
          );
        }
      } catch (error) {
        safelyLog(error);
      }
    }),
  );
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
      getInternalReader(reader)?.freeze?.();
    } catch (error) {
      logError(error);
    }
  }
}

export function unfreezeReaders(readers: ReaderLike[]): void {
  for (const reader of readers) {
    if (!isReaderLive(reader)) continue;
    try {
      getInternalReader(reader)?.unfreeze?.();
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
    // Reapply explicitly instead of relying on a toolbar re-render side
    // effect; this also rebinds if a future host reinitialization replaces the
    // annotation manager.
    enableImmediateAnnotationSaving(reader);
  }
  const activeInternal = activeReader ? getInternalReader(activeReader) : undefined;
  if (
    activeReader &&
    isReaderLive(activeReader) &&
    activeInternal?.navigate &&
    activeReader._iframeWindow
  ) {
    const location = Components.utils.cloneInto({ pageIndex }, activeReader._iframeWindow);
    await activeInternal.navigate(location);
  }
}

function closeGuardHasPending(guard: CloseGuard): boolean {
  try {
    const manager = getInternalReader(guard.reader)?._annotationManager;
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

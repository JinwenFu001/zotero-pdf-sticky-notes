import {
  beginReaderNotePlacement,
  bindStickyActivation,
  cleanupReaderHooksForTabIDs,
  enableImmediateAnnotationSaving,
  initializeReaderHooks,
  invalidateReaderHooks,
  installCloseSaveGuard,
  openNoteReaderWindow,
  setReaderTool,
  unregisterReaderHooks,
  waitForPendingCloseSaveGuards,
} from "./compat/zotero-9-reader";
import { PLACEMENT_TIMEOUT_MS, PLUGIN_ID, TESTED_ZOTERO_VERSION } from "./constants";
import { SafeReplaceError } from "./files/safe-replace";
import {
  AttachmentUnavailableError,
  NoteService,
  PageRecoveryError,
  PageSavedRefreshError,
} from "./notes/note-service";
import { isPluginNoteAttachment, isPluginSticky, resolveLinkedNote } from "./relations";
import type { ReaderEvent, ReaderLike, ZoteroItemLike } from "./types";
import { alertError, message, showStatus, type MessageKey } from "./ui/messages";

interface PendingPlacement {
  reader: ReaderLike;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
  expectedKey?: string;
  cancelCapture?: () => void;
}

export class StickyNotesPlugin {
  readonly data = { initialized: false };

  private readonly noteService = new NoteService();
  private readonly pendingPlacements = new Map<number, PendingPlacement>();
  private readonly toolbarNodes = new Map<
    Element,
    { ownerWindow?: Window; unloadListener?: () => void }
  >();
  private readonly activeTasks = new Set<Promise<unknown>>();
  private lifetime = new AbortController();
  private notifierID?: string;

  private logError(error: unknown): void {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  private trackTask(task: Promise<unknown>): void {
    const tracked = task
      .catch((error) => this.logError(error))
      .finally(() => this.activeTasks.delete(tracked));
    this.activeTasks.add(tracked);
  }

  private async waitForActiveTasks(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.all([...this.activeTasks]);
    }
  }

  private trackToolbarNode(node: Element): void {
    try {
      const ownerDocument = node.ownerDocument;
      const ownerWindow = ownerDocument?.defaultView ?? undefined;
      const unloadListener = () => this.toolbarNodes.delete(node);
      ownerWindow?.addEventListener("unload", unloadListener, { once: true });
      this.toolbarNodes.set(node, { ownerWindow, unloadListener });
    } catch (error) {
      this.logError(error);
      this.toolbarNodes.set(node, {});
    }
  }

  private readonly notifier = {
    notify: (
      event: string,
      type: string,
      ids: unknown[],
      extraData?: Record<string, { instanceID?: string }>,
    ) => {
      if (event === "close" && type === "tab") {
        const closed = new Set(this.flattenIDs(ids));
        for (const [sourceID, pending] of this.pendingPlacements) {
          if (!pending.reader.tabID || !closed.has(pending.reader.tabID)) continue;
          clearTimeout(pending.timeout);
          pending.cancelCapture?.();
          this.pendingPlacements.delete(sourceID);
        }
        cleanupReaderHooksForTabIDs(ids);
        return;
      }
      if (event === "add" && type === "item") {
        this.trackTask(
          this.handleAddedItems(
            this.flattenIDs(ids).map(Number).filter(Number.isInteger),
            extraData,
          ),
        );
      }
    },
  };

  private flattenIDs(values: unknown[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      if (Array.isArray(value)) result.push(...this.flattenIDs(value));
      else if (value !== undefined && value !== null) result.push(String(value));
    }
    return result;
  }

  private readonly renderToolbar = (event: ReaderEvent) => {
    if (!this.data.initialized) return;
    const { reader, doc, append } = event;
    if (!doc || reader._item?.attachmentContentType !== "application/pdf") return;
    const slot = doc.createElement("span");
    slot.className = "zpsn-toolbar-slot";
    append(slot);
    this.trackToolbarNode(slot);
    void this.populateToolbar(slot, reader).catch((error) => this.logError(error));
  };

  private readonly createAnnotationContextMenu = (event: ReaderEvent) => {
    if (!this.data.initialized) return;
    const ids = event.params?.ids as string[] | undefined;
    const source = event.reader._item;
    if (!source || ids?.length !== 1) return;
    const annotation = Zotero.Items.getByLibraryAndKey(source.libraryID, ids[0]) as
      | ZoteroItemLike
      | false;
    if (!isPluginSticky(annotation)) return;
    event.append({
      label: message("openNotes"),
      onCommand: () =>
        this.trackTask(this.openLinkedNote(annotation as ZoteroItemLike, event.reader)),
    });
  };

  async startup(_reason: number): Promise<void> {
    await Zotero.uiReadyPromise;
    if (String(Zotero.version) !== TESTED_ZOTERO_VERSION) {
      throw new Error(
        `Zotero PDF Sticky Notes ${PLUGIN_ID} is tested only with Zotero ${TESTED_ZOTERO_VERSION}; found ${Zotero.version}`,
      );
    }

    this.lifetime = new AbortController();
    initializeReaderHooks();
    Zotero.Reader.registerEventListener("renderToolbar", this.renderToolbar as any, PLUGIN_ID);
    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      this.createAnnotationContextMenu as any,
      PLUGIN_ID,
    );
    this.notifierID = Zotero.Notifier.registerObserver(this.notifier, ["item", "tab"], PLUGIN_ID);
    this.data.initialized = true;
    Zotero.debug(`[${PLUGIN_ID}] initialized for Zotero ${Zotero.version}`);
  }

  async onMainWindowLoad(_window: Window): Promise<void> {}

  async onMainWindowUnload(_window: Window): Promise<void> {}

  async shutdown(): Promise<void> {
    this.data.initialized = false;
    this.lifetime.abort();
    invalidateReaderHooks();
    if (this.notifierID !== undefined) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }
    for (const pending of this.pendingPlacements.values()) {
      clearTimeout(pending.timeout);
      pending.cancelCapture?.();
    }
    for (const [node, binding] of this.toolbarNodes) {
      try {
        if (binding.ownerWindow && binding.unloadListener) {
          binding.ownerWindow.removeEventListener("unload", binding.unloadListener);
        }
        node.remove();
      } catch (error) {
        this.logError(error);
      }
    }
    this.toolbarNodes.clear();
    await Promise.all([
      this.waitForActiveTasks(),
      this.noteService.waitForAllPendingFileOperations(),
    ]);
    await waitForPendingCloseSaveGuards();
    for (const pending of this.pendingPlacements.values()) {
      setReaderTool(pending.reader, { type: "pointer" });
    }
    this.pendingPlacements.clear();
    this.noteService.clear();
    unregisterReaderHooks();
  }

  private makeToolbarButton(
    doc: Document,
    label: string,
    glyph: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "toolbar-button zpsn-toolbar-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tabstop", "1");
    button.textContent = glyph;
    button.style.fontSize = "17px";
    button.style.fontWeight = "600";
    button.addEventListener("click", onClick);
    this.trackToolbarNode(button);
    return button;
  }

  private async populateToolbar(slot: Element, reader: ReaderLike): Promise<void> {
    if (!this.data.initialized) return;
    const item = (reader._item ?? (await Zotero.Items.getAsync(reader.itemID))) as
      | ZoteroItemLike
      | false;
    if (!item || item.deleted) return;
    await item.loadDataType?.("relations");
    if (!this.data.initialized) return;
    try {
      if (!slot.isConnected) return;
    } catch {
      return;
    }
    const doc = slot.ownerDocument;
    if (!doc) return;

    if (isPluginNoteAttachment(item)) {
      enableImmediateAnnotationSaving(reader);
      installCloseSaveGuard(
        reader,
        {
          hasPending: () => this.noteService.hasPendingFileOperation(item),
          waitForPending: () => this.noteService.waitForPendingFileOperations(item),
        },
        (error) => {
          if (this.data.initialized) alertError(reader._window, "pageFailed", error);
          else this.logError(error);
        },
      );
      const button = this.makeToolbarButton(doc, message("addPage"), "+▤", () => {
        showStatus("addingPage");
        void this.noteService
          .appendPage(item, reader)
          .then(() => {
            if (this.data.initialized) showStatus("pageAdded");
          })
          .catch((error) => {
            if (this.data.initialized) this.handlePageError(reader, error);
            else this.logError(error);
          });
      });
      const library = Zotero.Libraries.get(item.libraryID);
      if (!item.isEditable?.() || !library || !library.editable || !library.filesEditable) {
        button.disabled = true;
        button.title = message("noteReadOnly");
        button.setAttribute("aria-label", message("noteReadOnly"));
      }
      slot.append(button);
      return;
    }

    void bindStickyActivation(reader, (annotation, sourceReader) => {
      this.trackTask(this.openLinkedNote(annotation, sourceReader));
    }).catch((error) => this.logError(error));
    const button = this.makeToolbarButton(doc, message("addSticky"), "✎+", () => {
      this.beginPlacement(item, reader);
    });
    slot.append(button);
  }

  private beginPlacement(source: ZoteroItemLike, reader: ReaderLike): void {
    if (!this.data.initialized) return;
    if (!source.parentID) {
      alertError(reader._window, "parentRequired");
      return;
    }
    const parent = Zotero.Items.get(source.parentID) as ZoteroItemLike | false;
    if (!parent || parent.deleted) {
      alertError(reader._window, "parentUnavailable");
      return;
    }
    const library = Zotero.Libraries.get(source.libraryID);
    if (!source.isEditable?.() || !library || !library.editable || !library.filesEditable) {
      alertError(reader._window, "sourceReadOnly");
      return;
    }

    const previous = this.pendingPlacements.get(source.id);
    if (previous) {
      clearTimeout(previous.timeout);
      previous.cancelCapture?.();
      setReaderTool(previous.reader, { type: "pointer" });
    }

    const pending: PendingPlacement = {
      reader,
      expiresAt: Date.now() + PLACEMENT_TIMEOUT_MS,
      timeout: setTimeout(() => {
        if (this.pendingPlacements.get(source.id) !== pending) return;
        pending.cancelCapture?.();
        this.pendingPlacements.delete(source.id);
        setReaderTool(reader, { type: "pointer" });
        showStatus("placementExpired");
      }, PLACEMENT_TIMEOUT_MS),
    };
    this.pendingPlacements.set(source.id, pending);
    const cancelCapture = beginReaderNotePlacement(
      reader,
      "#2ea8e5",
      (key) => {
        if (this.pendingPlacements.get(source.id) === pending) pending.expectedKey = key;
      },
      () => {
        if (this.pendingPlacements.get(source.id) !== pending) return;
        clearTimeout(pending.timeout);
        this.pendingPlacements.delete(source.id);
      },
    );
    if (!cancelCapture) {
      clearTimeout(pending.timeout);
      this.pendingPlacements.delete(source.id);
      alertError(reader._window, "readerUnsupported");
      return;
    }
    pending.cancelCapture = cancelCapture;
    showStatus("placeHint");
  }

  private async handleAddedItems(
    ids: number[],
    extraData?: Record<string, { instanceID?: string }>,
  ): Promise<void> {
    for (const id of ids) {
      if (!this.data.initialized) return;
      const annotation = (await Zotero.Items.getAsync(id)) as unknown as ZoteroItemLike | false;
      if (!this.data.initialized) return;
      if (!annotation || annotation.annotationType !== "note" || !annotation.parentID) continue;
      const pending = this.pendingPlacements.get(annotation.parentID);
      if (!pending) continue;
      if (!pending.expectedKey || annotation.key !== pending.expectedKey) continue;
      const expectedInstanceID = pending.reader._instanceID;
      const actualInstanceID = extraData?.[String(id)]?.instanceID;
      if (
        !expectedInstanceID ||
        !actualInstanceID ||
        String(actualInstanceID) !== String(expectedInstanceID)
      ) {
        continue;
      }
      this.pendingPlacements.delete(annotation.parentID);
      clearTimeout(pending.timeout);
      pending.cancelCapture?.();
      setReaderTool(pending.reader, { type: "pointer" });
      if (pending.expiresAt < Date.now()) {
        await annotation.eraseTx?.().catch((error) => this.logError(error));
        if (this.data.initialized) showStatus("placementExpired");
        continue;
      }

      const source = (await Zotero.Items.getAsync(annotation.parentID)) as ZoteroItemLike | false;
      if (!this.data.initialized) return;
      if (!source) {
        await annotation.eraseTx?.().catch((error) => this.logError(error));
        if (this.data.initialized) {
          alertError(
            pending.reader._window,
            "createFailed",
            new Error("Source PDF is unavailable"),
          );
        }
        continue;
      }
      try {
        await this.noteService.createForAnnotation(source, annotation);
        if (this.data.initialized) showStatus("created");
      } catch (error) {
        this.logError(error);
        if (this.data.initialized) alertError(pending.reader._window, "createFailed", error);
      }
    }
  }

  private async openLinkedNote(
    annotation: ZoteroItemLike,
    sourceReader: ReaderLike,
  ): Promise<void> {
    if (!this.data.initialized) return;
    const signal = this.lifetime.signal;
    try {
      const resolution = await resolveLinkedNote(annotation);
      if (signal.aborted) return;
      if (resolution.status !== "ok") {
        const key: MessageKey =
          resolution.status === "deleted" ? "targetDeleted" : "relationInvalid";
        alertError(sourceReader._window, key);
        return;
      }
      const noteReader = await this.noteService.withNoteFileLock(resolution.item, async () => {
        await this.noteService.ensureReadablePdf(resolution.item, signal);
        if (!this.data.initialized || signal.aborted) {
          const error = new Error("The plugin was disabled while opening notes");
          error.name = "AbortError";
          throw error;
        }
        return openNoteReaderWindow(resolution.item.id, sourceReader, signal);
      });
      installCloseSaveGuard(
        noteReader,
        {
          hasPending: () => this.noteService.hasPendingFileOperation(resolution.item),
          waitForPending: () => this.noteService.waitForPendingFileOperations(resolution.item),
        },
        (error) => {
          if (this.data.initialized) alertError(noteReader._window, "pageFailed", error);
          else this.logError(error);
        },
      );
    } catch (error) {
      if (!this.data.initialized || (error instanceof Error && error.name === "AbortError")) return;
      if (error instanceof AttachmentUnavailableError) {
        const key: MessageKey =
          error.problem === "deleted"
            ? "targetDeleted"
            : error.problem === "not-downloaded" || error.problem === "download-failed"
              ? "notDownloaded"
              : "fileMissing";
        alertError(sourceReader._window, key, error);
      } else {
        this.logError(error);
        alertError(sourceReader._window, "openFailed", error);
      }
    }
  }

  private handlePageError(reader: ReaderLike, error: unknown): void {
    this.logError(error);
    if (error instanceof PageSavedRefreshError) {
      alertError(reader._window, "pageSavedRefreshFailed", error);
      return;
    }
    if (
      error instanceof PageRecoveryError ||
      (error instanceof SafeReplaceError && Boolean(error.backupPath))
    ) {
      alertError(reader._window, "pageRecoveryFailed", error);
      return;
    }
    alertError(reader._window, "pageFailed", error);
  }
}

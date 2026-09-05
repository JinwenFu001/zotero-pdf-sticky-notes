import { SerialQueue } from "../core/serial-queue";
import { replaceFileSafely, SafeReplaceError, type ReplacementHandle } from "../files/safe-replace";
import { zoteroFileOps } from "../files/zotero-file-ops";
import {
  flushReaderAnnotations,
  freezeReaders,
  openReadersForItem,
  readerInstancesForItem,
  reloadReaders,
  unfreezeReaders,
  waitForReader,
  withPDFWorkerSerialized,
  withReaderOpeningPaused,
  withSyncPaused,
} from "../compat/zotero-9-reader";
import { appendBlankPage, createBlankNotePdf, getPdfPageCount } from "../pdf/pdf-document";
import { linkStickyAndNote, resolveLinkedNote } from "../relations";
import type { ReaderLike, ZoteroItemLike } from "../types";

export type AttachmentProblem =
  | "deleted"
  | "not-downloaded"
  | "download-failed"
  | "missing"
  | "unreadable";

export class AttachmentUnavailableError extends Error {
  constructor(
    readonly problem: AttachmentProblem,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AttachmentUnavailableError";
  }
}

export class PageSavedRefreshError extends Error {
  constructor(
    message: string,
    readonly backupPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PageSavedRefreshError";
  }
}

export class PageRecoveryError extends Error {
  constructor(
    message: string,
    readonly backupPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PageRecoveryError";
  }
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

function cancellationError(): Error {
  const error = new Error("The plugin operation was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

async function downloadFileWithCancellation(
  item: ZoteroItemLike,
  registerSettlementBarrier: (settlement: Promise<void>) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  let request: { stop: (force?: boolean) => void } | undefined;
  let cancellationReason: Error | undefined;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (error: Error) => {
    if (cancellationReason) return;
    cancellationReason = error;
    try {
      request?.stop(true);
    } catch (stopError) {
      logError(stopError);
    }
    rejectCancellation(error);
  };
  const onAbort = () => cancel(cancellationError());
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () =>
      cancel(
        new Error(`Attachment download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`),
      ),
    DOWNLOAD_TIMEOUT_MS,
  );

  const download = Promise.resolve().then(() =>
    (Zotero.Sync.Runner.downloadFile as any)(item, {
      onStart: (startedRequest: { stop: (force?: boolean) => void }) => {
        request = startedRequest;
        if (cancellationReason) request.stop(true);
        // Zotero combines all onStart callback results as Storage.Result
        // instances, so the observer must return a neutral result.
        return new (Zotero.Sync.Storage as any).Result();
      },
    }),
  );
  const outcome = download.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

  try {
    const result = await Promise.race([outcome, cancellation]);
    if (!result.ok) throw result.error;
    return result.value;
  } catch (error) {
    if (error !== cancellationReason) throw error;
    // Zotero 9.0.6 storage backends do not always attach a cancellable channel
    // to Storage.Request. Return the user-facing timeout/abort promptly, but
    // retain a per-attachment barrier until the real request settles so a late
    // download can never race a later append operation.
    const settlement = (async () => {
      for (;;) {
        try {
          request?.stop(true);
        } catch (stopError) {
          logError(stopError);
        }
        const waiting = {};
        const settled = await Promise.race([
          outcome,
          new Promise<typeof waiting>((resolve) => setTimeout(() => resolve(waiting), 50)),
        ]);
        if (settled !== waiting) return;
      }
    })();
    registerSettlementBarrier(settlement);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function randomToken(): string {
  return `${Date.now()}-${Zotero.Utilities.randomString(8)}`;
}

function logError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}

async function markAttachmentForManualRecovery(item: ZoteroItemLike): Promise<void> {
  item.attachmentSyncState = "in_conflict";
  await item.saveTx({ skipAll: true });
}

async function nextAttachmentTitle(parent: ZoteroItemLike): Promise<string> {
  const existingTitles = new Set<string>();
  for (const id of parent.getAttachments?.(true) ?? []) {
    const child = (await Zotero.Items.getAsync(id)) as unknown as ZoteroItemLike | false;
    if (child) existingTitles.add(String(child.getField("title") ?? ""));
  }
  for (let index = 1; ; index += 1) {
    const title = `Sticky Notes ${index}.pdf`;
    if (!existingTitles.has(title)) return title;
  }
}

async function eraseQuietly(item: ZoteroItemLike | undefined): Promise<boolean> {
  if (!item?.eraseTx) return false;
  try {
    await item.eraseTx();
    return true;
  } catch (error) {
    logError(error);
    return false;
  }
}

export class NoteService {
  private readonly noteFileQueue = new SerialQueue<string>();
  private readonly downloadSettlementBarriers = new Map<string, Promise<void>>();

  private queueKey(item: ZoteroItemLike): string {
    return `${item.libraryID}:${item.key}`;
  }

  hasPendingFileOperation(item: ZoteroItemLike): boolean {
    const key = this.queueKey(item);
    return this.noteFileQueue.has(key) || this.downloadSettlementBarriers.has(key);
  }

  async waitForPendingFileOperations(item: ZoteroItemLike): Promise<void> {
    const key = this.queueKey(item);
    for (;;) {
      await this.noteFileQueue.waitForIdle(key);
      const download = this.downloadSettlementBarriers.get(key);
      if (download) await download;
      if (!this.noteFileQueue.has(key) && !this.downloadSettlementBarriers.has(key)) return;
    }
  }

  async waitForAllPendingFileOperations(): Promise<void> {
    for (;;) {
      const downloads = [...this.downloadSettlementBarriers.values()];
      await Promise.all([this.noteFileQueue.waitForAllIdle(), ...downloads]);
      if (this.downloadSettlementBarriers.size === 0) {
        await this.noteFileQueue.waitForAllIdle();
        if (this.downloadSettlementBarriers.size === 0) return;
      }
    }
  }

  withNoteFileLock<T>(item: ZoteroItemLike, task: () => Promise<T>): Promise<T> {
    return this.noteFileQueue.run(this.queueKey(item), task);
  }

  private registerDownloadSettlement(item: ZoteroItemLike, settlement: Promise<void>): void {
    const key = this.queueKey(item);
    const tracked = settlement.finally(() => {
      if (this.downloadSettlementBarriers.get(key) === tracked) {
        this.downloadSettlementBarriers.delete(key);
      }
    });
    this.downloadSettlementBarriers.set(key, tracked);
  }

  private async waitForDownloadSettlement(
    item: ZoteroItemLike,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const pending = this.downloadSettlementBarriers.get(this.queueKey(item));
    if (!pending) return;
    if (!signal) {
      await pending;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(cancellationError());
      };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  async createForAnnotation(
    sourceAttachment: ZoteroItemLike,
    annotation: ZoteroItemLike,
  ): Promise<ZoteroItemLike> {
    if (!sourceAttachment.parentID) {
      throw new Error("Source PDF has no parent bibliographic item");
    }
    const parent = (await Zotero.Items.getAsync(sourceAttachment.parentID)) as unknown as
      | ZoteroItemLike
      | false;
    if (!parent || parent.deleted) throw new Error("Parent bibliographic item is unavailable");
    const library = Zotero.Libraries.get(sourceAttachment.libraryID);
    if (
      !sourceAttachment.isEditable?.() ||
      !library ||
      !library.editable ||
      !library.filesEditable
    ) {
      throw new Error("The source attachment or its library is read-only");
    }

    const title = await nextAttachmentTitle(parent);
    const tempPath = PathUtils.join(
      PathUtils.tempDir,
      `zotero-pdf-sticky-notes-${randomToken()}.pdf`,
    );
    let noteAttachment: ZoteroItemLike | undefined;

    try {
      await IOUtils.write(tempPath, await createBlankNotePdf());
      noteAttachment = (await (Zotero.Attachments.importFromFile as any)({
        file: tempPath,
        parentItemID: parent.id,
        title,
        fileBaseName: title.replace(/\.pdf$/i, ""),
        contentType: "application/pdf",
        moveFile: true,
      })) as unknown as ZoteroItemLike;

      await linkStickyAndNote(annotation, noteAttachment);
      const verified = await resolveLinkedNote(annotation);
      if (verified.status !== "ok" || verified.item.id !== noteAttachment.id) {
        throw new Error(`Link verification failed (${verified.status})`);
      }
      await this.ensureLocalFile(noteAttachment, false);
      return noteAttachment;
    } catch (error) {
      const annotationRemoved = await eraseQuietly(annotation);
      const attachmentRemoved = await eraseQuietly(noteAttachment);
      if ((!annotationRemoved && annotation.id) || (noteAttachment && !attachmentRemoved)) {
        const rollbackError = new Error(
          `Sticky-note creation failed and cleanup was incomplete. Inspect annotation ${annotation.libraryID}/${annotation.key} and attachment ${noteAttachment?.libraryID ?? "unknown"}/${noteAttachment?.key ?? "unknown"}.`,
          { cause: error },
        );
        Zotero.logError(rollbackError);
        throw rollbackError;
      }
      throw error;
    } finally {
      try {
        if (await IOUtils.exists(tempPath)) {
          await IOUtils.remove(tempPath, { ignoreAbsent: true });
        }
      } catch (cleanupError) {
        logError(cleanupError);
      }
    }
  }

  async ensureLocalFile(
    item: ZoteroItemLike,
    tryDownload = true,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    await this.waitForDownloadSettlement(item, signal);
    throwIfAborted(signal);
    if (item.deleted) {
      throw new AttachmentUnavailableError("deleted", "The attachment item is deleted");
    }

    let path = await item.getFilePathAsync?.();
    throwIfAborted(signal);
    if (path && (await IOUtils.exists(path))) return path;

    const storageEnabled = Boolean(
      await Zotero.Sync.Storage.Local.getEnabledForLibrary(item.libraryID),
    );
    throwIfAborted(signal);
    if (tryDownload && storageEnabled) {
      try {
        await downloadFileWithCancellation(
          item,
          (settlement) => this.registerDownloadSettlement(item, settlement),
          signal,
        );
      } catch (error) {
        throw new AttachmentUnavailableError(
          "download-failed",
          "Downloading the attachment failed",
          { cause: error },
        );
      }
      throwIfAborted(signal);
      path = await item.getFilePathAsync?.();
      throwIfAborted(signal);
      if (path && (await IOUtils.exists(path))) return path;
      throw new AttachmentUnavailableError(
        "not-downloaded",
        "The attachment is not available on this device or the sync server",
      );
    }

    throw new AttachmentUnavailableError(
      storageEnabled ? "not-downloaded" : "missing",
      storageEnabled
        ? "The attachment has not been downloaded"
        : "The local attachment file is missing and file sync is disabled",
    );
  }

  async ensureReadablePdf(item: ZoteroItemLike, signal?: AbortSignal): Promise<string> {
    const path = await this.ensureLocalFile(item, true, signal);
    try {
      const pageCount = await getPdfPageCount(await zoteroFileOps.read(path));
      throwIfAborted(signal);
      if (pageCount < 1) throw new Error("The PDF has no pages");
      return path;
    } catch (error) {
      if (error instanceof AttachmentUnavailableError) throw error;
      throw new AttachmentUnavailableError(
        "unreadable",
        "The notes attachment exists but is not a readable PDF",
        { cause: error },
      );
    }
  }

  appendPage(noteAttachment: ZoteroItemLike, activeReader?: ReaderLike): Promise<number> {
    const queueKey = this.queueKey(noteAttachment);
    return this.noteFileQueue.run(queueKey, () =>
      withReaderOpeningPaused(noteAttachment.id, () =>
        withPDFWorkerSerialized(() =>
          withSyncPaused(async () => {
            const fresh = (await Zotero.Items.getByLibraryAndKeyAsync(
              noteAttachment.libraryID,
              noteAttachment.key,
            )) as unknown as ZoteroItemLike | false;
            if (!fresh || fresh.deleted) {
              throw new AttachmentUnavailableError("deleted", "The notes attachment was deleted");
            }
            const library = Zotero.Libraries.get(fresh.libraryID);
            if (!fresh.isEditable?.() || !library || !library.editable || !library.filesEditable) {
              throw new Error("The notes attachment or its library is read-only");
            }
            const path = await this.ensureLocalFile(fresh);
            const frozenReaders = new Set<ReaderLike>();
            const captureAndFreezeReaders = () => {
              const current = openReadersForItem(fresh.id);
              freezeReaders(current);
              for (const reader of current) frozenReaders.add(reader);
              return current;
            };
            let replacement: ReplacementHandle | undefined;
            let stateSaved = false;
            let rollbackPageIndex = 0;
            captureAndFreezeReaders();

            try {
              const flushedReaders = new Set<ReaderLike>();
              for (;;) {
                const unflushed = readerInstancesForItem(fresh.id).filter(
                  (reader) => !flushedReaders.has(reader),
                );
                if (unflushed.length === 0) break;
                for (const reader of unflushed) {
                  try {
                    await waitForReader(reader);
                  } catch (error) {
                    if (!readerInstancesForItem(fresh.id).includes(reader)) continue;
                    throw new Error(
                      "Another notes reader did not finish initializing; close it and retry adding the page",
                      { cause: error },
                    );
                  }
                  if (!readerInstancesForItem(fresh.id).includes(reader)) continue;
                  freezeReaders([reader]);
                  frozenReaders.add(reader);
                  await flushReaderAnnotations(reader);
                  flushedReaders.add(reader);
                }
              }
              let source: Uint8Array;
              try {
                source = await zoteroFileOps.read(path);
              } catch (error) {
                throw new AttachmentUnavailableError("unreadable", "Reading the notes PDF failed", {
                  cause: error,
                });
              }

              const result = await appendBlankPage(source);
              rollbackPageIndex = Math.max(0, result.addedPageIndex - 1);
              const expectedPages = result.pageCount;
              try {
                replacement = await replaceFileSafely(
                  zoteroFileOps,
                  path,
                  result.bytes,
                  randomToken(),
                  {
                    expectedOriginal: source,
                    validate: async (writtenPath) => {
                      const actualPages = await getPdfPageCount(
                        await zoteroFileOps.read(writtenPath),
                      );
                      if (actualPages !== expectedPages) {
                        throw new Error(
                          `Written PDF has ${actualPages} pages; expected ${expectedPages}`,
                        );
                      }
                    },
                  },
                );
              } catch (error) {
                if (error instanceof SafeReplaceError && error.manualRecoveryRequired) {
                  try {
                    await markAttachmentForManualRecovery(fresh);
                  } catch (stateError) {
                    throw new PageRecoveryError(
                      `Automatic PDF recovery failed and Zotero could not quarantine the attachment from sync (${String(stateError)}). Recovery copy: ${error.backupPath ?? "unavailable"}`,
                      error.backupPath ?? "unavailable",
                      { cause: error },
                    );
                  }
                }
                throw error;
              }

              const previousSyncState = fresh.attachmentSyncState;
              const previousLastProcessed = fresh.attachmentLastProcessedModificationTime;
              await Zotero.File.setNormalFilePermissions(path);
              const modificationTime = await fresh.attachmentModificationTime;
              if (!modificationTime)
                throw new Error("Could not read updated PDF modification time");
              fresh.attachmentLastProcessedModificationTime = Math.floor(modificationTime / 1000);
              fresh.attachmentSyncState = "to_upload";
              try {
                await fresh.saveTx({ skipAll: true });
              } catch (saveError) {
                let reloaded = false;
                try {
                  if (fresh.reload) {
                    await fresh.reload(["primaryData"], true);
                    reloaded = true;
                  }
                } catch (reloadError) {
                  logError(reloadError);
                }
                if (!reloaded) {
                  // DataObject.save() normally reloads after rollback, but its
                  // own recovery failure is swallowed. Restore safe cached
                  // values so a later unrelated save cannot persist to_upload
                  // metadata for the PDF that we are about to roll back.
                  if (previousSyncState !== undefined) {
                    fresh.attachmentSyncState = previousSyncState;
                  }
                  fresh.attachmentLastProcessedModificationTime = previousLastProcessed ?? null;
                }
                throw saveError;
              }
              stateSaved = true;
              try {
                await Zotero.Sync.Storage.Local.checkForUpdatedFiles(fresh.libraryID, [fresh.id]);
              } catch (error) {
                // The state was explicitly marked for upload above, so this secondary scan is best-effort.
                logError(error);
              }

              try {
                await reloadReaders(captureAndFreezeReaders(), activeReader, result.addedPageIndex);
              } catch (error) {
                throw new PageSavedRefreshError(
                  `The page was saved, but Zotero could not refresh the reader. Reopen the attachment. Recovery copy: ${replacement.backupPath}`,
                  replacement.backupPath,
                  { cause: error },
                );
              }

              await replacement.commit().catch(logError);
              replacement = undefined;
              return result.addedPageIndex;
            } catch (error) {
              if (replacement && !stateSaved) {
                const recovery = replacement;
                let rollbackQuarantinedPath: string | undefined;
                try {
                  rollbackQuarantinedPath = (await recovery.rollback()).quarantinedPath;
                  replacement = undefined;
                } catch (rollbackError) {
                  let syncStateError: unknown;
                  try {
                    await markAttachmentForManualRecovery(fresh);
                  } catch (error) {
                    syncStateError = error;
                  }
                  throw new PageRecoveryError(
                    `Adding the page failed (${String(error)}), and automatic recovery also failed (${String(rollbackError)}).${syncStateError ? ` Zotero could not mark the attachment as conflicted (${String(syncStateError)}).` : " The attachment was marked as conflicted to prevent automatic upload."} Recovery copy: ${recovery.backupPath}`,
                    recovery.backupPath,
                    { cause: rollbackError },
                  );
                }
                try {
                  await reloadReaders(captureAndFreezeReaders(), activeReader, rollbackPageIndex);
                } catch (refreshError) {
                  logError(refreshError);
                }
                if (rollbackQuarantinedPath) {
                  throw new SafeReplaceError(
                    `Adding the page failed (${String(error)}); the original PDF was restored, and a concurrently created file was preserved at ${rollbackQuarantinedPath}.`,
                    undefined,
                    false,
                    rollbackQuarantinedPath,
                    { cause: error },
                  );
                }
              }
              throw error;
            } finally {
              unfreezeReaders([...frozenReaders]);
            }
          }),
        ),
      ),
    );
  }

  clear(): void {
    this.noteFileQueue.clear();
  }
}

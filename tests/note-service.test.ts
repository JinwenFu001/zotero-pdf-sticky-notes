import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachmentUnavailableError, NoteService } from "../src/notes/note-service";
import type { ZoteroItemLike } from "../src/types";

afterEach(() => {
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

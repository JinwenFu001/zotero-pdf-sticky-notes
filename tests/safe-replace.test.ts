import { describe, expect, it } from "vitest";

import { replaceFileSafely, SafeReplaceError } from "../src/files/safe-replace";
import type { FileOps } from "../src/types";

class MemoryFileOps implements FileOps {
  readonly files = new Map<string, Uint8Array>();

  async exists(path: string) {
    return this.files.has(path);
  }
  async read(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error("missing");
    return value.slice();
  }
  async write(path: string, data: Uint8Array) {
    this.files.set(path, data.slice());
  }
  async copy(source: string, destination: string, _overwrite?: boolean) {
    this.files.set(destination, await this.read(source));
  }
  async move(source: string, destination: string, overwrite: boolean) {
    if (!overwrite && this.files.has(destination)) throw new Error("exists");
    const value = await this.read(source);
    this.files.set(destination, value);
    this.files.delete(source);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  parent(path: string) {
    return path.slice(0, path.lastIndexOf("/")) || "/";
  }
  filename(path: string) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  join(...parts: string[]) {
    return parts.join("/").replaceAll("//", "/");
  }
}

describe("replaceFileSafely", () => {
  it("keeps a recovery copy until commit", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const handle = await replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test");
    expect([...(await files.read("/notes.pdf"))]).toEqual([2]);
    expect(await files.exists(handle.backupPath)).toBe(true);
    await handle.commit();
    expect(await files.exists(handle.backupPath)).toBe(false);
  });

  it("can roll a successful replacement back", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const handle = await replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test");
    await handle.rollback();
    expect([...(await files.read("/notes.pdf"))]).toEqual([1]);
  });

  it("restores the original when validation fails", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    await expect(
      replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test", {
        validate: async () => {
          throw new Error("invalid PDF");
        },
      }),
    ).rejects.toBeInstanceOf(SafeReplaceError);
    expect([...(await files.read("/notes.pdf"))]).toEqual([1]);
  });

  it("keeps and reports the recovery copy when automatic restore fails", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const copy = files.copy.bind(files);
    files.copy = async (source, destination, overwrite) => {
      if (destination === "/notes.pdf") throw new Error("restore blocked");
      await copy(source, destination, overwrite);
    };

    await expect(
      replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test", {
        validate: async () => {
          throw new Error("validation failed");
        },
      }),
    ).rejects.toMatchObject({
      name: "SafeReplaceError",
      backupPath: "/.notes.pdf.test.backup",
      manualRecoveryRequired: true,
      quarantinedPath: "/.notes.pdf.test.failed",
      message: expect.stringContaining("Recovery copy: /.notes.pdf.test.backup"),
    });
    expect(await files.exists("/notes.pdf")).toBe(false);
    expect([...(await files.read("/.notes.pdf.test.backup"))]).toEqual([1]);
    expect([...(await files.read("/.notes.pdf.test.failed"))]).toEqual([2]);
  });

  it("refuses to overwrite a PDF changed after it was read", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([9]));

    await expect(
      replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test", {
        expectedOriginal: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/changed after it was read/);
    expect([...(await files.read("/notes.pdf"))]).toEqual([9]);
  });

  it("classifies an unreadable recovery copy as manual recovery", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const read = files.read.bind(files);
    files.read = async (path) => {
      if (path.endsWith(".backup")) throw new Error("backup cannot be read");
      return read(path);
    };

    await expect(
      replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test", {
        validate: async () => {
          throw new Error("validation failed");
        },
      }),
    ).rejects.toMatchObject({
      name: "SafeReplaceError",
      backupPath: "/.notes.pdf.test.backup",
      manualRecoveryRequired: true,
    });
    expect(await files.exists("/notes.pdf")).toBe(false);
    expect(await files.exists("/.notes.pdf.test.backup")).toBe(true);
    expect([...(await files.read("/.notes.pdf.test.failed"))]).toEqual([2]);
  });

  it("does not let temporary cleanup failure hide a successful replacement", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const exists = files.exists.bind(files);
    files.exists = async (path) => {
      if (path.endsWith(".tmp")) throw new Error("cleanup stat failed");
      return exists(path);
    };

    const handle = await replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test");
    expect([...(await files.read("/notes.pdf"))]).toEqual([2]);
    await handle.commit();
  });

  it("treats a verified restore as successful even when backup cleanup fails", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const remove = files.remove.bind(files);
    files.remove = async (path) => {
      if (path.endsWith(".backup")) throw new Error("cleanup remove failed");
      await remove(path);
    };

    await expect(
      replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test", {
        validate: async () => {
          throw new Error("invalid PDF");
        },
      }),
    ).rejects.toMatchObject({
      name: "SafeReplaceError",
      manualRecoveryRequired: false,
    });
    expect([...(await files.read("/notes.pdf"))]).toEqual([1]);
    expect(await files.exists("/.notes.pdf.test.backup")).toBe(true);
  });

  it("never deletes a target that changes while quarantine is attempted", async () => {
    const files = new MemoryFileOps();
    files.files.set("/notes.pdf", new Uint8Array([1]));
    const move = files.move.bind(files);
    files.move = async (source, destination, overwrite) => {
      if (destination.endsWith(".failed")) {
        files.files.set(source, new Uint8Array([9]));
        throw new Error("concurrent writer won the quarantine race");
      }
      await move(source, destination, overwrite);
    };

    await expect(
      replaceFileSafely(files, "/notes.pdf", new Uint8Array([2]), "test", {
        validate: async () => {
          throw new Error("invalid PDF");
        },
      }),
    ).rejects.toMatchObject({
      name: "SafeReplaceError",
      manualRecoveryRequired: true,
      backupPath: "/.notes.pdf.test.backup",
    });
    expect([...(await files.read("/notes.pdf"))]).toEqual([9]);
    expect([...(await files.read("/.notes.pdf.test.backup"))]).toEqual([1]);
  });
});

import type { FileOps } from "../types";

export class SafeReplaceError extends Error {
  constructor(
    message: string,
    readonly backupPath: string | undefined,
    readonly manualRecoveryRequired = false,
    readonly quarantinedPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SafeReplaceError";
  }
}

export interface ReplacementHandle {
  readonly backupPath: string;
  commit(): Promise<void>;
  rollback(): Promise<{ quarantinedPath?: string }>;
}

export interface SafeReplaceOptions {
  validate?: (path: string) => Promise<void>;
  expectedOriginal?: Uint8Array;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function restoreFromBackup(
  fileOps: FileOps,
  targetPath: string,
  backupPath: string,
  quarantinedPath: string,
  replacement: Uint8Array,
): Promise<{ restored: boolean; quarantinedPath?: string; error?: unknown }> {
  let backup: Uint8Array;
  try {
    backup = await fileOps.read(backupPath);
  } catch (error) {
    let quarantined: string | undefined;
    let recoveryError: unknown = error;
    try {
      if (await fileOps.exists(targetPath)) {
        await fileOps.move(targetPath, quarantinedPath, true);
        quarantined = quarantinedPath;
      }
    } catch (quarantineError) {
      recoveryError = quarantineError;
    }
    return { restored: false, quarantinedPath: quarantined, error: recoveryError };
  }
  let quarantined: string | undefined;
  let quarantinedIsPluginReplacement = false;
  try {
    if (await fileOps.exists(targetPath)) {
      try {
        quarantinedIsPluginReplacement = bytesEqual(await fileOps.read(targetPath), replacement);
      } catch {
        // Preserve an unreadable or externally replaced target for inspection.
      }
      try {
        await fileOps.move(targetPath, quarantinedPath, true);
        quarantined = quarantinedPath;
      } catch (error) {
        // A file can change between read() and move(). Never fall back to
        // remove(), even when the earlier read matched our replacement.
        return { restored: false, error };
      }
    }
    await fileOps.copy(backupPath, targetPath, false);
    if (!bytesEqual(await fileOps.read(targetPath), backup)) {
      throw new Error("The restored PDF differs from its recovery copy");
    }
  } catch (error) {
    // Do not remove a live target here: it may have been created concurrently
    // after the previous target was quarantined. The caller persists an
    // in-conflict sync state before releasing the sync pause.
    return { restored: false, quarantinedPath: quarantined, error };
  }

  // The copy-and-verify above is the recovery commit point. Cleanup must not
  // turn a successful restore into a manual-recovery error.
  try {
    await fileOps.remove(backupPath);
  } catch {
    // A redundant recovery copy is safe to leave behind.
  }
  if (quarantined && quarantinedIsPluginReplacement) {
    try {
      if (await fileOps.exists(quarantined)) await fileOps.remove(quarantined);
      quarantined = undefined;
    } catch {
      // Report the preserved path to the caller instead of reversing recovery.
    }
  }
  return { restored: true, quarantinedPath: quarantined };
}

export async function replaceFileSafely(
  fileOps: FileOps,
  targetPath: string,
  replacement: Uint8Array,
  token: string,
  options: SafeReplaceOptions = {},
): Promise<ReplacementHandle> {
  const parent = fileOps.parent(targetPath);
  const filename = fileOps.filename(targetPath);
  const temporaryPath = fileOps.join(parent, `.${filename}.${token}.tmp`);
  const backupPath = fileOps.join(parent, `.${filename}.${token}.backup`);
  const quarantinedPath = fileOps.join(parent, `.${filename}.${token}.failed`);
  let backupCreated = false;
  let installed = false;

  try {
    await fileOps.write(temporaryPath, replacement);
    // Renaming the current target out of the way closes the check/install race
    // inside this process and gives rollback the exact last on-disk version.
    await fileOps.move(targetPath, backupPath, false);
    backupCreated = true;
    if (
      options.expectedOriginal &&
      !bytesEqual(await fileOps.read(backupPath), options.expectedOriginal)
    ) {
      throw new Error("The notes PDF changed after it was read; refusing to overwrite it");
    }
    await fileOps.move(temporaryPath, targetPath, false);
    await options.validate?.(targetPath);
    installed = true;
  } catch (error) {
    if (!backupCreated) {
      try {
        if (await fileOps.exists(backupPath)) backupCreated = true;
      } catch (inspectionError) {
        throw new SafeReplaceError(
          `Replacing the PDF failed and the recovery copy could not be inspected: ${String(inspectionError)}. Possible recovery copy: ${backupPath}.`,
          backupPath,
          true,
          undefined,
          { cause: error },
        );
      }
    }
    if (backupCreated) {
      const recovery = await restoreFromBackup(
        fileOps,
        targetPath,
        backupPath,
        quarantinedPath,
        replacement,
      );
      if (!recovery.restored) {
        throw new SafeReplaceError(
          `Replacing the PDF failed and automatic restore also failed: ${String(recovery.error)}. Recovery copy: ${backupPath}.${recovery.quarantinedPath ? ` Quarantined file: ${recovery.quarantinedPath}.` : ""}`,
          backupPath,
          true,
          recovery.quarantinedPath,
          { cause: error },
        );
      }
      const quarantineNotice = recovery.quarantinedPath
        ? ` A concurrently created file was preserved at ${recovery.quarantinedPath}.`
        : "";
      throw new SafeReplaceError(
        `Replacing the PDF failed (${String(error)}); the original file was restored.${quarantineNotice}`,
        undefined,
        false,
        recovery.quarantinedPath,
        { cause: error },
      );
    }
    throw new SafeReplaceError(
      "Replacing the PDF failed before the original file was moved",
      undefined,
      false,
      undefined,
      { cause: error },
    );
  } finally {
    // Temporary-file cleanup is best-effort. In particular, an IO failure in
    // exists() must not hide the structured outcome of the replacement.
    try {
      if (await fileOps.exists(temporaryPath)) await fileOps.remove(temporaryPath);
    } catch {
      // A dot-prefixed temporary file is recoverable and never authoritative.
    }
  }

  if (!installed || !backupCreated) {
    throw new SafeReplaceError(
      "Replacing the PDF did not reach a recoverable state",
      undefined,
      true,
    );
  }

  let finished = false;
  return {
    backupPath,
    async commit() {
      if (finished) return;
      if (await fileOps.exists(backupPath)) await fileOps.remove(backupPath);
      finished = true;
    },
    async rollback() {
      if (finished) return {};
      if (!(await fileOps.exists(backupPath))) {
        throw new SafeReplaceError("The recovery copy is no longer available", undefined, true);
      }
      const recovery = await restoreFromBackup(
        fileOps,
        targetPath,
        backupPath,
        quarantinedPath,
        replacement,
      );
      if (!recovery.restored) {
        throw new SafeReplaceError(
          `Restoring the original PDF failed: ${String(recovery.error)}. Recovery copy: ${backupPath}.${recovery.quarantinedPath ? ` Quarantined file: ${recovery.quarantinedPath}.` : ""}`,
          backupPath,
          true,
          recovery.quarantinedPath,
        );
      }
      finished = true;
      return { quarantinedPath: recovery.quarantinedPath };
    },
  };
}

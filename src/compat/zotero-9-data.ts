import { TESTED_ZOTERO_VERSION } from "../constants";
import type { ZoteroItemLike } from "../types";

/**
 * Zotero 9.0.6's tag reload replaces cached values but does not clear the
 * corresponding dirty bit. Use its DataObject compatibility hook after a
 * rolled-back transaction has been reloaded from the database.
 */
export function clearRolledBackTagChanges(item: ZoteroItemLike): void {
  const clearChanged = (item as any)._clearChanged;
  if (typeof clearChanged !== "function") {
    throw new Error(
      `Zotero tag rollback hook is unavailable in ${Zotero.version}; ` +
        `tested with ${TESTED_ZOTERO_VERSION}`,
    );
  }
  clearChanged.call(item, "tags");
}

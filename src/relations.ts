import { MARKER_TAG_TYPE, NOTE_TAG, RELATION_PREDICATE, STICKY_TAG } from "./constants";
import { clearRolledBackTagChanges } from "./compat/zotero-9-data";
import type { ZoteroItemLike } from "./types";

function relations(item: ZoteroItemLike, predicate: string): string[] {
  try {
    return item.getRelationsByPredicate(predicate) ?? [];
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

function tags(item: ZoteroItemLike): string[] {
  try {
    return (item.getTags?.() ?? []).map(({ tag }) => tag);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

export function isPluginSticky(item: ZoteroItemLike | false | null | undefined): boolean {
  return Boolean(
    item &&
    (item.isAnnotation?.() ?? item.annotationType !== undefined) &&
    item.annotationType === "note" &&
    tags(item).includes(STICKY_TAG),
  );
}

export function isPluginNoteAttachment(item: ZoteroItemLike | false | null | undefined): boolean {
  return Boolean(
    item &&
    (item.isPDFAttachment?.() ?? item.attachmentContentType === "application/pdf") &&
    tags(item).includes(NOTE_TAG),
  );
}

export async function linkStickyAndNote(
  annotation: ZoteroItemLike,
  noteAttachment: ZoteroItemLike,
): Promise<void> {
  if (annotation.libraryID !== noteAttachment.libraryID) {
    throw new Error("Sticky annotation and note attachment must be in the same library");
  }

  await Promise.all(
    [annotation, noteAttachment].flatMap((item) => [
      item.loadDataType?.("relations"),
      item.loadDataType?.("tags"),
    ]),
  );

  if (typeof annotation.addTag !== "function" || typeof noteAttachment.addTag !== "function") {
    throw new Error("Zotero item tag API is unavailable");
  }

  const annotationURI = Zotero.URI.getItemURI(annotation as any);
  const noteURI = Zotero.URI.getItemURI(noteAttachment as any);

  const addedRelations: Array<[ZoteroItemLike, string, string]> = [];
  const changedTags: Array<{
    item: ZoteroItemLike;
    tag: string;
    previousType: number | undefined;
  }> = [];
  const add = (item: ZoteroItemLike, predicate: string, object: string) => {
    if (item.addRelation(predicate, object)) addedRelations.push([item, predicate, object]);
  };
  const addMarkerTag = (item: ZoteroItemLike, tag: string) => {
    const previous = item.getTags?.().find((candidate) => candidate.tag === tag);
    if (item.addTag?.(tag, MARKER_TAG_TYPE)) {
      changedTags.push({ item, tag, previousType: previous ? (previous.type ?? 0) : undefined });
    }
  };

  try {
    addMarkerTag(annotation, STICKY_TAG);
    add(annotation, RELATION_PREDICATE, noteURI);
    addMarkerTag(noteAttachment, NOTE_TAG);
    add(noteAttachment, RELATION_PREDICATE, annotationURI);
    await Zotero.DB.executeTransaction(async () => {
      await annotation.save({ skipSelect: true });
      await noteAttachment.save({ skipSelect: true });
    });
  } catch (error) {
    // save() updates Zotero.Relations' in-memory index before an enclosing
    // transaction commits. Explicitly undo only the pairs introduced here.
    for (const [item, predicate, object] of addedRelations) {
      try {
        item.removeRelation(predicate, object);
      } catch (removeError) {
        Zotero.logError(
          removeError instanceof Error ? removeError : new Error(String(removeError)),
        );
      }
      try {
        (Zotero as any).Relations.unregister("item", item.id, predicate, object);
      } catch (unregisterError) {
        Zotero.logError(
          unregisterError instanceof Error ? unregisterError : new Error(String(unregisterError)),
        );
      }
    }
    for (const { item, tag, previousType } of changedTags) {
      try {
        if (previousType === undefined) item.removeTag?.(tag);
        else item.addTag?.(tag, previousType);
      } catch (removeError) {
        Zotero.logError(
          removeError instanceof Error ? removeError : new Error(String(removeError)),
        );
      }
    }
    // A rolled-back transaction can still leave finalized relation values in
    // Zotero's loaded DataObject cache. Reload both before creation cleanup so
    // the current session agrees with the database.
    const reloadedItems = [annotation, noteAttachment];
    const reloads = await Promise.allSettled(
      reloadedItems.map((item) => item.reload?.(["relations", "tags"], true)),
    );
    for (let index = 0; index < reloads.length; index += 1) {
      const result = reloads[index];
      if (result.status === "rejected") {
        Zotero.logError(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
      } else {
        // Zotero 9.0.6's relation loader clears its dirty bit, while its tag
        // loader does not. The database is authoritative after rollback, so
        // clear the tag change left by the best-effort in-memory restoration.
        try {
          clearRolledBackTagChanges(reloadedItems[index]);
        } catch (clearError) {
          Zotero.logError(clearError instanceof Error ? clearError : new Error(String(clearError)));
        }
      }
    }
    throw error;
  }
}

export type LinkedNoteResolution =
  | { status: "ok"; item: ZoteroItemLike }
  | { status: "missing-relation" }
  | { status: "deleted" }
  | { status: "wrong-library" }
  | { status: "wrong-parent" }
  | { status: "invalid-target" };

export async function resolveLinkedNote(annotation: ZoteroItemLike): Promise<LinkedNoteResolution> {
  await Promise.all([annotation.loadDataType?.("relations"), annotation.loadDataType?.("tags")]);
  if (!isPluginSticky(annotation)) return { status: "invalid-target" };
  const targetURIs = relations(annotation, RELATION_PREDICATE);
  if (!targetURIs.length) {
    return { status: "missing-relation" };
  }
  if (targetURIs.length !== 1) return { status: "invalid-target" };

  let item: ZoteroItemLike | false;
  try {
    item = (await Zotero.URI.getURIItem(targetURIs[0])) as unknown as ZoteroItemLike | false;
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return { status: "invalid-target" };
  }
  if (!item || item.deleted) return { status: "deleted" };
  await Promise.all([item.loadDataType?.("relations"), item.loadDataType?.("tags")]);
  if (item.libraryID !== annotation.libraryID) return { status: "wrong-library" };
  const sourceAttachment = annotation.parentID
    ? ((await Zotero.Items.getAsync(annotation.parentID)) as unknown as ZoteroItemLike | false)
    : false;
  if (!sourceAttachment || item.parentID !== sourceAttachment.parentID) {
    return { status: "wrong-parent" };
  }
  if (!isPluginNoteAttachment(item) || !item.isStoredFileAttachment?.()) {
    return { status: "invalid-target" };
  }
  const annotationURI = Zotero.URI.getItemURI(annotation as any);
  if (!relations(item, RELATION_PREDICATE).includes(annotationURI)) {
    return { status: "invalid-target" };
  }
  return { status: "ok", item };
}

/**
 * Permanently erase the annotation while moving its recoverable PDF to the
 * Zotero Trash. Both database changes share one host transaction; the PDF
 * attachment itself is deliberately not erased because Zotero removes its
 * storage directory before a surrounding database rollback could restore it.
 */
export async function deleteStickyAndTrashNote(
  annotation: ZoteroItemLike,
  expectedNote: ZoteroItemLike,
): Promise<void> {
  const resolution = await resolveLinkedNote(annotation);
  if (
    resolution.status !== "ok" ||
    resolution.item.id !== expectedNote.id ||
    resolution.item.libraryID !== expectedNote.libraryID ||
    resolution.item.key !== expectedNote.key
  ) {
    throw new Error(`The sticky-note link changed before deletion (${resolution.status})`);
  }
  const note = resolution.item;
  const annotationURI = Zotero.URI.getItemURI(annotation as any);
  const reverseRelations = relations(note, RELATION_PREDICATE);
  if (reverseRelations.length !== 1 || reverseRelations[0] !== annotationURI) {
    throw new Error("The notes PDF is not linked exclusively to this sticky note");
  }
  const library = Zotero.Libraries.get(annotation.libraryID);
  if (
    !annotation.isEditable?.() ||
    !note.isEditable?.() ||
    !library ||
    !library.editable ||
    !library.filesEditable
  ) {
    throw new Error("The sticky note, notes PDF, or its library is read-only");
  }
  if (typeof annotation.erase !== "function") {
    throw new Error("Zotero's in-transaction annotation deletion API is unavailable");
  }

  const noteURI = Zotero.URI.getItemURI(note as any);
  const database = Zotero.DB as typeof Zotero.DB & {
    addCurrentCallback?: (type: "commit" | "rollback", callback: () => unknown) => void;
  };
  if (typeof database.addCurrentCallback !== "function") {
    throw new Error("Zotero's transaction outcome callback API is unavailable");
  }

  let committed = false;
  let mutationStarted = false;
  let recoveryFinished = false;
  const recoverRolledBackState = async () => {
    if (recoveryFinished) return;
    recoveryFinished = true;
    const reloads = await Promise.allSettled([
      annotation.reload?.(["primaryData", "relations", "tags"], true),
      note.reload?.(["primaryData", "relations", "tags"], true),
    ]);
    for (const result of reloads) {
      if (result.status === "rejected") {
        Zotero.logError(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
      }
    }
    // erase()/trash() can update Zotero.Relations' global index before the
    // surrounding SQLite transaction commits. A rollback restores the rows,
    // so restore the two already-validated pairs idempotently for this session.
    try {
      (Zotero as any).Relations.register("item", annotation.id, RELATION_PREDICATE, noteURI);
      (Zotero as any).Relations.register("item", note.id, RELATION_PREDICATE, annotationURI);
    } catch (registerError) {
      Zotero.logError(
        registerError instanceof Error ? registerError : new Error(String(registerError)),
      );
    }
  };

  try {
    await database.executeTransaction(async () => {
      // Register this before host item operations so it runs before any of
      // their commit callbacks. Zotero's transaction wrapper can reject after
      // SQLite has committed if a later commit callback throws.
      database.addCurrentCallback?.("commit", () => {
        committed = true;
      });
      database.addCurrentCallback?.("rollback", recoverRolledBackState);
      mutationStarted = true;
      await annotation.erase?.();
      await Zotero.Items.trash(note.id);
    });
  } catch (error) {
    if (committed) {
      // The requested deletion is durable. Do not report it as failed or
      // reconstruct relations that no longer exist just because a later host
      // commit callback failed.
      Zotero.logError(
        new Error("A Zotero commit callback failed after paired deletion was committed", {
          cause: error,
        }),
      );
      return;
    }
    // Real Zotero runs the temporary rollback callback above. This fallback
    // also covers test doubles or a future wrapper that rejects after rolling
    // back without dispatching that callback.
    if (mutationStarted) await recoverRolledBackState();
    throw error;
  }
}

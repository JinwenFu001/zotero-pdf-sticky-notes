import { NOTE_MARKER, RELATION_PREDICATE, STICKY_MARKER, TYPE_PREDICATE } from "./constants";
import type { ZoteroItemLike } from "./types";

function relations(item: ZoteroItemLike, predicate: string): string[] {
  try {
    return item.getRelationsByPredicate(predicate) ?? [];
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
    relations(item, TYPE_PREDICATE).includes(STICKY_MARKER),
  );
}

export function isPluginNoteAttachment(item: ZoteroItemLike | false | null | undefined): boolean {
  return Boolean(
    item &&
    (item.isPDFAttachment?.() ?? item.attachmentContentType === "application/pdf") &&
    relations(item, TYPE_PREDICATE).includes(NOTE_MARKER),
  );
}

export async function linkStickyAndNote(
  annotation: ZoteroItemLike,
  noteAttachment: ZoteroItemLike,
): Promise<void> {
  if (annotation.libraryID !== noteAttachment.libraryID) {
    throw new Error("Sticky annotation and note attachment must be in the same library");
  }

  await Promise.all([
    annotation.loadDataType?.("relations"),
    noteAttachment.loadDataType?.("relations"),
  ]);

  const annotationURI = Zotero.URI.getItemURI(annotation as any);
  const noteURI = Zotero.URI.getItemURI(noteAttachment as any);

  const addedRelations: Array<[ZoteroItemLike, string, string]> = [];
  const add = (item: ZoteroItemLike, predicate: string, object: string) => {
    if (item.addRelation(predicate, object)) addedRelations.push([item, predicate, object]);
  };
  add(annotation, TYPE_PREDICATE, STICKY_MARKER);
  add(annotation, RELATION_PREDICATE, noteURI);
  add(noteAttachment, TYPE_PREDICATE, NOTE_MARKER);
  add(noteAttachment, RELATION_PREDICATE, annotationURI);

  try {
    await Zotero.DB.executeTransaction(async () => {
      await annotation.save({ skipSelect: true });
      await noteAttachment.save({ skipSelect: true });
    });
  } catch (error) {
    // save() updates Zotero.Relations' in-memory index before an enclosing
    // transaction commits. Explicitly undo only the pairs introduced here.
    for (const [item, predicate, object] of addedRelations) {
      try {
        (Zotero as any).Relations.unregister("item", item.id, predicate, object);
      } catch (unregisterError) {
        Zotero.logError(
          unregisterError instanceof Error ? unregisterError : new Error(String(unregisterError)),
        );
      }
    }
    // A rolled-back transaction can still leave finalized relation values in
    // Zotero's loaded DataObject cache. Reload both before creation cleanup so
    // the current session agrees with the database.
    const reloads = await Promise.allSettled([
      annotation.reload?.(["relations"], true),
      noteAttachment.reload?.(["relations"], true),
    ]);
    for (const result of reloads) {
      if (result.status === "rejected") {
        Zotero.logError(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
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
  await annotation.loadDataType?.("relations");
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
  await item.loadDataType?.("relations");
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

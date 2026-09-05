import { PDFDocument } from "pdf-lib";

import { DEFAULT_PAGE_SIZE } from "../constants";

export interface PdfMutationResult {
  bytes: Uint8Array;
  pageCount: number;
  addedPageIndex: number;
  pageSize: readonly [number, number];
}

export async function createBlankNotePdf(
  pageSize: readonly [number, number] = DEFAULT_PAGE_SIZE,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle("Handwritten Notes");
  document.setCreator("Zotero PDF Sticky Notes");
  document.addPage([pageSize[0], pageSize[1]]);
  return document.save();
}

export async function appendBlankPage(source: Uint8Array): Promise<PdfMutationResult> {
  const document = await PDFDocument.load(source, { updateMetadata: false });
  const pages = document.getPages();
  const lastSize = pages.at(-1)?.getSize();
  const pageSize: readonly [number, number] = lastSize
    ? [lastSize.width, lastSize.height]
    : DEFAULT_PAGE_SIZE;

  document.addPage([pageSize[0], pageSize[1]]);
  const pageCount = document.getPageCount();
  return {
    bytes: await document.save(),
    pageCount,
    addedPageIndex: pageCount - 1,
    pageSize,
  };
}

export async function getPdfPageCount(source: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(source, { updateMetadata: false });
  return document.getPageCount();
}

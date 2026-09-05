import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { appendBlankPage, createBlankNotePdf, getPdfPageCount } from "../src/pdf/pdf-document";

describe("PDF note documents", () => {
  it("creates a one-page A4 PDF", async () => {
    const bytes = await createBlankNotePdf();
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 2);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(841.89, 2);
  });

  it("appends a blank page using the last page size and preserves old content", async () => {
    const original = await PDFDocument.create();
    const page = original.addPage([400, 300]);
    page.drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: rgb(1, 0, 0) });
    const before = await original.save();
    const beforeDocument = await PDFDocument.load(before);
    const beforeContent = (beforeDocument.getPage(0).node.Contents() as any)
      .lookup(0)
      .getContents();

    const result = await appendBlankPage(before);
    const after = await PDFDocument.load(result.bytes);
    const afterContent = (after.getPage(0).node.Contents() as any).lookup(0).getContents();
    expect(result.pageCount).toBe(2);
    expect(result.addedPageIndex).toBe(1);
    expect(after.getPage(0).getWidth()).toBe(400);
    expect(after.getPage(1).getWidth()).toBe(400);
    expect(after.getPage(1).getHeight()).toBe(300);
    expect(await getPdfPageCount(result.bytes)).toBe(2);
    expect(result.bytes.byteLength).toBeGreaterThan(200);
    expect([...afterContent]).toEqual([...beforeContent]);
  });

  it("rejects a damaged PDF without producing output", async () => {
    await expect(appendBlankPage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

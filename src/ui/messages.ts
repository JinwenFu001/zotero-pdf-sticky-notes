const messages = {
  en: {
    addSticky: "Add handwritten sticky note",
    addPage: "Add blank page",
    openNotes: "Open handwritten notes",
    placeHint: "Click a position on the PDF to place the handwritten sticky note.",
    placementExpired: "Sticky-note placement timed out. Choose Add handwritten sticky note again.",
    parentRequired:
      "This PDF is a standalone attachment. Attach it to a Zotero bibliographic item first; the new notes PDF will be stored under that same item.",
    parentUnavailable:
      "The parent bibliographic item is missing or in the trash. Restore it, or move the PDF under an available bibliographic item first.",
    created: "Handwritten notes PDF created.",
    createFailed: "The handwritten sticky note could not be created.",
    openFailed: "The linked handwritten notes PDF could not be opened.",
    targetDeleted: "The linked notes attachment has been deleted or no longer exists.",
    notDownloaded: "The linked notes PDF has not been downloaded on this device yet.",
    fileMissing: "The linked notes PDF file is missing or unreadable.",
    relationInvalid: "The sticky note link is missing or invalid.",
    addingPage: "Saving ink and adding a blank page…",
    pageAdded: "Blank page added.",
    pageFailed: "The blank page could not be added. Check the error details before retrying.",
    closeSaveFailed:
      "The notes window stayed open because Zotero could not confirm that the latest handwriting was saved. Check the error details, then retry closing it.",
    pageRecoveryFailed:
      "The blank page could not be added, and automatic recovery did not complete. Stop editing this attachment and keep the reported recovery copy.",
    pageSavedRefreshFailed:
      "The page was saved, but the reader could not refresh. Reopen the notes attachment.",
    sourceReadOnly: "This library or PDF is read-only.",
    noteReadOnly: "This notes PDF or its library is read-only; a page cannot be added.",
    readerUnsupported:
      "The tested Zotero 9.0.6 annotation interface is not ready or available. Close and reopen this PDF, then try again. No sticky note was created.",
  },
  zh: {
    addSticky: "添加手写便签",
    addPage: "添加空白页",
    openNotes: "打开手写笔记",
    placeHint: "请在 PDF 页面上的具体位置单击，以放置手写便签。",
    placementExpired: "便签放置已超时，请重新单击“添加手写便签”。",
    parentRequired:
      "当前 PDF 是独立附件。请先把它挂到一条 Zotero 文献记录下；新的笔记 PDF 会作为普通附件保存在同一条记录下。",
    parentUnavailable:
      "当前 PDF 的父文献记录缺失或位于回收站。请先恢复父记录，或将 PDF 移到另一条可用文献记录下。",
    created: "手写笔记 PDF 已创建。",
    createFailed: "无法创建手写便签。",
    openFailed: "无法打开关联的手写笔记 PDF。",
    targetDeleted: "关联的笔记附件已删除或已不存在。",
    notDownloaded: "关联的笔记 PDF 尚未下载到这台设备。",
    fileMissing: "关联的笔记 PDF 文件缺失或无法读取。",
    relationInvalid: "便签关联缺失或无效。",
    addingPage: "正在保存笔迹并添加空白页…",
    pageAdded: "空白页已添加。",
    pageFailed: "无法添加空白页。请检查错误详情后再重试。",
    closeSaveFailed:
      "笔记窗口仍保持打开，因为 Zotero 无法确认最新笔迹已经保存。请检查错误详情后再尝试关闭。",
    pageRecoveryFailed:
      "无法添加空白页，且自动恢复未完成。请停止编辑该附件，并保留错误详情中列出的恢复副本。",
    pageSavedRefreshFailed: "页面已经保存，但阅读器刷新失败。请重新打开笔记附件。",
    sourceReadOnly: "当前文献库或 PDF 为只读。",
    noteReadOnly: "当前笔记 PDF 或其文献库为只读，无法添加页面。",
    readerUnsupported:
      "Zotero 9.0.6 的批注接口尚未就绪或无法访问。请关闭并重新打开当前 PDF 后重试；本次未创建便签。",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

export function message(key: MessageKey): string {
  const locale = String(Zotero.locale ?? Services.locale?.appLocaleAsBCP47 ?? "en");
  return locale.toLowerCase().startsWith("zh") ? messages.zh[key] : messages.en[key];
}

export function alertError(
  parent: Window | null | undefined,
  key: MessageKey,
  error?: unknown,
): void {
  let detailText = error instanceof Error ? error.message : error ? String(error) : "";
  if (error instanceof Error && error.cause && error.cause !== error) {
    const causeText = error.cause instanceof Error ? error.cause.message : String(error.cause);
    if (causeText && causeText !== detailText) detailText += `\nCause: ${causeText}`;
  }
  const details = detailText ? `\n\n${detailText}` : "";
  Zotero.alert((parent ?? undefined) as Window, "Zotero PDF Sticky Notes", message(key) + details);
}

export function showStatus(key: MessageKey): void {
  try {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("Zotero PDF Sticky Notes");
    progress.addDescription(message(key));
    progress.show();
    progress.startCloseTimer(2500);
  } catch {
    Zotero.debug(`[Zotero PDF Sticky Notes] ${message(key)}`);
  }
}

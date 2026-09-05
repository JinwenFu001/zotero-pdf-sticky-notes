# 架构说明

## 范围

第一版只实现一条核心流程：在原文 PDF 中创建带持久标识的原生便签批注，由该便签打开
同一父文献下的独立笔记 PDF，并使用 Zotero 原生阅读器手写及在 PDF 末尾增加空白页。

插件不维护自有绘图画布、不把笔迹直接写入 PDF，也不实现页面插入、删除、重排或模板。

## 版本基线

- 目标及唯一允许版本：Zotero 9.0.6
- 本机 Zotero BuildID：20260707110915
- Gecko：140.12.0（BuildID 20260609153453）
- 阅读器实现依据：本机应用包与对应 Zotero 9.0.6 源码

manifest 的 `strict_min_version` 和 `strict_max_version` 均为 `9.0.6`，运行时也执行完全相同
的版本检查。扩展兼容范围前，必须重新核对源码并执行全部客户端测试。

## 核心不变量

1. 原文便签和笔记附件必须属于同一个 Zotero library。
2. 笔记附件与原文附件必须拥有同一个父文献条目。
3. 笔记必须是普通 stored-file PDF attachment。
4. 一个插件便签只指向一个笔记附件。
5. 修改 PDF 前必须完成当前原生批注保存。
6. 同一笔记的加页操作必须串行。
7. 旧页面索引不得改变，因此第一版只向末尾追加。
8. 普通删除便签、停用或卸载插件不得删除笔记附件。

## 数据所有权和模型

```text
Bibliographic item
├── Source PDF attachment
│   └── Zotero note annotation
│       ├── Zotero tag → zotero-pdf-sticky-notes:sticky:v1
│       └── dc:relation → note attachment Zotero item URI
└── Notes PDF attachment
    ├── Zotero tag → zotero-pdf-sticky-notes:note:v1
    └── dc:relation → annotation Zotero item URI
```

便签的页码和坐标由 Zotero 原生 note annotation 保存。笔记附件是 Zotero 管理的普通 PDF；
空白页面位于 PDF 文件，ink annotation 位于 Zotero 数据库。

Zotero item URI 编码 library 归属和稳定 item key。附件标题不是关联主键，因此重命名附件
不应破坏关系。打开目标前仍验证：

- annotation 和 attachment 处于同一 library；
- note attachment 与 source attachment 处于同一父文献；
- 目标带有插件 note marker；
- 目标是 stored-file PDF attachment；
- 条目未删除且附件文件可读。

关系元数据和附件同步是否能完整往返尚为 `NOT RUN`。

## 模块职责

| 模块                            | 职责                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| `src/plugin.ts`                 | 生命周期、工具栏入口、放置状态、notifier、用户流程协调             |
| `src/compat/zotero-9-reader.ts` | Zotero 9.0.6 阅读器私有 API、单击、窗口、open/保存屏障、冻结和刷新 |
| `src/compat/zotero-9-data.ts`   | Zotero 9.0.6 条目事务回滚后的 tag dirty-state 兼容处理             |
| `src/relations.ts`              | 类型标识、双向 URI 关联和关联解析                                  |
| `src/notes/note-service.ts`     | 创建附件、部分失败回滚、文件可用性检查、加页事务                   |
| `src/pdf/pdf-document.ts`       | 创建空白 PDF、追加页面和页数校验                                   |
| `src/files/safe-replace.ts`     | 临时文件、恢复副本、commit/rollback                                |
| `src/files/zotero-file-ops.ts`  | 将通用文件操作映射到 Zotero 的 IOUtils/PathUtils                   |
| `src/core/serial-queue.ts`      | 按 `libraryID:itemKey` 串行化同一笔记操作                          |
| `src/ui/messages.ts`            | 中英文状态和错误消息                                               |

## 创建流程

```text
用户进入放置模式
→ Zotero 创建原生 note annotation
→ item notifier 捕获新 annotation
→ 检查父条目和编辑权限
→ 在临时目录创建一页空白 PDF
→ importFromFile 创建 Zotero 管理附件
→ 在数据库事务中写双向关系
→ 重新解析关系并检查本地文件
→ 成功
```

创建的附件依次命名为 `Sticky Notes 1.pdf`、`Sticky Notes 2.pdf` 等，避免覆盖同一父条目下
已有标题。

失败时只回滚本次新建的便签和附件。关系事务回滚后，显式撤销本次写入的 marker tag 和在
`Zotero.Relations` 全局索引中的注册，再重载两个条目的 relations/tags 缓存，避免数据库、
索引与当前会话的 DataObject 状态不一致。若 Zotero 拒绝删除其中一项，则向用户报告并记录
annotation 和 attachment 标识，避免把不完整清理静默当作成功。正常用户删除便签时不删除
笔记附件。

无父条目的原文会在进入放置模式前被拒绝。只读条目或 `filesEditable = false` 的 library 也
会被拒绝。

放置状态以 source attachment ID 为键，有效期 60 秒。兼容层从
`reader._iframeWindow.wrappedJSObject._reader` 取得 Zotero 的实际 reader，选择原生 note
工具，并在 PDF view 的原生 capture listener 之后监听同一次 `pointerdown`/`mousedown`。
Zotero 同步写入 `_annotationManager._annotations` 后，插件以放置前后的 ID 差集取得唯一的
annotation key；它不再跨 Gecko compartment 覆写 `setTool` 或 `addAnnotation`。notifier 只有
同时匹配该 key 和 reader instance ID 才会创建笔记附件。用户切换工具会取消捕获，避免把
普通原生便签误认成插件便签。超时会清除 pending state、切回 pointer 工具并显示提示。

## 打开流程

```text
左键短按插件便签
→ 兼容层从阅读器选择状态定位 annotation
→ 验证插件 marker
→ 解析 Zotero item URI
→ 验证 library / parent / stored PDF / delete state
→ 获取本地文件，必要时请求 Zotero 下载
→ Zotero.Reader.open(..., { openInWindow: true })
→ 调整新窗口尺寸和位置
→ 激活原生批注即时保存与关闭保护
```

左键激活要求一次短按移动不超过 5 像素，并且命中当前唯一选中的插件便签。监听逻辑不拦截
未带插件 marker 的普通便签。右键“打开手写笔记”是辅助入口。

窗口初始目标尺寸为 760 × 680 像素，并根据可用屏幕范围缩小。窗口复用、移动、缩放、位于
原文前方以及关闭后焦点回原文均需在 `Z-07` 中验证，目前为 `NOT RUN`。

## 本地文件可用性

打开或加页前按照以下顺序检查：

1. 条目是否已删除；
2. `getFilePathAsync()` 是否返回存在的本地文件；
3. 当前 library 是否启用 Zotero storage sync；
4. 可下载时调用 Zotero 的文件下载流程；
5. 区分下载失败、尚未下载、本地缺失和不可读取。

插件不以空白 PDF 替换缺失目标，也不在关系损坏时自动猜测其他附件。

Zotero 9.0.6 的部分 storage backend 没有给 `Storage.Request.stop()` 设置可停止的 channel。
因此超时或插件停用时，用户流程会立即收到取消结果，但 note service 保留该附件的
settlement barrier；底层下载真正 resolve/reject 前，后续打开或加页不得读取或替换这个
附件，插件停用屏障也不会释放兼容层。极端情况下这会延迟停用，但不会允许晚到的下载覆盖
加页结果。

## 手写保存

插件不实现自有绘图或手势代码。墨迹、擦除和撤销均由 Zotero native ink annotation 处理。
笔记阅读器打开后，兼容层把该 reader 的 annotation saving debounce 切为立即保存，并在关闭
时检查未保存集合。Zotero 9.0.6 的 host 保存桥不会把保存 rejection 传回 iframe，因此兼容层
同时锁存保存期间意外进入只读状态。Zotero 的擦除回调也不会被 annotation manager await；
兼容层跟踪该 host Promise，使加页、关闭和 reload 都等待擦除事务，并传播失败；卡死事务
在 15 秒后作为失败返回，避免保存屏障永久挂起。

如果关闭时仍有保存任务或未保存 annotation，close guard 会冻结 reader、触发保存并在成功
后重新关闭。对标签式 reader，guard 直接包装 `ReaderTab.close()`，在 Zotero 移除内部输入
监听器之前执行屏障；同时保护 `Zotero_Tabs.close/unload` 等其他关闭入口。保存失败时解除
冻结、保持窗口并显示错误。该行为目前为 `NOT RUN`。

## 加页事务

```text
进入该附件的 serial queue
→ 阻止同一 item 启动新的 Zotero.Reader.open
→ 等待此前已启动的 reader open 完成
→ 进入 Zotero 原生 PDFWorker 全局队列
→ 等待当前 Zotero sync
→ 阻止新 sync 开始
→ freeze 所有同附件 reader
→ flush 原生 annotation manager
→ 读取 PDF
→ pdf-lib 在末尾追加页面
→ 同目录写临时文件
→ 原子重命名原文件为 recovery copy
→ 比较 recovery copy 与读取时字节，拒绝并发覆盖
→ 安装临时文件为目标文件
→ 重新读取并验证页数
→ 更新权限、mtime 和 attachment sync state
→ reload 所有 reader
→ 活动 reader 跳到新页
→ 删除 recovery copy
→ unfreeze
```

串行队列键为 `libraryID:itemKey`。同一附件的连续加页严格按顺序执行；不同笔记不会共享
队列阻塞。一次失败不会污染该键后续任务。

兼容层从插件 startup 起包装 `Zotero.Reader.open`，按 item ID 跟踪尚未完成的 open。进入
加页事务后先安装该 item 的 blocker，再等待此前已经启动但尚未进入 `_readers` 的 open；
等待超过 15 秒时加页安全失败，不继续替换文件。随后把完整的保存、读取、替换、附件状态
更新和 reader reload 临界区通过 Zotero 9.0.6 的 `PDFWorker._enqueue(..., true)` 加入原生全局
队列。原生旋转、删页或导入先完成，插件才读取其结果并加页；插件完成前，后续原生变换也
不能基于旧字节覆盖新页。操作结束后释放等待中的 reader open。

只向末尾增加页面，使旧页面的 page index 保持不变，因而不会主动改变已有 Zotero annotation
的页码引用。初始 PDF 是 A4；追加页沿用最后一页尺寸。

## 文件替换和恢复

安全替换在目标 PDF 所在目录中使用：

- `.<filename>.<token>.tmp`：待写入文件；
- `.<filename>.<token>.backup`：恢复副本。
- `.<filename>.<token>.failed`：必要时隔离的失败或并发文件。

流程先写临时文件，再把原文件在同目录原子重命名为恢复副本。恢复副本必须与此前读取的
源字节完全一致，才会安装临时文件；安装后重新读取并验证页数。

- 写入或验证失败：尽量自动恢复原文件。
- 文件在读取后发生变化：拒绝覆盖，恢复最新原文件。
- 自动恢复失败：保留 `.backup`，隔离 `.failed`，并把附件持久标记为 `in_conflict`，防止
  Zotero 自动上传不可信目标。
- Zotero 附件状态保存失败：回滚 PDF，并刷新旧阅读器状态。
- PDF 与 Zotero 状态已经保存，但 reader reload 失败：保留新文件及恢复副本，报告
  `PageSavedRefreshError`，要求用户重开附件。
- 全部成功：删除恢复副本。

更新附件同步字段前会保存旧缓存值。`saveTx()` 失败时优先重载 `primaryData`；如果 Zotero
自己的恢复重载也失败，则显式写回旧的 sync state 与 last-processed mtime，避免后续无关
保存把已回滚 PDF 错误标成待上传。

“恢复副本已经写回且逐字节校验通过”是恢复的 commit point。之后删除 `.backup`、清理
`.failed` 或临时文件均为 best-effort，清理失败不会把已经成功的恢复误报为数据恢复失败；
遗留路径会在可用时随错误返回，供用户检查。

纯文件替换分支已有单元测试；真实 Zotero 文件、权限、同步和 reader reload 分支仍为
`NOT RUN`。

## 同步协调

加页前等待正在运行的 Zotero sync，随后使用 sync runner 的 indefinite delay 在文件和附件
状态更新期间阻止新同步开始。写入成功后：

- 读取新文件 modification time；
- 更新 `attachmentLastProcessedModificationTime`；
- 把 `attachmentSyncState` 设为 `to_upload`；
- 调用 Zotero storage updated-file 检查。

这表明实现接入 Zotero 的同步状态机，但不构成同步支持声明。双 profile 往返仍为
`NOT RUN`。

桌面 XPI 不会在 Zotero iOS/iPadOS 客户端运行。普通 stored-file 笔记 PDF 和 Zotero 原生
ink annotation 属于可同步的数据形态，因此设计目标包括“Mac 创建、iPad 从同一文献的附件
列表打开并书写、Mac 再打开”的伴随流程；真实设备往返仍为 `NOT RUN`。iPad 上的便签单击
跳转和 PDF 加页需要 iOS 客户端原生支持，不由本兼容层提供。

## 兼容边界

以下版本敏感访问集中在 `src/compat/zotero-9-reader.ts`：

- `_iframeWindow.wrappedJSObject._reader`（`_internalReader` 仅作旧环境/测试 fallback）
- `_primaryView` / `_secondaryView`
- `pointerEventToPosition`
- `getSelectableAnnotations`
- `selectedAnnotationIDs`
- `_annotationManager`
- `_annotations`
- `_unsavedAnnotations`
- `_savingInProgress`
- `_triggerSaving`
- `_skipAnnotationSavingDebounce`
- `_onDeleteAnnotations`
- `setReadOnly`
- `setTool`
- Reader `_readers`
- `Zotero.Reader.open`（启动期 active-open 监控与按 item 加页屏障）
- `Zotero.PDFWorker._enqueue`（与原生 PDF 文件变换共用写入队列）
- `freeze` / `unfreeze` / `reload` / `navigate`
- reader `_window`
- 主窗口 `Zotero_Tabs.close` / `unload`
- sync runner `delayIndefinite`
- `Components.utils.cloneInto` / `exportFunction` 跨 reader iframe 边界

`src/compat/zotero-9-data.ts` 另集中封装 Zotero 9.0.6 的
`DataObject._clearChanged("tags")`：该版本的 tag loader 在事务回滚后会替换缓存值，但不会像
relation loader 一样清除 dirty bit。

阅读器 toolbar/context-menu event、notifier、attachment import、relations 和 IOUtils 等调用也应
随目标 Zotero 版本重新核对，但私有 reader 状态是首要兼容风险。

## 生命周期

启动时注册 reader toolbar、annotation context menu 和 item notifier。停用时：

- 注销 notifier；
- 注销 reader event listener；
- 移除 pointer 和 close 监听器；
- 恢复 annotation manager 原 debounce 配置；
- 恢复保存、擦除及 view lifecycle 的内部 wrapper；移除放置事件监听和工具状态 timer；
- 恢复 `Zotero.Reader.open` 和 reader/tab close wrapper；
- 移除工具栏节点；
- 取消放置定时器并切回 pointer；
- 清空 pending placement 和 serial queue。

停用和卸载逻辑不清理或删除用户条目、文件、批注或 relation。该生命周期结果仍须通过
`Z-22` 和 `Z-23` 验证。

## 重要术语

| 中文            | 推荐英文                            |
| --------------- | ----------------------------------- |
| 文献记录/父条目 | bibliographic item / parent item    |
| 子附件          | child attachment                    |
| Zotero 管理附件 | stored-file attachment              |
| 链接附件        | linked-file attachment              |
| 附件条目        | attachment item                     |
| 附件文件        | attachment file                     |
| 便签批注        | note annotation / sticky annotation |
| 手写批注        | ink annotation                      |
| 条目标识        | item key                            |
| 条目 URI        | Zotero item URI                     |
| 关系谓词        | relation predicate                  |
| 数据同步        | data sync                           |
| 附件/文件同步   | storage sync / file sync            |
| 同步往返        | sync round trip                     |
| 保存屏障        | save barrier                        |
| 刷新前强制保存  | flush pending annotations           |
| 防抖保存        | debounced saving                    |
| 同目录临时文件  | same-directory temporary file       |
| 恢复副本        | recovery copy                       |
| 安全替换        | safe replacement                    |
| 回滚/提交       | rollback / commit                   |
| 按附件串行      | per-attachment serialization        |
| 兼容适配层      | compatibility adapter               |
| 内部/私有 API   | internal/private API                |
| 含批注 PDF      | annotated PDF                       |
| 已检测          | detected                            |
| 已源码核对      | source-reviewed                     |
| 已自动测试      | automatically tested                |
| 已客户端验证    | client-verified                     |

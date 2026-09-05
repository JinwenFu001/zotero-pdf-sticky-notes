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
8. Zotero 原生删除便签、停用或卸载插件不得删除笔记附件；只有用户
   在插件右键菜单中明确确认“删除两者”，才永久擦除便签并将笔记 PDF 移入
   Zotero 回收站。

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

条目对象可能只加载了 primary data。判定 marker 或读取 relation 前显式加载 `tags` 和
`relations`；读取附件标题前加载 `itemData`；枚举父条目附件前加载 `childItems`。
这些加载失败都作为真实失败处理，不会用未加载的空集合继续创建、打开或删除。

关系元数据和附件同步是否能完整往返尚为 `NOT RUN`。

## 模块职责

| 模块                            | 职责                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| `src/plugin.ts`                 | 生命周期、工具栏/右键入口、放置状态、notifier、用户确认与流程协调  |
| `src/compat/zotero-9-reader.ts` | Zotero 9.0.6 阅读器私有 API、单击、窗口、open/保存屏障、冻结和刷新 |
| `src/compat/zotero-9-data.ts`   | Zotero 9.0.6 条目事务回滚后的 tag dirty-state 兼容处理             |
| `src/relations.ts`              | 类型标识、双向 URI 关联、关联解析、独占性校验和成对删除事务        |
| `src/notes/note-service.ts`     | 创建/删除协调、编号、部分失败清理、文件可用性检查、加页事务        |
| `src/pdf/pdf-document.ts`       | 创建空白 PDF、追加页面和页数校验                                   |
| `src/files/safe-replace.ts`     | 临时文件、恢复副本、commit/rollback                                |
| `src/files/zotero-file-ops.ts`  | 映射 IOUtils/PathUtils，并把跨 realm 读取结果复制到插件 realm      |
| `src/core/serial-queue.ts`      | 按 `libraryID:itemKey` 串行化笔记文件或父条目生命周期操作          |
| `src/ui/messages.ts`            | 中英文状态和错误消息                                               |

## 创建流程

```text
用户进入放置模式
→ Zotero 创建原生 note annotation
→ item notifier 捕获新 annotation
→ 检查父条目和编辑权限
→ 进入父条目生命周期队列
→ 懒加载 childItems 及现有附件的 itemData
→ 取未进回收站附件标题中的最小空缺编号
→ 在临时目录创建一页空白 PDF
→ importFromFile 创建 Zotero 管理附件
→ 在数据库事务中写双向关系
→ 重新解析关系并检查本地文件
→ 成功
```

编号不是单调计数器。插件先显式加载父条目的 `childItems`，再加载每个未进
回收站子附件的 `itemData`，并选择 `Sticky Notes N.pdf` 中的最小未用正整数。
因此活动的孤立 PDF 仍会占号，成对删除将 PDF 移入回收站后会释放该号；以后恢复
旧 PDF 时可能出现同名附件，但 URI 关联不依赖标题。同一父条目下的创建、成对删除和
编号分配共用父条目队列，避免并发创建选中同一编号。

创建流程的父条目及子附件允许处于 Zotero 懒加载的 cold-cache 状态；需要
`getAttachments()`、标题、tag 或 relation 前都先请求对应 data type，而不把未加载误判为空值。

任意创建步骤失败时，只清理本次新建的便签和附件。即使在父条目或编号元数据加载
时就失败，刚由 Zotero 创建的便签也必须擦除。只有确认便签已擦除后才永久删除新建 PDF；
如果 Zotero 拒绝清理便签，PDF 必须保留并在错误中报告两者标识，避免主动制造不可恢复的
断链。关系事务回滚后，显式撤销本次写入的 marker tag 和在
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

创建事务成功后会立即进入同一打开流程；以后可从便签再次触发。

## 打开流程

```text
首次创建完成，或左键短按插件便签
→ 兼容层从 annotation DOM 的 data-annotation-id 定位条目
→ 验证插件 marker
→ 解析 Zotero item URI
→ 验证 library / parent / stored PDF / delete state
→ 获取本地文件，必要时请求 Zotero 下载
→ Zotero.Reader.open(..., { openInWindow: true })
→ 调整新窗口尺寸和位置
→ 激活原生批注即时保存与关闭保护
```

左键激活要求一次短按移动不超过 5 像素。Zotero 9.0.6 对 note icon 提供
`data-annotation-id`；兼容层只接受这一本次事件路径中的精确标识，不复用先前的阅读器选择
状态。解析条目并检查插件 marker 之后才关闭原生 popup 和打开附件，所以未带 marker 的
普通便签保持原生行为。右键“打开手写笔记”是辅助入口。

窗口初始目标尺寸为 760 × 680 像素，并根据可用屏幕范围缩小。窗口复用、移动、缩放、位于
原文前方以及关闭后焦点回原文均需在 `Z-07` 中验证，目前为 `NOT RUN`。

## 成对删除

Zotero 原生 Delete/Backspace 路径不由插件拦截：它删除便签，但默认保留笔记 PDF。
成对操作只从插件便签的右键菜单进入，并使用默认选中“取消”的明确确认框。

```text
用户右键插件便签并选择成对删除
→ 懒加载 relation/tag/itemData，解析唯一双向关联
→ 显示默认取消的确认框
→ 进入父条目生命周期队列
→ 按 library/key 重新取得便签和 PDF，重验 ID、父条目、编辑权限和独占反向关联
→ 进入该 PDF 的文件队列，阻止新 reader open 并等待既有 open/下载屏障
→ freeze 并 flush 每个已打开的笔记 reader
→ 同一 Zotero 数据库事务内 annotation.erase() + Zotero.Items.trash(noteID)
→ unfreeze 并显示结果
```

便签会永久擦除；PDF 附件和它的原生手写数据移入 Zotero 回收站，清空回收站前
可恢复。恢复 PDF 不会恢复已擦除的便签或自动重建关联。不对 PDF 执行 `erase()`，
因为 Zotero 可能在外层事务回滚前已删除其 storage directory，数据库回滚无法恢复该文件。

成对删除在第一项条目改动前注册 transaction commit/rollback callback，用实际 SQLite 结果
区分“真正回滚”和“已提交后某个 host commit callback 报错”。只有真正回滚才执行
恢复：Zotero 的嵌套条目保存可能已经从 `Zotero.Relations` 全局索引移除双向关系，
因此此时重载两个条目的 primary data/relations/tags，重新注册事前已验证的两条
relation，并由 note service 重载 source/父条目的 `childItems` 缓存。如果数据库已提交，
后续 host callback 异常只记录日志；该删除仍视为成功，不能重建已删除的 relation，也不能
向用户误报“删除失败”。
真实 Zotero 回收站、窗口和同步行为仍为 `NOT RUN`。

## 本地文件可用性

打开或加页前按照以下顺序检查：

1. 条目是否已删除；
2. `getFilePathAsync()` 是否返回存在的本地文件；
3. 当前 library 是否启用 Zotero storage sync；
4. 可下载时调用 Zotero 的文件下载流程；
5. 区分下载失败、尚未下载、本地缺失和不可读取。

在 Zotero 9.0.6 中，`IOUtils.read()` 返回的 `Uint8Array` 属于特权全局的 JavaScript realm。
打包在插件 realm 的 `pdf-lib` 使用 `instanceof Uint8Array` 检查输入，因此会拒绝这种字节，
并用其类型格式化逻辑误报为 `NaN`。`zotero-file-ops` 在文件边界用插件 realm 的
`new Uint8Array(bytes)` 复制一次。打开前可读性检查和加页均只把这个归一化结果交给
`pdf-lib`，文件本身不会因为 realm 转换被改写。

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
同时锁存保存期间意外进入只读状态。

Zotero 的 annotation manager 每次保存都会调用删除 dispatcher，即使删除列表为空，
而且不会 await chrome 侧删除回调。这个 `_onDelete` 的 ID 数组和返回值属于 reader realm；
从特权回调枚举其 Xray 参数会触发 `Permission denied to access property "length"`，跨
compartment 的 host Promise 也不是可靠的完成信号。0.1.3 不再包装、读取或同化 `_onDelete`，
它的参数、返回值和原生调用顺序完全交还 Zotero。

为了仍能确认已持久化 ink 的擦除，兼容层观察 chrome `Reader.annotationItemIDs`。
Zotero 9.0.6 将它创建为可写且可配置的 own data property；兼容层只在该 descriptor 精确
匹配时安装可恢复的 getter/setter，从更新前后的数字 item ID 集合取差集。对每个消失 ID，
使用 `Zotero.Items.getAsync(id, { noCache: true })` 等待数据库条目不再存在。未首次保存就完全
擦除的新 ink 没有 item ID，不会伪造屏障。加页、关闭和 reload 都等待已观察到的擦除；
15 秒仍未完成时安全失败，避免永久挂起。如果属性 descriptor 与 9.0.6 预期不符，
兼容层不修改它，也不干扰 Zotero 原生保存。如果阅读器内部 manager 被替换，则清除旧
pending/failure 状态、恢复 descriptor 并重新绑定；普通 page reload 不会伪造一次 manager 替换。

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
- PDF annotation DOM `data-annotation-id` / `Event.composedPath()`
- `_annotationManager`
- `_annotations`
- `_unsavedAnnotations`
- `_savingInProgress`
- `_triggerSaving`
- `_skipAnnotationSavingDebounce`
- chrome `Reader.annotationItemIDs` own-property descriptor
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

annotation manager `_onDelete` 是已核对但刻意不接入的 Zotero 内部边界：插件不包装、
读取或等待它，防止把 reader-realm 参数或返回值带入插件 compartment。

`src/compat/zotero-9-data.ts` 另集中封装 Zotero 9.0.6 的
`DataObject._clearChanged("tags")`：该版本的 tag loader 在事务回滚后会替换缓存值，但不会像
relation loader 一样清除 dirty bit。
成对删除另依赖 `Zotero.DB.addCurrentCallback`、annotation `erase()` 和
`Zotero.Items.trash()` 区分真实 transaction outcome，扩大兼容范围前也必须重新核对。

阅读器 toolbar/context-menu event、notifier、attachment import、relations 和 IOUtils 等调用也应
随目标 Zotero 版本重新核对，但私有 reader 状态是首要兼容风险。

## 生命周期

启动时注册 reader toolbar、annotation context menu 和 item notifier。停用时：

- 注销 notifier；
- 注销 reader event listener；
- 移除 pointer 和 close 监听器；
- 恢复 annotation manager 原 debounce 配置；
- 恢复 `setReadOnly` 及 view lifecycle 的内部 wrapper，并恢复原始
  `Reader.annotationItemIDs` descriptor；移除放置事件监听和工具状态 timer；
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

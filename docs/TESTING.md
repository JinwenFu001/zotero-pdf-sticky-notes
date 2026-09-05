# 测试与验收

本文档区分不启动 Zotero 的自动检查、源码核对和真实客户端验收。原型只有在对应客户端
用例实际通过后，才能对外声称支持相关功能。

## 结果标记

- `PASS`：已在所列环境中实际执行，结果符合预期。
- `FAIL`：已执行，但结果不符合预期。
- `BLOCKED`：因已记录的环境或依赖条件无法执行。
- `NOT RUN`：尚未执行。
- `SOURCE REVIEW`：仅核对源码或接口，不代表运行通过。
- `AUTOMATED`：不启动 Zotero 的自动化测试。

`SOURCE REVIEW` 和 `AUTOMATED` 都不能替代 Zotero 客户端验收。

## 当前环境记录

- 检测日期：2026-09-05
- macOS：15.6.1（Build 24G90）
- Zotero：9.0.6
- Zotero BuildID：20260707110915
- Gecko：140.12.0（BuildID 20260609153453）
- 插件版本：0.1.0
- XPI：`dist/zotero-pdf-sticky-notes-0.1.0.xpi`
- XPI SHA-256：`79ef37874c436d2b92e5736e0a43349cdbcaba6cdbc37f93308f724aa6f26d7a`
- 客户端测试 profile：尚未创建或使用
- 测试文献库：尚未创建
- Zotero 数据同步：`NOT RUN`
- Zotero 文件同步：`NOT RUN`

本机 Zotero 版本检测和源码核对没有修改或使用用户的默认 Zotero profile。

## 已执行的自动检查

| ID           | 类型        | 覆盖内容                                            | 结果   |
| ------------ | ----------- | --------------------------------------------------- | ------ |
| UT-PDF-01    | `AUTOMATED` | 创建一页 A4 空白 PDF                                | `PASS` |
| UT-PDF-02    | `AUTOMATED` | 追加页面时沿用末页尺寸并保留已有页面内容            | `PASS` |
| UT-PDF-03    | `AUTOMATED` | 损坏 PDF 被拒绝且不产生输出                         | `PASS` |
| UT-FILE-01   | `AUTOMATED` | 安全替换在 commit 前保留恢复副本                    | `PASS` |
| UT-FILE-02   | `AUTOMATED` | 已完成替换可 rollback                               | `PASS` |
| UT-FILE-03   | `AUTOMATED` | 写后校验失败时恢复原文件                            | `PASS` |
| UT-FILE-04   | `AUTOMATED` | 自动恢复失败时保留并报告 recovery copy              | `PASS` |
| UT-FILE-05   | `AUTOMATED` | 拒绝覆盖读取后被并发修改的 PDF                      | `PASS` |
| UT-FILE-06   | `AUTOMATED` | recovery copy 不可读时进入人工恢复状态              | `PASS` |
| UT-FILE-07   | `AUTOMATED` | 临时文件清理失败不覆盖已成功的安全替换结果          | `PASS` |
| UT-FILE-08   | `AUTOMATED` | 原文件恢复验证成功后，清理失败不误报恢复失败        | `PASS` |
| UT-FILE-09   | `AUTOMATED` | 隔离竞争中不删除被外部再次替换的目标文件            | `PASS` |
| UT-QUEUE-01  | `AUTOMATED` | 同一附件操作严格串行                                | `PASS` |
| UT-QUEUE-02  | `AUTOMATED` | 一次失败不阻塞后续操作                              | `PASS` |
| UT-QUEUE-03  | `AUTOMATED` | 不同附件可独立推进                                  | `PASS` |
| UT-QUEUE-04  | `AUTOMATED` | 50 个快速连续操作不重叠且结果顺序完整               | `PASS` |
| UT-QUEUE-05  | `AUTOMATED` | 快速队列中前项失败后后项继续执行                    | `PASS` |
| UT-QUEUE-06  | `AUTOMATED` | 单附件 idle barrier 会等待随后排入的任务            | `PASS` |
| UT-QUEUE-07  | `AUTOMATED` | shutdown barrier 等待所有附件队列清空               | `PASS` |
| UT-REL-01    | `AUTOMATED` | 正确解析同库、同父条目、双向关联                    | `PASS` |
| UT-REL-02    | `AUTOMATED` | 拒绝缺失或多目标的便签关联                          | `PASS` |
| UT-REL-03    | `AUTOMATED` | 拒绝跨 library 或跨父条目目标                       | `PASS` |
| UT-REL-04    | `AUTOMATED` | 要求 stored PDF、插件 marker 和反向关联             | `PASS` |
| UT-REL-05    | `AUTOMATED` | 区分已删除的目标附件                                | `PASS` |
| UT-REL-06    | `AUTOMATED` | 在单一数据库事务中写入双向关联                      | `PASS` |
| UT-REL-07    | `AUTOMATED` | 写入前拒绝跨 library 关联                           | `PASS` |
| UT-REL-08    | `AUTOMATED` | 损坏的 Zotero item URI 被归类为无效关联             | `PASS` |
| UT-REL-09    | `AUTOMATED` | 关联事务回滚后重载两个条目的关系缓存                | `PASS` |
| UT-COMPAT-01 | `AUTOMATED` | 检测只读 reader 静默拒绝 note tool                  | `PASS` |
| UT-COMPAT-02 | `AUTOMATED` | 放置操作捕获本次原生便签的精确 key                  | `PASS` |
| UT-COMPAT-03 | `AUTOMATED` | 用户切换工具时取消插件放置状态                      | `PASS` |
| UT-COMPAT-04 | `AUTOMATED` | 锁存 Zotero 仅以只读状态暴露的 host 保存失败        | `PASS` |
| UT-COMPAT-05 | `AUTOMATED` | 保存屏障等待 Zotero 未 await 的擦除事务             | `PASS` |
| UT-COMPAT-06 | `AUTOMATED` | 擦除事务失败向加页/关闭屏障传播                     | `PASS` |
| UT-COMPAT-07 | `AUTOMATED` | reader reload 后重绑且停用时不残留嵌套 wrapper      | `PASS` |
| UT-COMPAT-08 | `AUTOMATED` | 独立笔记窗口关闭前 flush 未保存笔迹                 | `PASS` |
| UT-COMPAT-09 | `AUTOMATED` | 关闭时保存失败则保持窗口并报告                      | `PASS` |
| UT-COMPAT-10 | `AUTOMATED` | barrier 期间被选中的 reader tab 不被自动卸载        | `PASS` |
| UT-COMPAT-11 | `AUTOMATED` | 工具栏初始化前已发生的 editable-reader 保存失败锁存 | `PASS` |
| UT-COMPAT-12 | `AUTOMATED` | ReaderTab.close 的宿主副作用前执行保存屏障          | `PASS` |
| UT-COMPAT-13 | `AUTOMATED` | 加页前阻止新 reader open 并等待既有 open 完成       | `PASS` |
| UT-COMPAT-14 | `AUTOMATED` | 卡死的擦除事务在保存屏障中超时而非永久挂起          | `PASS` |
| UT-COMPAT-15 | `AUTOMATED` | 卡死的既有 reader open 使加页安全失败而非继续替换   | `PASS` |
| UT-COMPAT-16 | `AUTOMATED` | 插件文件变换排在 Zotero 原生 PDFWorker 操作之后     | `PASS` |
| UT-NET-01    | `AUTOMATED` | 下载取消后，文件访问及停用屏障等待原请求结束        | `PASS` |
| STATIC-01    | 静态检查    | TypeScript `tsc --noEmit`                           | `PASS` |
| BUILD-01     | 构建检查    | XPI 根目录包含 manifest、bootstrap、bundle 和许可证 | `PASS` |
| BUILD-02     | 构建检查    | XPI 不包含 `node_modules` 或未替换模板变量          | `PASS` |
| BUILD-03     | 构建检查    | manifest/package 版本一致，兼容范围锁定为 9.0.6     | `PASS` |
| BUILD-04     | 构建检查    | `pdf-lib` 已进入运行时 bundle                       | `PASS` |

执行命令：

```bash
npm run typecheck
npm test
npm run build
```

结果摘要：TypeScript 类型检查通过；Vitest 共有 6 个测试文件、45 项测试，全部通过；XPI
已生成并通过 `scripts/validate-xpi.mjs`。

这些结果证明纯 TypeScript/PDF/文件替换/队列逻辑和静态包结构符合当前断言，不证明
Zotero 内部 API 可以在 GUI 中正常工作。

## 客户端测试安全要求

1. 退出日常使用的 Zotero。
2. 创建独立 Zotero 测试 profile 和独立数据目录。
3. 只使用可丢弃的测试文献、原文和测试同步库。
4. 安装本次构建的 XPI，并记录其 SHA-256。
5. 打开 Zotero Debug Output Logging，并在每个失败用例后保存日志。
6. 不要在默认 profile、唯一副本或重要同步库中模拟文件缺失和写入失败。

## 客户端验收矩阵

当前以下项目全部为 `NOT RUN`。

| ID   | 场景           | 核心预期                                                   | 状态      |
| ---- | -------------- | ---------------------------------------------------------- | --------- |
| Z-01 | 安装和启动     | 9.0.6 能安装；无启动错误；工具栏入口出现                   | `NOT RUN` |
| Z-02 | 完整主流程     | 放置便签、单击打开、手写、加页、继续手写、关闭、重开均正确 | `NOT RUN` |
| Z-03 | 重启持久性     | 重启后同一便签仍打开正确附件，页数与笔迹存在               | `NOT RUN` |
| Z-04 | 多便签及多文献 | 同文献多个便签、不同文献便签分别打开正确笔记               | `NOT RUN` |
| Z-05 | 坐标和原文状态 | 缩放、滚动和窗口调整后便签位置正确；原文状态不被改变       | `NOT RUN` |
| Z-06 | 原生便签隔离   | 普通便签保持 Zotero 原有交互                               | `NOT RUN` |
| Z-07 | 窗口行为       | 笔记窗口较小、可移动缩放、重复点击复用、关闭后焦点回原文   | `NOT RUN` |
| Z-08 | 原生手写工具   | 画笔、擦除、撤销、重做、翻页和缩放正常                     | `NOT RUN` |
| Z-09 | 快速保存       | 刚写完立即加页、刚写完立即关闭、连续加页不丢内容           | `NOT RUN` |
| Z-10 | 多窗口协调     | 同一笔记存在多个阅读器视图时加页串行且均刷新               | `NOT RUN` |
| Z-11 | 重命名         | 重命名笔记附件后原便签仍打开同一附件                       | `NOT RUN` |
| Z-12 | 直接打开附件   | 从附件列表打开笔记，页数及原生笔迹完整                     | `NOT RUN` |
| Z-13 | 删除便签       | 删除便签后笔记附件保留并可直接打开                         | `NOT RUN` |
| Z-14 | 删除目标附件   | 单击原便签时显示明确的目标已删除错误                       | `NOT RUN` |
| Z-15 | 未下载附件     | 可下载时取得文件；下载失败时错误明确                       | `NOT RUN` |
| Z-16 | 文件缺失       | 测试文件缺失时显示明确错误，不创建空壳或覆盖数据           | `NOT RUN` |
| Z-17 | 保存失败       | 使用一次性测试副本模拟不可写，原 PDF 或恢复副本完好        | `NOT RUN` |
| Z-18 | 创建部分失败   | 不留下看似成功但实际无目标的插件便签                       | `NOT RUN` |
| Z-19 | 无父条目       | 阻止创建并说明笔记将归属于哪条记录                         | `NOT RUN` |
| Z-20 | 只读文献库     | 阻止创建且不留下部分数据                                   | `NOT RUN` |
| Z-21 | 导出           | “文件 → 另存为…”所得 PDF 在独立阅读器中显示所有页面和笔迹  | `NOT RUN` |
| Z-22 | 停用           | UI/监听器消失；笔记附件和原生笔迹仍可读取                  | `NOT RUN` |
| Z-23 | 卸载           | 重启后数据仍可读取，插件功能不再介入                       | `NOT RUN` |
| Z-24 | 同步往返       | 两个独立 profile 间关系、附件、重命名、笔迹和加页正确往返  | `NOT RUN` |

## 关键用例步骤

### Z-02/Z-03：完整流程和重启

1. 在测试文献记录下添加 `Original.pdf`。
2. 打开原文，记录页码、滚动位置和缩放。
3. 选择“添加手写便签”，在明确位置放置。
4. 确认同一父文献下出现一页笔记 PDF。
5. 单击便签，确认打开较小的独立 Zotero 阅读器窗口。
6. 在第一页写下可辨认的 `P1`，测试擦除、撤销和重做。
7. 立即单击“添加空白页”，确认显示第二页。
8. 在第二页写下 `P2`，立即关闭窗口。
9. 再次单击同一便签，确认两页和两处笔迹都存在。
10. 关闭并重启 Zotero，再次确认关联、页数和笔迹。
11. 检查原文页码、滚动和缩放是否保持。

至少记录：原文和便签截图、附件列表截图、两页笔迹截图、重开及重启截图、Debug Output。

### Z-04：映射隔离

1. 在文献 A 创建两个便签 A1、A2，在文献 B 创建便签 B1。
2. 分别在三个笔记 PDF 写入唯一标识。
3. 以不同顺序重复单击三个便签。
4. 确认每个便签只打开自己的附件，并且 A1/A2 都属于文献 A、B1 属于文献 B。

### Z-09：快速保存

分别测试：

- 写完最后一笔后立即加页；
- 写完最后一笔后立即关闭；
- 连续快速单击三次加页；
- 加页处理中尝试关闭窗口；
- 操作完成后重开并重启。

每次都检查旧页面、最后一笔、最终页数及 Zotero 错误日志。

### Z-16/Z-17：故障恢复

只在可丢弃的测试 profile 中操作。先关闭相关阅读器并备份测试附件，再模拟文件被移走或
不可写。检查插件是否明确报错、原文件或恢复副本是否存在，以及 UI 是否没有显示虚假成功。
测试结束后恢复文件权限和测试附件。

### Z-21：导出

1. 在第一页画圆，在新增页画三角形。
2. 等待保存后选择“文件 → 另存为…”。
3. 将输出保存到 Zotero 存储目录之外。
4. 使用 macOS“预览”打开输出文件。
5. 确认页数、圆和三角形均可见。
6. 记录导出文件大小、SHA-256 和截图。

仅在此项为 `PASS` 后，README 才能写“已验证导出包含手写内容”。

### Z-22/Z-23：停用和卸载

停用插件并重启 Zotero，确认工具栏入口消失，但笔记附件仍可从附件列表打开，已有页面和
原生笔迹仍存在。随后卸载插件并再次重启、检查。不要把“源码没有删除逻辑”当作测试通过。

### Z-24：同步往返

使用两个独立 profile 或两台设备，且在同一 Zotero 账户中启用数据和附件同步：

1. A 创建便签和笔记并完成同步。
2. B 同步、下载附件，从便签打开并检查关联。
3. B 重命名笔记附件，书写并加页，然后同步。
4. A 再次同步并检查标题、关系、页数和笔迹。
5. 交换 A/B 再执行一轮，检查失败和冲突提示。

关系解析、附件下载、标题变更、页数及笔迹必须全部通过，才能对外声称支持同步。

## 单项结果记录模板

```md
### Z-XX — 场景名称

- 日期：
- 环境：
- XPI SHA-256：
- 前置状态：
- 实际步骤：
- 预期结果：
- 实际结果：
- 状态：PASS / FAIL / BLOCKED
- 截图或日志：
- 发现的问题：
```

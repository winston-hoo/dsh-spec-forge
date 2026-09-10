# Changelog

本插件锁定目标 dsh 版本：`@deepseek-ai/dsh` 0.1.x（developer preview，API 可能有破坏性变更）。
兼容性以实际安装的 profile 依赖树为准。

## 0.4.0 — 2026-09-10

成本归因驱动的「少追问、少烧 token」版本。起因是一次真实会话（youting，620K 日志、482 事件）被逐事件解码后，发现一次简单的需求花了 1.41 元调度费且需返工。归因结论：**插件只占约 4% 成本，整读大文件才是大头（≈50%）**；但插件确实存在「简单需求被反复追问」的体验问题。本版把两类问题一起治。

### P0-1 大文件纪律（治成本大头）

- 系统提示段新增第 3 条：`>20K` 字符的文件禁止整文件 read，先 `grep` 定位再分段读；确需整读先落要点摘要。
- `SKILL.md` 新增「大文件纪律」章节（5 条：禁用整读 / 读后落摘要 / 不预扫工作区 / grep 优先 / 长 HTML 只读目标区段），并写入硬规则第 4 条。

### P0-2 L1 快速通道扩容（治「简单需求被追问」）

- `classifyComplexity` 新增 `fastTrack` 字段（`level===1` 时为 `true`），所有返回分支都带上。
- 新增「带参考物的自包含新建」识别：需求含 `新建/做一个/实现…页面|组件|弹窗|表单|列表页|详情页|卡片|视图` **且**含 `参考/参照/仿照/按照/对标/类似/依据/基于` 时 → L1 fastTrack。典型：「参考现有列表页新建一个订单页」。
- `spec_recall` 返回值新增 `level` 与 `fastTrack`，命中快速通道时在注入文本顶部插入「禁止追问；跳过 spec_triage 与 spec_distill」的显式指令。
- 修复一处会**吃掉快速通道收益**的 DDL 误判：原 `建[…]{0,15}表` 会把「新建订单**列表页**」「搜索**表单**组件」「**报表**页面」里的"表"当成建表信号判成 L3。改为带前后视断言 `(?<![列报图])表(?!单|格|头|尾|示|现|明|演|决|情|面|率|白|达|盘|针|带|记|稿|述|扬|层)`，真 DDL（新建订单表 / 建表 t_user / 新增数据库）仍判 L3。

### P0-3 默认只在 L3 追问（治「教条式追问」）

- `triageRequirement.needsClarify` 从「L2/L3 都问」改为：**仅 L3 问**；L2 一律「按报告默认值执行」。
- 保留一道**安全阀**：`tooShort && 缺失≥2 维 && 零推断锚点` 时 `unactionable=true`，L2 也允许**一次性**问清核心（否则「帮我改一下那个查询」这类空需求盲目套默认值必然返工）。新增 `unactionable` 字段对外暴露。
- `renderStandardReport` 重构：L3 出「先问后查」完整 Grill-me；L2 安全阀出「L2 信息不足：先确认核心」（含"不要反复追问""提问前禁止文件类工具"）；L2 可自举出「已按默认执行」+ 推断值清单。`levelBadge` 三态化。
- `spec_triage` 的 `questions` 仅在 `needsClarify=true` 时回传，避免 L2 场景被误当成待澄清。

### P1-4 工具合并 6 → 5

- `spec_store` 并入 `spec_library`：新增 `action` 参数（`list` 默认 / `info` / `migrate`）与 `move` 参数；原 `spec_store` 逻辑抽成 `runStoreAction()`。
- 收益：常驻工具定义减少约 480 token/请求；对外工具面收敛为一个「模板库」入口。

### P1-6 系统提示段重写与压缩

- 12 行历史文案（含残留乱码字符）重写为 11 行结构化路由规则，新增 fastTrack 分支、L2 安全阀、大文件纪律三处。
- 实测：575 字符 ≈ 358 token/请求（预算 ≤450），较 0.3.2 的 600 字符基线在**增加内容**的前提下反而更短。
- `scripts/token-audit.js`：常驻段预算改为动态判定（≤450 通过，超出标 ⚠️）。

### 测试与文档

- 测试：148 → **158**。新增 `fastTrack` 全分支、自包含新建、裸新建落 L2、DDL 真信号不误伤、DDL 复合词防误伤共 7 个用例；`render.test.js` 按新语义重写 L2/安全阀相关 6 个用例。
- `README.md`：链路图、等级表、L2 语义、工具表（5 个）、新增「成本：它花多少，大头在哪」章节、验收步骤与已知边界同步。
- `skills/spec-forge/SKILL.md`：第 2/3/4 步语义、L1/L2/L3 约定、硬规则 1–10 全部对齐。

### 兼容性

- 工具面变更：调用过 `spec_store` 的脚本/提示词需改调 `spec_library({ action: 'info' | 'migrate' })`。
- `spec_recall` 返回值新增字段（向后兼容）；`spec_triage` 在 L2 可自举时不再返回问题清单（行为变更）。
- 存储路径、模板格式、打分算法均未变动，已有模板库无需迁移。

---

## 0.3.3 — 2026-09-07

### 新增：模板库跟随工作区（解决跨盘 EPERM）

- **症状**：很多用户的 dsh 工作区在 D/E 盘（如 `D:\document\novels`），但插件的模板库默认写 `$HOME/.dsh/spec-forge/`（C 盘）。dsh 的 `workspace-write` 沙箱会拒绝跨盘写，需要用户手动把插件权限提到全权限（截图里 HaoJun 的反馈就是这个）。
- **方案**：新增 `storageRoot` 配置字段，取值 `'workspace'`（默认，跟 `<启动 dsh 的 cwd>/.dsh-spec-forge/`）/ `'home'`（兼容 0.3.2 默认）/ 留空 → 旧行为。`storageHome` 绝对路径仍保留作为显式覆盖（优先级最高）。
- **新增工具 `spec_store`**：查询当前模式 / 跨盘判定 / 旧路径数据量；`migrate` 操作可把 `$DSH_HOME/spec-forge/{global, projects/<cwd-hash>}` 一次性复制（同名文件跳过不覆盖，可选 `move: true` 删源）到当前数据目录。
- **新工具 helper**：`lib/store.js` 新增 `resolveStorageRoot()` 解析函数、`isCrossDrive()` 跨盘判定、`copyTree()` 递归复制（同名跳过）、`bumpWriteEpoch()` 让 `spec_store` 拷贝文件后强制让进程内读缓存失效。
- **向后兼容**：旧用户升级后 `storageRoot` 默认改为 `workspace`，**旧 `$DSH_HOME/spec-forge` 数据**留在原处不自动迁移；调 `spec_store({ action: 'info' })` 看一眼，调 `spec_store({ action: 'migrate' })` 一次性拷过去。
- 测试：138 → 148。新增 `resolveStorageRoot` / `STORAGE_MODES` / `isCrossDrive` / `copyTree` / `bumpWriteEpoch` 共 10 个用例。

### 行为变更

- 旧默认路径 `$DSH_HOME/spec-forge` 不再是默认**新装**用户的目标（仅当用户显式设置 `storageRoot: 'home'` 时使用）。
- system prompt 路由段描述不变（该段不涉及存储路径）。

---

## 0.3.2 — 2026-09-05

代码审查驱动的健壮性 & 性能修复（配合 README 去公式化重写），并回应 token 消耗验证结论。

### 新增：查询侧关键词聚焦（提高命中余量）

- **症状**：真实用户需求往往很长（带路径、叙述、寒暄），`fingerprint()` 默认 24 个 token 里一多半是权重 1 的中文 2-gram，压低余弦与覆盖率；跨仓库（无同仓库加分）时容易跌破 0.35 阈值。同一条「管理页加 isMainAdmin 开关字段」需求，浓缩表述命中而原话（85 字）只在阈值边缘。
- **修复**：新增 `focusFingerprint()`（lib/fingerprint.js）：查询指纹削掉低信号 2-gram 尾巴（权重≥2 的强 token 全保留 + 最多 8 个 2-gram 兜底中文表述），只作用于查询侧、不碰落盘模板指纹。`buildQueryFp`（spec_recall/spec_triage 共用）统一应用。
- **实证（真实模板库，含仓库/标签/分类全加分）**：原话长需求总分 0.462 → 0.510（gram 上限 8）；无关需求 0.105 不变，无误召回。审计脚本按真实接线测量后，3 个仓库中 2 个默认阈值命中。

### 精简：常驻系统提示段与工具描述

- 常驻系统提示段 `spec-forge:routing`：873 字符 ≈603 tok → **615 字符 ≈407 tok**（删冗余句式，硬规则全部保留）。
- `spec_triage` / `spec_retro` 工具描述精简（完整判据仍在 SKILL.md 与报告正文，不依赖描述里的长文）。
- 五个工具定义合计 ≈2364 → ≈2250 tok/完整请求；固定税 ≈2967 → ≈2657 tok/完整请求。

### 修复（spec_retro：假成功、坏指纹、摘要没接线）

- **`saved: true` 硬编码**：模板写盘失败会静默返回"已保存"。现在写盘包 try/catch，失败返回
  `saved: false` + 错误信息 + 重试指引，不再向上冒泡崩溃 dsh。
- **指纹引用了参数表里不存在的 `args.requirement`**（恒 undefined）：指纹只有 name/trigger/tags
  三个来源，丢掉了真实做过的 approach。现改为 `name + trigger + tags + approach + digest前300字`
  五源拼接。
- **`buildRetroDigest` 只 import 没调用**：描述里承诺的"digest 留空自动提取"从未实现。现接入
  `exec.agent.session` 事件流自动提取摘要，`prompt` 为空时回退到 digest。

### 修复（召回打分一致性 & 失真）

- `spec_triage` 的模板排序仍用裸 `fingerprint()`，tags/category 加分没接上（0.3.1 只修了
  `spec_recall`）。现抽出 `buildQueryFp()` 统一两处查询指纹。
- `spec_recall` 记命中前只排 top-N：热度排序在小库上失真。改为全量排序后取 top 再注入。
- 标签重叠从 jaccard 改为**覆盖率**（交集/模板标签数）：查询侧标签上限 8 个会撑大 jaccard 分母，
  把重叠率稀释到无意义。新增组件别名归一（`a-switch`→`switch`、`el-switch`→`switch`、
  `element-plus`→`elementplus`、`vue3`→`vue`）与中英技术词映射（"开关"→`switch`、"分页"→`pagination`），
  解决模板标签与需求原文跨语言对不上。

### 性能 & 死代码

- `listTemplates` 每次召回都全量读盘解析全部模板。现加进程内读缓存：任何写盘（写版本号）或
  文件名集合变化（外部增删）即失效，返回副本防调用方原地排序污染。
- `purgeStale` 无人调用（死代码）。拆出 `staleTemplates()`（只统计不删除），`spec_library`
  报告 ≥90 天未命中的过期模板；物理删除只在用户显式要求时通过 `purge: true` 执行。

### 验证

- 单元测试 129 → **138 通过**（新增：staleTemplates 统计、缓存三态失效、调用方排序不污染、focusFingerprint 4 例）
- smoke / verify 全绿；`npm test` 全量通过
- 新增 `npm run token-audit`：静态 token 预算审计（可复现，无外部依赖）



### 修复：打分里 22% 权重从未生效（查询侧 tags / category 没接线）

- **症状**：`scoreTemplate` 设计的「同分类 +0.14」「标签重叠 +0.08」在真实调用中恒为 0。
- **根因**：`spec_recall` 传给打分器的 `queryFp` 是 `fingerprint()` 返回的**纯指纹数组**，不带 `category`/`tags`；而模板侧这两个字段在沉淀时都存了。天平两侧只接了一边。
- **修复**：
  - 新增 `inferQueryTags(requirement)`（lib/fingerprint.js）：从需求原文推断候选标签，**保留带连字符的复合词整体**（`a-switch` / `ant-design-vue`，否则会被切碎成 ant/design/vue 与模板标签对不上），并抽取路径片段、技术词、中文技术词、驼峰标识符；结果按权重截断到 8 个（数量过大会稀释 jaccard 分母，反而降低重叠率）
  - 新增 `inferQueryCategory(requirement)`（lib/classify.js）：只推断**一级**分类（`bugfix`/`refactor`/`frontend`/`feature`），判不出来返回 undefined（宁可不加分，也不误加分 0.14）
  - `scoreTemplate` 的分类比较放宽为**一级相同即同类**，匹配模板侧自由填写的二级名
  - `spec_recall` execute 中把两者附加到 `queryFp` 上再打分

### 实证（真实模板，非构造数据）

| 需求 | 修复前 | 修复后 | 命中 |
| --- | --- | --- | --- |
| 同类：Vue 管理页加 isMainAdmin 开关字段（a-switch） | 0.487 | **0.633**（tag 重叠 0.077 + 同分类 1） | ✅ 命中，区分度更大 |
| 无关：node_modules 加 .gitignore + 写 README | 0.105 | 0.105（tag/category 均为 0） | ❌ 仍不命中，无误召回 |

### 验证

- 单元测试 117 → **129 通过**（新增 12 用例：标签推断 5、类别推断 5、接线加分 2）

## 0.3.0 — 2026-09-05

### 新功能：沉淀时机判据（三层漏斗 + 合并沉淀）

按用户反馈治理"沉淀时机"：不该每轮对话都沉淀，也不该让该沉的漏掉。引入三层判定：

1. **第一层 硬门槛（插件代码判定，不依赖模型自觉）**
   - 新增 `evaluateRetroEligibility()`：要求会话**真实改过代码**（工具名命中写工具集合 edit/write/...，只读诊断、纯问答不计）且工具调用达到 `retroMinToolCalls`，才认为"有资格沉淀"
   - 新增配置 `retroRequireCodeChange`（默认 `true`）：纯问答 / 只读诊断 / 一次性任务被自动拦下，不再提示沉淀
2. **第二层 复用价值三问（模型在调用 spec_retro 前自检）**：下次是否还这么干 / 结论是否跨项目成立 / 用户是否会反复提；任一为否则跳过
3. **第三层 合并沉淀（任务链收尾一次）**：一条任务链（两次 spec_recall 之间）只沉淀一次，链内小修（编译错、警告修复）合并进最终那份；`spec_retro` 描述与 SKILL.md 同步改写

配套规则：跳过沉淀时必须回一句话说明（"本次为只读诊断/无复用价值，已跳过；需要记录说一声"）；用户说"沉淀/总结/记到模板库"时无条件调用 `spec_retro`；纯问答/只读诊断禁止沉淀。

### 修复：兜底提醒从未真正生效（关键 Bug）

- **症状**：模型漏调 `spec_retro` 时没有任何提醒，沉淀完全靠模型自觉。
- **根因**：兜底逻辑挂在 `ctx.on('turn/end')`，但 dsh 的 turn/end 事件载荷**不含 session 事件流**（`data` 只有 `{turn, reason}`），`extractSessionFacts(turn.session)` 恒为 null、`toolCalls` 恒为 0，低于 `retroMinToolCalls=2` → `pendingRetro` **从未被设置**，`spec_recall` 的 notice 从不出现。
- **修复**：删除失效的 turn/end 判定与 `pendingRetro` 状态；`buildRecallNotice()` 改为在 `spec_recall` execute 内用 `exec.agent.session`（确定可得）实时提取会话事实并跑门槛，未沉淀且真实改码时随召回结果附带提示。

### 验证

- 单元测试 109 → **117 通过**（新增门槛判定 8 用例）
- 硬门槛分离度验证：真实 dsh 会话（youting propertyStaff 任务链）中 spec_retro 2 次沉淀均可被门槛放行；只读问答会话被 `no-code-change` 拦下

## 0.2.1 — 2026-09-05

### 修复（阻断性 Bug）

- **修复 `dsh web` / harness 启动崩溃**：`spec_triage` 工具 output schema 中的 `classification` 字段写成了 `{ type: 'object' }`，缺少 `additionalProperties: true`，违反 dsh schema 编译器要求（object 类型必须显式声明 true/false），导致启动时抛 `UNSUPPORTED_SCHEMA: schema.properties.classification.additionalProperties must be explicitly true or false`，整个插件树加载失败。
- 修复位置：`index.js` `spec_triage` output schema（顶层 schema 及所有嵌套 object 字段均需显式 `additionalProperties`，v0.1.0 已知坑在 0.2.0 引入新字段时复发）。
- 已全量排查：其余 5 个工具的顶层 schema 均带 `additionalProperties: true`，无其他 object 类型隐患。

### 验证

- 单元测试 109/109 通过
- `pnpm dsh web`（deepseek-harness 开发模式）成功启动，web 服务在 `http://127.0.0.1:3080/` 正常监听，schema 错误消失

## 0.2.0 — 2026-09-05

按用户反馈治理"教条式追问"，新增 **3 级复杂度分级响应**。

### 痛点

- 简单 CRUD（加一个 `isMainAdmin` 开关字段）也被当成架构变更处理，连发 5 个问题
- 即便每个问题都给了默认值，仍然强迫用户回答，对模板填充型需求过度严谨
- 缺乏"用户明确说不要问"的快捷通道

### 新功能

- **3 级复杂度分级**：每条需求会被分成 L1 原子操作 / L2 模块变更 / L3 架构重构
  - **L1 原子操作**（单文件 CRUD + 组件/默认值明确）：**禁止追问**，报告输出"直接执行清单 + 风格自举要求 + 保守默认表 + 待办标注规则"。模型扫描目标文件最近 50 行表单代码模仿现有风格，疑虑用 `// TODO: [待确认]` 标注
  - **L2 模块变更**（模块级新增/调整）：最多 3 个追问，每题附分类器推断出的默认值；被截断的维度按当前信息推断执行
  - **L3 架构重构**（架构/重构/迁移/升级/DDL/跨文件）：完整 Grill-me，问题数无上限
- **用户跳过词**：消息中含 `直接做/速做/不用问/别问/不要问/极速模式` 任意一个 → 无条件 L1
- **保守默认表**（L1 用）：列表展示默认不展示、校验默认不加、后端默认已支持；用户主动追加可改写
- **代码风格自举要求**（L1 用）：先 grep 目标文件最近 50 行表单代码，沿用 el-form-item 写法、value 绑定方式、列表列展示约定
- **分类器推断**：自动从需求中抽取字段名（`isMainAdmin`）、组件类型（`el-switch`）、默认值（`否`）、目标文件路径

### 工具协议变更

`spec_triage` 输出新增字段：

- `mode: 'fast-track' | 'clarify' | 'ready'`
- `level: 1 | 2 | 3`
- `classification: { level, signals, inferredComponent, inferredField, inferredDefaultValue, inferredFile, skipTrigger }`

L2 不再附带"历史模板建议追加确认"——分类器的推断值已覆盖该信息（L3 仍保留模板提示）。

### 已知限制

- 复杂度分级是启发式判定：写得很短的需求（如"加个字段"）会被判 L2，而不会默认 L1
- 字段名/组件/默认值推断基于关键词匹配，遇到生僻表述可能漏检——漏检时回退到 L2

## 0.1.0 — 2026-09-04

首个社区试用版。

### 功能

- **五工具闭环**：`spec_recall`（历史模板召回）/ `spec_triage`（四维需求体检）/
  `spec_distill`（提示词提炼）/ `spec_retro`（复盘沉淀）/ `spec_library`（模板库状态）
- **三层注入**：常驻系统提示词（约 200 token 路由规则）+ 运行时 Skill（按需加载流程说明书）+ 工具层
- **双层模板库**：全局层 + 按仓库哈希隔离的项目层，明文 Markdown + JSON，原子写
- **禁区持久化**：每次会话识别到的"不能改"写入项目档案，后续同类需求自动注入
- **幂等沉淀**：同名需求覆盖更新，不堆积

### 修复

- **先问后查急停规则**：需求不完整时，模型此前可能先扫一遍工作区再提问（浪费 token）。
  现已在体检报告、常驻系统提示、Skill 硬规则、工具描述四层钉死：
  `spec_triage` 判定缺失后，唯一动作是向用户提问，提问前禁止调用任何文件类工具。

### 已知限制

- 匹配基于加权关键词指纹（非向量检索），对"说法完全不同但语义相同"的需求召回有限
- 自动复盘依赖模型调用 `spec_retro`（插件有三层保障 + 漏调提醒，但理论上仍可能遗漏）
- 详见 README「已知限制与风险」

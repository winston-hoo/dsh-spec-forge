# Changelog

本插件锁定目标 dsh 版本：`@deepseek-ai/dsh` 0.1.x（developer preview，API 可能有破坏性变更）。
兼容性以实际安装的 profile 依赖树为准。

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

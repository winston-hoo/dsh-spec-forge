# dsh-spec-forge · 需求锻造

一个 DeepSeek Harness（dsh）插件。它管两件事：**动手前把模糊需求问清楚，做完后把经验存下来**，下次遇到同类需求时自动顶上来。

> 实测于 `@deepseek-ai/dsh` 0.1.2-alpha.4（Windows + Web profile）。dsh 仍是 developer preview，插件已锁定其 API 面；升级 dsh 后如失效，先看 CHANGELOG。

---

## 它解决什么

| 痛点 | 这个插件的做法 |
| --- | --- |
| 需求说不清就开工，做完才发现理解错了 | 收到需求先分级：**该问的只问一次，不该问的直接动手** |
| 同一套规矩每次都要重新交代 | 识别到的禁区自动累积进项目档案，此后每轮自动注入 |
| 同一个套路每次都从零描述 | 把套路沉淀成明文模板，同类需求自动召回 |
| 调教好的提示词关掉对话就没了 | 模板是你能看能改的 Markdown，可以进 Git |

模板库存在磁盘上（默认 `<启动 dsh 的 cwd>/.dsh-spec-forge/`），**不是黑盒**。

---

## 主要功能

### 1. 需求分级：三级响应 + 三态路由

`spec_recall` 收到需求后返回一个 `nextStep`，模型**严格按它执行**，不自作主张加步骤：

| `nextStep` | 什么时候 | 做什么 |
| --- | --- | --- |
| `implement` | 需求够明确：单字段 CRUD、**取值型**小改（改文案/调间距/改按钮样式/改默认值）、带参考物的自包含新建、或你说了"直接做/不用问" | **一个问题都不问**，直接给执行清单 + 保守默认值，疑虑标 `// TODO: [待确认]` |
| `confirm` | 需求只给了"容器"却没说是什么：**加个按钮 / 加个路由 / 加一列 / 加个菜单项** | **用一次 `ask_user_question` 问清再动手**（每题给候选 + 推荐默认），不走体检 |
| `triage` | 模块级 / 架构级 | 先做四维体检定级：L2 按报告默认值执行，L3 完整 Grill-me |

分级只看两件事：**范围**（改动多大）与**信息完备度**（有没有说清要做的对象是什么）。
判据一句话：

> **缺「新增物的身份/用途」必问；缺「已有物的属性取值」自决。**

所以「改一下文案」「调一下间距」一步直达，而「登录页加个按钮」会先问一次——加什么按钮、点了做什么，那是产品决策，替你挑一个就是猜。

而且这个判定**不等模型读完工具返回值**：插件在请求发出前就用同一套判据算好，并以一条 `system-reminder` 直接注入
（dsh 的 `agent/pre-step`，等价于 Claude Code 的 `UserPromptSubmit`）。命中 `implement`/`confirm` 时注入，
`triage` 与普通对话不注入——**不该花的 token 一分不花**。关掉它用 `preStepRouting: false`。

### 2. 需求体检：四维完整度 + 保守默认

`spec_triage` 检查四个维度（要实现什么 / 怎么改 / 哪些不能改 / 上下文），并给出可直接执行的报告：

- **L1** → 执行清单（不追问）
- **L2** → 默认值清单，**按默认执行、不列问题**；只有需求确实过短、缺一半以上维度、且没有任何可推断锚点时才转一次性追问
- **L3** → 完整追问清单

L1/L2 背后有一张**保守默认表**兜底：列表默认不展示新列、默认不加业务校验、默认后端接口已就绪——宁可少做也不瞎猜。

### 3. 模板沉淀：三层漏斗，同名幂等

不是每轮对话都值得存。沉淀由三层把关：

1. **代码层硬门槛** —— 这一轮必须真实改过代码且工具调用数达标，纯问答/只读诊断直接拦下，不提示不打扰
2. **复用价值三问**（模型自检）—— 下次还会用吗？结论跨项目成立吗？用户会反复提吗？任一为否就跳过
3. **任务链合并** —— 一条任务链只沉淀一次，中途的小修小补并进最终那份

漏了也有兜底：下次再提编程需求时，插件会提醒"上一轮改过代码却没沉淀"。你也可以直接说 **"把这次沉淀成模板"**，无条件触发。

模板**同名幂等**：同类需求再次沉淀是覆盖更新，不会无限堆积。每份模板六个段落——触发场景 / 需求澄清清单 / 标准改法 / 禁区 / 提示词模板 / 验收标准。示例见 `templates/example-spring-pagination.md`。

### 4. 项目禁区自动累积

会话里识别到的"不能改"（`common/Result.java` 别动、Controller 不写业务逻辑……）会累积到该仓库的 `profile.md`，此后**所有**同类需求自动注入，不用反复交代。禁区是硬约束，模型不得修改。

### 5. 召回：零依赖、可解释的关键词指纹

`spec_recall` 把需求原文拆成加权指纹，和模板库逐份比对打分，超过阈值就注入（默认最多 2 份），连同项目禁区一起。

打分是透明的六维加权，主项是词汇相似度（路径 > 技术词 > 标识符 > 中文 2-gram）。**阈值默认 0.35**，实测分离度：

| 需求 | 得分 | 结果 |
| --- | --- | --- |
| 同类：Vue 管理页加 `isMainAdmin` 开关字段 | 0.63 | 命中 |
| 同类：管理页表单加开关字段 | 0.558 | 命中 |
| 无关：node_modules 加 .gitignore + 写 README | 0.111 | 不命中 |
| 无关但同仓库同分类（唯一交集是通用基名 `index.vue`） | 0.311 | 不命中 |

**诚实边界**：这不是向量检索，而是零依赖、零成本、可解释的关键词指纹。对"说法完全不同但语义相同"的需求召回有限——这是刻意的取舍。公式、各维度含义与阈值标定依据见 [`docs/design.md`](docs/design.md)。

### 6. 成本控制：少往返 + 大文件纪律

- **少往返** —— 简单需求从 3 次工具往返降到 1 次。用真实模板库回放 7 条样本，合计调用 22 → 14 次（−36%），简单需求全部 3 → 1 次（−67%）
- **常驻开销透明** —— 常驻提示段约 489 token，四个工具定义约 2237 token，只出现在发往模型的完整请求里（`npm run token-audit` 实测）
- **真正的成本大头是整读大文件** —— 一次实测里，两个 >100K 字符的文件被整读后，在其后约 73 步被反复重计，占整轮约 50%。所以「大文件纪律」写进了常驻提示与 Skill：`>20K` 字符的文件禁止整读，先 `grep` 定位再分段读；确需整读先落要点摘要

完整成本归因见 [`docs/design.md`](docs/design.md)。

---

## 一次任务长什么样

```
收到编程需求
     ↓
spec_recall ── 翻模板库 + 项目禁区，给出 nextStep
     ↓
  implement（直接动手） / confirm（问一次） / triage（先体检）
     ↓
   写代码（大文件先 grep 定位）
     ↓
spec_retro ── 过得了复用价值三问才沉淀 → 下次同类需求被自动召回
```

---

## 安装

**前置**：dsh 可用、Node 22+、`pnpm` 在 PATH 上（`dsh plugin` 内部转发 pnpm）。

```bash
dsh plugin --profile web add github:<你的账号>/dsh-spec-forge
dsh web   # 必须重启，插件才会组合进插件树
```

验证装上了（`--dump-config` 只合成插件树、不启动服务，是排障第一招）：

```bash
# Bash / Git Bash
pnpm dsh --profile web --dump-config | grep spec-forge

# PowerShell
pnpm dsh --profile web --dump-config | Select-String spec-forge
```

出现 `# == dsh-spec-forge` 段即成功。本地源码调试、以及 `--patch` 加载的坑见 [`docs/operations.md`](docs/operations.md)。

## 快速验收

装完之后照着发几条，观察行为：

1. **明确需求**（"index.vue 加 isMainAdmin 字段，开关，默认 0"）→ 直接动手，不追问
2. **取值型小改**（"改一下这个文案"、"调一下间距"）→ `nextStep=implement`，只调一次 `spec_recall` 就动手
3. **容器型缺内容**（"登录页加个按钮"）→ `nextStep=confirm`，先用一次 `ask_user_question` 问清
4. **模块级 / 架构级**（"给订单模块加导出，要 Excel 和 CSV"、"帮我优化一下那个查询"）→ 先体检：模块级按默认值直接执行，过短无锚点的只问一次，架构级才完整追问
5. **完整需求**（路径 + 禁区 + 验收命令）→ 走完 召回 → 体检 → 提炼 → 实现 → 沉淀

模板落盘位置：`ls <工作区>/.dsh-spec-forge/projects/<hash>/templates/`

## 配置

全部参数都有默认值，一般不用动。要调（比如改命中阈值 `matchThreshold`、换模板库位置 `storageRoot`）就改 profile 目录的 `cordis.patch.yml`：

```yaml
# 顶层数组；⚠️ id 定向补丁会「整体替换」该行 config，必须完整重述所有字段
# 下面就是全部 12 个参数的默认值（tests/contract.test.js 会检查示例是否漏项）
- id: spec-forge
  config:
    autoRecall: true
    autoRetro: true
    matchThreshold: 0.35
    maxInjectTemplates: 2
    injectMaxChars: 4000
    preStepRouting: true
    defaultScope: project
    storageHome: ''
    storageRoot: workspace
    retroMinToolCalls: 2
    retroRequireCodeChange: true
    strictDistill: true
```

**参数全表、写法细节与坑见 [`docs/operations.md`](docs/operations.md#二配置改-cordispatchyml)。**

---

## 已知边界

1. **dsh 还是开发者预览版。** 插件锁定的 API 面是 `ctx.tools.register` / `systemPrompt` / `skills` / `exec.agent.session`。升级 dsh 后失效先 `--dump-config` 排查。
2. **匹配不是向量检索。** 关键词指纹对"说法完全不同但语义相同"的需求召回有限，是刻意的零依赖取舍。
3. **沉淀时机有三层保障但非绝对**，理论上仍可能漏——漏了会提醒，或直接说"把这次沉淀成模板"。
4. **分级是启发式，且部分约束是软约束。** 判据基于正则信号，生僻表述可能漏检——**漏检一律回退 L2（按默认执行），不会默认 L1 瞎干**；"提问前不许扫工作区"这类急停规则写在模型可见的文本里，实测有效但模型仍可能违背。
5. **插件与宿主同进程同权限。** 只读写数据目录，不联网、不执行 shell、不读凭据；源码公开，装前可自行审查。

## 卸载

```bash
dsh plugin --profile web remove dsh-spec-forge
# 若声明了 dsh.bundle.patch，还需清理 profile 的 cordis.patch.yml 对应行
dsh web   # 重启生效
```

模板数据在插件目录之外，**卸载不删沉淀**。

---

## 更多文档

- [`docs/design.md`](docs/design.md) —— 分级判据、召回打分公式与阈值标定、成本归因
- [`docs/operations.md`](docs/operations.md) —— 存储模式与迁移、配置全表、排障、测试与验收、发布流程
- [`CHANGELOG.md`](CHANGELOG.md) —— 逐版本变更记录

## 许可证

MIT

# dsh-spec-forge · 需求锻造

一个 DeepSeek Harness（dsh）插件，把模糊的编程需求锻造成可执行规格，并在每次任务完成后沉淀为**会自动复用的个人提示词模板库**。

**一句话定义**：在用户提出编程需求时，先召回历史经验、再体检需求完整度、缺什么就直接问什么（不预扫代码库），任务完成后自动归类沉淀，下次遇到同类需求自动加载。

> 实测于 `@deepseek-ai/dsh` 0.1.2-alpha.4（Windows + Web profile）。
> dsh 处于 developer preview，插件锁定其 API 面，升级 dsh 后如失效请查看 CHANGELOG。

---

## 它解决什么

| 没有这个插件 | 有了这个插件 |
| --- | --- |
| 需求说不清就开工，中途反复返工 | 动手前自动体检四个维度，缺什么先问什么 |
| 每次都要重复交代「哪些地方不能改」 | 禁区沉淀进项目档案，长期生效，自动注入 |
| 同一个套路的需求，每次都从零描述 | 命中历史模板，直接复用澄清清单与标准改法 |
| 好用的提示词用完就丢 | 自动提炼成模板，越用越贴合你的习惯 |
| 历史经验散落在会话记录里 | 结构化模板库，可查、可改、可回溯 |

---

## 工作原理

```
捕获 spec_recall → 体检 spec_triage → 澄清(人工问答)
      ↑                                        ↓
   自动复用  ←  沉淀 spec_retro  ←  实现  ←  提炼 spec_distill
```

**先问后查**：`spec_triage` 判定需求不完整时，模型的唯一动作是向用户提问——
提问前禁止调用任何文件类工具（read_file/grep/bash/find 等），避免为「更懂业务」预扫整个
工作区而烧掉大量 token。这条规则钉在体检报告、常驻系统提示、Skill 硬规则、工具描述四层。

三个注入层次，各司其职：

| 层次 | 机制 | 内容 | token 成本 |
| --- | --- | --- | --- |
| 常驻层 | `ctx.systemPrompt.section` | 四步路由规则 + 急停规则，约 250 token | 低，始终占用 |
| 按需层 | `ctx.get('skills').register()` | 完整流程说明书 | 零，按需加载 |
| 执行层 | `ctx.tools.register()` | 五个工具 | 零，调用时才产生 |

---

## 安装

### 前置条件

- dsh 可用（`npx @deepseek-ai/dsh web` 或源码 checkout 均可）
- Node.js 22 及以上
- **pnpm 在 PATH 上**——`dsh plugin` 命令内部转发给 pnpm（未装则 `npm i -g pnpm`）

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:<你的账号>/dsh-spec-forge
dsh web   # 必须重启，插件才会被组合进插件树
```

### 方式二：本地开发（源码运行 dsh）

克隆后，插件里的裸导入（`@deepseek-ai/dsh-tools` 等）会从插件目录向上找 `node_modules`，
找不到会直接启动失败。三种解法：

1. **已装过 dsh + pnpm 的环境**，直接正式安装（方式一）；
2. **源码调试**：把 `node_modules/@deepseek-ai` 指到 dsh profile 的公共依赖目录
   （Windows 用 junction：`New-Item -ItemType Junction -Path "<repo>/node_modules/@deepseek-ai" -Target "$HOME\.dsh\profiles\node_modules\@deepseek-ai"`；
   macOS/Linux 用 `ln -s`）；
3. 用 `--patch` 叠加插件启动（Windows 注意：`name` 必须写成 `file:///` URL，
   裸盘符路径会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）：

```bash
cd <deepseek-harness>
node apps/cli/lib/bin.js --profile web \
  --patch "<repo>/dev/spec-forge.patch.yml"
```

> 本仓库 `dev/` 目录下的 patch 文件含本机绝对路径，仅供本地调试，
> 已被 `.gitignore` 排除、不会进入发布包。`npm pack` 内容可用 `npm pack --dry-run` 预检。

### 验证安装

```bash
dsh --profile web --dump-config | grep spec-forge   # 确认在插件树里
```

---

## 五个工具

| 工具 | 何时调用 | 作用 |
| --- | --- | --- |
| `spec_recall` | 收到编程需求的**第一件事**，先于一切代码改动 | 检索模板库，返回命中模板的澄清清单、标准改法、验收标准，以及本项目禁区 |
| `spec_triage` | 召回之后 | 四维度体检（要实现什么 / 要怎么改 / 哪些不能改 / 上下文）；判定缺失时输出急停指令，要求先问后查 |
| `spec_distill` | 需求澄清完毕、准备动手前 | 把需求 + 澄清答案 + 禁区蒸馏成结构化实现提示词；未声明禁区会报错拦下 |
| `spec_retro` | 任务完整结束时 | 归类总结并写入模板库，同名需求自动覆盖更新 |
| `spec_library` | 用户询问模板库状态时 | 查看数据目录、模板清单、项目禁区 |

---

## 配置项

在 profile 的 `cordis.patch.yml` 中调整：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `autoRecall` | `true` | 是否注入常驻路由提示 |
| `autoRetro` | `true` | 是否在任务完成后提示沉淀 |
| `matchThreshold` | `0.35` | 命中阈值。调低更容易命中（可能误召回），调高更严格 |
| `maxInjectTemplates` | `2` | 单次最多注入几份模板 |
| `injectMaxChars` | `4000` | 注入上下文的字符上限 |
| `defaultScope` | `project` | 沉淀默认落在项目层还是全局层 |
| `retroMinToolCalls` | `2` | 自动复盘要求的最少工具调用次数 |
| `strictDistill` | `true` | 提炼时是否强制要求填写禁区 |
| `storageHome` | 空 | 自定义数据目录，留空用 `$DSH_HOME/spec-forge` |

---

## 数据存储

全部是明文 Markdown + JSON，可以直接看、直接改、直接进 Git。

```
$DSH_HOME/spec-forge/
├── global/                      # 全局层：跨仓库通用的习惯
│   ├── templates/<id>.md
│   └── profile.md
└── projects/<repo-hash>/        # 项目层：按仓库路径哈希隔离
    ├── templates/<id>.md
    └── profile.md               # 该项目持久化的禁区与约定
```

- 仓库哈希 = 工作目录路径小写归一后的 sha256 前 12 位（Windows 路径同样适用）
- 项目层优先于全局层，同名模板不会重复注入
- 所有落盘都是原子写（先写 `.tmp` 再 rename），不会留下半个文件

---

## 模板格式

每份模板是六个标准段落，沉淀与消费两侧共用同一套结构：

```markdown
# Spring Boot 新增分页查询接口

分类：`feature/api`　标签：`java` `spring-boot`

## 触发场景
当用户要求新增支持分页的查询接口时适用。

## 需求澄清清单
- 分页参数用 pageNum/pageSize 还是 offset/limit？
- 返回 VO 是否包含关联表字段？

## 标准改法
1. XxxController 新增方法
2. XxxService 与 XxxServiceImpl 实现
3. Mapper XML 写查询 SQL

## 禁区
- 不要修改 common/Result.java 的返回结构

## 提示词模板
```text
按 Controller → Service → ServiceImpl → Mapper 四层实现……
```

## 验收标准
- [ ] mvn -q test 通过
```

完整示例见 `templates/example-spring-pagination.md`。

---

## 验证

```bash
# 单元测试：88 个用例，覆盖指纹/匹配/会话提取/存储/渲染/急停规则
npm test

# 端到端冒烟：验证沉淀→召回→复用→禁区生效整条链路
npm run smoke

# 加载验证：mock ctx 执行 apply()，确认五个工具都能注册
npm run verify
```

冒烟脚本的实际输出（可作为验收基线）：

```
同类需求命中 —— 得分 0.499
异类需求不命中 —— 得分 0.136
模糊需求要求澄清 —— 缺失 要实现什么/哪些不能改/上下文
用户还要改时不误判为完成 —— user-continue-intent
```

真实环境验收（装完之后）：

1. 发一条含糊需求（如「帮我优化一下那个查询」），观察模型是否**先提问、未扫代码**；
2. 发一条完整需求（含文件路径 + 禁区 + 验收命令），观察是否走完
   `spec_recall → spec_triage → spec_distill → 实现 → spec_retro`；
3. 检查模板落盘：`ls ~/.dsh/spec-forge/projects/<hash>/templates/`；
4. 再发一条同类需求，确认 `spec_recall` 能召回刚沉淀的模板（模型会引用其中的澄清清单）。

---

## ⚠️ 已知限制与风险

1. **dsh 仍是开发者预览版**，官方明确警告会有破坏性变更。本插件锁定的 API 面为：
   `ctx.tools.register` / `ctx.get('systemPrompt')` / `ctx.get('skills')` / `ctx.on('turn/end')` /
   `exec.agent.session`。升级 dsh 后若插件失效，先跑 `--dump-config` 排查，再看 CHANGELOG。

2. **匹配用的是加权关键词指纹，不是向量检索。** 好处是零依赖、零成本、可解释；
   代价是对「说法完全不同但语义相同」的需求召回有限。调低 `matchThreshold` 可缓解，
   但会引入误召回。

3. **自动复盘依赖模型主动调用 `spec_retro`。** 插件做了三层保障（常驻提示、Skill 说明书、
   漏调时下次召回会提醒），但模型理论上仍可能漏掉。发现漏沉淀时，直接说「把这次沉淀成模板」即可。

4. **「对话完整结束」是启发式判定**，依据是事件流结构（turn 完成 + 有工具活动 +
   用户消息已回应 + 无继续意图）。它判断得准，但不是绝对可靠。

5. **急停规则是提示词约束，不是硬拦截。** 「先问后查」写在了模型可见的四层文本里，
   实测有效；但模型仍可能违背。若你的模型反复无视该约束，可在需求层面配合说明
   （例如先答三问再动手），或等待 dsh 提供工具级前置钩子。

6. **插件与宿主同进程、同权限。** 本插件只读写 `$DSH_HOME/spec-forge` 目录，
   不联网、不执行 shell、不读凭据。源码公开，安装前可自行审查。

---

## 卸载

```bash
dsh plugin --profile web remove dsh-spec-forge
# 若声明了 dsh.bundle.patch，还需清理 profile 的 cordis.patch.yml 中对应行
dsh web   # 重启生效
```

模板数据不在插件目录内，卸载不会删除已沉淀的模板。要彻底清理：

```bash
rm -rf ~/.dsh/spec-forge
```

---

## 开发与发布

```bash
# 自检
npm test && npm run smoke && npm run verify

# 预检发布内容（应只含 index.js / lib / skills / templates / 文档）
npm pack --dry-run

# 发布到 GitHub（打上 dsh-plugin 话题即可被社区目录发现）
gh repo create <你的账号>/dsh-spec-forge --public --source . --push
gh repo edit --add-topic dsh-plugin
```

- 给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提收录 PR 可加速传播
- 变更记录见 `CHANGELOG.md`

---

## 许可证

MIT

# 运维手册

安装、存储、配置、排障、验证。功能说明见 [README](../README.md)，判据与算法见 [design.md](design.md)。

---

## 一、存储

### 目录布局

双层明文目录，**项目层优先于全局层**：

```
<数据根>/
├── global/                      # 全局层：跨仓库通用的习惯
│   ├── templates/<id>.md
│   └── profile.md
└── projects/<repo-hash>/        # 项目层：按仓库路径哈希隔离
    ├── templates/<id>.md
    └── profile.md               # 该项目的禁区与约定
```

仓库哈希 = 工作目录路径归一化后的 sha256 前 12 位（`\`→`/` + 转小写 + 去尾斜杠，Windows 路径同样适用）。

> ⚠️ **反查某个哈希对应哪个项目**：读该目录下 `profile.md` 的 frontmatter `repoName` 字段。
> 这很实用——重放脚本传错会话 cwd 会得到完全不同的哈希，症状（未命中 + 0 条禁区 + 0 份模板）
> 与"功能坏了"一模一样，极易误诊。

所有落盘都是原子写（先 `.tmp` 再 rename），崩溃不会留下半个文件。

### 三种存储模式

| 模式 | 实际路径 | 适用场景 |
| --- | --- | --- |
| `workspace`（默认） | `<启动 dsh 的 cwd>/.dsh-spec-forge/` | 工作区与 `$DSH_HOME` 不同盘，避免跨盘 EPERM；模板库跟随当前项目 |
| `home` | `$DSH_HOME/spec-forge/` | 旧版（≤0.3.2）默认；适合把模板库统一存在用户目录 |
| `storageHome` 显式 | 你给的任意绝对路径 | 想放到自定义位置（如 OneDrive 同步盘） |

跨盘写会触发 dsh 的 `workspace-write` 沙箱 EPERM（用户常反馈的"C 盘被拒绝"就是这个）。
**新装用户无须配置**；老用户升级后如果还在用旧路径，调 `spec_library({ action: 'info' })` 看当前模式与路径，
必要时调 `spec_library({ action: 'migrate' })` 把 `$DSH_HOME/spec-forge` 拷过来
（默认复制保留源，验证后再传 `move: true` 删除源）。

### 布局迁移史（排查老数据读不到时看这里）

- **0.4.1 布局修正**：0.3.3/0.4.0 因把已是数据根的 `home` 又追加了一层，数据实际落在 `<root>/spec-forge/…`
  （`home` 模式下导致历史模板全部读不到、`migrate` 写到了插件不读的位置）。
  0.4.1 起 `<root>` 即数据根；启动时会自动把遗留的 `<root>/spec-forge/…` 一次性上移归位（新位置已有数据则不动）。
- **0.4.2**：上移归位后若源目录已空，会顺手删掉它——0.4.1 会在曾踩坑的机器上永久留下一个 `<root>/spec-forge/` 空壳。

### 过期模板

`spec_library` 会统计超过 90 天未被命中的过期模板并列出名字——模板不是越多越好，旧模板会稀释召回精度。
但它**只报告不擅自动手**，只有你明确说"清理过期模板"才会物理删除（删了不可恢复）。

---

## 二、配置：改 `cordis.patch.yml`

profile 的行配置**不是**写成一个 `spec-forge:` 缩进块，而是改在 profile 目录的 patch 文件里，
且它必须是**顶层 YAML 数组**：

```
~/.dsh/profiles/<profile>/cordis.patch.yml
```

```yaml
# 顶层数组；条目用 id 定位到已有行。
# ⚠️ id 定向补丁会「整体替换」该行的 config，不是合并——
#    所以下面必须完整重述所有字段，否则漏掉的字段会回落到插件默认值。
- id: spec-forge
  config:
    autoRecall: true
    autoRetro: true
    matchThreshold: 0.35
    maxInjectTemplates: 2
    injectMaxChars: 4000
    defaultScope: project
    storageRoot: home          # 改这里：workspace（默认）| home
    storageHome: ''            # 非空则强制覆盖 storageRoot；建议留空
    retroMinToolCalls: 2
    retroRequireCodeChange: true
    strictDistill: true
```

改完重启 dsh，用 `dsh --profile <profile> --dump-config` 确认 `# == dsh-spec-forge` 段里的值与预期一致。

### 参数全表

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `autoRecall` | `true` | 是否注入常驻路由提示 |
| `autoRetro` | `true` | 是否在任务完成后提示沉淀 |
| `matchThreshold` | `0.35` | 命中阈值，低更易命中、高更严格 |
| `maxInjectTemplates` | `2` | 单次最多注入几份模板 |
| `injectMaxChars` | `4000` | 注入上下文上限字符数 |
| `defaultScope` | `project` | 沉淀默认落项目层还是全局层 |
| `retroMinToolCalls` | `2` | 自动复盘要求的最少工具调用数 |
| `retroRequireCodeChange` | `true` | 沉淀提醒要求真实改过代码，纯问答/只读不提醒 |
| `strictDistill` | `true` | 提炼时强制要求禁区，空则报错 |
| `storageRoot` | `workspace` | 存储模式：`workspace`（跟工作区）/ `home`（放 `$DSH_HOME`）；设置 `storageHome` 绝对路径时此字段被忽略 |
| `storageHome` | 空 | 自定义数据目录（绝对路径）。非空时优先于 `storageRoot` |

---

## 三、排障

### 第一招永远是 dump-config

```bash
pnpm dsh --profile web --dump-config | grep spec-forge
```

它只合成插件树、不启动服务。干净输出里应有一段 `# == dsh-spec-forge` 及其配置块。

### 安装

**前置**：dsh 可用、Node 22+、`pnpm` 在 PATH 上（`dsh plugin` 内部转发 pnpm，没装就 `npm i -g pnpm`）。

```bash
dsh plugin --profile web add github:<你的账号>/dsh-spec-forge
dsh web   # 必须重启，插件才会组合进插件树
```

### 发布新版本后重装仍是旧代码？

**pnpm-lock 会钉住 GitHub 依赖的提交 SHA。** push 之后必须刷新锁文件，否则重装拿到的还是旧提交：

```bash
cd ~/.dsh/profiles/<profile>
env -u NODE_OPTIONS pnpm update dsh-spec-forge
```

### 本地源码调试

插件里的裸导入（`@deepseek-ai/dsh-tools` 等）会从插件目录向上找 `node_modules`。
已装过 dsh + pnpm 就直接用上面的正式安装方式；需要跑未发布的源码时：

- 把 `node_modules/@deepseek-ai` 指到 profile 的公共依赖目录（Windows 用 junction，macOS/Linux 用 `ln -s`）
- 或用 `--patch` 叠加启动。**Windows 下 patch 里的 `name` 必须写成 `file:///` URL，裸盘符会报
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`**

本仓库 `dev/` 下的 patch 含本机绝对路径、已被 `.gitignore` 排除，仅供本地调试。

### 编写插件时的两个必踩坑

1. **object 类型的 output schema 必须写 `additionalProperties: true/false`**，
   否则插件树加载失败、harness 直接启不来（`UNSUPPORTED_SCHEMA`）。给 schema 新增任何 object 字段都要带上。
2. **Profile 目录本身是 pnpm workspace 根目录**，在该目录直接 `add` 可能需要 `-w`。

### 卸载

```bash
dsh plugin --profile web remove dsh-spec-forge
# 若声明了 dsh.bundle.patch，还需清理 profile 的 cordis.patch.yml 对应行
dsh web   # 重启生效
```

模板数据在插件目录之外，**卸载不删沉淀**。要彻底清空：删掉数据根目录（默认 `<工作区>/.dsh-spec-forge`）。

---

## 四、验证

```bash
npm test            # 单元测试：204 个
npm run smoke       # 端到端冒烟：沉淀→召回→注入→体检→完成判定→幂等 整条链路
npm run verify      # 加载验证：mock ctx 执行 apply()，确认工具都能注册、schema 合规
npm run token-audit # 静态 token 预算审计：常驻/工具定义/SKILL/单次调用产出/真实库命中注入
```

测试覆盖面：指纹（含通用基名降权）/ 匹配（含"先验分不得脱离词汇证据"）/ 会话提取 / 存储（含布局、空壳与禁区近重复去重）/ 渲染（含注入裁剪）/ 分类器（含内容闸门与"路径不得当内容"反例）/ 路由契约（含提示段内容护栏）/ 沉淀门槛 / 读缓存 / 查询聚焦 / 路径解析 / 迁移。

### 两类专门的回归护栏

**① 路由契约（`tests/routing.test.js`）** —— 把"快速通道必须真正短路"钉死：
`nextStep` 必填、`implement` 正文必须明文禁止调用 `spec_triage`/`spec_distill`、
`triage` 必须给出正向指令、`spec_triage` 不得接收 `cwd`、召回未命中分支不得出现无条件沉淀指令。

**② 常驻提示段的内容清单** —— 从 mock 的 `systemPrompt.section` 注册里抽出常驻段真文本，
断言 `order === 150` 且包含全部必需子串，并反向断言段长上限。
起因是曾为压缩 token 静默删掉了「报错排查」等 4 条约束——**只比 token 数字看不出这种坏，必须有内容清单回归。**

### 冒烟基线（可作验收参考）

```
1. 沉淀：一次任务结束后写入模板          [PASS] 模板已落盘
   指纹与布局自检                        [PASS] 指纹 8 项损坏 0 项 / 落盘无 [object Object] / 无多余层级
2. 召回：同类需求命中                    [PASS] 得分 0.499，lexical=0.635
3. 召回：异类需求不命中                  [PASS] 得分 0.136
4. 注入：禁区/澄清清单/标准改法进上下文  [PASS]
5. 体检：模糊需求被拦下要求澄清          [PASS] 缺失 要实现什么/哪些不能改/上下文
6. 完成判定：不做完的活不误判为完成      [PASS]
7. 幂等：同类需求再次沉淀是覆盖非堆积    [PASS] 仍 1 份
```

### 真实环境验收

装完之后照着发几条，观察行为：见 [README 的快速验收](../README.md#快速验收)。

---

## 五、开发与发布

变更记录见 [`CHANGELOG.md`](../CHANGELOG.md)。发布流程：

1. 改代码
2. `npm test`（+ `smoke` / `verify` / `token-audit`）
3. 升 `package.json` 版本
4. `CHANGELOG.md` 顶部加条目
5. 同步 `README.md` 与 `docs/`（改了行为契约时，还要同步常驻提示段、工具 description、`skills/*/SKILL.md`——见下）
6. commit & push
7. 在 profile 目录执行 `env -u NODE_OPTIONS pnpm update dsh-spec-forge` 刷新锁文件
8. 对**安装产物**再跑一遍端到端（不是只跑仓库源码的单测）

### 改「工具契约」时必须同步四处

工具返回值里加一个枚举值或字段，看着是小改，实际会牵动一整片。**漏任何一处，产出的就是"文档自相矛盾"**——
模型读标题不读子条目，照样走错：

| # | 位置 |
| --- | --- |
| 1 | 工具 `output.schema` 的字段描述 |
| 2 | 常驻提示段的执行路径分支 + 权限类封闭列举 |
| 3 | 受影响工具的 `description` |
| 4 | `skills/*/SKILL.md` 的速查表 + 各步骤的跳过条件 + 总结段 |

第 4 项最易漏：SKILL.md 里「本步只在 `fastTrack=false` 时执行」这类写法，
在 `nextStep` 出现第三态后**必然变成假话**。

### 契约变更时测试会成批失败

那是护栏在工作，不是改坏了。判断标准：

- 失败断言写的是**"旧行为应该发生"** → 改断言
- 失败断言写的是**"新行为不该发生"** → 才是 bug

### 排障脚本固化在 `.local/`

`.local/` 已 gitignore，放一次性诊断脚本，比每次现写 `node -e` 快得多。常用两个：

- **会话解码** —— 按 `--user/--assistant/--tools` 打印某次会话的输入、模型原话与全部工具调用，
  用来回答"它到底做了什么、有没有被误导"。
  注意 v3 日志载荷位置不统一：`user/message → data.content`；`assistant/message → data.message.content` + `data.usage`；
  `tool/result → data.message.content[].content[].text`（两层嵌套）。
  另：**`NODE_PATH` 只对 CJS 的 `require` 生效，ESM 的 `import()` 会完全忽略它**，所以这类脚本一律写成 `.cjs` + `require`。
- **召回诊断** —— 打印查询指纹 + 每份模板的打分分解 + 交集 token，用来定位"为什么命中/不命中"。
  **必须走与生产相同的输入构造路径**（少一个字段就会得出相反结论），并且**会话 cwd 必须是库里那个真实项目路径**（见上文反查方法）。

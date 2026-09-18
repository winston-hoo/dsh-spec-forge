// dsh-spec-forge —— 需求锻造
//
// 一个把「模糊需求」锻造成「可执行规格」并持续沉淀为个人模板库的 dsh 插件。
//
// 闭环：
//   捕获(spec_recall) → 体检(spec_triage) → 补全(人工/模型问答)
//   → 提炼(spec_distill) → 实现(模型) → 沉淀(spec_retro) → 复用(spec_recall)
//
// 依赖 dsh 的服务：
//   tools        —— 硬依赖，写进 inject
//   systemPrompt —— 可选，用 ctx.get 探测
//   skills       —— 可选，用 ctx.get 探测

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { fingerprint, focusFingerprint, inferQueryTags } from './lib/fingerprint.js'
import { classifyComplexity, inferQueryCategory } from './lib/classify.js'
import { rankTemplates } from './lib/match.js'
import { buildRetroDigest, evaluateRetroEligibility, extractSessionFacts, isSessionComplete } from './lib/extract.js'
import {
  bulletLines,
  collectRedlines,
  dedupeRedlines,
  liftLegacyNesting,
  listTemplates,
  readProfile,
  recordHit,
  repoHash,
  resolveStorageRoot,
  templateId,
  writeProfile,
  writeTemplate,
} from './lib/store.js'
import {
  SECTIONS,
  renderInjection,
  renderPreStepNotice,
  renderRoutingLines,
  renderTemplateMarkdown,
  renderTriageReport,
  sectionOf,
  triageRequirement,
} from './lib/render.js'

export const name = 'spec-forge'

// 只把 tools 作为硬依赖；systemPrompt / skills 用 ctx.get 探测，缺失也能跑。
export const inject = ['tools']

// 配置 schema 必须导出成 `Config`：cordis 的 resolveConfig 只认这个键 ——
//   `if (!runtime.Config) return config;`
// 不导出它就等于**从不校验、也从不填默认值**：配置里少写一个键（例如 profile patch 没写
// preStepRouting）会原样变成 undefined。0.6.4 之前这里叫 `schema`，于是所有默认值形同虚设。
export const Config = Schema.object({
  autoRecall: Schema.boolean().default(true).description('是否在收到编程需求时自动召回历史模板'),
  autoRetro: Schema.boolean().default(true).description('是否在任务完成后提示沉淀复盘'),
  matchThreshold: Schema.number().min(0).max(1).default(0.35).description('模板命中阈值，0~1，越低越容易命中'),
  maxInjectTemplates: Schema.number().min(1).max(5).default(2).description('单次最多注入几份历史模板'),
  injectMaxChars: Schema.number().min(500).max(20000).default(4000).description('注入上下文的最大字符数'),
  preStepRouting: Schema.boolean()
    .default(true)
    .description(
      '每轮请求发出前，由插件按需求原文算出 nextStep 并以 system-reminder 注入（L1 一步直达 / 需求缺内容两种情形）。关闭后回退为"只靠常驻段与 spec_recall 返回值"'
    ),
  defaultScope: Schema.union(['project', 'global']).default('project').description('沉淀默认落在项目层还是全局层'),
  storageHome: Schema.string().default('').description('自定义数据目录（绝对路径）。非空时优先于 storageRoot'),
  storageRoot: Schema.string().default('workspace').description('存储模式：workspace 跟当前工作目录（推荐，跨盘时避免 EPERM）/home 放 $DSH_HOME（兼容旧版默认）'),
  retroMinToolCalls: Schema.number().min(0).default(2).description('自动复盘要求的最少工具调用次数，低于此值视为未真正动手'),
  retroRequireCodeChange: Schema.boolean().default(true).description('自动沉淀提醒要求本会话真实改过代码（有 edit/write 类工具调用），纯问答/只读诊断不提醒'),
  strictDistill: Schema.boolean()
    .default(true)
    .description('提炼提示词时若未声明禁区：是否在提示词里插入警告、并回传 missingConstraints=true（模型据此先补问再动手）。关闭后不再警告'),
})

/** 同一份 schema 的旧名（0.6.4 之前的导出名）。仅为兼容既有测试与文档引用保留。 */
export const schema = Config

const __dirname = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, config) {
  // 顶层确定 home：用户配置 > $DSH_HOME 兜底。process.cwd() 作为 workspace 模式的兜底，
  // 对 99% 用例（dsh 启动时的 cwd = 工作区）够用；session 级 cwd 由 resolveCwd 工具级处理。
  const resolvedStorage = resolveStorageRoot({
    storageHome: config.storageHome,
    storageRoot: config.storageRoot,
    cwd: process.cwd(),
  })
  const home = resolvedStorage.path
  const storageMode = resolvedStorage.mode

  // 0.4.1：把 0.3.3/0.4.0 误生成的 `<root>/spec-forge/…` 布局一次性归位到 `<root>/…`。
  // 只在检测到旧嵌套且新位置为空时动手，失败仅告警、不影响插件其余功能。
  const layoutNotice = liftLegacyNesting(home, ctx.logger)
  if (layoutNotice) ctx.logger?.info?.(`[spec-forge] ${layoutNotice}`)

  // 会话级状态：只存标记位，不存内容，避免占用内存与持久化风险
  const state = {
    retroDone: new Set(), // sessionId：已成功沉淀过的会话，不再打扰
  }

  // ---------- 第 1 层：常驻系统提示词（必须短，0.3.2 精简后约 400 token/请求） ----------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt?.section && config.autoRecall !== false) {
    systemPrompt.section({
      name: 'spec-forge:routing',
      order: 150,
      text: [
        '## 需求锻造（spec-forge）',
        '编程需求：先 `spec_recall`（传原文），然后**严格按它返回的 `nextStep` 执行**，不自作主张加步骤。',
        // 三态路由由 lib/render.js 的 ROUTING_CONTRACT 渲染 —— 唯一事实来源。
        // 0.4.7 之前这里手写了一份、SKILL.md 又手写了一份，两边已经漂移（SKILL.md 把
        // 「加按钮/加列」写成 L1 直通，与 0.4.6 的 confirm 相反）。
        ...renderRoutingLines(),
        '- 可以 `ask_user_question` 的只有三种：`nextStep=confirm`、L3、L2 安全阀；',
        '  提问前禁用任何文件类工具（read/grep/glob/bash/ls），一次问完。',
        '大文件纪律：>20K 字符的文件禁止整文件 read，先 grep 定位再分段读；确需整读先落要点摘要。',
        '收尾过复用价值三问（还会照做/跨项目成立/会反复提）后 `spec_retro` 一次；纯问答、只读诊断、报错排查、',
        '环境修复、L1 原子小改不沉淀；用户明确要求时无条件沉淀。',
        '禁区（项目档案/模板注入）是硬约束，不得修改。',
      ].join('\n'),
    })
  }

  // ---------- 第 2 层：Skill（按需加载完整流程说明书，不占常驻 token） ----------

  const skills = ctx.get('skills')
  if (skills?.register) {
    try {
      const skillFile = join(__dirname, 'skills', 'spec-forge', 'SKILL.md')
      skills.register({
        name: 'spec-forge',
        description: '需求澄清、提示词提炼与经验沉淀：把模糊需求变成可执行规格，并沉淀为可复用的个人模板库',
        content: readFileSync(skillFile, 'utf8'),
        source: 'runtime',
        provider: 'dsh-spec-forge',
      })
    } catch (err) {
      ctx.logger?.warn?.(`[spec-forge] Skill 注册失败，插件其余功能不受影响: ${err.message}`)
    }
  }

  // ---------- 第 3 层：pre-step 硬注入（0.5.0） ----------
  //
  // 为什么需要这一层：常驻段与 spec_recall 的返回值都是"模型先读到、再自觉执行"的软约束。
  // 实测 20 次真实召回里有 17 次紧接着调了 spec_triage（一次简单改页面白跑两趟往返），
  // 而 0.4.6 记录的那次会话则是模型自己替用户挑了按钮用途。
  //
  // dsh 提供 `agent/pre-step` 瀑布事件（等价于 Claude Code 的 UserPromptSubmit）：它在每个 step
  // 的请求**发出之前**调用，返回值里的 messages 就是本轮进入模型的上下文。内置插件正是这么做的 ——
  // dsh-tool-skill 用它注入 skill 目录，dsh-repeat-tool-reminder 用它手搓用户消息（createUserMessage）。
  // 于是插件可以自己算好路由、作为一条 plugin 消息送进请求，而不必指望模型照做。
  //
  // 三条安全设计：
  //   ① 判据与 spec_recall 同源（同一个 classifyComplexity、同一份需求原文）→ 结论不可能打架；
  //   ② 只注入两种"最容易走错"的情形（见 renderPreStepNotice），triage 不注入，省 token；
  //   ③ 全程 try/catch + 幂等：任何异常都原样放行（返回下游 decision），绝不拖垮本轮。
  // 注意这里是 `!== false` 而不是直接取真值：配置来自 profile 的 patch 层，**少写一个键不该
  // 关掉一个功能**。0.6.4 之前正是 `config.preStepRouting &&`，而 profile 没写这个键 →
  // undefined → 整个注入块被静默跳过，监听器从 0.5.0 起就没注册过（根因见 CHANGELOG 0.6.4）。
  if (config.preStepRouting !== false && typeof ctx.on === 'function') {
    // 同一轮内已注入过的需求（`轮次:原文哈希`）。会话消息只在本轮第一步的 payload 里，
    // 多 step 时靠它兜底，避免每个 step 都注入一遍。
    const injected = new Set()
    const preStep = async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind === 'reject') return decision
        payload?.signal?.throwIfAborted?.()
        // 内置插件（dsh-tool-skill / dsh-repeat-tool-reminder）判定时读的都是 payload.messages；
        // 0.6.2 起跟随它们：payload 里没有才退回 decision.messages。
        const claimed = Array.isArray(payload?.messages) ? payload.messages : []
        const entering = Array.isArray(decision.messages) ? decision.messages : []
        const requirement = pickRequirementMessage(claimed.length > 0 ? claimed : entering)
        if (!requirement) return decision
        const requirementText = messageTextOf(requirement)
        // ponytail: 幂等只按「需求原文哈希 + 轮次」判定，不做语义去重 —— 用户换句话复述同一需求
        // 会被当成新需求再注入一次（代价约 140 token）。上限：改写后重复注入；
        // 升级触发：真实会话里观察到这种重复噪声，再考虑按指纹相似度合并。
        const digest = shortDigest(requirementText)
        const turn = payload?.turn
        const key = `${turn}:${digest}`
        if (injected.has(key)) return decision
        // 会话重放（同一轮的消息已在上下文里）同样不能重复注入
        const already = [...claimed, ...entering].some(
          (m) =>
            m?.source?.plugin === PLUGIN_ID &&
            m?.source?.digest === digest &&
            (turn === undefined || m?.source?.turn === turn)
        )
        if (already) return decision
        const classification = classifyComplexity(requirementText)
        const notice = renderPreStepNotice(classification)
        if (!notice) return decision
        injected.add(key)
        return {
          ...decision,
          messages: [...entering, createNoticeMessage(notice, { digest, turn, classification })],
        }
      } catch (err) {
        ctx.logger?.warn?.(`[spec-forge] pre-step 注入失败，已忽略（本轮不受影响）: ${err.message}`)
        return decision
      }
    }
    // `{ global: true }`：`agent/*` 是「作用域过滤事件」，Cordis 派发时按监听器 ctx 的 scope 标签筛
    // （dsh-scope 的 scopeTarget：无标签或标签是祖先才放行）。插件自己的 ctx 无标签时本就通过，
    // 带上这个选项连"ctx 被打上标签"的情形也一并覆盖；dsh-scope 的跨切面不变式监听器也这么注册。
    ctx.on('agent/pre-step', preStep, { global: true })
  }

  // ---------- 第 4 层：兜底提醒（模型漏调 spec_retro 时提示） ----------
  // 注意：dsh 的 turn/end 事件载荷不含 session 事件流（data 只有 {turn, reason}），
  // 无法在此做沉淀门槛判定；旧版靠 turn.session/steps 的写法实际永远不触发。
  // 兜底已改到 spec_recall execute 内用 exec.agent.session 惰性判定（见 buildRecallNotice），
  // 每次召回时若发现「上一轮已完成且真实改过代码但尚未沉淀」，随召回结果附带一行提示。

  // ---------- 工具 1：召回 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_recall',
      description:
        '检索历史提示词模板库，返回命中模板（澄清清单/标准改法/验收标准）、本项目禁区，以及复杂度分级（level、fastTrack、contentGap 与 nextStep）。nextStep=confirm 时表示需求缺内容（如只说"加个按钮"没说是什么），必须先问清再动手。用户提出编程需求时在任何代码改动之前调用，是硬性前置步骤。',
      parameters: {
        requirement: {
          type: 'string',
          required: true,
          description: '用户的原始需求描述，原样传入，不要先加工',
        },
        cwd: {
          type: 'string',
          description: '当前工作目录绝对路径。留空则自动取会话工作目录',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            matched: { type: 'boolean', required: true },
            context: { type: 'string', required: true },
            redlines: { type: 'array' },
            templates: { type: 'array' },
            notice: { type: 'string' },
            level: { type: 'number', description: '复杂度等级 1|2|3' },
            fastTrack: { type: 'boolean', description: 'true 时直接实现，禁止调用 spec_triage 与 spec_distill' },
            contentGap: {
              type: 'array',
              description: '需求缺失的内容（如“按钮的文案与用途”）。非空时禁止直接实现，必须先问清',
            },
            nextStep: {
              type: 'string',
              required: true,
              description:
                "下一步动作指令：'implement'（fastTrack，直接改代码）| 'confirm'（contentGap 非空：先用一次 ask_user_question 问清再动手，不要调 spec_triage）| 'triage'（先调 spec_triage）",
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.context + (value.notice ? `\n\n${value.notice}` : '') }],
      },
      async execute(args, exec) {
        const cwd = resolveCwd(args.cwd, exec)
        const scope = repoHash(cwd)

        const templates = listTemplates(home, scope)
        const queryFp = buildQueryFp(args.requirement)
        const classification = classifyComplexity(args.requirement)

        // 先对全部模板打分（不截断），把每一份过线模板都记一次命中——
        // 热度加成才反映真实分布。旧版只遍历截断后的前 N 名，第 3 名之后
        // 的高相关模板永远攒不到热度。
        const all = rankTemplates({
          queryFp,
          templates,
          repoHash: scope,
          threshold: config.matchThreshold,
          limit: templates.length || 1,
        })
        for (const r of all) {
          if (r.hit) recordHit(home, r.template.scope, r.template.id)
        }

        const results = all.slice(0, config.maxInjectTemplates)
        const hitTemplates = results.filter((r) => r.hit)
        const redlines = collectRedlines(home, scope, hitTemplates.map((r) => r.template))

        // 0.4.0：召回时顺带给出复杂度分级 —— L1 据此可跳过 spec_triage/spec_distill 两次往返
        // 0.4.3：分级行改成「执行路径」指令式表述，并新增 nextStep 字段。
        //   背景：实测中模型会把 SKILL.md「第 2 步（必做）」当成无条件规则，即使召回已判定
        //   fastTrack 也照样调 spec_triage/spec_distill，一次简单改页面的需求白跑 2 次往返。
        //   修法：把「下一步」写成模型可见的硬指令（nextStep + 首行路径说明），不再只靠隐含约定。
        // 0.4.5：fastTrack 必须在渲染注入之前算出来 —— 注入侧要据此省掉
        //   「澄清清单 + 体检流程行」（那两块与"禁止追问/不要调 triage"冲突，且占返回量七成）。
        const level = classification.level
        const fastTrack = classification.fastTrack === true
        // 0.4.6：新增第三态 'confirm' —— 容器型原子改动但没说清"加的是什么"
        //   （如「登录页加个按钮」）。此时既不该直接实现（要替用户做产品决策），
        //   也不必走完整体检（就缺一个信息）→ 直接要求问一次再动手。
        const contentGap = Array.isArray(classification.contentGap) ? classification.contentGap : []
        const nextStep = fastTrack ? 'implement' : contentGap.length > 0 ? 'confirm' : 'triage'

        const injection = renderInjection({
          results,
          redlines,
          fastTrack,
          maxTemplates: config.maxInjectTemplates,
          maxChars: config.injectMaxChars,
        })

        const levelLine = fastTrack
          ? '> **执行路径：1 步直达。** fastTrack=true（L1 原子改动 / 自包含新建 / 用户已要求不追问）。\n' +
            '> **下一步就是实现**：禁止追问；**不要调用 `spec_triage`，也不要调用 `spec_distill`**（本条已替代它们的产出）。\n' +
            '> 直接改代码，疑虑写 `// TODO: [待确认] <内容>`，最终报告里点出。\n\n'
          : nextStep === 'confirm'
            ? `> **执行路径：先确认再动手。** fastTrack=false（level=L${level}，需求缺内容：${contentGap.join('；')}）。\n` +
              '> **下一步用一次 `ask_user_question` 把上面缺的内容问清**（每题给 2-3 个候选 + 一个推荐默认），\n' +
              '> **不要调用 `spec_triage` / `spec_distill`**；拿到回答后直接实现。提问前禁用文件类工具。\n\n'
            : `> **执行路径：先体检。** fastTrack=false（level=L${level}）。\n` +
              '> **下一步调用 `spec_triage`**（传同一份原文），按它给出的清单再动手：' +
              (level === 3
                ? 'L3 完整先问后查（可 ask_user_question，提问前禁用文件类工具）。\n\n'
                : 'L2 按报告默认值执行、禁止追问（仅"过短且零锚点"会让你一次问清再动手）。\n\n')
        const context = levelLine + injection

        const notice = buildRecallNotice(exec, state, config)

        return {
          matched: hitTemplates.length > 0,
          context,
          redlines,
          templates: results.map((r) => ({
            id: r.template.id,
            name: r.template.name,
            category: r.template.category,
            score: r.score,
            hit: r.hit,
          })),
          notice,
          level,
          fastTrack,
          contentGap,
          nextStep,
        }
      },
    })
  )

  // ---------- 工具 2：体检 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_triage',
      description:
        '四维需求体检（要实现什么/怎么改/哪些不能改/上下文）并标注 Level，返回可直接执行的报告：L1 出执行清单（禁追问）；L2 出默认值清单（按默认执行、禁追问，仅"过短且零锚点"或"缺内容"时转为一次性追问）；L3 出完整追问清单。**仅当 spec_recall 返回 nextStep=triage 时调用**；nextStep=implement（可直接动手）或 confirm（先用 ask_user_question 问清 contentGap）时都不要调用本工具。',
      parameters: {
        requirement: {
          type: 'string',
          required: true,
          description: '用户的原始需求描述',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            mode: { type: 'string', required: true, description: 'fast-track(L1 直接实现) | clarify(需一次性问清) | ready(可直接实现)' },
            level: { type: 'number', required: true, description: '复杂度等级 1|2|3' },
            needsClarify: { type: 'boolean', required: true },
            ready: { type: 'boolean', required: true },
            report: { type: 'string', required: true },
            questions: { type: 'array' },
            classification: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args) {
        // 0.4.3：不再在这里重跑 listTemplates + rankTemplates。
        // 旧实现为了给报告追加「历史模板的澄清清单」，把 spec_recall 刚做过的
        // 「全量模板扫描 + 指纹 + 余弦打分」又完整做了一遍 —— 纯重复劳动；
        // 而这份澄清清单早已随 spec_recall 的注入正文进入上下文，本次不再重复计算。
        const result = triageRequirement(args.requirement)
        const report = renderTriageReport(result)

        const level = result.classification.level
        const mode = level === 1 ? 'fast-track' : result.needsClarify ? 'clarify' : 'ready'

        return {
          mode,
          level,
          needsClarify: result.needsClarify,
          ready: result.ready,
          report,
          // 仅在允许追问时回传问题清单，避免 L2「按默认执行」场景被误当成待澄清
          questions: result.needsClarify
            ? [...result.missing, ...result.partial].map((d) => `${d.label}：${d.question}`)
            : [],
          classification: result.classification,
        }
      },
    })
  )

  // ---------- 工具 3：提炼 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_distill',
      description:
        '把「原始需求 + 澄清答案 + 上下文」蒸馏成结构化实现提示词。需求澄清完毕、动手之前调用（fastTrack=true 的 L1 需求可跳过）。',
      parameters: {
        requirement: { type: 'string', required: true, description: '原始需求' },
        clarifications: {
          type: 'array',
          description: '澄清问答记录，每项形如「问：… 答：…」',
        },
        files: { type: 'array', description: '预期涉及的文件路径' },
        constraints: { type: 'array', description: '本次明确不能改的地方（禁区）' },
        stack: { type: 'string', description: '技术栈说明，如 Spring Boot 2.7 + MyBatis-Plus' },
        acceptance: { type: 'array', description: '验收标准' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            prompt: { type: 'string', required: true },
            missingConstraints: { type: 'boolean', required: true },
          },
        },
        // 0.4.7：missingConstraints 必须在渲染文本里可见。此前 render 只回传 value.prompt，
        // 而结构字段模型看不到 —— SKILL.md 却写着"若返回 missingConstraints: true 就回第 3 步补问"，
        // 属于说明书承诺了、实际拿不到的信息（strictDistill 的"空则报错"也是同一处空承诺）。
        render: (_args, value) => [
          {
            type: 'text',
            text: value.missingConstraints
              ? '⚠️ missingConstraints=true：本次未声明禁区。**动手前先向用户确认哪些文件/行为不允许改动**，再按下面的提示词执行。\n\n' +
                value.prompt
              : value.prompt,
          },
        ],
      },
      async execute(args) {
        const constraints = args.constraints ?? []
        const missingConstraints = config.strictDistill && constraints.length === 0

        const lines = []
        lines.push('# 实现任务')
        lines.push('')
        lines.push('## 目标')
        lines.push(args.requirement.trim())
        lines.push('')

        if (args.stack) {
          lines.push('## 技术栈', '', args.stack.trim(), '')
        }

        if (args.clarifications?.length > 0) {
          lines.push('## 已澄清项', '')
          for (const c of args.clarifications) lines.push(`- ${c}`)
          lines.push('')
        }

        if (args.files?.length > 0) {
          lines.push('## 预期改动范围', '')
          for (const f of args.files) lines.push(`- ${f}`)
          lines.push('')
        }

        lines.push('## 硬约束（违反即失败）', '')
        if (constraints.length > 0) {
          for (const c of constraints) lines.push(`- ${c}`)
        } else if (config.strictDistill) {
          lines.push('- （未提供）**警告：本次未声明禁区。动手前必须向用户确认哪些文件或行为不允许改动。**')
        } else {
          // 0.4.7：原来无论 strictDistill 取什么值都插这句警告 —— 关掉开关也不生效。
          lines.push('- （未提供）')
        }
        lines.push('')

        if (args.acceptance?.length > 0) {
          lines.push('## 验收标准', '')
          for (const a of args.acceptance) lines.push(`- [ ] ${a}`)
          lines.push('')
        }

        lines.push('## 执行要求', '')
        lines.push('1. 严格限定在上述改动范围内，不触碰未列出的文件。')
        lines.push('2. 每完成一处改动，立即自查是否违反硬约束。')
        lines.push('3. 完成后逐条核对验收标准，未通过项如实报告，不要粉饰。')
        lines.push('4. 若实现过程中发现需求仍有歧义，停下来提问，不要擅自假设。')

        return {
          prompt: lines.join('\n'),
          missingConstraints,
        }
      },
    })
  )

  // ---------- 工具 4：沉淀 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_retro',
      description:
        '任务链收尾（改码完成、验证通过、用户无新要求）时把本次做法沉淀为模板，供未来同类需求自动召回。先过复用价值三问（还照做吗/跨项目成立吗/会反复提吗）；纯问答、只读诊断、报错排查、环境修复、一次性任务不调用；用户明确要求时无条件调用。同名需求覆盖更新，不新建。',
      parameters: {
        name: { type: 'string', required: true, description: '模板名称，一句话概括这类需求，如「Spring Boot 新增分页查询接口」' },
        category: { type: 'string', description: '分类，如 feature/api、bugfix/refactor、frontend/component，默认 uncategorized' },
        tags: { type: 'array', description: '标签，用于辅助匹配，如 java、spring-boot、pagination' },
        trigger: { type: 'string', description: '触发场景：什么样的需求描述应该命中这个模板' },
        clarify: { type: 'array', description: '需求澄清清单：下次遇到同类需求时，动手前必须问清楚的问题' },
        approach: { type: 'array', description: '标准改法：按执行顺序排列的步骤' },
        redlines: { type: 'array', description: '禁区：绝对不能改的文件、配置或行为' },
        prompt: { type: 'string', description: '可直接复用的提示词模板' },
        acceptance: { type: 'array', description: '验收标准' },
        persistRedlines: { type: 'boolean', description: '是否把禁区同时写入项目档案，长期生效（默认 true）' },
        scope: { type: 'string', description: 'project（仅当前仓库可用）或 global（跨仓库通用），默认取插件配置' },
        cwd: { type: 'string', description: '当前工作目录绝对路径' },
        digest: { type: 'string', description: '本次会话的过程摘要。留空则自动从会话事件提取' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            saved: { type: 'boolean', required: true },
            id: { type: 'string', required: true },
            file: { type: 'string', required: true },
            scope: { type: 'string', required: true },
            preview: { type: 'string', required: true },
            updated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.saved === false
                ? `模板写盘失败\n${value.preview}`
                : `${value.updated ? '已更新' : '已新建'}模板 \`${value.id}\`（${value.scope} 层）\n路径：${value.file}\n\n${value.preview}`,
          },
        ],
      },
      async execute(args, exec) {
        const cwd = resolveCwd(args.cwd, exec)
        const scopeName = args.scope === 'global' ? 'global' : args.scope === 'project' ? 'project' : config.defaultScope
        const hash = repoHash(cwd)
        const scope = scopeName === 'global' ? 'global' : hash

        // 过程摘要：模型传了就用手传的，否则从会话事件流自动提取。
        // （描述里承诺了"留空自动提取"，旧版从未实现——buildRetroDigest 只 import 没调用。）
        const digest =
          args.digest ||
          (exec?.agent?.session ? buildRetroDigest(exec.agent.session, 1500) : '') ||
          ''

        const id = templateId(args.name, scope)
        const existing = listTemplates(home, scope).find((t) => t.id === id)
        const updated = Boolean(existing)

        // 禁区合并：新模板的禁区 + 项目档案既有禁区，近重复去重
        // 0.4.5：原来只做 `new Set` 字符串级去重，同一规则换个括号说明或改个语序就漏过去了。
        const profile = readProfile(home, hash)
        const redlines = dedupeRedlines([...(args.redlines ?? []), ...profile.redlines])

        const body = renderTemplateMarkdown({
          name: args.name,
          category: args.category || 'uncategorized',
          tags: args.tags ?? [],
          trigger: args.trigger || `当用户提出「${args.name}」这类需求时适用。`,
          // 0.4.7：条目提取统一走 store 层的 bulletLines（唯一实现）——
          // 它会剥掉验收标准的 `[ ]` 前缀，否则覆盖更新会把 `- [ ] x` 叠成 `- [ ] [ ] x`。
          clarify: mergeList(existing ? bulletLines(sectionOf(existing.body, SECTIONS.clarify)) : [], args.clarify ?? []),
          approach: args.approach ?? [],
          redlines,
          prompt: args.prompt || digest || '',
          acceptance: mergeList(
            existing ? bulletLines(sectionOf(existing.body, SECTIONS.acceptance)) : [],
            args.acceptance ?? []
          ),
          repoName: profile.repoName || cwd,
        })

        // 模板写盘：失败不抛到 dsh（旧版 saved 硬编码 true，写失败会直接冒泡）。
        let saved
        let writeError = null
        try {
          saved = writeTemplate(
            home,
            scope,
            id,
            {
              name: args.name,
              category: args.category || 'uncategorized',
              tags: args.tags ?? [],
              // 指纹正文：name+trigger+tags 太单薄，且旧版引用了参数表里不存在的
              // args.requirement（恒 undefined），等于只有三个来源。补上 approach 与
              // digest 前缀，把真实做过的事带进指纹，召回才能命中。
              fingerprint: fingerprint(
                [
                  args.name,
                  args.trigger ?? '',
                  (args.tags ?? []).join(' '),
                  (args.approach ?? []).join(' '),
                  digest.slice(0, 300),
                ]
                  .filter(Boolean)
                  .join(' ')
              ).map(({ token, weight }) => `${token}|${weight}`),
              repo: scope === 'global' ? '' : scope,
              hitCount: existing?.hitCount ?? 0,
              created: existing?.created,
            },
            body
          )
        } catch (err) {
          writeError = err
          ctx.logger?.warn?.(`[spec-forge] 模板写盘失败: ${err.message}`)
        }

        // 禁区写入项目档案，长期生效
        // 0.4.7：去掉 `hash !== 'global'` —— repoHash() 只可能返回 sha 片段或 'no-repo'，
        // 该条件恒为真，属于"看起来在防护、实际什么也没挡"的死守卫。
        if (!writeError && args.persistRedlines !== false && redlines.length > 0) {
          try {
            writeProfile(home, hash, {
              repoName: profile.repoName || cwd,
              redlines: dedupeRedlines([...profile.redlines, ...(args.redlines ?? [])]),
            })
          } catch (err) {
            ctx.logger?.warn?.(`[spec-forge] 禁区写入项目档案失败: ${err.message}`)
          }
        }

        if (writeError) {
          // 0.4.7：写盘失败时**不能**标记本会话已沉淀。原来这里先 state.retroDone.add()
          // 再 return，后果是"提醒永久失效"：retroDone 会让后续所有 buildRecallNotice 直接短路，
          // 用户再也收不到"本会话还没沉淀"的提示，而返回值却说"下次重试"。
          return {
            saved: false,
            id,
            file: '',
            scope,
            updated,
            preview: `模板未能写入磁盘（${writeError.message}）。内容没有丢失：请在会话里把 name/approach/redlines 直接贴给下一次 spec_retro 重试。`,
          }
        }

        const sessionId = exec?.agent?.session?.id
        if (sessionId) state.retroDone.add(sessionId)

        return {
          saved: true,
          id,
          file: saved.file,
          scope,
          updated,
          // 0.4.7：原为 `digest || buildPreview(args)` —— 只要有会话 digest 就非空，
          // buildPreview 永不执行（死代码）。过程摘要本身就是"本次沉淀内容"最完整的呈现。
          preview: digest || '(未生成过程摘要)',
        }
      },
    })
  )

  ctx.logger?.info?.(
    `[spec-forge] 已加载，存储模式 ${storageMode}，数据目录 ${home}`
  )
}

// ---------- 辅助函数 ----------

function resolveCwd(explicit, exec) {
  return explicit || exec?.agent?.session?.cwd || exec?.agent?.cwd || process.cwd()
}

function mergeList(existing, incoming) {
  return [...new Set([...existing, ...incoming])].filter(Boolean)
}

/**
 * 构造查询指纹：tokens + tags + category 三件套。
 * 打分器里 0.14 同分类与 0.08 标签重叠需要查询侧补齐这两个字段，
 * 否则天平只接模板一边、两项恒为 0（0.3.1 曾因此在 spec_recall 漏接，spec_triage 同病）。
 */
function buildQueryFp(requirement) {
  // 查询侧聚焦：长需求原话先削掉低信号 2-gram 尾巴再进打分，
  // 避免叙述性文字稀释余弦/覆盖率（见 lib/fingerprint.js focusFingerprint）。
  const fp = focusFingerprint(fingerprint(requirement))
  fp.tags = inferQueryTags(requirement)
  const category = inferQueryCategory(requirement)
  if (category) fp.category = category
  return fp
}

function buildRecallNotice(exec, state, config) {
  if (config.autoRetro === false) return ''
  const session = exec?.agent?.session
  const sessionId = session?.id
  if (!sessionId || state.retroDone.has(sessionId)) return ''
  // 用当前会话事件流实时做门槛判定（第一层硬过滤）：
  // 会话至今改过代码且工具调用达到下限 → 说明有已完成任务可能未沉淀，提示一次。
  const facts = extractSessionFacts(session)
  // 0.4.7：把 isSessionComplete 真正接上。此前这里只传两个选项，`sessionComplete` 恒为
  // 默认 true —— "上一轮已完成"这条门槛从未被评估过，任务做到一半也会催沉淀，
  // 而提示语里那句"已完成的编程任务"是空话（extract.js 的 sessionComplete 形参无人使用）。
  const completion = isSessionComplete(session)
  const gate = evaluateRetroEligibility(facts, {
    minToolCalls: config.retroMinToolCalls,
    // 缺键 = 保持 schema 默认（true）；只有显式 false 才关掉"必须真改过代码"这道门槛。
    requireCodeChange: config.retroRequireCodeChange !== false,
    sessionComplete: completion.complete,
  })
  if (!gate.eligible) return ''
  return (
    '提示：本会话有已完成的编程任务但尚未沉淀为模板（检测到真实改码 ' +
    `${gate.writeToolCalls} 次）。先过一遍复用价值三问（下次是否还这么干 / 结论是否` +
    '跨项目成立 / 用户是否会反复提），有复用价值就先调用 `spec_retro` 沉淀成模板，' +
    '再开始本次需求；确无复用价值可忽略并继续。'
  )
}

/** 插件身份：注入消息的 source.plugin（字段约定同内置插件 dsh-repeat-tool-reminder） */
const PLUGIN_ID = 'dsh-spec-forge'

/** 取出消息的纯文本（content 可能是字符串、也可能是 [{type:'text',text}] 数组） */
function messageTextOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? (part.text ?? '') : ''))
    .join('\n')
}

/**
 * 从本轮消息里挑出「用户原始需求」。
 * 优先 `source.kind === 'user'`（真实用户输入的标记，内置插件也用它判断）；
 * 拿不到时退回到"最后一条非插件注入、且不含 system-reminder"的用户角色消息 ——
 * **必须排除插件注入**（runtime-context / 政策快照 / 技能目录都是 role=user 且不带
 * system-reminder 的消息），否则会把"当前运行时上下文"当成用户需求拿去分级。
 */
function pickRequirementMessage(messages) {
  const users = messages.filter((m) => m?.role === 'user')
  const real = users.find((m) => m?.source?.kind === 'user')
  if (real) return real
  return users.find((m) => !m?.source?.plugin && !/<system-reminder>/.test(messageTextOf(m))) ?? null
}

function shortDigest(text) {
  return createHash('sha256').update(String(text ?? '').trim()).digest('hex').slice(0, 12)
}

/**
 * 注入消息：与内置插件 `createUserMessage` 同形（稳定 id + 不可变内容）。
 * source 里额外带上 `plugin` / `digest` / `turn`，供幂等判定与会话回放时去重。
 */
function createNoticeMessage(text, { digest, turn, classification }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: 'plugin',
      plugin: PLUGIN_ID,
      form: 'notice',
      digest,
      turn,
      summary: classification?.fastTrack === true ? 'L1 一步直达' : '需求缺内容',
    }),
  })
}

export { extractSessionFacts, isSessionComplete, buildRetroDigest }

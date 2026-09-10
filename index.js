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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { fingerprint, focusFingerprint, inferQueryTags } from './lib/fingerprint.js'
import { classifyComplexity, inferQueryCategory } from './lib/classify.js'
import { rankTemplates } from './lib/match.js'
import { buildRetroDigest, evaluateRetroEligibility, extractSessionFacts, isSessionComplete } from './lib/extract.js'
import {
  bumpWriteEpoch,
  collectRedlines,
  copyTree,
  dataRoot,
  describeStore,
  isCrossDrive,
  listTemplates,
  purgeStale,
  readProfile,
  recordHit,
  repoHash,
  resolveHome,
  resolveStorageRoot,
  staleTemplates,
  templateId,
  writeProfile,
  writeTemplate,
} from './lib/store.js'
import {
  SECTIONS,
  renderInjection,
  renderTemplateMarkdown,
  renderTriageReport,
  sectionOf,
  triageRequirement,
} from './lib/render.js'

export const name = 'spec-forge'

// 只把 tools 作为硬依赖；systemPrompt / skills 用 ctx.get 探测，缺失也能跑。
export const inject = ['tools']

export const schema = Schema.object({
  autoRecall: Schema.boolean().default(true).description('是否在收到编程需求时自动召回历史模板'),
  autoRetro: Schema.boolean().default(true).description('是否在任务完成后提示沉淀复盘'),
  matchThreshold: Schema.number().min(0).max(1).default(0.35).description('模板命中阈值，0~1，越低越容易命中'),
  maxInjectTemplates: Schema.number().min(1).max(5).default(2).description('单次最多注入几份历史模板'),
  injectMaxChars: Schema.number().min(500).max(20000).default(4000).description('注入上下文的最大字符数'),
  defaultScope: Schema.union(['project', 'global']).default('project').description('沉淀默认落在项目层还是全局层'),
  storageHome: Schema.string().default('').description('自定义数据目录（绝对路径）。非空时优先于 storageRoot'),
  storageRoot: Schema.string().default('workspace').description('存储模式：workspace 跟当前工作目录（推荐，跨盘时避免 EPERM）/home 放 $DSH_HOME（兼容旧版默认）'),
  retroMinToolCalls: Schema.number().min(0).default(2).description('自动复盘要求的最少工具调用次数，低于此值视为未真正动手'),
  retroRequireCodeChange: Schema.boolean().default(true).description('自动沉淀提醒要求本会话真实改过代码（有 edit/write 类工具调用），纯问答/只读诊断不提醒'),
  strictDistill: Schema.boolean().default(true).description('提炼提示词时是否强制要求填写禁区，空则报错'),
})

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

  // 会话级状态：只存标记位，不存内容，避免占用内存与持久化风险
  const state = {
    retroDone: new Set(), // sessionId：已成功沉淀过的会话，不再打扰
  }

  // ---------- 第 1 层：常驻系统提示词（必须短，0.3.2 精简后约 400 token/请求） ----------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt?.section && config.autoRecall) {
    systemPrompt.section({
      name: 'spec-forge:routing',
      order: 150,
      text: [
        '## 需求锻造（spec-forge）',
        '编程需求：spec_recall →（按需 spec_triage / spec_distill）→ 实现 → 收尾 spec_retro。',
        '1. 先 spec_recall（传原文），返回历史模板、项目禁区与 fastTrack。',
        '2. fastTrack=true（L1）：禁止追问，跳过 triage/distill，直接实现；疑虑写 `// TODO: [待确认]` 并在报告点出。',
        '   否则看 spec_triage 等级：L2 按报告默认值执行、禁止追问（仅"过短且零锚点"会让你一次问清再动手）；',
        '   L3 完整先问后查。含"直接做/速做/不用问/别问/不要问/极速模式"→ 无条件 fastTrack。',
        '   仅 L3 与 L2 安全阀可 ask_user_question；提问前禁用任何文件类工具（read/grep/glob/bash/ls），一次问完。',
        '3. 大文件纪律：>20K 字符的文件禁止整文件 read，先 grep 定位再分段读；确需整读先落要点摘要。',
        '4. 收尾过复用价值三问（还会照做/跨项目成立/会反复提）后 spec_retro 一次；纯问答、只读诊断、',
        '   报错排查、环境修复不沉淀；用户明确要求时无条件沉淀。',
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

  // ---------- 第 3 层：兜底提醒（模型漏调 spec_retro 时提示） ----------
  // 注意：dsh 的 turn/end 事件载荷不含 session 事件流（data 只有 {turn, reason}），
  // 无法在此做沉淀门槛判定；旧版靠 turn.session/steps 的写法实际永远不触发。
  // 兜底已改到 spec_recall execute 内用 exec.agent.session 惰性判定（见 buildRecallNotice），
  // 每次召回时若发现「上一轮已完成且真实改过代码但尚未沉淀」，随召回结果附带一行提示。

  // ---------- 工具 1：召回 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_recall',
      description:
        '检索历史提示词模板库，返回命中模板（澄清清单/标准改法/验收标准）、本项目禁区，以及复杂度分级（level 与 fastTrack）。用户提出编程需求时在任何代码改动之前调用，是硬性前置步骤。',
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
            fastTrack: { type: 'boolean', description: 'true 时可跳过 spec_triage 与 spec_distill，直接实现' },
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

        const injection = renderInjection({
          results,
          redlines,
          maxTemplates: config.maxInjectTemplates,
          maxChars: config.injectMaxChars,
        })

        // 0.4.0：召回时顺带给出复杂度分级 —— L1 据此可跳过 spec_triage/spec_distill 两次往返
        const level = classification.level
        const fastTrack = classification.fastTrack === true
        const levelLine = fastTrack
          ? '> **分级：L1 快速通道（fastTrack=true）** —— 禁止追问；跳过 spec_triage 与 spec_distill，直接实现。\n\n'
          : `> **分级：L${level}** —— ${
              level === 3
                ? 'L3 架构重构，先问后查（可 ask_user_question）。'
                : 'L2 模块变更，按报告默认值执行、禁止追问。'
            }\n\n`
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
        }
      },
    })
  )

  // ---------- 工具 2：体检 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_triage',
      description:
        '四维需求体检（要实现什么/怎么改/哪些不能改/上下文）并标注 Level，返回可直接执行的报告：L1 出执行清单（禁追问）；L2 出默认值清单（按默认执行、禁追问，仅"过短且零锚点"时转为一次性追问）；L3 出完整追问清单。仅当 spec_recall 返回 fastTrack=false 时调用。',
      parameters: {
        requirement: {
          type: 'string',
          required: true,
          description: '用户的原始需求描述',
        },
        cwd: {
          type: 'string',
          description: '当前工作目录绝对路径',
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
      async execute(args, exec) {
        const result = triageRequirement(args.requirement)

        // 若有命中模板，把它的澄清清单作为追加确认项，实现「模板越用越贴合」
        const scope = repoHash(resolveCwd(args.cwd, exec))
        const templates = listTemplates(home, scope)
        const results = rankTemplates({
          queryFp: buildQueryFp(args.requirement),
          templates,
          repoHash: scope,
          threshold: config.matchThreshold,
          limit: 1,
        })
        const hints = results
          .filter((r) => r.hit)
          .flatMap((r) => bulletsOf(sectionOf(r.template.body, SECTIONS.clarify)))
          .slice(0, 5)

        const report = renderTriageReport(result, { templateHints: hints })

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
        render: (_args, value) => [{ type: 'text', text: value.prompt }],
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
        } else {
          lines.push('- （未提供）**警告：本次未声明禁区。动手前必须向用户确认哪些文件或行为不允许改动。**')
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

        // 禁区合并：新模板的禁区 + 项目档案既有禁区，去重
        const profile = readProfile(home, hash)
        const redlines = [...new Set([...(args.redlines ?? []), ...profile.redlines])]

        const body = renderTemplateMarkdown({
          name: args.name,
          category: args.category || 'uncategorized',
          tags: args.tags ?? [],
          trigger: args.trigger || `当用户提出「${args.name}」这类需求时适用。`,
          clarify: mergeList(existing ? bulletsOf(sectionOf(existing.body, SECTIONS.clarify)) : [], args.clarify ?? []),
          approach: args.approach ?? [],
          redlines,
          prompt: args.prompt || digest || '',
          acceptance: mergeList(
            existing ? bulletsOf(sectionOf(existing.body, SECTIONS.acceptance)) : [],
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
        if (!writeError && args.persistRedlines !== false && hash !== 'global' && redlines.length > 0) {
          try {
            writeProfile(home, hash, {
              repoName: profile.repoName || cwd,
              redlines: [...new Set([...profile.redlines, ...(args.redlines ?? [])])],
              conventions: profile.conventions,
              notes: profile.notes,
            })
          } catch (err) {
            ctx.logger?.warn?.(`[spec-forge] 禁区写入项目档案失败: ${err.message}`)
          }
        }

        const sessionId = exec?.agent?.session?.id
        if (sessionId) {
          state.retroDone.add(sessionId)
        }

        if (writeError) {
          return {
            saved: false,
            id,
            file: '',
            scope,
            updated,
            preview: `模板未能写入磁盘（${writeError.message}）。内容没有丢失：请在会话里把 name/approach/redlines 直接贴给下一次 spec_retro 重试。`,
          }
        }

        return {
          saved: true,
          id,
          file: saved.file,
          scope,
          updated,
          preview: digest || buildPreview(args),
        }
      },
    })
  )

  // ---------- 工具 5：模板库状态 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_library',
      description:
        '模板库管理。action=list：列模板清单/命中统计/项目禁区/过期模板（用户问「模板库里有什么」时用；purge=true 才物理删除）。action=info：查看存储模式、数据目录、跨盘状态与旧路径数据量。action=migrate：把旧 $DSH_HOME/spec-forge 复制到当前数据目录（move=true 删源）。',
      parameters: {
        action: {
          type: 'string',
          description: "'list'（默认）模板清单 | 'info' 存储路径与模式 | 'migrate' 迁移旧数据",
        },
        cwd: { type: 'string', description: '当前工作目录绝对路径' },
        purge: {
          type: 'boolean',
          description:
            'list 时是否物理删除过期模板（>90 天未命中）。默认 false 只统计；必须用户明确表达「清理/删除过期模板」才传 true，删除不可恢复。',
        },
        move: {
          type: 'boolean',
          description: 'migrate 时是否删除源文件，默认 false（复制保留源）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            report: { type: 'string', required: true },
            total: { type: 'number' },
            removed: { type: 'number' },
            action: { type: 'string' },
            mode: { type: 'string' },
            storagePath: { type: 'string' },
            crossDrive: { type: 'boolean' },
            legacy: { type: 'object', additionalProperties: true },
            migration: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args, exec) {
        const action = args.action || 'list'
        const cwd = resolveCwd(args.cwd, exec)

        // 0.4.0：原 spec_store 的能力并入本工具，避免多一个常驻工具定义
        if (action === 'info' || action === 'migrate') {
          return runStoreAction(action, {
            cwd,
            move: args.move === true,
            home,
            storageMode,
            logger: ctx.logger,
          })
        }

        const scope = repoHash(cwd)

        let removed = 0
        if (args.purge === true) {
          removed = purgeStale(home, scope, 90)
        }
        const stale = staleTemplates(home, scope)
        const info = describeStore(home, scope)
        const templates = listTemplates(home, scope)

        const lines = []
        lines.push('## 提示词模板库')
        lines.push('')
        lines.push(`- 数据目录：\`${info.home}\``)
        lines.push(`- 当前仓库哈希：\`${info.repoHash}\``)
        lines.push(`- 模板总数：${info.total}（项目层 ${info.projectCount}，全局层 ${info.globalCount}）`)
        lines.push('')

        if (templates.length > 0) {
          lines.push('| 模板 | 分类 | 层级 | 命中次数 | 最近使用 |')
          lines.push('| --- | --- | --- | --- | --- |')
          for (const t of templates.sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))) {
            lines.push(
              `| ${t.name} | \`${t.category}\` | ${t.scope === 'global' ? '全局' : '项目'} | ${t.hitCount ?? 0} | ${t.lastUsed ? String(t.lastUsed).slice(0, 10) : '—'} |`
            )
          }
          lines.push('')
        } else {
          lines.push('模板库还是空的。完成第一个任务后调用 `spec_retro` 即可沉淀。')
          lines.push('')
        }

        if (removed > 0) {
          lines.push(`已按用户要求清理 ${removed} 个过期模板（≥90 天未使用）。`)
          lines.push('')
        } else if (stale.length > 0) {
          lines.push(`### 过期模板（≥90 天未使用，${stale.length} 个）`)
          lines.push('')
          lines.push('这些模板长期未被召回命中。模板库不是越堆越好——过期模板会稀释检索精度。')
          lines.push('如需删除请在对话中明确说「清理过期模板」，会物理删除且不可恢复。')
          lines.push('')
          for (const t of stale) {
            const last = t.lastUsed || t.updated || t.created || ''
            lines.push(
              `- ${t.name}（${t.scope === 'global' ? '全局' : '项目'}，最近使用 ${String(last).slice(0, 10) || '未知'}）`
            )
          }
          lines.push('')
        }

        if (info.profile.redlines.length > 0) {
          lines.push('### 项目禁区（长期生效）')
          lines.push('')
          for (const r of info.profile.redlines) lines.push(`- ${r}`)
        }

        return { report: lines.join('\n'), total: info.total, removed, action: 'list' }
      },
    })
  )

  ctx.logger?.info?.(
    `[spec-forge] 已加载，存储模式 ${storageMode}，数据目录 ${home}`
  )
}

// ---------- 辅助函数 ----------

/**
 * spec_library 的 info / migrate 分支（0.4.0 由原 spec_store 工具并入，减少一个常驻工具定义）。
 */
function runStoreAction(action, { cwd, move, home, storageMode, logger }) {
  const legacyPath = dataRoot(resolveHome())
  const crossDrive = isCrossDrive(cwd, legacyPath)
  const projectHash = repoHash(cwd)

  const legacy = { hasData: false, projectCount: 0, globalCount: 0, projectHash }
  try {
    const srcProj = join(legacyPath, 'projects', projectHash)
    const srcGlobal = join(legacyPath, 'global')
    if (existsSync(srcProj)) legacy.projectCount = listTemplates(legacyPath, projectHash).length
    if (existsSync(srcGlobal)) legacy.globalCount = listTemplates(legacyPath, 'global').length
    legacy.hasData = legacy.projectCount + legacy.globalCount > 0
  } catch (err) {
    logger?.warn?.(`[spec-forge] 旧路径扫描失败: ${err.message}`)
  }

  let migration
  if (action === 'migrate') {
    const ops = []
    const srcGlobal = join(legacyPath, 'global')
    const srcProj = join(legacyPath, 'projects', projectHash)
    if (existsSync(srcGlobal)) ops.push(copyTree(srcGlobal, join(home, 'global'), move))
    if (existsSync(srcProj)) ops.push(copyTree(srcProj, join(home, 'projects', projectHash), move))
    migration = {
      copied: ops.reduce((n, o) => n + o.copied, 0),
      skipped: ops.reduce((n, o) => n + o.skipped, 0),
      report: ops.map((o) => o.report).filter(Boolean).join('\n') || '(无文件复制)',
    }
    bumpWriteEpoch()
  }

  const lines = ['## 模板库存储', '']
  lines.push(`- 模式：\`${storageMode}\``)
  lines.push(`- 数据目录：\`${home}\``)
  lines.push(`- 当前工作目录：\`${cwd}\``)
  lines.push(`- 旧路径（$DSH_HOME/spec-forge）：\`${legacyPath}\``)
  lines.push(`- 当前项目哈希：\`${projectHash}\``)
  if (crossDrive) lines.push('- ⚠️ 检测到跨盘（cwd 与 $DSH_HOME 不同盘）。workspace 模式已规避跨盘写。')
  lines.push('')
  lines.push('### 旧路径数据概览')
  lines.push('')
  if (legacy.hasData) {
    lines.push(`- 全局层模板：${legacy.globalCount}`)
    lines.push(`- 当前项目层模板：${legacy.projectCount}`)
  } else {
    lines.push('- 旧路径无数据（global/ 或 projects/<hash> 不存在或为空）')
  }
  lines.push('')
  if (migration) {
    lines.push('### 迁移结果')
    lines.push('')
    lines.push(`- 复制：${migration.copied} 个文件；跳过（目标已存在）：${migration.skipped} 个`)
    lines.push('')
    lines.push('```')
    lines.push(migration.report)
    lines.push('```')
  } else if (action === 'migrate') {
    lines.push('未发现可迁移的旧数据，迁移执行了 0 次拷贝。')
  } else {
    lines.push('迁移用 `spec_library({ action: "migrate" })`：默认复制保留源，确认后再传 `move: true` 删源。')
  }

  return {
    report: lines.join('\n'),
    action,
    mode: storageMode,
    storagePath: home,
    crossDrive,
    legacy,
    migration,
  }
}

function resolveCwd(explicit, exec) {
  return explicit || exec?.agent?.session?.cwd || exec?.agent?.cwd || process.cwd()
}

function bulletsOf(section) {
  return String(section ?? '')
    .split(/\r?\n/)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1]?.trim())
    .filter((l) => l && !l.startsWith('（'))
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
  if (!config.autoRetro) return ''
  const session = exec?.agent?.session
  const sessionId = session?.id
  if (!sessionId || state.retroDone.has(sessionId)) return ''
  // 用当前会话事件流实时做门槛判定（第一层硬过滤）：
  // 会话至今改过代码且工具调用达到下限 → 说明有已完成任务可能未沉淀，提示一次。
  const facts = extractSessionFacts(session)
  const gate = evaluateRetroEligibility(facts, {
    minToolCalls: config.retroMinToolCalls,
    requireCodeChange: config.retroRequireCodeChange,
  })
  if (!gate.eligible) return ''
  return (
    '提示：本会话有已完成的编程任务但尚未沉淀为模板（检测到真实改码 ' +
    `${gate.writeToolCalls} 次）。先过一遍复用价值三问（下次是否还这么干 / 结论是否` +
    '跨项目成立 / 用户是否会反复提），有复用价值就先调用 `spec_retro` 沉淀成模板，' +
    '再开始本次需求；确无复用价值可忽略并继续。'
  )
}

function buildPreview(args) {
  const lines = ['本次沉淀内容：', '']
  if (args.trigger) lines.push(`- 触发场景：${args.trigger}`)
  if (args.clarify?.length) lines.push(`- 澄清项 ${args.clarify.length} 条`)
  if (args.approach?.length) lines.push(`- 改法 ${args.approach.length} 步`)
  if (args.redlines?.length) lines.push(`- 禁区 ${args.redlines.length} 条`)
  if (args.acceptance?.length) lines.push(`- 验收标准 ${args.acceptance.length} 条`)
  return lines.join('\n')
}

export { extractSessionFacts, isSessionComplete, buildRetroDigest }

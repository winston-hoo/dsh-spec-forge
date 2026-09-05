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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { fingerprint } from './lib/fingerprint.js'
import { rankTemplates } from './lib/match.js'
import { buildRetroDigest, evaluateRetroEligibility, extractSessionFacts, isSessionComplete } from './lib/extract.js'
import {
  collectRedlines,
  dataRoot,
  describeStore,
  listTemplates,
  readProfile,
  recordHit,
  repoHash,
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
  storageHome: Schema.string().default('').description('自定义数据目录，留空则用 $DSH_HOME/spec-forge'),
  retroMinToolCalls: Schema.number().min(0).default(2).description('自动复盘要求的最少工具调用次数，低于此值视为未真正动手'),
  retroRequireCodeChange: Schema.boolean().default(true).description('自动沉淀提醒要求本会话真实改过代码（有 edit/write 类工具调用），纯问答/只读诊断不提醒'),
  strictDistill: Schema.boolean().default(true).description('提炼提示词时是否强制要求填写禁区，空则报错'),
})

const __dirname = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, config) {
  const home = config.storageHome || undefined
  const root = dataRoot(home)

  // 会话级状态：只存标记位，不存内容，避免占用内存与持久化风险
  const state = {
    retroDone: new Set(), // sessionId：已成功沉淀过的会话，不再打扰
  }

  // ---------- 第 1 层：常驻系统提示词（必须短，控制在 200 token 内） ----------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt?.section && config.autoRecall) {
    systemPrompt.section({
      name: 'spec-forge:routing',
      order: 150,
      text: [
        '## 需求锻造（spec-forge）',
        '收到编程类需求时，按以下顺序执行，不要跳过：',
        '1. 先调用 `spec_recall` 检索历史模板与本项目禁区，再动手。',
        '2. 调用 `spec_triage` 做需求完整度体检。报告会标注 Level 1/2/3，',
        '   **严格按报告等级执行**：',
        '   - **Level 1 原子操作**（单文件 CRUD + 组件/默认值已明确）：直接看报告里的',
        '     "直接执行清单"动手，扫描现有代码风格自举，不许追问。',
        '     对默认值有疑虑就用 `// TODO: [待确认]` 标注，最终报告里点出。',
        '   - **Level 2 模块变更**（最多 3 个追问）：把报告里"需要先向你确认"的问题整理给用户，',
        '     已推断的默认值会一起给出（"不答复即按此执行"）。',
        '   - **Level 3 架构重构**：完整 Grill-me 追问流程，无问题数上限。',
        '   **跳过词规则**：用户消息中包含"直接做 / 速做 / 不用问 / 别问 / 不要问 / 极速模式"',
        '   任意一个 → 无条件 Level 1。',
        '   **急停规则（无条件遵守）：任何等级下，提问之前禁止调用任何文件类工具**——',
        '   read_file、read_dir、grep、glob、find、search、bash、ls、tree 一律不许碰。',
        '   即使你对项目一无所知，也必须先问（Level 2/3）或先动手（Level 1），不要预扫工作区。',
        '3. 需求明确后调用 `spec_distill` 生成结构化提示词，作为后续实现的执行依据。',
        '4. 任务链真正收尾（改码完成且验证通过）后调用 `spec_retro` 沉淀成模板，一次即可，链内小修合并进最终那份。',
        '   调用前过复用价值三问（下次是否还这么干/结论是否跨项目成立/用户是否会反复提）；',
        '   纯问答、只读诊断、一次性改动不调；用户说"沉淀/总结/记到模板库"则必须调。',
        '禁区是硬约束：任何被标记为禁区的文件或行为，一律不得修改。',
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
        '检索历史提示词模板库。当用户提出编程需求（新增功能、修改、重构、修 Bug、样式调整等）时，在任何代码改动之前调用。返回命中的历史模板（澄清清单、标准改法、验收标准）与本项目禁区。这是硬性前置步骤。',
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
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.context + (value.notice ? `\n\n${value.notice}` : '') }],
      },
      async execute(args, exec) {
        const cwd = resolveCwd(args.cwd, exec)
        const scope = repoHash(cwd)

        const templates = listTemplates(home, scope)
        const queryFp = fingerprint(args.requirement)
        const results = rankTemplates({
          queryFp,
          templates,
          repoHash: scope,
          threshold: config.matchThreshold,
          limit: config.maxInjectTemplates,
        })

        // 记录命中，让高频模板在后续检索中逐渐占优
        for (const r of results) {
          if (r.hit) recordHit(home, r.template.scope, r.template.id)
        }

        const hitTemplates = results.filter((r) => r.hit)
        const redlines = collectRedlines(home, scope, hitTemplates.map((r) => r.template))

        const context = renderInjection({
          results,
          redlines,
          maxTemplates: config.maxInjectTemplates,
          maxChars: config.injectMaxChars,
        })

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
        }
      },
    })
  )

  // ---------- 工具 2：体检 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_triage',
      description:
        '对用户需求做完整度体检，从「要实现什么、要怎么改、哪些不能改、上下文」四个维度识别信息缺口。报告头部会标注 Level 1/2/3：Level 1 原子操作（单文件 CRUD + 组件/默认值明确）输出"直接执行清单"与风格自举要求，**禁止追问**；Level 2 模块变更最多 3 个追问，每题报告里已给默认值；Level 3 架构重构走完整 Grill-me。判定 Level 1 的关键信号：用户消息中包含"直接做/速做/不用问/别问/不要问/极速模式"任意一个 → 无条件 Level 1。',
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
            mode: { type: 'string', required: true, description: 'fast-track(L1) | clarify(L2/L3 待追问) | ready(可直接实现)' },
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
          queryFp: fingerprint(args.requirement),
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
          questions: [...result.missing, ...result.partial].map((d) => `${d.label}：${d.question}`),
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
        '把「原始需求 + 澄清答案 + 上下文」蒸馏成一段结构化、可直接执行的实现提示词。在需求已澄清完毕、即将开始写代码之前调用。产出的是确定性的结构化文本，不再经过模型二次加工，因此可复现、可比对。',
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
        '任务链结束时做归类总结并沉淀为模板（供未来同类需求自动召回复用）。调用时机与取舍：1) 仅当一条任务链真正收尾——改动完成、验证通过、用户未提出新的修改要求——时调用一次，链内的小修小补不要中途反复调用，合并进最终那一份；2) 调用前先过复用价值三问：下次遇到同类需求是否还会照此做法？结论是否离了本项目仍成立？用户是否会反复提这类需求？三问任一为否则不调；3) 纯问答、只读诊断、一次性临时任务绝不调用；4) 用户明确要求沉淀（说"沉淀/总结/记到模板库"等）时无条件调用。写库后同类需求会被 spec_recall 自动召回。',
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
            text: `${value.updated ? '已更新' : '已新建'}模板 \`${value.id}\`（${value.scope} 层）\n路径：${value.file}\n\n${value.preview}`,
          },
        ],
      },
      async execute(args, exec) {
        const cwd = resolveCwd(args.cwd, exec)
        const scopeName = args.scope === 'global' ? 'global' : args.scope === 'project' ? 'project' : config.defaultScope
        const hash = repoHash(cwd)
        const scope = scopeName === 'global' ? 'global' : hash

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
          prompt: args.prompt || args.requirement || '',
          acceptance: mergeList(
            existing ? bulletsOf(sectionOf(existing.body, SECTIONS.acceptance)) : [],
            args.acceptance ?? []
          ),
          repoName: profile.repoName || cwd,
        })

        const saved = writeTemplate(
          home,
          scope,
          id,
          {
            name: args.name,
            category: args.category || 'uncategorized',
            tags: args.tags ?? [],
            fingerprint: fingerprint(`${args.name} ${args.trigger ?? ''} ${(args.tags ?? []).join(' ')} ${args.requirement ?? ''}`).map(
              ({ token, weight }) => `${token}|${weight}`
            ),
            repo: scope === 'global' ? '' : scope,
            hitCount: existing?.hitCount ?? 0,
            created: existing?.created,
          },
          body
        )

        // 禁区写入项目档案，长期生效
        if (args.persistRedlines !== false && hash !== 'global' && redlines.length > 0) {
          writeProfile(home, hash, {
            repoName: profile.repoName || cwd,
            redlines: [...new Set([...profile.redlines, ...(args.redlines ?? [])])],
            conventions: profile.conventions,
            notes: profile.notes,
          })
        }

        const sessionId = exec?.agent?.session?.id
        if (sessionId) {
          state.retroDone.add(sessionId)
        }

        return {
          saved: true,
          id,
          file: saved.file,
          scope,
          updated,
          preview: args.digest || buildPreview(args),
        }
      },
    })
  )

  // ---------- 工具 5：模板库状态 ----------

  ctx.tools.register(
    defineTool({
      name: 'spec_library',
      description:
        '查看提示词模板库的状态与清单：数据目录、当前仓库哈希、模板总数、项目禁区。当用户询问「模板库里有什么」「都沉淀了哪些模板」时调用。',
      parameters: {
        cwd: { type: 'string', description: '当前工作目录绝对路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            report: { type: 'string', required: true },
            total: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args, exec) {
        const cwd = resolveCwd(args.cwd, exec)
        const scope = repoHash(cwd)
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

        if (info.profile.redlines.length > 0) {
          lines.push('### 项目禁区（长期生效）')
          lines.push('')
          for (const r of info.profile.redlines) lines.push(`- ${r}`)
        }

        return { report: lines.join('\n'), total: info.total }
      },
    })
  )

  ctx.logger?.info?.(`[spec-forge] 已加载，数据目录 ${root}`)
}

// ---------- 辅助函数 ----------

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

// 渲染层：把结构化数据变成 Markdown 文本。
// 分两类产物：落盘的模板文件、注入给模型看的上下文片段（后者必须省 token）。

import { sectionOf } from './store.js'
import {
  ELEMENT_COMPONENT_FOR_TYPE,
  L1_DEFAULTS,
  classifyComplexity,
} from './classify.js'

// 段落提取在 store 层实现，此处透出，让消费侧只依赖 render 一个模块
export { sectionOf }

/** 模板的标准段落。沉淀与消费两侧共用，保证结构永远一致。 */
export const SECTIONS = {
  trigger: '触发场景',
  clarify: '需求澄清清单',
  approach: '标准改法',
  redlines: '禁区',
  prompt: '提示词模板',
  acceptance: '验收标准',
}

export const SECTION_ORDER = [
  SECTIONS.trigger,
  SECTIONS.clarify,
  SECTIONS.approach,
  SECTIONS.redlines,
  SECTIONS.prompt,
  SECTIONS.acceptance,
]

/** 生成一份完整的模板 Markdown */
export function renderTemplateMarkdown(input) {
  const {
    name,
    category = 'uncategorized',
    tags = [],
    trigger = '',
    clarify = [],
    approach = [],
    redlines = [],
    prompt = '',
    acceptance = [],
    repoName = '',
  } = input

  const lines = []
  lines.push(`# ${name}`)
  lines.push('')
  if (repoName) lines.push(`> 适用仓库：${repoName}`, '')
  lines.push(`分类：\`${category}\`　标签：${tags.length > 0 ? tags.map((t) => `\`${t}\``).join(' ') : '（无）'}`)
  lines.push('')

  lines.push(`## ${SECTIONS.trigger}`, '', trigger || '（待补充）', '')
  lines.push(`## ${SECTIONS.clarify}`, '')
  lines.push(...bulletize(clarify, '（待补充）'), '')
  lines.push(`## ${SECTIONS.approach}`, '')
  lines.push(...numberize(approach, '（待补充）'), '')
  lines.push(`## ${SECTIONS.redlines}`, '')
  lines.push(...bulletize(redlines, '（本次未识别到明确禁区）'), '')
  lines.push(`## ${SECTIONS.prompt}`, '')
  lines.push('```text', prompt || '（待补充）', '```', '')
  lines.push(`## ${SECTIONS.acceptance}`, '')
  lines.push(...checkboxize(acceptance, '（待补充）'), '')

  return lines.join('\n')
}

function bulletize(items, empty) {
  if (!items || items.length === 0) return [empty]
  return items.map((i) => `- ${i}`)
}

function numberize(items, empty) {
  if (!items || items.length === 0) return [empty]
  return items.map((i, n) => `${n + 1}. ${i}`)
}

function checkboxize(items, empty) {
  if (!items || items.length === 0) return [empty]
  return items.map((i) => `- [ ] ${i}`)
}

/**
 * 把召回结果渲染成注入给模型的上下文。
 * 关键取舍：只注入「澄清清单 + 改法 + 禁区」三段，不注入全文，控制 token 占用。
 */
export function renderInjection({ results, redlines, maxTemplates = 2, maxChars = 4000 }) {
  const hits = (results ?? []).filter((r) => r.hit).slice(0, maxTemplates)
  const lines = []

  if (redlines && redlines.length > 0) {
    lines.push('### 本项目禁区（硬约束，不得违反）')
    for (const r of redlines.slice(0, 20)) lines.push(`- ${r}`)
    lines.push('')
  }

  if (hits.length === 0) {
    lines.push('### 历史模板')
    lines.push('未命中任何历史模板，本次按新需求处理。会话结束时请调用 `spec_retro` 沉淀为新模板。')
    return clip(lines.join('\n'), maxChars)
  }

  lines.push('### 命中的历史模板')
  for (const { template, score } of hits) {
    lines.push('')
    lines.push(`**${template.name}**（匹配度 ${score}，\`${template.id}\`）`)
    const clarify = bulletsOf(sectionOf(template.body, SECTIONS.clarify))
    const approach = bulletsOf(sectionOf(template.body, SECTIONS.approach), true)
    const tplRedlines = bulletsOf(sectionOf(template.body, SECTIONS.redlines))
    const acceptance = bulletsOf(sectionOf(template.body, SECTIONS.acceptance))

    if (clarify.length > 0) {
      lines.push('澄清清单：')
      lines.push(...clarify.map((c) => `  - ${c}`))
    }
    if (approach.length > 0) {
      lines.push('标准改法：')
      lines.push(...approach.map((a) => `  ${a}`))
    }
    if (tplRedlines.length > 0) {
      lines.push('该模板禁区：')
      lines.push(...tplRedlines.map((r) => `  - ${r}`))
    }
    if (acceptance.length > 0) {
      lines.push('验收标准：')
      lines.push(...acceptance.map((a) => `  - ${a}`))
    }
  }
  lines.push('')
  lines.push('> 上述模板是历史经验的起点，不是终点。若本次需求与之有出入，以用户当下表述为准，并在复盘时更新模板。')

  return clip(lines.join('\n'), maxChars)
}

function bulletsOf(section, keepNumber = false) {
  return String(section ?? '')
    .split(/\r?\n/)
    .map((l) => (keepNumber ? /^\s*(\d+\.|-\s)\s*(.*)$/.exec(l) : /^\s*-\s+(.*)$/.exec(l)))
    .filter(Boolean)
    .map((m) => (keepNumber ? m[2] : m[1]).trim())
    .filter((l) => l && !l.startsWith('（'))
}

function clip(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(已截断)` : text
}

// ---------- 需求体检 ----------

/**
 * 四维体检模型。每一维都有「必须回答的问题」，缺一个就是潜在返工点。
 */
export const TRIAGE_DIMENSIONS = [
  {
    key: 'goal',
    label: '要实现什么',
    question: '目标功能与验收标准是否明确？',
    hints: ['验收', '效果', '测试', '通过', '达到', '完成标准', 'test', 'mvn', 'npm', 'build', 'passed'],
  },
  {
    key: 'approach',
    label: '要怎么改',
    question: '改动范围与技术路径是否明确？',
    hints: ['controller', 'service', 'mapper', '组件', '页面', '接口', '加', '改', '用', '新增', '修改', '实现', '优化'],
    pathRequired: true,
  },
  {
    key: 'boundary',
    label: '哪些不能改',
    question: '禁区与兼容性约束是否说明？',
    hints: ['不要', '不能', '禁止', '别动', '除了', '保留', '不影响', '兼容', '不动', '避免', '不改', '只允许'],
  },
  {
    key: 'context',
    label: '上下文',
    question: '目标仓库、技术栈、相关文件是否清楚？',
    hints: ['仓库', '项目', '模块', 'java', 'vue', 'vue3', '小程序', 'spring', 'react', 'typescript', 'miniprogram'],
    pathRequired: true,
  },
]

/**
 * 启发式预检 + 复杂度分级。
 *
 * 注意：分级只是给模型的「初筛结果」，最终判定权在模型。
 * 插件负责把明显的信息缺口先挑出来，避免模型偷懒跳过澄清。
 */
export function triageRequirement(text, options = {}) {
  const { minLength = 15 } = options
  const normalized = String(text ?? '').trim()
  const lower = normalized.toLowerCase()
  const hasPath = /(?:[\w.$-]+[\\/])*[\w.-]+\.[a-z]{1,8}\b/i.test(normalized) || /(?:[\w.$-]+[\\/])+[\w.$-]+/.test(normalized)

  const tooShort = normalized.length < minLength

  const dimensions = TRIAGE_DIMENSIONS.map((dim) => {
    const hintHit = dim.hints.some((h) => lower.includes(h.toLowerCase()))
    let status
    if (dim.pathRequired && hasPath && hintHit) status = 'covered'
    else if (hintHit) status = dim.pathRequired ? 'partial' : 'covered'
    else if (dim.pathRequired && hasPath) status = 'partial'
    else status = 'missing'

    return {
      key: dim.key,
      label: dim.label,
      question: dim.question,
      status,
    }
  })

  const missing = dimensions.filter((d) => d.status === 'missing')
  const partial = dimensions.filter((d) => d.status === 'partial')

  // 复杂度分级（参见 lib/classify.js）
  const classification = classifyComplexity(normalized)
  const isLevel1 = classification.level === 1

  // 是否存在任何"可动手的锚点"：推断出的文件/字段/组件/默认值。
  // 完全没有锚点 + 过短 + 四维全缺 = 需求尚未成形，连默认值都无从谈起。
  const hasAnchor = !!(
    classification.inferredFile ||
    classification.inferredField ||
    classification.inferredComponent ||
    classification.inferredDefaultValue
  )
  // 安全阀：过短 + 超过半数维度缺失 + 零锚点 => 需求尚未成形，问一次再动手
  const unactionable = tooShort && missing.length >= 2 && !hasAnchor

  return {
    tooShort,
    length: normalized.length,
    hasPath,
    dimensions,
    missing,
    partial,
    classification,
    // 0.4.0：默认只有 L3 允许追问；L1/L2 一律按默认执行。
    // 例外：L2 但"完全无法自举"（过短 + ≥2 维缺失 + 零锚点）时保留一道安全阀，
    //       否则对"帮我改一下那个查询"这类空需求盲目套默认值必然返工。
    needsClarify: classification.level === 3 || (classification.level === 2 && unactionable),
    unactionable,
    ready: isLevel1 || (!tooShort && missing.length === 0 && partial.length === 0),
  }
}

/** 渲染体检结果（给用户看的可读版本） */
export function renderTriageReport(result, { templateHints = [] } = {}) {
  const lines = []
  const classification = result.classification || classifyComplexity(result?.requirement ?? '')
  const level = classification.level

  // 顶部：等级 + 输入摘要
  lines.push('## 需求完整度体检')
  lines.push('')
  lines.push(levelBadge(level, classification, result.needsClarify))
  if (classification.skipTrigger) {
    lines.push(`- 跳过触发词：\`${classification.skipTrigger}\`（用户已显式要求不追问）`)
  }
  lines.push('')
  lines.push(`- 输入长度：${result.length} 字${result.tooShort ? '（偏短，信息量可能不足）' : ''}`)
  lines.push(`- 是否提及具体文件/路径：${result.hasPath ? '是' : '否'}`)
  lines.push('')

  if (level === 1) {
    renderFastTrack(lines, result, classification)
  } else {
    renderStandardReport(lines, result, level, templateHints)
  }

  return lines.join('\n')
}

function levelBadge(level, classification, needsClarify = false) {
  if (level === 1) {
    const trigger = classification.skipTrigger
      ? `（跳过触发：${classification.skipTrigger}）`
      : '（单文件 CRUD + 组件/默认值明确）'
    return `- 复杂度等级：**Level 1 · 原子操作** ${trigger}`
  }
  if (level === 2) {
    return needsClarify
      ? '- 复杂度等级：**Level 2 · 模块变更**（信息不足，需先确认核心一项）'
      : '- 复杂度等级：**Level 2 · 模块变更**（按报告默认值执行，不追问）'
  }
  return '- 复杂度等级：**Level 3 · 架构重构**（完整 Grill-me 追问）'
}

/**
 * L1 快速通道报告：不追问，直接给"执行清单 + 风格自举要求 + 保守默认"。
 */
function renderFastTrack(lines, result, c) {
  lines.push('### 直接执行清单（无需确认，按此实现）')
  lines.push('')
  if (c.inferredFile) {
    lines.push(`- **改动文件**：\`${c.inferredFile}\`（基于需求中的路径推断；动手前请确认）`)
  } else {
    lines.push('- **改动文件**：用户未提供具体路径，请先 grep 工作区定位同类表单/页面再动手')
  }
  if (c.inferredField) {
    lines.push(`- **字段名**：\`${c.inferredField}\``)
  }
  if (c.inferredComponent) {
    lines.push(`- **UI 组件**：\`${ELEMENT_COMPONENT_FOR_TYPE[c.inferredComponent] || c.inferredComponent}\`（推断依据：含 \`${componentSignalOf(c)}\` 关键词）`)
  } else {
    lines.push('- **UI 组件**：用户未指定类型，请扫描当前文件已有同类字段沿用')
  }
  if (c.inferredDefaultValue) {
    lines.push(`- **默认值**：\`${c.inferredDefaultValue}\``)
  }
  lines.push('')

  lines.push('### 风格自举要求')
  lines.push('')
  if (c.inferredFile) {
    lines.push(`动手前先 \`grep\` 读取 \`${c.inferredFile}\` 的最近 50 行表单代码，模仿现有字段的实现：`)
  } else {
    lines.push('动手前先 grep 项目里同类 UI 组件的最近实现（搜索 `el-switch`/`el-input`/`el-select` 等），模仿现有字段风格：')
  }
  lines.push('- 沿用相同的 `el-form-item` 包裹方式、prop 命名、label 对齐、`:rules` 风格')
  lines.push('- 沿用项目里类似数字/布尔字段的 `:active-value` `:inactive-value` 或 `value-format` 绑定方式')
  lines.push('- 沿用项目里类似的列表列展示/隐藏约定（默认值需结合模板推断）')
  lines.push('')

  lines.push('### 保守默认（用户未说明时按下表执行，可纠正）')
  lines.push('')
  lines.push('| 维度 | 保守默认 | 触发改写的关键词 |')
  lines.push('| --- | --- | --- |')
  lines.push(`| 列表是否展示该列 | ${L1_DEFAULTS.listDisplay} | "列表展示""表格里显示" |`)
  lines.push(`| 校验规则 | ${L1_DEFAULTS.validation} | "校验""唯一""必填" |`)
  lines.push(`| 后端接口 | ${L1_DEFAULTS.backend} | "接口还没""后端不支持""新建接口" |`)
  lines.push('')
  lines.push('### 待办标注规则')
  lines.push('')
  lines.push('若对默认值仍有疑虑，在代码中用 `// TODO: [待确认] <具体疑虑>` 标注而非反复追问。')
  lines.push('最终实现报告里点出所有 TODO 即可。')
  lines.push('')

  lines.push('### 触发信号')
  lines.push('')
  for (const s of c.signals || []) lines.push(`- ${s}`)
}

function componentSignalOf(c) {
  const sig = (c.signals || []).find((s) => s.startsWith('L1:component:'))
  return sig ? sig.slice('L1:component:'.length) : c.inferredComponent
}

/**
 * L2/L3 标准报告。
 * 0.4.0 起：仅 L3 输出追问清单；L2 输出"已按默认执行"，不再追问。
 */
function renderStandardReport(lines, result, level, templateHints) {
  const mark = (s) => (s === 'covered' ? '[已明确]' : s === 'partial' ? '[部分明确]' : '[缺失]')
  lines.push('| 维度 | 状态 | 说明 |')
  lines.push('| --- | --- | --- |')
  for (const d of result.dimensions) {
    lines.push(`| ${d.label} | ${mark(d.status)} | ${d.question} |`)
  }
  lines.push('')

  // ---- L3：唯一允许追问的等级（完整 Grill-me）----
  if (level === 3) {
    lines.push('> ### L3 架构重构：先问后查')
    lines.push('>')
    lines.push('> 以下信息缺失，**你现在唯一的动作是向用户提问**，把缺失项整理成一份简短问卷。')
    lines.push('> **提问前禁止调用任何文件类工具**（read_file、read_dir、grep、glob、find、search、')
    lines.push('> bash、ls、tree 等）。即使对代码库一无所知，也先问清需求，不要预扫工作区。')
    lines.push('')

    lines.push('### 需要先向你确认')
    lines.push('')
    const questions = [...result.missing, ...result.partial]
    if (questions.length > 0) {
      for (const d of questions) lines.push(`- **${d.label}**：${d.question}`)
    } else {
      lines.push('- 四维要素表面齐全，但属架构级变更，仍需就改动边界与回滚方案向用户确认一次。')
    }

    if (templateHints.length > 0) {
      lines.push('')
      lines.push('历史模板建议追加确认：')
      for (const h of templateHints) lines.push(`- ${h}`)
    }
    return
  }

  // ---- L2 信息不足：完全无法自举，保留一道安全阀 ----
  if (result.needsClarify) {
    lines.push('> ### L2 信息不足：先确认核心')
    lines.push('>')
    lines.push('> 这条需求没有任何可动手的锚点（无文件、无字段、无组件、无默认值），')
    lines.push('> 盲目套默认值必然返工。请用 `ask_user_question` **一次性**问清下面几项后立即动手，')
    lines.push('> 不要反复追问、不要预扫工作区（提问前禁止 read/grep/glob/bash/ls）。')
    lines.push('')
    lines.push('### 需要先向你确认')
    lines.push('')
    const gaps = result.dimensions.filter((d) => d.status !== 'covered')
    for (const d of gaps) lines.push(`- **${d.label}**：${d.question}`)

    if (templateHints.length > 0) {
      lines.push('')
      lines.push('历史模板建议追加确认：')
      for (const h of templateHints) lines.push(`- ${h}`)
    }
    return
  }

  // ---- L2：按默认执行，不追问 ----
  lines.push('> ### L2 模块变更：按默认执行')
  lines.push('>')
  lines.push('> 缺失维度已由报告给出默认值，**直接按默认动手，不调用 ask_user_question**。')
  lines.push('> 实现说明里列出所做的假设即可；只有"需求与禁区硬冲突"这类默认值无法化解的情形才停下确认。')
  lines.push('')

  const c = result.classification || {}
  const inferred = []
  if (c.inferredField) inferred.push(`字段名 \`${c.inferredField}\``)
  if (c.inferredComponent) {
    inferred.push(`UI 类型 \`${ELEMENT_COMPONENT_FOR_TYPE[c.inferredComponent] || c.inferredComponent}\``)
  }
  if (c.inferredDefaultValue) inferred.push(`默认值 \`${c.inferredDefaultValue}\``)
  if (c.inferredFile) inferred.push(`改动文件 \`${c.inferredFile}\``)

  lines.push('### 已按默认执行')
  lines.push('')
  if (inferred.length > 0) {
    for (const i of inferred) lines.push(`- ${i}`)
  } else {
    lines.push('- 组件形态、表单校验、后端支持均沿用项目既有模式（先 grep 同类实现自举）')
  }
  lines.push('- 列表展示默认展示、校验默认按现有 rules 风格、后端默认已支持')
  lines.push('')
  lines.push('若某项默认值与实际不符，在代码中用 `// TODO: [待确认] <具体内容>` 标注，并在实现报告里点出。')
}

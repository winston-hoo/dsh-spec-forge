// token-audit.js —— 插件 token 成本静态审计
//
// 目标：量化「dsh-spec-forge 到底吃掉多少 token」以及「命中复用一次的成本」。
// 方法：
//   1. 固定开销：常驻系统提示词段、5 个工具的 defineTool 定义文本（近似序列化）
//   2. 按需开销：SKILL.md 全文（首次加载时进上下文一次）
//   3. 调用开销：用插件自身 lib 对样例需求产出真实的 recall/triage/distill 文本并测量
//   4. 命中开销：用真实模板库（~/.dsh/spec-forge）跑 rankTemplates + renderInjection 实测
//
// 口径说明：无 DeepSeek 官方 tokenizer，采用近似估算
//   tokens ≈ CJK 字符数 × 1.0 + 其余字符数 × 0.25
//   真实值取决于模型 tokenizer，误差约 ±30%，数量级可靠。
//
// 用法：node scripts/token-audit.js [--home <DSH_HOME>]

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { focusFingerprint, fingerprint, inferQueryTags } from '../lib/fingerprint.js'
import { inferQueryCategory } from '../lib/classify.js'
import { rankTemplates } from '../lib/match.js'
import { triageRequirement, renderInjection, renderTriageReport } from '../lib/render.js'
import { listTemplates, repoHash, dataRoot } from '../lib/store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ---------- 估算器 ----------
const cjkRe = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g
function estTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(cjkRe) || []).length
  const rest = s.length - cjk
  return Math.round(cjk * 1.0 + rest * 0.25)
}
const pad = (s, n) => String(s).padEnd(n)
const row = (...cells) => cells.map((c, i) => pad(String(c), [26, 10, 10, 10][i] ?? 10)).join('')

const out = []
out.push('# dsh-spec-forge · token 静态审计')
out.push('')
out.push(`> 口径：tokens ≈ CJK 字符×1.0 + 其余字符×0.25（无官方 tokenizer，误差 ±30%，数量级可靠）`)
out.push('')
out.push(row('项目', '字符数', '估算tokens', '说明'))
out.push(row('---', '---', '---', '---'))

// ---------- 1. 常驻系统提示词段 ----------
const indexSrc = readFileSync(join(repoRoot, 'index.js'), 'utf8')
const sysMatch = /name: 'spec-forge:routing'[\s\S]*?text: \[([\s\S]*?)\]\.join\('\\n'\)/.exec(indexSrc)
let sysText = ''
if (sysMatch) {
  const lines = [...sysMatch[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
  sysText = lines.join('\n')
}
out.push(row('① 常驻系统提示词段 spec-forge:routing', sysText.length, estTokens(sysText), '每轮请求都带，~280 token 预算内'))

// ---------- 2. 五个工具的 defineTool 定义（近似序列化体量） ----------
const toolBlocks = {}
const names = ['spec_recall', 'spec_triage', 'spec_distill', 'spec_retro', 'spec_library']
for (let i = 0; i < names.length; i++) {
  const name = names[i]
  const start = indexSrc.indexOf(`name: '${name}'`)
  if (start < 0) continue
  const next = i + 1 < names.length ? indexSrc.indexOf(`name: '${names[i + 1]}'`) : indexSrc.indexOf('ctx.logger?.info')
  const end = next > start ? next : start + 2000
  let slice = indexSrc.slice(start, end)
  // 去掉 JS 代码噪音里不属于"发给模型"的部分：函数体、execute、async、大括号样板
  // 保留 description + schema 的字段名与描述文本（序列化后这些都会出现）
  slice = slice
    .replace(/async execute[\s\S]*$/, '')
    .replace(/\b(?:const|return|function|=>|\{|\}|\[|\])\s*/g, ' ')
    .replace(/'/g, '')
  // 去掉 execute 之后残留（上面已截断）
  toolBlocks[name] = slice
}
let toolsTotal = 0
let toolsToks = 0
for (const name of names) {
  const t = toolBlocks[name] ?? ''
  toolsTotal += t.length
  toolsToks += estTokens(t)
  out.push(row(`② 工具定义 ${name}`, t.length, estTokens(t), '每轮请求都带（5 个合计见下）'))
}
out.push(row('② 五个工具定义合计', toolsTotal, toolsToks, '随工具列表每轮注入，含字段描述'))

// ---------- 3. SKILL.md（按需加载） ----------
const skillFile = join(repoRoot, 'skills', 'spec-forge', 'SKILL.md')
const skillText = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : ''
out.push(row('③ SKILL.md（按需加载一次）', skillText.length, estTokens(skillText), '模型调用 skill 工具时整篇进上下文'))

// ---------- 4. 单次工具调用的典型输出 ----------
const REQUIREMENTS = {
  L1字段需求: 'index.vue 这个物业管理员管理页面的新增/修改接口增加一个主管管员字段 isMainAdmin，值为1是，0否，默认为否，这个字段用开关来显示，请帮我完成这个需求',
  模糊需求: '帮我优化一下那个查询',
  purgeStale开发: '在 dsh-spec-forge 的 lib/store.js 里新增一个 purgeStale 方法，清理超过 90 天未使用的模板，不要改 listTemplates 的返回结构，需要 npm test 通过',
}
out.push('')
out.push('### 4. 单次工具调用产出的文本（插件发给模型的增量）')
out.push('')
for (const [label, req] of Object.entries(REQUIREMENTS)) {
  const triage = triageRequirement(req)
  const triageReport = renderTriageReport(triage)
  const recallMiss = renderInjection({ results: [], redlines: [] })
  const fp = fingerprint(`示例模板 ${req}`)
  out.push(`- **${label}**（输入需求 ${req.length} 字）`)
  out.push(`  - spec_recall 未命中注入：${recallMiss.length} 字符 ≈ ${estTokens(recallMiss)} tokens`)
  out.push(`  - spec_triage 报告：${triageReport.length} 字符 ≈ ${estTokens(triageReport)} tokens（L${triage.classification.level}）`)
  out.push(`  - 需求指纹 token：${fp.length} 个`)
}

// ---------- 5. 命中复用的真实成本 ----------
out.push('')
out.push('### 5. 命中历史模板时的注入成本（真实模板库）')
out.push('')
const home = process.argv.includes('--home') ? process.argv[process.argv.indexOf('--home') + 1] : join(homedir(), '.dsh')
const root = dataRoot(home)
const projDir = join(root, 'projects')
let totalReal = 0
let hitInject = null
if (existsSync(projDir)) {
  const scopes = readdirSync(projDir)
  out.push(`真实库位置：${root}（项目层 ${scopes.length} 个仓库）`)
  for (const scope of scopes) {
    const templates = listTemplates(home, scope)
    if (templates.length === 0) continue
    totalReal += templates.length
    out.push(`- 仓库 ${scope}：${templates.length} 份模板`)
    // 用与 spec_recall 一致的查询构建（聚焦 + tags/category + 同仓库加分）测命中注入
    const q = REQUIREMENTS.L1字段需求
    const buildQ = (text) => {
      const fp = focusFingerprint(fingerprint(text))
      fp.tags = inferQueryTags(text)
      const cat = inferQueryCategory(text)
      if (cat) fp.category = cat
      return fp
    }
    let results = rankTemplates({ queryFp: buildQ(q), templates, repoHash: scope, threshold: 0.35 })
    let tag = ''
    let hit = results.filter((r) => r.hit)
    if (hit.length === 0) {
      results = rankTemplates({ queryFp: buildQ(q), templates, repoHash: scope, threshold: 0.2 })
      hit = results.filter((r) => r.hit)
      tag = '（默认 0.35 未命中，放宽到 0.2 观察注入上限）'
    }
    if (hit.length > 0) {
      const inj = renderInjection({ results: hit, redlines: [], maxTemplates: 2, maxChars: 4000 })
      out.push(`  - 样例需求「${q.slice(0, 18)}…」命中 ${hit.length} 份，注入 ${inj.length} 字符 ≈ ${estTokens(inj)} tokens ${tag}`)
      if (!hitInject) hitInject = inj.length
    }
  }
}
if (totalReal === 0) {
  out.push('（~/.dsh/spec-forge 暂无模板，回退用仓库示例模板估算）')
  const ex = join(repoRoot, 'templates', 'example-spring-pagination.md')
  if (existsSync(ex)) {
    const tplText = readFileSync(ex, 'utf8')
    out.push(`- 示例模板全文：${tplText.length} 字符 ≈ ${estTokens(tplText)} tokens（这是整份，注入只取节选）`)
  }
}

// ---------- 汇总 ----------
out.push('')
out.push('### 汇总（每次全新请求的固定税 = ① + ②）')
const fixed = estTokens(sysText) + toolsToks
out.push('')
out.push(`- 常驻系统提示段：≈ ${estTokens(sysText)} tokens/请求`)
out.push(`- 五个工具定义：≈ ${toolsToks} tokens/请求（含字段描述；dsh 序列化为 JSON schema 会略增）`)
out.push(`- **固定税合计 ≈ ${fixed} tokens/请求**（只出现在发往模型的完整请求里）`)
out.push(`- SKILL.md ≈ ${estTokens(skillText)} tokens，仅在模型展开技能那一次计入（及其后的上下文重建）`)
out.push('')
out.push('> 注意：以上是"发往模型"的文本量。实际计费按请求次数累计，且 dsh 会在新用户轮重建长上下文，')
out.push('> 届时此前注入的历史（含模板/报告）会整体重计一次——所以让每次注入尽量短、命中尽量准，收益是复利。')

console.log(out.join('\n'))

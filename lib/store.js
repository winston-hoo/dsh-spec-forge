// 模板库存储：双层结构（全局层 + 项目层），纯 Markdown + JSON，无数据库依赖。
// 所有落盘操作都做路径安全校验。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const ID_PATTERN = /^tpl-[a-z0-9]{8,16}$/

/** $DSH_HOME，默认 ~/.dsh */
export function resolveHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件数据根目录 */
export function dataRoot(home = resolveHome()) {
  return join(home, 'spec-forge')
}

/** 仓库哈希：用路径前 12 位 sha256 做目录名，避免路径字符非法 */
export function repoHash(cwd) {
  if (!cwd) return 'no-repo'
  const normalized = String(cwd).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}

/** 模板 ID 由 name + 仓库共同决定，同名需求自动覆盖更新而非堆积 */
export function templateId(name, hash) {
  const seed = `${String(name).trim().toLowerCase()}::${hash ?? 'global'}`
  return `tpl-${createHash('sha256').update(seed).digest('hex').slice(0, 10)}`
}

/** 路径穿越防护：ID 必须匹配白名单 */
export function assertSafeId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`非法的模板 ID: ${String(id)}`)
  }
  return id
}

function scopeDir(home, scope) {
  const root = dataRoot(home)
  return scope && scope !== 'global' ? join(root, 'projects', scope) : join(root, 'global')
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 进程内写版本号：任何落盘（模板/档案）都会自增。
 * listTemplates 的读缓存据此失效——dsh 进程内写都是走本模块，
 * 只要写版本号没变，缓存必然新鲜。
 */
let writeEpoch = 0

/** 原子写：先写临时文件再 rename，避免中途崩溃留下半个文件 */
function writeFileAtomic(file, content) {
  ensureDir(resolve(file, '..'))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
  writeEpoch += 1
}

// ---------- 极简 frontmatter 解析（只支持插件自己写出的子集） ----------

export function parseFrontmatter(md) {
  const text = String(md ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { meta: {}, body: text }
  return { meta: parseSimpleYaml(match[1]), body: match[2] }
}

export function stringifyFrontmatter(meta, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) lines.push(`  - ${formatScalar(item)}`)
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`)
    }
  }
  lines.push('---')
  lines.push('')
  return `${lines.join('\n')}${String(body ?? '').replace(/^\s*\n/, '')}`
}

function formatScalar(value) {
  const s = String(value)
  if (s === '' || /[:#\-{}\[\],&*?|>%@`"']|^\s|\s$/.test(s)) return `'${s.replace(/'/g, "''")}'`
  return s
}

export function parseSimpleYaml(yaml) {
  const out = {}
  let currentListKey = null
  for (const rawLine of String(yaml).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentListKey) {
      out[currentListKey].push(stripQuotes(item[1]))
      continue
    }

    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()

    if (value === '') {
      out[key] = []
      currentListKey = key
      continue
    }
    if (value === '[]') {
      out[key] = []
      currentListKey = null
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      out[key] = inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s.trim()))
      currentListKey = null
      continue
    }
    out[key] = stripQuotes(value)
    currentListKey = null
  }
  return out
}

function stripQuotes(s) {
  const v = String(s).trim()
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  return v
}

// ---------- 模板读写 ----------

export function templatePath(home, scope, id) {
  return join(ensureDir(join(scopeDir(home, scope), 'templates')), `${assertSafeId(id)}.md`)
}

export function readTemplate(home, scope, id) {
  const file = templatePath(home, scope, id)
  if (!existsSync(file)) return null
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  // YAML 解析出的都是字符串，这里把已知的计数/结构化字段还原成正确类型
  return {
    ...meta,
    id: assertSafeId(id),
    scope,
    body,
    file,
    hitCount: Number(meta.hitCount ?? 0) || 0,
    tags: normalizeTags(meta.tags),
    fingerprint: normalizeFingerprint(meta.fingerprint),
  }
}

export function writeTemplate(home, scope, id, meta, body) {
  const safeId = assertSafeId(id)
  const file = templatePath(home, scope, safeId)
  const payload = {
    id: safeId,
    name: meta.name ?? safeId,
    category: meta.category ?? 'uncategorized',
    scope,
    tags: meta.tags ?? [],
    fingerprint: meta.fingerprint ?? [],
    repo: scope === 'global' ? '' : scope,
    hitCount: meta.hitCount ?? 0,
    created: meta.created ?? today(),
    updated: today(),
    lastUsed: meta.lastUsed ?? '',
  }
  writeFileAtomic(file, stringifyFrontmatter(payload, body))
  return { ...payload, body, file }
}

/**
 * 模板列表读缓存：进程内避免每次召回都对全部模板做 readFile + frontmatter 解析。
 * 失效条件：① 写版本号变化（本进程任何落盘，覆盖保存/命中计数/清理）；
 *          ② 文件名集合变化（外部进程增删了 .md）。
 * 返回浅拷贝，防止调用方 sort() 等原地操作污染缓存。
 */
const listCache = new Map() // key: `${home}|${scopes}` → { epoch, files, list }

export function listTemplates(home, scope) {
  const scopes = scope && scope !== 'global' ? [scope, 'global'] : ['global']
  const key = `${home}|${scopes.join(',')}`

  // 快照当前文件集合（readdir 只列目录，比逐文件读盘解析便宜得多）
  const fileSet = new Set()
  for (const sc of scopes) {
    const dir = join(scopeDir(home, sc), 'templates')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || file.endsWith('.tmp')) continue
      fileSet.add(join(dir, file))
    }
  }

  const hit = listCache.get(key)
  if (hit && hit.epoch === writeEpoch && hit.files.size === fileSet.size) {
    let same = true
    for (const f of hit.files) {
      if (!fileSet.has(f)) {
        same = false
        break
      }
    }
    if (same) return hit.list.slice()
  }

  const seen = new Set()
  const out = []
  for (const sc of scopes) {
    const dir = join(scopeDir(home, sc), 'templates')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || file.endsWith('.tmp')) continue
      const id = file.replace(/\.md$/, '')
      if (!ID_PATTERN.test(id) || seen.has(id)) continue
      seen.add(id)
      try {
        const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'))
        out.push({
          ...meta,
          id,
          scope: sc,
          tags: normalizeTags(meta.tags),
          fingerprint: normalizeFingerprint(meta.fingerprint),
          hitCount: Number(meta.hitCount ?? 0) || 0,
          body,
          file: join(dir, file),
        })
      } catch {
        // 单个损坏模板不应拖垮整个检索
      }
    }
  }
  listCache.set(key, { epoch: writeEpoch, files: fileSet, list: out })
  return out.slice() // 返回副本，调用方 sort() 等原地操作不污染缓存本体
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String)
  if (typeof value === 'string' && value) return value.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function normalizeFingerprint(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          const [token, weight] = item.split('|')
          return { token, weight: Number(weight ?? 1) || 1 }
        }
        if (item && typeof item === 'object' && item.token) {
          return { token: String(item.token), weight: Number(item.weight ?? 1) || 1 }
        }
        return null
      })
      .filter(Boolean)
  }
  return []
}

/** 记录一次命中：累加次数并刷新最近使用时间 */
export function recordHit(home, scope, id) {
  const existing = readTemplate(home, scope, id)
  if (!existing) return null
  return writeTemplate(
    home,
    scope,
    id,
    {
      ...existing,
      hitCount: (Number(existing.hitCount ?? 0) || 0) + 1,
      lastUsed: new Date().toISOString(),
      created: existing.created ?? today(),
    },
    existing.body
  )
}

/** 取模板的最近使用日期：lastUsed → updated → created 回退；全无则返回空串（视为未知，不参与清理） */
function usedDateOf(template) {
  const raw = template.lastUsed || template.updated || template.created || ''
  const date = String(raw).trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
}

/**
 * 列出超过 days 天（默认 90）未使用的模板（只统计，不删除）。
 * 供 spec_library 报告展示，也让清理动作保持"显式触发"而不是隐藏副作用。
 * 时间判定回退链 lastUsed → updated → created，三个字段都缺失的模板一律视为保留。
 * @param {string} home
 * @param {string} scope 当前仓库哈希
 * @param {number} [days=90] 未使用天数阈值
 * @returns {Array<object>} 过期模板列表（含 file 路径，可供后续 purgeStale 精确删除）
 */
export function staleTemplates(home, scope, days = 90) {
  const cutoff = today(new Date(Date.now() - days * 86_400_000))
  return listTemplates(home, scope).filter((template) => {
    const used = usedDateOf(template)
    return Boolean(used) && used < cutoff
  })
}

/**
 * 物理删除超过 days 天未使用的模板。
 * 作用域解析与 listTemplates 一致：scope 为仓库时合并项目层 + 全局层，删除发生在模板实际所在层。
 * @param {string} home
 * @param {string} scope 当前仓库哈希
 * @param {number} [days=90] 未使用天数阈值
 * @returns {number} 被清理的模板数量
 */
export function purgeStale(home, scope, days = 90) {
  let removed = 0
  for (const template of staleTemplates(home, scope, days)) {
    try {
      unlinkSync(template.file)
      removed += 1
    } catch {
      // 单个文件删除失败（已不存在/无权限）不应中断整体清理
    }
  }
  if (removed > 0) writeEpoch += 1 // 直接 unlink 不经过 writeFileAtomic，需手动失效缓存
  return removed
}

// ---------- 项目档案：持久化的「禁区清单」 ----------

export function profilePath(home, scope) {
  return join(ensureDir(scopeDir(home, scope)), 'profile.md')
}

export function readProfile(home, scope) {
  const file = profilePath(home, scope)
  if (!existsSync(file)) return { repoName: '', redlines: [], conventions: [], notes: '' }
  return parseProfile(readFileSync(file, 'utf8'))
}

export function parseProfile(md) {
  const { meta, body } = parseFrontmatter(md)
  const sections = splitSections(body)
  return {
    repoName: meta.repoName ?? '',
    redlines: bulletLines(sections['禁区'] ?? ''),
    conventions: bulletLines(sections['约定'] ?? ''),
    notes: (sections['备注'] ?? '').trim(),
  }
}

export function writeProfile(home, scope, { repoName, redlines, conventions, notes }) {
  const body = [
    '## 禁区',
    '',
    ...(redlines.length > 0 ? redlines.map((r) => `- ${r}`) : ['- （暂无）']),
    '',
    '## 约定',
    '',
    ...(conventions.length > 0 ? conventions.map((c) => `- ${c}`) : ['- （暂无）']),
    '',
    '## 备注',
    '',
    notes || '（暂无）',
    '',
  ].join('\n')
  writeFileAtomic(profilePath(home, scope), stringifyFrontmatter({ repoName: repoName ?? scope, updated: today() }, body))
  return profilePath(home, scope)
}

/** 合并项目自身禁区 + 命中模板的禁区，去重后返回 */
export function collectRedlines(home, scope, templates = []) {
  const own = readProfile(home, scope).redlines
  const fromTemplates = templates.flatMap((t) => bulletLines(sectionOf(t.body, '禁区')))
  return [...new Set([...own, ...fromTemplates])].filter(Boolean)
}

function splitSections(md) {
  const out = {}
  let current = null
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line)
    if (h) {
      current = h[1].trim()
      out[current] = ''
      continue
    }
    if (current) out[current] += `${line}\n`
  }
  return out
}

export function sectionOf(md, title) {
  return splitSections(md)[title] ?? ''
}

function bulletLines(md) {
  return String(md ?? '')
    .split(/\r?\n/)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1]?.trim())
    .filter((l) => l && l !== '（暂无）')
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** 数据目录总览，供 /spec-forge 状态查询用 */
export function describeStore(home, scope) {
  const templates = listTemplates(home, scope)
  const globalCount = templates.filter((t) => t.scope === 'global').length
  const projectCount = templates.filter((t) => t.scope !== 'global').length
  return {
    home: dataRoot(home),
    repoHash: scope,
    total: templates.length,
    globalCount,
    projectCount,
    profile: readProfile(home, scope),
  }
}

export { sep }

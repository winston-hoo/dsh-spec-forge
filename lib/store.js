// 模板库存储：双层结构（全局层 + 项目层），纯 Markdown + JSON，无数据库依赖。
// 所有落盘操作都做路径安全校验。

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
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

/** 用户可选存储模式关键字。storageHome 非空时优先级最高 */
export const STORAGE_MODES = Object.freeze(['workspace', 'home'])

/**
 * 解析模板库数据根绝对路径。
 * 优先级：显式 storageHome 绝对路径 > storageRoot 关键字 > 默认 workspace。
 *
 * 模式语义：
 *   - 'workspace' (默认)：放在 `<cwd>/.dsh-spec-forge/`，模板库随当前项目走。
 *     推荐：工作区与 $DSH_HOME 不同盘时，避免跨盘 EPERM。
 *   - 'home'：放在 `$DSH_HOME/spec-forge/`，兼容 0.3.2 及以前的默认行为。
 *   - 'explicit'：storageHome 非空，直接当绝对路径用。
 *
 * @param {{ storageHome?: string, storageRoot?: string, cwd?: string }} [opts]
 * @returns {{ path: string, mode: 'workspace'|'home'|'explicit' }}
 */
export function resolveStorageRoot(opts = {}) {
  const storageHome = String(opts.storageHome ?? '').trim()
  const storageRoot = String(opts.storageRoot ?? 'workspace').trim() || 'workspace'
  const cwd = opts.cwd || process.cwd()

  if (storageHome) {
    return { path: resolve(storageHome), mode: 'explicit' }
  }
  if (storageRoot === 'home') {
    return { path: dataRoot(resolveHome()), mode: 'home' }
  }
  if (storageRoot === 'workspace') {
    return { path: join(cwd, '.dsh-spec-forge'), mode: 'workspace' }
  }
  throw new Error(
    `[spec-forge] 未知的 storageRoot: "${storageRoot}"。可选: ${STORAGE_MODES.join(' | ')}；或设置 storageHome 为绝对路径`
  )
}

/**
 * 检查两个路径是否在不同的盘符（Windows）。
 * 同盘返回 false，跨盘返回 true。POSIX 下永远返回 false。
 */
export function isCrossDrive(a, b) {
  if (process.platform !== 'win32') return false
  const ma = /^([a-zA-Z]):[\\/]/.exec(String(a))
  const mb = /^([a-zA-Z]):[\\/]/.exec(String(b))
  if (!ma || !mb) return false
  return ma[1].toUpperCase() !== mb[1].toUpperCase()
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

/**
 * 作用域目录。
 *
 * 注意：`home` 从 0.3.3 起已经是**数据根**（`resolveStorageRoot()` 的返回值），
 * 不再是 `$DSH_HOME`。0.3.3/0.4.0 曾在这里多调用一次 `dataRoot()`，
 * 使数据实际落在 `<root>/spec-forge/…`，而 migrate 又写到 `<root>/…`，
 * 读写路径不一致 → 历史模板失联、迁移无效（0.4.1 修复）。
 */
function scopeDir(home, scope) {
  return scope && scope !== 'global' ? join(home, 'projects', scope) : join(home, 'global')
}

/**
 * 一次性把 0.3.3/0.4.0 遗留的 `<root>/spec-forge/…` 布局归位到 `<root>/…`。
 *
 * 仅在新位置（`<root>/global` 或 `<root>/projects`）尚不存在时才动，避免覆盖新数据；
 * 逐项 `rename`，目标已存在则跳过（不覆盖）。返回说明文本，无操作返回 null。
 *
 * 上移完成后若源目录已空则顺手删除——否则每台曾踩坑的机器都会永久留一个
 * `<root>/spec-forge/` 空壳（0.4.1 的实测残留）。新布局已在用时也做一次空壳清理。
 */
export function liftLegacyNesting(root, logger) {
  const nested = join(root, 'spec-forge')
  if (!existsSync(nested)) return null

  let entries = []
  try {
    entries = readdirSync(nested)
  } catch (err) {
    logger?.warn?.(`[spec-forge] 旧布局读取失败 ${nested}: ${err.message}`)
    return null
  }

  // 新布局已在使用：旧目录里的数据不再动，只在其已空时清掉历史空壳。
  if (existsSync(join(root, 'global')) || existsSync(join(root, 'projects'))) {
    if (entries.length === 0) removeEmptyDir(nested, logger)
    return null
  }

  let moved = 0
  for (const name of entries) {
    const from = join(nested, name)
    const to = join(root, name)
    if (existsSync(to)) continue
    try {
      renameSync(from, to)
      moved += 1
    } catch (err) {
      logger?.warn?.(`[spec-forge] 旧布局归位失败 ${from}: ${err.message}`)
    }
  }
  // 有跳过项（目标已存在）时源目录非空，rmdir 会失败——属预期，静默跳过。
  removeEmptyDir(nested, logger)
  if (moved === 0) return null
  bumpWriteEpoch()
  return `检测到 0.3.3/0.4.0 的旧存储布局，已把 \`${nested}\` 下 ${moved} 个条目上移到 \`${root}\``
}

/** 仅删空目录；非空（有跳过项）或删除失败都属预期，debug 级别跳过即可。 */
function removeEmptyDir(dir, logger) {
  try {
    rmdirSync(dir)
    return true
  } catch (err) {
    logger?.debug?.(`[spec-forge] 旧布局空目录未删除 ${dir}: ${err.message}`)
    return false
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 强制让进程内读缓存下次失效。
 * 适用于外部工具（如 spec_store 迁移）直接复制文件绕过 writeFileAtomic 的场景。
 */
export function bumpWriteEpoch() {
  writeEpoch += 1
  return writeEpoch
}

/**
 * 递归复制目录到目标。同名文件**跳过不覆盖**（避免覆盖用户已在 workspace 沉淀的新模板）。
 * @param {string} src 源目录（必须存在）
 * @param {string} dst 目标目录（不存在会自动创建）
 * @param {boolean} [deleteSource=false] 是否在成功复制后删除源文件（move 语义）
 * @returns {{ copied:number, skipped:number, report:string }}
 */
export function copyTree(src, dst, deleteSource = false) {
  ensureDir(dst)
  let copied = 0
  let skipped = 0
  const lines = []

  let list
  try {
    list = readdirSync(src, { withFileTypes: true })
  } catch (e) {
    return { copied: 0, skipped: 0, report: `源目录不可读 ${src}: ${e.message}` }
  }

  for (const entry of list) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      const sub = copyTree(s, d, deleteSource)
      copied += sub.copied
      skipped += sub.skipped
      if (sub.report) lines.push(sub.report)
      continue
    }
    if (existsSync(d)) {
      skipped += 1
      lines.push(`跳过 ${entry.name}（目标已存在，未覆盖）`)
      continue
    }
    try {
      // 复制空文件 statSync 可能 throw；保险起见先 stat
      statSync(s)
      copyFileSync(s, d)
      copied += 1
      lines.push(`复制 ${entry.name}`)
      if (deleteSource) {
        try {
          unlinkSync(s)
        } catch {}
      }
    } catch (e) {
      skipped += 1
      lines.push(`失败 ${entry.name}: ${e.message}`)
    }
  }
  return { copied, skipped, report: lines.join('\n') }
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
  // 0.4.7：单个模板文件损坏 / 被占用 / 目录里混进手工命名（非法 ID）的 .md，
  // 都不应让整次 spec_recall 直接失败 —— 与「文件不存在」同样返回 null，
  // 由 listTemplates 过滤掉这一份，其余模板照常可用。
  // 注意 try 必须连 templatePath 一起包住：ID 校验（assertSafeId）在 templatePath 内部。
  try {
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
  } catch (err) {
    console.warn(`[spec-forge] 模板读取失败，已跳过（scope=${scope} id=${id}）: ${err.message}`)
    return null
  }
}

/**
 * 指纹落盘格式：`token|weight` 字符串数组，读侧由 `normalizeFingerprint` 还原。
 *
 * 必须在这里统一序列化：`fingerprint()` 返回的是 `{token, weight}` 对象数组，
 * 而 `stringifyFrontmatter` 走的是 `String(value)`，直接写对象会得到一堆
 * `'[object Object]'` —— 指纹等同报废，召回词汇分恒为 0（0.4.0 的真实缺陷）。
 * 同时接受字符串输入，保证 `recordHit` 等把已读出的对象再写回时也正确。
 */
function serializeFingerprint(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && item.token != null) {
        const weight = Number(item.weight)
        return `${item.token}|${Number.isFinite(weight) && weight > 0 ? weight : 1}`
      }
      return null
    })
    .filter(Boolean)
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
    fingerprint: serializeFingerprint(meta.fingerprint),
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
  // 0.4.7：这里原先会 ensureDir —— 于是"读档案"变成有副作用（顺手建目录），
  // 且当数据目录不可写时 readProfile 会抛 ENOTDIR/EPERM，一路穿过 spec_retro 的工具边界
  // （tests/plugin.test.js 复现：写盘失败本该被捕获成 saved:false，实际直接抛异常）。
  // 写路径不需要这个 ensureDir：writeFileAtomic 自己会建父目录。
  return join(scopeDir(home, scope), 'profile.md')
}

export function readProfile(home, scope) {
  const file = profilePath(home, scope)
  const empty = { repoName: '', redlines: [], conventions: [], notes: '' }
  if (!existsSync(file)) return empty
  // 0.4.7：档案损坏同样不能拖垮整次召回（档案只提供"项目禁区"，缺了应当降级而不是报错）
  try {
    return parseProfile(readFileSync(file, 'utf8'))
  } catch (err) {
    console.warn(`[spec-forge] 项目档案读取失败，本次按空档案继续 ${file}: ${err.message}`)
    return empty
  }
}

/**
 * 禁区文本归一化：只用于**近重复判定**，不改写落盘原文。
 *
 * 去掉括号里的补充说明，是因为实测里同一规则常被写成
 * `package.json 不新增依赖（需要 zip/导出时用浏览器原生 Blob，不引 jszip）`
 * 与 `package.json 不新增依赖（项目已登记禁区）`—— 括号内容不同、规则完全相同。
 */
export function normalizeRedline(text) {
  return String(text ?? '')
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/[\s`'"“”‘’，。、；：,.;:!?！？\-_/\\|*]+/g, '')
    .toLowerCase()
}

function bigramsOf(s) {
  const out = new Set()
  if (s.length === 1) out.add(s)
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/**
 * 近重复判定：归一化后相等，或字符 bigram 包含度 ≥ ratio。
 *
 * 用 bigram 包含度而不是相等，是因为同一规则也常被**改写语序**：
 * `example-admin/dist 是 git 跟踪的目录，vite build 默认 emptyOutDir 会清空它；…`
 * 与 `验证构建必须显式 --outDir 到临时目录并事后清理；example-admin/dist 是 git 跟踪目录…`
 * 归一化后并不相等，但共享绝大部分字面。
 *
 * ratio 默认 0.7 的依据（example-admin 真实档案 11 条禁区两两实测）：
 *   真实重复对   package.json 那对 = 1.000，outDir 那对 = 0.897
 *   最高的非重复对 = 0.571（其余 ≤ 0.222）
 * → 安全窗口 (0.571, 0.897)，0.7 落在中间。**改这个阈值前请先重跑一遍两两分布。**
 */
export function isNearDuplicateRedline(a, b, ratio = 0.7) {
  const na = normalizeRedline(a)
  const nb = normalizeRedline(b)
  if (na.length === 0 || nb.length === 0) return false
  if (na === nb) return true
  const A = bigramsOf(na)
  const B = bigramsOf(nb)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / Math.min(A.size, B.size) >= ratio
}

/**
 * 近重复去重，保留信息量更大的那条（更长者胜）。
 *
 * 0.4.5：旧版只用 `[...new Set(...)]` 做字符串级去重，实测 example-admin 项目档案里
 * 11 条禁区有 2 组是同一规则的不同写法，每次请求都重复注入。
 * 放在 parseProfile 里做，是因为读路径同时服务注入与写盘 ——
 * 读时收敛，下次 spec_retro 落盘就会把净化后的集合写回去（自愈）。
 */
export function dedupeRedlines(list = [], ratio = 0.7) {
  const out = []
  for (const raw of list) {
    const item = String(raw ?? '').trim()
    if (!item) continue
    const idx = out.findIndex((kept) => isNearDuplicateRedline(kept, item, ratio))
    if (idx < 0) out.push(item)
    else if (item.length > out[idx].length) out[idx] = item
  }
  return out
}

export function parseProfile(md) {
  const { meta, body } = parseFrontmatter(md)
  const sections = splitSections(body)
  return {
    repoName: meta.repoName ?? '',
    redlines: dedupeRedlines(bulletLines(sections['禁区'] ?? '')),
    conventions: dedupeRedlines(bulletLines(sections['约定'] ?? '')),
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

/** 合并项目自身禁区 + 命中模板的禁区，近重复去重后返回 */
export function collectRedlines(home, scope, templates = []) {
  const own = readProfile(home, scope).redlines
  const fromTemplates = templates.flatMap((t) => bulletLines(sectionOf(t.body, '禁区')))
  return dedupeRedlines([...own, ...fromTemplates]).filter(Boolean)
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

/**
 * 段落里的条目行提取（**全项目唯一实现**，0.4.7 合并）。
 *
 * 0.4.7 之前这里、`lib/render.js:170` 与 `index.js:787` 各有一份近似实现，且已经漂移：
 * 只有本份认「（暂无）」占位，只有 `render.js` 那份认编号行，而**三份都不剥复选框前缀** ——
 * 验收标准落盘时写成 `- [ ] x`（见 render.js checkboxize），读回时若带着 `[ ]`，
 * 下一次 `spec_retro` 覆盖更新就会把它当新内容并进去，叠成 `- [ ] [ ] x`（每沉淀一次多一层）。
 *
 * @param {string} md 段落文本
 * @param {{ keepNumber?: boolean }} [opts] keepNumber=true 时同时识别 `1. xxx` 编号行（标准改法段用）
 * @returns {string[]} 条目正文数组，已剥复选框前缀、已滤占位行
 */
export function bulletLines(md, { keepNumber = false } = {}) {
  const line = keepNumber ? /^\s*(?:\d+\.|-)\s+(.*)$/ : /^\s*-\s+(.*)$/
  return String(md ?? '')
    .split(/\r?\n/)
    .map((l) => line.exec(l)?.[1]?.trim())
    .filter((l) => l && !l.startsWith('（'))
    .map((l) => l.replace(/^\[[ xX]\]\s*/, ''))
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
    home,
    repoHash: scope,
    total: templates.length,
    globalCount,
    projectCount,
    profile: readProfile(home, scope),
  }
}


// 相似度匹配：决定「这次需求该加载哪个历史模板」。
// 纯函数，无 IO，全部可单测。

import { toWeightMap } from './fingerprint.js'

/** 加权余弦相似度 */
export function cosine(mapA, mapB) {
  if (mapA.size === 0 || mapB.size === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  const [small, large] = mapA.size <= mapB.size ? [mapA, mapB] : [mapB, mapA]
  for (const [token, wa] of small) {
    const wb = large.get(token)
    if (wb !== undefined) dot += wa * wb
  }
  for (const w of mapA.values()) normA += w * w
  for (const w of mapB.values()) normB += w * w
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * 覆盖率：查询词中有多少比例被模板覆盖。
 * 对短查询更友好——避免「分页查询」这种短需求被长模板稀释。
 */
export function coverage(mapA, mapB) {
  if (mapA.size === 0) return 0
  let covered = 0
  let total = 0
  for (const [token, wa] of mapA) {
    total += wa
    const wb = mapB.get(token)
    if (wb !== undefined) covered += Math.min(wa, wb)
  }
  return total === 0 ? 0 : covered / total
}

/** 两个集合的 Jaccard 系数 */
export function jaccard(setA, setB) {
  if (!setA || !setB || setA.length === 0 || setB.length === 0) return 0
  const a = new Set(setA)
  const b = new Set(setB)
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 新鲜度衰减：半衰期 90 天，返回 0.5~1.0 */
export function recency(lastUsed, now = Date.now()) {
  if (!lastUsed) return 0.5
  const t = typeof lastUsed === 'number' ? lastUsed : Date.parse(lastUsed)
  if (Number.isNaN(t)) return 0.5
  const days = Math.max(0, (now - t) / DAY_MS)
  return Math.max(0.5, Math.pow(0.5, days / 90))
}

/** 使用频次加成：命中越多越可信，但用对数压平避免马太效应 */
export function popularity(hitCount) {
  if (!hitCount || hitCount <= 0) return 0
  return Math.min(1, Math.log2(hitCount + 1) / 5)
}

export const DEFAULT_THRESHOLD = 0.35

/**
 * 对单个模板打分。
 * @param {object} args
 * @param {Map|Array} args.queryFp 本次需求的指纹
 * @param {object} args.template 模板元数据（含 fingerprint/category/tags/repo/hitCount/lastUsed）
 * @param {string} [args.repoHash] 当前仓库哈希，同仓库加权
 * @param {number} [args.threshold] 命中阈值
 * @param {number} [args.now]
 * @returns {{score:number, hit:boolean, breakdown:object}}
 */
export function scoreTemplate({ queryFp, template, repoHash, threshold = DEFAULT_THRESHOLD, now = Date.now() }) {
  const q = toWeightMap(queryFp)
  const t = toWeightMap(template.fingerprint ?? [])

  const cos = cosine(q, t)
  const cov = coverage(q, t)
  const lexical = 0.6 * cos + 0.4 * cov

  // 分类相同：完全相等，或一级相同（feature/api 与 feature/pagination 视为同类）。
  // 模板的二级分类由模型沉淀时自由填写，只比一级才能既准又命中。
  const qCat = queryFp?.category
  const tCat = template.category
  const sameCategory = qCat && tCat && (qCat === tCat || qCat.split('/')[0] === tCat.split('/')[0]) ? 1 : 0

  const tagOverlap = jaccard(template.tags ?? [], queryFp.tags ?? [])
  const sameRepo = repoHash && template.repo && template.repo === repoHash ? 1 : 0

  const fresh = recency(template.lastUsed, now)
  const pop = popularity(template.hitCount)

  // 词汇相似度是主项，其余都是调节项
  const score = clamp01(
    0.62 * lexical +
      0.14 * sameCategory +
      0.08 * tagOverlap +
      0.08 * sameRepo +
      0.05 * fresh +
      0.03 * pop
  )

  return {
    score: round3(score),
    hit: score >= threshold,
    breakdown: {
      cosine: round3(cos),
      coverage: round3(cov),
      lexical: round3(lexical),
      sameCategory,
      tagOverlap: round3(tagOverlap),
      sameRepo,
      recency: round3(fresh),
      popularity: round3(pop),
    },
  }
}

/**
 * 排序检索。
 * @returns {Array<{template:object, score:number, hit:boolean, breakdown:object}>}
 */
export function rankTemplates({ queryFp, templates, repoHash, threshold = DEFAULT_THRESHOLD, limit = 5, now = Date.now() }) {
  return templates
    .map((template) => ({ template, ...scoreTemplate({ queryFp, template, repoHash, threshold, now }) }))
    .sort((a, b) => b.score - a.score || String(a.template.id).localeCompare(String(b.template.id)))
    .slice(0, limit)
}

function clamp01(n) {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

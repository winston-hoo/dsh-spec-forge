import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fingerprint, inferQueryTags, toWeightMap } from '../lib/fingerprint.js'
import { cosine, coverage, jaccard, popularity, rankTemplates, recency, scoreTemplate } from '../lib/match.js'

const NOW = Date.parse('2026-09-04T00:00:00Z')

test('cosine：完全相同为 1，无交集为 0', () => {
  const a = new Map([['a', 1], ['b', 2]])
  const identical = cosine(a, new Map([['a', 1], ['b', 2]]))
  assert.ok(Math.abs(identical - 1) < 1e-9, `完全相同应为 1，实际 ${identical}`)
  assert.equal(cosine(a, new Map([['c', 5]])), 0)
})

test('cosine：空集合返回 0 而不是 NaN', () => {
  assert.equal(cosine(new Map(), new Map([['a', 1]])), 0)
  assert.equal(cosine(new Map([['a', 1]]), new Map()), 0)
})

test('cosine：已知向量值正确', () => {
  // (1,0) 与 (1,1) 的余弦是 1/sqrt(2)
  const a = new Map([['x', 1]])
  const b = new Map([['x', 1], ['y', 1]])
  assert.ok(Math.abs(cosine(a, b) - Math.SQRT1_2) < 1e-9)
})

test('coverage：查询被完全覆盖时为 1', () => {
  const q = new Map([['分页', 3], ['接口', 3]])
  const t = new Map([['分页', 3], ['接口', 3], ['其他', 1]])
  assert.equal(coverage(q, t), 1)
})

test('coverage：短查询对长模板不失真', () => {
  const q = new Map([['分页', 3]])
  const t = new Map([['分页', 3], ['a', 2], ['b', 2], ['c', 2], ['d', 2]])
  assert.equal(coverage(q, t), 1, '覆盖率只看查询侧，不被模板长度稀释')
})

test('jaccard：集合交集计算正确', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3)
  assert.equal(jaccard(['a'], ['a']), 1)
  assert.equal(jaccard([], ['a']), 0)
})

test('recency：越久远分越低，且有下限', () => {
  assert.ok(recency(NOW, NOW) > recency(NOW - 200 * 86400000, NOW))
  assert.equal(recency(NOW - 3650 * 86400000, NOW), 0.5, '下限为 0.5')
  assert.equal(recency(null, NOW), 0.5)
})

test('popularity：命中次数递增，且被对数压平', () => {
  assert.ok(popularity(10) > popularity(1))
  assert.ok(popularity(1000) <= 1, '必须封顶，避免马太效应')
})

test('scoreTemplate：同类需求命中，异类需求不命中', () => {
  const template = {
    id: 'tpl-aaaaaaaaaa',
    name: 'Spring Boot 新增分页查询接口',
    category: 'feature/api',
    tags: ['java', 'spring-boot', 'pagination'],
    fingerprint: fingerprint('Spring Boot 新增分页查询接口 MyBatis-Plus 分页'),
    hitCount: 3,
    lastUsed: '2026-09-01T00:00:00Z',
  }

  const similar = scoreTemplate({
    queryFp: fingerprint('在 UserController 里新增一个支持分页的查询接口'),
    template,
    repoHash: 'abc123',
    now: NOW,
  })
  assert.equal(similar.hit, true, `同类需求应命中，实际得分 ${similar.score}`)

  const distant = scoreTemplate({
    queryFp: fingerprint('修复微信小程序登录页面的样式错位问题'),
    template,
    repoHash: 'abc123',
    now: NOW,
  })
  assert.equal(distant.hit, false, `异类需求不应命中，实际得分 ${distant.score}`)

  assert.ok(similar.score > distant.score, '同类得分必须高于异类')
})

test('scoreTemplate：同仓库加成生效', () => {
  const template = {
    id: 'tpl-bbbbbbbbbb',
    fingerprint: fingerprint('新增分页查询接口'),
    category: 'feature/api',
    tags: ['java'],
    hitCount: 0,
  }
  const same = scoreTemplate({ queryFp: fingerprint('新增分页查询接口'), template, repoHash: 'abc123', now: NOW })
  const other = scoreTemplate({ queryFp: fingerprint('新增分页查询接口'), template, repoHash: 'zzz999', now: NOW })
  // 模板未声明 repo 时，sameRepo 都是 0，得分应相同
  assert.equal(same.score, other.score)

  const withRepo = { ...template, repo: 'abc123' }
  const boosted = scoreTemplate({ queryFp: fingerprint('新增分页查询接口'), template: withRepo, repoHash: 'abc123', now: NOW })
  assert.ok(boosted.score > same.score, '声明了 repo 且匹配时应有加成')
})

test('scoreTemplate：分数始终落在 0~1', () => {
  const template = { id: 'tpl-cccccccccc', fingerprint: [{ token: 'x', weight: 9 }], tags: [], hitCount: 0 }
  const r = scoreTemplate({ queryFp: fingerprint('完全不相关的东西'), template, now: NOW })
  assert.ok(r.score >= 0 && r.score <= 1)
})

test('rankTemplates：按分数降序且截断到 limit', () => {
  const templates = [
    { id: 'tpl-0000000001', name: '低', fingerprint: fingerprint('完全无关的部署脚本'), hitCount: 0 },
    { id: 'tpl-0000000002', name: '高', fingerprint: fingerprint('新增分页查询接口'), hitCount: 5 },
    { id: 'tpl-0000000003', name: '中', fingerprint: fingerprint('分页查询'), hitCount: 1 },
  ]
  const ranked = rankTemplates({
    queryFp: fingerprint('新增一个分页查询接口'),
    templates,
    limit: 2,
    now: NOW,
  })
  assert.equal(ranked.length, 2)
  assert.ok(ranked[0].score >= ranked[1].score)
  assert.equal(ranked[0].template.name, '高')
})

test('toWeightMap：兼容数组与 Map 两种输入', () => {
  const arr = [{ token: 'a', weight: 2 }]
  assert.deepEqual(toWeightMap(arr), new Map([['a', 2]]))
  const m = new Map([['b', 1]])
  assert.equal(toWeightMap(m), m)
})

test('scoreTemplate：查询侧标签重叠带来加成（0.3.1 接线修复）', () => {
  const template = {
    id: 'tpl-dddddddddd',
    category: 'frontend/component',
    tags: ['vue', 'a-switch', 'form'],
    fingerprint: fingerprint('Vue 管理页表单加开关字段'),
    hitCount: 0,
  }
  const term = '在 Vue 管理页用 a-switch 给表单加一个开关字段'
  const base = fingerprint(term)

  // 修复前：queryFp 是纯数组，无 tags → 标签重叠恒为 0
  const before = scoreTemplate({ queryFp: base, template, now: NOW })

  // 修复后：查询侧推断出 tags 并附加
  const withTags = fingerprint(term)
  withTags.tags = inferQueryTags(term)
  const after = scoreTemplate({ queryFp: withTags, template, now: NOW })

  assert.ok(inferQueryTags(term).includes('a-switch'), '应保留 a-switch 这种连字符复合词')
  assert.equal(before.breakdown.tagOverlap, 0, '未接线时标签重叠为 0')
  assert.ok(after.breakdown.tagOverlap > 0, '接线后标签重叠应大于 0')
  assert.ok(after.score > before.score, `接线后得分应提升：${before.score} -> ${after.score}`)
})

test('scoreTemplate：一级分类相同即计同分类（二级自由填写）', () => {
  const template = {
    id: 'tpl-eeeeeeeeee',
    category: 'frontend/component',
    tags: [],
    fingerprint: fingerprint('Vue 管理页表单'),
    hitCount: 0,
  }
  const qp = fingerprint('Vue 管理页表单')
  qp.category = 'frontend/pagination' // 一级相同、二级不同
  assert.equal(scoreTemplate({ queryFp: qp, template, now: NOW }).breakdown.sameCategory, 1)

  const qp2 = fingerprint('Vue 管理页表单')
  qp2.category = 'bugfix/null' // 一级不同
  assert.equal(scoreTemplate({ queryFp: qp2, template, now: NOW }).breakdown.sameCategory, 0)
})

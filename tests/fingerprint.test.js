import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WEIGHT_PATH,
  WEIGHT_TECH,
  extractPaths,
  fingerprint,
  focusFingerprint,
  inferQueryTags,
  normalize,
  segmentChinese,
  splitIdentifier,
  tokenize,
} from '../lib/fingerprint.js'

test('normalize：全角转半角、小写、空白归一', () => {
  assert.equal(normalize('ＡＢＣ　１２３'), 'abc 123')
  assert.equal(normalize('  Spring   Boot  '), 'spring boot')
  assert.equal(normalize(null), '')
})

test('splitIdentifier：驼峰与分隔符拆分', () => {
  assert.deepEqual(splitIdentifier('getUserInfo'), ['get', 'user', 'info'])
  assert.deepEqual(splitIdentifier('PageHelper'), ['page', 'helper'])
  assert.deepEqual(splitIdentifier('user-service'), ['user', 'service'])
  assert.deepEqual(splitIdentifier('XxxController'), ['xxx', 'controller'])
})

test('extractPaths：抽出路径并留下残串', () => {
  const { paths, rest } = extractPaths('修改 src/main/java/XxxController.java 这个文件')
  assert.deepEqual(paths, ['src/main/java/XxxController.java'])
  assert.ok(!rest.includes('src/main/java/XxxController.java'))
})

test('extractPaths：Windows 反斜杠归一为正斜杠', () => {
  const { paths } = extractPaths('改一下 src\\views\\user\\index.vue')
  assert.deepEqual(paths, ['src/views/user/index.vue'])
})

test('segmentChinese：技术词典优先命中', () => {
  const grams = segmentChinese('新增分页查询接口')
  const tokens = grams.map((g) => g.token)
  assert.ok(tokens.includes('新增'), '应命中词典词「新增」')
  assert.ok(tokens.includes('分页'), '应命中词典词「分页」')
  assert.ok(tokens.includes('查询'), '应命中词典词「查询」')
  assert.ok(tokens.includes('接口'), '应命中词典词「接口」')
})

test('tokenize：技术词拿到高权重', () => {
  const t = tokenize('新增分页查询接口')
  assert.equal(t.get('分页'), WEIGHT_TECH)
  assert.equal(t.get('接口'), WEIGHT_TECH)
})

test('tokenize：文件路径权重最高', () => {
  const t = tokenize('修改 src/main/java/XxxController.java')
  assert.equal(t.get('src/main/java/xxxcontroller.java'), WEIGHT_PATH)
  assert.equal(t.get('xxxcontroller.java'), WEIGHT_PATH)
})

test('tokenize：路径中的类名再拆驼峰', () => {
  const t = tokenize('改 src/main/java/com/demo/UserOrderController.java')
  assert.ok(t.has('user'), '应从 UserOrderController 拆出 user')
  assert.ok(t.has('order'), '应从 UserOrderController 拆出 order')
  assert.ok(t.has('controller'), '应从 UserOrderController 拆出 controller')
})

test('tokenize：过滤停用词产生的噪音', () => {
  const t = tokenize('我的这个东西可以怎么弄一下')
  assert.ok(t.size <= 3, `停用词应被大幅过滤，实际剩余 ${[...t.keys()].join(',')}`)
})

test('fingerprint：按权重降序且不超过上限', () => {
  const fp = fingerprint('在 src/main/java/XxxController.java 新增分页查询接口，用 MyBatis-Plus 实现', 8)
  assert.ok(fp.length <= 8)
  for (let i = 1; i < fp.length; i++) {
    assert.ok(fp[i - 1].weight >= fp[i].weight, '权重必须降序')
  }
})

test('fingerprint：不同需求产生不同指纹', () => {
  const a = fingerprint('新增分页查询接口')
  const b = fingerprint('修复登录页面的样式错位')
  const setA = new Set(a.map((x) => x.token))
  const setB = new Set(b.map((x) => x.token))
  const inter = [...setA].filter((x) => setB.has(x)).length
  const union = new Set([...setA, ...setB]).size
  assert.ok(inter / union < 0.3, `两条差异很大的需求不应高度重合，实际 ${inter}/${union}`)
})

test('fingerprint：同类需求产生相近指纹', () => {
  const a = tokenize('新增一个分页查询接口')
  const b = tokenize('添加一个支持分页的查询接口')
  const inter = [...a.keys()].filter((k) => b.has(k))
  assert.ok(inter.length >= 3, `同类需求应共享多个 token，实际 ${inter.join(',')}`)
})

// ---------- 查询侧标签推断（0.3.1） ----------

test('inferQueryTags：保留带连字符的复合技术词整体', () => {
  const tags = inferQueryTags('在 Vue 管理页用 a-switch 给表单加开关字段')
  assert.ok(tags.includes('a-switch'), '应保留 a-switch 整体，实际：' + tags.join(', '))
})

test('inferQueryTags：抽取路径片段（末段文件名与有效目录名）', () => {
  const tags = inferQueryTags('修改 src/views/propertyStaff/index.vue 这个页面')
  assert.ok(tags.includes('index'), '应取末段文件名（去扩展名）')
  assert.ok(tags.includes('propertystaff'), '应取非噪声目录名')
  assert.ok(!tags.includes('views'), '噪声目录应被排除')
})

test('inferQueryTags：识别技术词与中文技术词', () => {
  const tags = inferQueryTags('在 vue 管理页给列表加 a-switch，表单也要改')
  assert.ok(tags.includes('vue'), '技术词 vue 应被识别，实际：' + tags.join(', '))
  assert.ok(tags.some((t) => ['表单', '列表'].includes(t)), '中文技术词应被识别')
})

test('inferQueryTags：结果数量不超过上限（避免稀释 jaccard 分母）', () => {
  const tags = inferQueryTags(
    '改造 src/views/user/UserOrderController.java 的分页查询接口，配合 mybatis-plus 做筛选排序导出导入'
  )
  assert.ok(tags.length <= 8, '标签数应 <= 8，实际 ' + tags.length)
  assert.ok(tags.length > 0)
})

test('inferQueryTags：空输入返回空数组', () => {
  assert.deepEqual(inferQueryTags(''), [])
  assert.deepEqual(inferQueryTags(null), [])
})

// ---------- 查询侧聚焦（0.3.2） ----------

test('focusFingerprint：强信号 token 全保留，2-gram 截断到上限', () => {
  const fp = [
    { token: 'index.vue', weight: 4 },
    { token: '新增', weight: 3 },
    { token: 'ismainadmin', weight: 2 },
    { token: '管理', weight: 1 },
    { token: '页面', weight: 1 },
    { token: '字段', weight: 1 },
    { token: '展示', weight: 1 },
    { token: '完成', weight: 1 },
    { token: '需求', weight: 1 },
    { token: '帮助', weight: 1 },
    { token: '这个', weight: 1 },
  ]
  const out = focusFingerprint(fp, 3)
  const strong = out.filter((t) => t.weight >= 2).length
  const grams = out.filter((t) => t.weight < 2).length
  assert.equal(strong, 3, '权重>=2 的 token 一个都不能丢')
  assert.equal(grams, 3, '2-gram 应截断到 maxGram=3')
  assert.equal(out.length, 6)
})

test('focusFingerprint：默认保留 8 个 2-gram 兜底中文表述', () => {
  const grams = Array.from({ length: 20 }, (_, i) => ({ token: `词${i}`, weight: 1 }))
  const strong = [{ token: 'vue', weight: 3 }]
  const out = focusFingerprint([...grams, ...strong])
  assert.equal(out.filter((t) => t.weight < 2).length, 8, '默认 maxGram=8')
  assert.ok(out.some((t) => t.token === 'vue'))
})

test('focusFingerprint：非数组与空输入安全返回', () => {
  assert.deepEqual(focusFingerprint(null), [])
  assert.deepEqual(focusFingerprint(undefined), [])
  assert.deepEqual(focusFingerprint([]), [])
})

test('focusFingerprint：长需求聚焦后覆盖率不降反升（低信号尾巴被削掉）', () => {
  const long = fingerprint(
    'index.vue 这个物业管理员管理页面的新增/修改接口增加一个主管管员字段 isMainAdmin，值为1是，0否，默认为否，这个字段用开关来显示，请帮我完成这个需求',
    24
  )
  const focused = focusFingerprint(long)
  assert.ok(focused.length < long.length, '聚焦应削减 token 数')
  // 模板侧只含强信号 token + 少量共有 gram 的受控场景
  const template = new Map([
    ['index.vue', 4],
    ['新增', 3],
    ['修改', 3],
    ['ismainadmin', 2],
    ['admin', 2],
    ['管理', 1],
    ['页面', 1],
  ])
  const cov = (tokens) => {
    const total = tokens.reduce((a, x) => a + (x.weight ?? 1), 0)
    let covered = 0
    for (const t of tokens) {
      const wb = template.get(t.token)
      if (wb !== undefined) covered += Math.min(t.weight ?? 1, wb)
    }
    return covered / total
  }
  assert.ok(cov(focused) >= cov(long), `聚焦后覆盖率应更高：聚焦=${cov(focused).toFixed(3)} 原=${cov(long).toFixed(3)}`)
})

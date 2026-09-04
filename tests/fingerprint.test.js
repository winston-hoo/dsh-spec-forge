import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WEIGHT_PATH,
  WEIGHT_TECH,
  extractPaths,
  fingerprint,
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

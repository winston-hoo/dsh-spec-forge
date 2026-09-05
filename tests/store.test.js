import { test } from 'node:test'
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ID_PATTERN,
  assertSafeId,
  collectRedlines,
  dataRoot,
  listTemplates,
  parseFrontmatter,
  parseProfile,
  parseSimpleYaml,
  purgeStale,
  readProfile,
  readTemplate,
  recordHit,
  repoHash,
  resolveHome,
  staleTemplates,
  stringifyFrontmatter,
  templateId,
  templatePath,
  writeProfile,
  writeTemplate,
} from '../lib/store.js'

let tmpHome

test.beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'spec-forge-'))
})

test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

test('resolveHome：优先读 DSH_HOME', () => {
  assert.equal(resolveHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh')
})

test('dataRoot：固定在 $DSH_HOME/spec-forge', () => {
  assert.equal(dataRoot('/x/dsh').replace(/\\/g, '/'), '/x/dsh/spec-forge')
})

test('repoHash：稳定且长度固定', () => {
  assert.equal(repoHash('/repo/a'), repoHash('/repo/a'))
  assert.notEqual(repoHash('/repo/a'), repoHash('/repo/b'))
  assert.equal(repoHash('/repo/a').length, 12)
})

test('repoHash：Windows 路径与大小写归一', () => {
  assert.equal(repoHash('C:\\Work\\Demo'), repoHash('c:/work/demo'))
  assert.equal(repoHash('C:\\Work\\Demo\\'), repoHash('c:/work/demo'))
})

test('templateId：同名同仓库幂等，跨仓库隔离', () => {
  const a = templateId('新增分页查询接口', 'abc123')
  const b = templateId('新增分页查询接口', 'abc123')
  const c = templateId('新增分页查询接口', 'zzz999')
  assert.equal(a, b, '同名需求应覆盖而非堆积')
  assert.notEqual(a, c)
  assert.match(a, ID_PATTERN)
})

test('assertSafeId：拒绝路径穿越', () => {
  assert.throws(() => assertSafeId('../../../etc/passwd'))
  assert.throws(() => assertSafeId('tpl-ABC'))
  assert.throws(() => assertSafeId('tpl-'))
  assert.doesNotThrow(() => assertSafeId('tpl-a1b2c3d4e5'))
})

test('parseSimpleYaml：支持标量、列表与内联数组', () => {
  const parsed = parseSimpleYaml(
    ['name: 测试模板', 'tags:', '  - java', '  - vue', 'category: feature/api', 'empty: []', 'inline: [a, b]', 'quoted: \'a: b\''].join('\n')
  )
  assert.equal(parsed.name, '测试模板')
  assert.deepEqual(parsed.tags, ['java', 'vue'])
  assert.equal(parsed.category, 'feature/api')
  assert.deepEqual(parsed.empty, [])
  assert.deepEqual(parsed.inline, ['a', 'b'])
  assert.equal(parsed.quoted, 'a: b')
})

test('stringifyFrontmatter + parseFrontmatter：往返一致', () => {
  const meta = {
    id: 'tpl-a1b2c3d4e5',
    name: '新增分页查询接口',
    category: 'feature/api',
    tags: ['java', 'spring-boot'],
    fingerprint: ['分页|3', '接口|3'],
    hitCount: 3,
  }
  const body = '# 标题\n\n正文内容\n'
  const md = stringifyFrontmatter(meta, body)
  const { meta: out, body: outBody } = parseFrontmatter(md)

  assert.equal(out.id, meta.id)
  assert.equal(out.name, meta.name)
  assert.equal(out.category, meta.category)
  assert.deepEqual(out.tags, meta.tags)
  assert.deepEqual(out.fingerprint, meta.fingerprint)
  assert.equal(out.hitCount, '3', 'YAML 解析出的是字符串，消费侧需自行转数字')
  assert.ok(outBody.includes('正文内容'))
})

test('stringifyFrontmatter：特殊字符被正确加引号', () => {
  const md = stringifyFrontmatter({ name: 'a: b', tags: [] }, 'body')
  const { meta } = parseFrontmatter(md)
  assert.equal(meta.name, 'a: b')
})

test('writeTemplate + readTemplate：落盘后可原样读回', () => {
  const id = templateId('新增分页查询接口', 'abc123')
  const body = '# 新增分页查询接口\n\n## 禁区\n\n- 不要改 Result.java\n'
  const written = writeTemplate(
    tmpHome,
    'abc123',
    id,
    { name: '新增分页查询接口', category: 'feature/api', tags: ['java'], fingerprint: ['分页|3'] },
    body
  )
  assert.ok(existsSync(written.file))

  const read = readTemplate(tmpHome, 'abc123', id)
  assert.equal(read.name, '新增分页查询接口')
  assert.equal(read.category, 'feature/api')
  assert.deepEqual(read.tags, ['java'])
  assert.deepEqual(read.fingerprint, [{ token: '分页', weight: 3 }])
  assert.ok(read.body.includes('不要改 Result.java'))
})

test('writeTemplate：原子写不留下临时文件', () => {
  const id = templateId('x', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: 'x' }, 'body')
  const dir = join(dataRoot(tmpHome), 'projects', 'abc123', 'templates')
  const files = readdirSync(dir)
  assert.ok(files.every((f) => !f.endsWith('.tmp')), `不应残留临时文件：${files.join(',')}`)
})

test('listTemplates：项目层与全局层合并', () => {
  writeTemplate(tmpHome, 'global', templateId('通用模板', 'global'), { name: '通用模板' }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('项目模板', 'abc123'), { name: '项目模板' }, 'body')

  const all = listTemplates(tmpHome, 'abc123')
  assert.equal(all.length, 2)

  const globalOnly = listTemplates(tmpHome, null)
  assert.equal(globalOnly.length, 1)
  assert.equal(globalOnly[0].name, '通用模板')
})

test('listTemplates：损坏的模板不影响其余加载', () => {
  writeTemplate(tmpHome, 'abc123', templateId('正常', 'abc123'), { name: '正常' }, 'body')
  const badId = templateId('损坏', 'abc123')
  writeTemplate(tmpHome, 'abc123', badId, { name: '损坏' }, 'body')
  writeFileSync(join(dataRoot(tmpHome), 'projects', 'abc123', 'templates', `${badId}.md`), 'not a valid template')

  const all = listTemplates(tmpHome, 'abc123')
  assert.equal(all.length, 2, '结构异常的文件也要能被列出，只是字段为空')
})

test('listTemplates：跳过非法文件名', () => {
  writeTemplate(tmpHome, 'abc123', templateId('正常', 'abc123'), { name: '正常' }, 'body')
  writeFileSync(join(dataRoot(tmpHome), 'projects', 'abc123', 'templates', 'evil.md'), 'x')
  assert.equal(listTemplates(tmpHome, 'abc123').length, 1)
})

test('recordHit：累加命中次数并刷新最近使用时间', () => {
  const id = templateId('y', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: 'y', hitCount: 0 }, 'body')

  recordHit(tmpHome, 'abc123', id)
  const after1 = readTemplate(tmpHome, 'abc123', id)
  assert.equal(after1.hitCount, 1)
  assert.ok(after1.lastUsed)

  recordHit(tmpHome, 'abc123', id)
  assert.equal(readTemplate(tmpHome, 'abc123', id).hitCount, 2)
})

test('writeProfile + readProfile：项目禁区持久化', () => {
  writeProfile(tmpHome, 'abc123', {
    repoName: 'asset-warning-system',
    redlines: ['不要改 common/Result.java', '不要动 MybatisPlusConfig'],
    conventions: ['Controller 不写业务逻辑'],
    notes: 'ISO 申报期间勿改公共模块',
  })

  const profile = readProfile(tmpHome, 'abc123')
  assert.equal(profile.repoName, 'asset-warning-system')
  assert.deepEqual(profile.redlines, ['不要改 common/Result.java', '不要动 MybatisPlusConfig'])
  assert.deepEqual(profile.conventions, ['Controller 不写业务逻辑'])
  assert.ok(profile.notes.includes('ISO'))
})

test('readProfile：未初始化时返回空结构而非报错', () => {
  const profile = readProfile(tmpHome, 'never-used')
  assert.deepEqual(profile.redlines, [])
  assert.deepEqual(profile.conventions, [])
})

test('parseProfile：空占位被正确忽略', () => {
  const parsed = parseProfile('---\nrepoName: demo\n---\n\n## 禁区\n\n- （暂无）\n\n## 约定\n\n- 用 4 空格缩进\n')
  assert.deepEqual(parsed.redlines, [])
  assert.deepEqual(parsed.conventions, ['用 4 空格缩进'])
})

test('collectRedlines：合并项目档案与命中模板的禁区并去重', () => {
  writeProfile(tmpHome, 'abc123', { repoName: 'demo', redlines: ['不要改 A'], conventions: [], notes: '' })
  const id = templateId('z', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: 'z' }, '## 禁区\n\n- 不要改 B\n- 不要改 A\n')

  const redlines = collectRedlines(tmpHome, 'abc123', [readTemplate(tmpHome, 'abc123', id)])
  assert.deepEqual(redlines, ['不要改 A', '不要改 B'], '重复项应被去掉')
})

/** 生成 n 天前（UTC 日期粒度）的日期串，避免毫秒级边界抖动 */
function dateNDaysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

test('purgeStale：清理超过 90 天未使用的模板并返回数量', () => {
  const fresh = writeTemplate(tmpHome, 'abc123', templateId('新鲜模板', 'abc123'), { name: '新鲜模板', lastUsed: dateNDaysAgo(1) }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('过期甲', 'abc123'), { name: '过期甲', lastUsed: dateNDaysAgo(95) }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('过期乙', 'abc123'), { name: '过期乙', lastUsed: dateNDaysAgo(200) }, 'body')

  assert.equal(purgeStale(tmpHome, 'abc123'), 2)

  const left = listTemplates(tmpHome, 'abc123')
  assert.equal(left.length, 1)
  assert.equal(left[0].id, fresh.id)
})

test('purgeStale：90 天边界——恰好 90 天保留、超过才删', () => {
  writeTemplate(tmpHome, 'abc123', templateId('整90', 'abc123'), { name: '整90', lastUsed: dateNDaysAgo(90) }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('超90', 'abc123'), { name: '超90', lastUsed: dateNDaysAgo(91) }, 'body')

  assert.equal(purgeStale(tmpHome, 'abc123'), 1)
  const left = listTemplates(tmpHome, 'abc123')
  assert.equal(left.length, 1)
  assert.equal(left[0].name, '整90')
})

test('purgeStale：days 参数可覆盖默认阈值', () => {
  writeTemplate(tmpHome, 'abc123', templateId('近七天', 'abc123'), { name: '近七天', lastUsed: dateNDaysAgo(3) }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('老十天', 'abc123'), { name: '老十天', lastUsed: dateNDaysAgo(10) }, 'body')

  assert.equal(purgeStale(tmpHome, 'abc123', 7), 1)
  assert.equal(listTemplates(tmpHome, 'abc123')[0].name, '近七天')
})

test('purgeStale：仓库视角下全局层超期模板一并清理', () => {
  writeTemplate(tmpHome, 'global', templateId('全局过期', 'global'), { name: '全局过期', lastUsed: dateNDaysAgo(300) }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('项目新鲜', 'abc123'), { name: '项目新鲜', lastUsed: dateNDaysAgo(2) }, 'body')

  assert.equal(purgeStale(tmpHome, 'abc123'), 1)
  assert.equal(listTemplates(tmpHome, null).length, 0, '全局层超期模板应被删除')
  assert.equal(listTemplates(tmpHome, 'abc123').length, 1)
})

test('purgeStale：时间判定回退 updated，无任何时间字段的模板保留', () => {
  // 手工落盘：仅带旧 updated 的模板应被清理（回退链第二环）
  const viaUpdated = templateId('老updated', 'abc123')
  writeFileSync(templatePath(tmpHome, 'abc123', viaUpdated), stringifyFrontmatter({ id: viaUpdated, name: '老updated', updated: dateNDaysAgo(120) }, 'body'))
  // 完全无时间字段的模板：保守保留，不误删
  const noDates = templateId('无日期', 'abc123')
  writeFileSync(templatePath(tmpHome, 'abc123', noDates), stringifyFrontmatter({ id: noDates, name: '无日期' }, 'body'))

  assert.equal(purgeStale(tmpHome, 'abc123'), 1)
  const left = listTemplates(tmpHome, 'abc123')
  assert.equal(left.length, 1)
  assert.equal(left[0].id, noDates)
})

test('staleTemplates：只统计不删除，返回可精确定位的过期模板', () => {
  writeTemplate(tmpHome, 'abc123', templateId('近的', 'abc123'), { name: '近的', lastUsed: dateNDaysAgo(5) }, 'body')
  const oldId = templateId('老的', 'abc123')
  writeTemplate(tmpHome, 'abc123', oldId, { name: '老的', lastUsed: dateNDaysAgo(95) }, 'body')

  const stale = staleTemplates(tmpHome, 'abc123')
  assert.equal(stale.length, 1)
  assert.equal(stale[0].name, '老的')
  assert.ok(stale[0].file, '应带 file 路径供后续精确删除')
  assert.ok(existsSync(templatePath(tmpHome, 'abc123', oldId)), '统计不应删除文件')
  assert.equal(listTemplates(tmpHome, 'abc123').length, 2)
})

test('listTemplates 读缓存：写盘后再次列出立即可见新模板（写版本号失效）', () => {
  writeTemplate(tmpHome, 'abc123', templateId('缓存甲', 'abc123'), { name: '缓存甲' }, 'body')
  assert.equal(listTemplates(tmpHome, 'abc123').length, 1)

  const id2 = templateId('缓存乙', 'abc123')
  writeTemplate(tmpHome, 'abc123', id2, { name: '缓存乙' }, 'body')
  const names = listTemplates(tmpHome, 'abc123').map((t) => t.name)
  assert.ok(names.includes('缓存乙'), '写盘后新模板必须立即可见，不得返回旧缓存')
})

test('listTemplates 读缓存：recordHit 只改内容不改文件名，命中数仍立即可见', () => {
  const id = templateId('计数', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: '计数' }, 'body')
  const before = listTemplates(tmpHome, 'abc123')[0]

  recordHit(tmpHome, 'abc123', id)
  const after = listTemplates(tmpHome, 'abc123')[0]
  assert.equal(after.hitCount, (before.hitCount ?? 0) + 1, '命中计数写盘后应立即可见')
})

test('listTemplates 读缓存：外部直写新文件（绕过写版本号）也能被文件名集合变化发现', () => {
  writeTemplate(tmpHome, 'abc123', templateId('已有', 'abc123'), { name: '已有' }, 'body')
  listTemplates(tmpHome, 'abc123') // 填充缓存

  const extId = templateId('外部新增', 'abc123')
  writeFileSync(templatePath(tmpHome, 'abc123', extId), stringifyFrontmatter({ id: extId, name: '外部新增' }, 'body'))
  const names = listTemplates(tmpHome, 'abc123').map((t) => t.name)
  assert.ok(names.includes('外部新增'), '文件名集合变化应触发缓存重建')
})

test('listTemplates 读缓存：调用方原地排序不污染缓存内容', () => {
  writeTemplate(tmpHome, 'abc123', templateId('低命中', 'abc123'), { name: '低命中', hitCount: 1 }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('高命中', 'abc123'), { name: '高命中', hitCount: 9 }, 'body')

  listTemplates(tmpHome, 'abc123').sort((a, b) => a.hitCount - b.hitCount) // 原地排序
  const again = listTemplates(tmpHome, 'abc123')
  assert.equal(again.length, 2)
  assert.deepEqual(again.map((t) => t.name).sort(), ['低命中', '高命中'], '缓存内容不得被调用方污染')
})

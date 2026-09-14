import { test } from 'node:test'
import assert from 'node:assert/strict'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ID_PATTERN,
  STORAGE_MODES,
  assertSafeId,
  bumpWriteEpoch,
  collectRedlines,
  copyTree,
  dataRoot,
  dedupeRedlines,
  isCrossDrive,
  liftLegacyNesting,
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
  resolveStorageRoot,
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
  const dir = join(tmpHome, 'projects', 'abc123', 'templates')
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
  writeFileSync(join(tmpHome, 'projects', 'abc123', 'templates', `${badId}.md`), 'not a valid template')

  const all = listTemplates(tmpHome, 'abc123')
  assert.equal(all.length, 2, '结构异常的文件也要能被列出，只是字段为空')
})

test('listTemplates：跳过非法文件名', () => {
  writeTemplate(tmpHome, 'abc123', templateId('正常', 'abc123'), { name: '正常' }, 'body')
  writeFileSync(join(tmpHome, 'projects', 'abc123', 'templates', 'evil.md'), 'x')
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
    repoName: 'example-admin',
    redlines: ['不要改 common/Result.java', '不要动 MybatisPlusConfig'],
    conventions: ['Controller 不写业务逻辑'],
    notes: 'ISO 申报期间勿改公共模块',
  })

  const profile = readProfile(tmpHome, 'abc123')
  assert.equal(profile.repoName, 'example-admin')
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

// ---------- 0.3.3：存储路径关键字解析与迁移 ----------

test('resolveStorageRoot：默认 workspace 模式指向 <cwd>/.dsh-spec-forge', () => {
  const cwd = join(tmpdir(), 'fake-cwd')
  const r = resolveStorageRoot({ cwd })
  assert.equal(r.mode, 'workspace')
  assert.equal(r.path, join(cwd, '.dsh-spec-forge'))
})

test('resolveStorageRoot：home 模式指向 $DSH_HOME/spec-forge', () => {
  const r = resolveStorageRoot({ storageRoot: 'home', cwd: tmpdir() })
  assert.equal(r.mode, 'home')
  assert.equal(r.path, dataRoot(resolveHome()))
})

test('resolveStorageRoot：storageHome 非空时优先级最高且原样当绝对路径', () => {
  const explicit = join(tmpdir(), 'explicit', 'templates')
  const r = resolveStorageRoot({
    storageHome: explicit,
    storageRoot: 'workspace',
    cwd: tmpdir(),
  })
  assert.equal(r.mode, 'explicit')
  assert.equal(r.path, explicit.replace(/[\\/]$/, ''))
})

test('resolveStorageRoot：未知关键字抛错并给出可选值', () => {
  assert.throws(() => resolveStorageRoot({ storageRoot: 'cloud', cwd: tmpdir() }), /未知的 storageRoot/)
})

test('resolveStorageRoot：空字符串 storageRoot 视为默认 workspace', () => {
  const cwd = tmpdir()
  const r = resolveStorageRoot({ storageRoot: '', cwd })
  assert.equal(r.mode, 'workspace')
})

test('STORAGE_MODES：仅 workspace 与 home 两种关键字', () => {
  assert.deepEqual([...STORAGE_MODES], ['workspace', 'home'])
})

test('isCrossDrive：同盘返回 false；POSIX 永远返回 false', () => {
  if (process.platform === 'win32') {
    assert.equal(isCrossDrive('C:/a', 'C:/b'), false)
    assert.equal(isCrossDrive('C:/a', 'D:/a'), true)
  }
  assert.equal(isCrossDrive('/a', '/b'), false)
})

test('copyTree：递归复制且同名文件跳过不覆盖', () => {
  const src = mkdtempSync(join(tmpdir(), 'cp-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'cp-dst-'))
  mkdirSync(join(src, 'sub'))
  writeFileSync(join(src, 'a.md'), 'from-src')
  writeFileSync(join(src, 'sub', 'b.md'), 'nested')
  writeFileSync(join(dst, 'a.md'), 'preexisting')

  const result = copyTree(src, dst, false)
  assert.equal(result.copied, 1, 'sub/b.md 复制；a.md 跳过')
  assert.equal(result.skipped, 1)
  assert.equal(readFileContent(join(dst, 'a.md')), 'preexisting', '跳过模式下目标不被覆盖')
  assert.equal(readFileContent(join(dst, 'sub', 'b.md')), 'nested')

  rmSync(src, { recursive: true, force: true })
  rmSync(dst, { recursive: true, force: true })
})

test('copyTree：move 模式成功后删除源文件', () => {
  const src = mkdtempSync(join(tmpdir(), 'mv-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'mv-dst-'))
  writeFileSync(join(src, 'x.md'), 'move me')
  const r = copyTree(src, dst, true)
  assert.equal(r.copied, 1)
  assert.equal(existsSync(join(src, 'x.md')), false, '源文件已被删除')
  rmSync(src, { recursive: true, force: true })
  rmSync(dst, { recursive: true, force: true })
})

test('bumpWriteEpoch：返回值递增', () => {
  const a = bumpWriteEpoch()
  const b = bumpWriteEpoch()
  assert.ok(b > a, `bump 应单调递增: ${a} -> ${b}`)
})

// ---------- 0.4.1 回归：指纹序列化 ----------

test('writeTemplate：对象形式的指纹会序列化成 token|weight（不再写成 [object Object]）', () => {
  const id = templateId('指纹序列化', 'abc123')
  writeTemplate(
    tmpHome,
    'abc123',
    id,
    { name: '指纹序列化', fingerprint: [{ token: 'index.vue', weight: 4 }, { token: '开关', weight: 3 }] },
    'body',
  )
  const raw = readFileContent(templatePath(tmpHome, 'abc123', id))
  assert.ok(!raw.includes('[object Object]'), '落盘内容不得出现 [object Object]')
  assert.ok(raw.includes("'index.vue|4'") || raw.includes('index.vue|4'), '应写成 token|weight 形式')

  const back = readTemplate(tmpHome, 'abc123', id)
  assert.deepEqual(
    back.fingerprint.map((f) => [f.token, f.weight]),
    [['index.vue', 4], ['开关', 3]],
    '读回后应还原为对象',
  )
})

test('writeTemplate：字符串形式的指纹原样保留', () => {
  const id = templateId('字符串指纹', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: 'x', fingerprint: ['a|3', 'b|1'] }, 'body')
  const back = readTemplate(tmpHome, 'abc123', id)
  assert.deepEqual(back.fingerprint.map((f) => [f.token, f.weight]), [['a', 3], ['b', 1]])
})

test('writeTemplate：非法指纹项被丢弃而不是写坏', () => {
  const id = templateId('脏指纹', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: 'x', fingerprint: [null, 42, { weight: 2 }, { token: 'ok', weight: 1 }] }, 'body')
  const back = readTemplate(tmpHome, 'abc123', id)
  assert.deepEqual(back.fingerprint.map((f) => f.token), ['ok'])
})

test('recordHit：重写模板不会破坏既有指纹（0.4.0 曾把旧模板写成 [object Object]）', () => {
  const id = templateId('命中的模板', 'abc123')
  writeTemplate(tmpHome, 'abc123', id, { name: '命中的模板', fingerprint: [{ token: 'element-plus', weight: 3 }] }, 'body')

  recordHit(tmpHome, 'abc123', id)
  const raw = readFileContent(templatePath(tmpHome, 'abc123', id))
  assert.ok(!raw.includes('[object Object]'), 'recordHit 后指纹仍必须可读')

  const back = readTemplate(tmpHome, 'abc123', id)
  assert.equal(back.hitCount, 1)
  assert.deepEqual(back.fingerprint.map((f) => [f.token, f.weight]), [['element-plus', 3]])
})

// ---------- 0.4.1 回归：home 即数据根 ----------

test('布局：home 就是数据根，模板直接落在 <home>/{global,projects}', () => {
  writeTemplate(tmpHome, 'global', templateId('全局', 'global'), { name: '全局' }, 'body')
  writeTemplate(tmpHome, 'abc123', templateId('项目', 'abc123'), { name: '项目' }, 'body')

  assert.ok(existsSync(join(tmpHome, 'global', 'templates')), `应落在 <home>/global，实际不存在: ${tmpHome}`)
  assert.ok(existsSync(join(tmpHome, 'projects', 'abc123', 'templates')), '应落在 <home>/projects/<hash>')
  assert.ok(!existsSync(join(tmpHome, 'spec-forge')), '不得再出现多余的 spec-forge 层级')

  assert.equal(listTemplates(tmpHome, 'abc123').length, 2)
  assert.equal(listTemplates(tmpHome, null).length, 1)
})

test('layoutNotice：0.3.3/0.4.0 的嵌套布局会被一次性归位', () => {
  // 造出旧布局：<home>/spec-forge/{global,projects}
  const nested = join(tmpHome, 'spec-forge')
  mkdirSync(join(nested, 'projects', 'abc123', 'templates'), { recursive: true })
  writeFileSync(
    join(nested, 'projects', 'abc123', 'templates', 'tpl-aaaaaaaaaa.md'),
    stringifyFrontmatter({ id: 'tpl-aaaaaaaaaa', name: '旧布局模板', scope: 'abc123' }, 'body'),
  )

  const notice = liftLegacyNesting(tmpHome, { warn() {} })
  assert.ok(typeof notice === 'string' && notice.length > 0, '应返回归位说明')
  assert.ok(existsSync(join(tmpHome, 'projects', 'abc123', 'templates', 'tpl-aaaaaaaaaa.md')), '文件应上移一层')
  assert.equal(listTemplates(tmpHome, 'abc123').length, 1, '归位后应能被检索到')
})

test('layoutNotice：新位置已有数据时不动旧嵌套目录', () => {
  writeTemplate(tmpHome, 'abc123', templateId('新数据', 'abc123'), { name: '新数据' }, 'body')
  const nested = join(tmpHome, 'spec-forge', 'projects', 'abc123', 'templates')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'tpl-bbbbbbbbbb.md'), 'x')

  const notice = liftLegacyNesting(tmpHome, { warn() {} })
  assert.equal(notice, null, '已有新数据时不应归位，避免覆盖')
  assert.ok(existsSync(join(nested, 'tpl-bbbbbbbbbb.md')))
})

// ---------- 0.4.2 回归：上移后不留空壳 ----------

test('layoutNotice：归位后不再遗留空的 <root>/spec-forge 空壳', () => {
  const nested = join(tmpHome, 'spec-forge')
  mkdirSync(join(nested, 'projects', 'abc123', 'templates'), { recursive: true })
  writeFileSync(
    join(nested, 'projects', 'abc123', 'templates', 'tpl-aaaaaaaaaa.md'),
    stringifyFrontmatter({ id: 'tpl-aaaaaaaaaa', name: '旧布局模板', scope: 'abc123' }, 'body'),
  )

  const notice = liftLegacyNesting(tmpHome, { warn() {} })
  assert.ok(typeof notice === 'string' && notice.length > 0, '应返回归位说明')
  assert.ok(existsSync(join(tmpHome, 'projects', 'abc123', 'templates', 'tpl-aaaaaaaaaa.md')), '文件应上移一层')
  assert.ok(!existsSync(nested), '0.4.2 起上移后空目录应被删除（0.4.1 会永久留下空壳）')
})

test('layoutNotice：新布局已在用时，遗留的空壳也会被清掉', () => {
  // 复现实测残留：<root>/projects 已在顶层，<root>/spec-forge/ 只剩空目录
  writeTemplate(tmpHome, 'abc123', templateId('新数据', 'abc123'), { name: '新数据' }, 'body')
  const nested = join(tmpHome, 'spec-forge')
  mkdirSync(nested, { recursive: true })

  const notice = liftLegacyNesting(tmpHome, { warn() {} })
  assert.equal(notice, null, '新布局在用时不上移、不报归位')
  assert.ok(!existsSync(nested), '空壳应被顺手清掉')
  assert.equal(listTemplates(tmpHome, 'abc123').length, 1, '新数据不受影响')
})

test('layoutNotice：旧目录上移后若非空（有跳过项）则保留，不误删数据', () => {
  // 触发 skip 分支：源目录里有个同名条目已在目标位置存在
  // （不能拿 global/projects 造，那会被“新布局已存在”的守卫提前拦下）
  writeFileSync(join(tmpHome, 'stray.txt'), 'root')
  const nested = join(tmpHome, 'spec-forge')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'stray.txt'), 'nested')

  const notice = liftLegacyNesting(tmpHome, { warn() {} })
  assert.equal(notice, null, '全部跳过时无归位动作')
  assert.ok(existsSync(join(nested, 'stray.txt')), '非空旧目录不得被删除')
  assert.equal(readFileContent(join(nested, 'stray.txt')), 'nested', '旧数据不被覆盖')
  assert.equal(readFileContent(join(tmpHome, 'stray.txt')), 'root', '目标数据不被覆盖')
})

function readFileContent(file) {
  return readFileSync(file, 'utf8')
}

// ---------- 0.4.5：禁区近重复去重 ----------

test('dedupeRedlines：括号说明不同但规则相同的条目会被合并（真实 example-admin 用例）', () => {
  const out = dedupeRedlines([
    'package.json 不新增依赖（需要 zip/导出时用浏览器原生 Blob，不引 jszip）',
    'package.json 不新增依赖（项目已登记禁区）',
  ])
  assert.equal(out.length, 1, '两条是同一规则')
  assert.ok(out[0].includes('不引 jszip'), '应保留信息量更大的那条')
})

test('dedupeRedlines：改写了语序的近重复条目也会被合并（真实 example-admin 用例）', () => {
  const out = dedupeRedlines([
    'example-admin/dist 是 git 跟踪的目录，vite build 默认 emptyOutDir 会清空它；验证构建必须显式 --outDir 到临时目录，事后清理；若已误写，用 git checkout HEAD -- example-admin/dist 还原',
    '验证构建必须显式 --outDir 到临时目录并事后清理；example-admin/dist 是 git 跟踪目录，被误写用 git checkout HEAD -- example-admin/dist 还原',
  ])
  assert.equal(out.length, 1, '两条是同一规则的不同写法')
  assert.ok(out[0].startsWith('example-admin/dist'), '应保留更完整的那条')
})

test('dedupeRedlines：不同规则不得被误合并', () => {
  const out = dedupeRedlines([
    'design/*.html 是设计稿基准，只读参考，任何情况下不改',
    'dynamic-routes.js 的双重限制机制不得弱化：只往 ROUTE_RECORDS 加登记',
    '只在 vite.config.js 兜底，不动业务源码',
    '不要用 server.watch.usePolling 替代忽略规则（CPU 代价高）',
  ])
  assert.equal(out.length, 4, '四条互不相同，不该被合并')
})

test('dedupeRedlines：内容相近但确实是两条规则的不得被合并', () => {
  // 注意：不要用「第一条规则…」「第二条规则…」这类只差开头两字的假数据当反例 ——
  // 它们共享 7/9 个 bigram，被判重复是算法的正确行为。
  const out = dedupeRedlines([
    '不要改 vite.config.js 里 watch.ignored 与 watcher error 监听这两层兜底',
    '不新增 npm 依赖，导出功能用浏览器原生 Blob 实现',
    '临时探针脚本用完必须删除，不留 __probe 残留',
  ])
  assert.equal(out.length, 3, '三条讲的是不同的事，不该被合并')
})

test('dedupeRedlines：空串与纯空白被丢弃，且保持原顺序', () => {
  const out = dedupeRedlines(['不要动全局配置文件里的任何字段', '   ', '', '导出一律走浏览器原生 Blob 下载'])
  assert.deepEqual(out, ['不要动全局配置文件里的任何字段', '导出一律走浏览器原生 Blob 下载'])
})

test('parseProfile：读档案时就做近重复去重（读路径同时服务注入与写盘，写回即自愈）', () => {
  const md = [
    '---',
    "repoName: 'demo'",
    '---',
    '## 禁区',
    '',
    '- package.json 不新增依赖（需要 zip/导出时用浏览器原生 Blob，不引 jszip）',
    '- package.json 不新增依赖（项目已登记禁区）',
    '- 不要改 vite.config.js 的兜底配置',
    '',
    '## 约定',
    '',
    '（暂无）',
    '',
    '## 备注',
    '',
    '（暂无）',
    '',
  ].join('\n')
  const p = parseProfile(md)
  assert.equal(p.redlines.length, 2, '两条 package.json 规则应合并为一条')
  assert.equal(p.repoName, 'demo')
})

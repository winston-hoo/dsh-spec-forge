// 工具层测试（0.4.7 新增）：用 mock ctx 执行 apply()，直接驱动注册出来的工具。
//
// 存在理由：`index.js` 的工具层此前**零单元测试**，而两次最严重的线上事故
// （写盘失败仍标记已沉淀、home 模式把自己复制给自己）都出在这一层。
// 这里不启动 dsh，只喂最小 ctx + 假会话事件流。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const CWD = 'D:/plugin-test-demo'

/** 造一份最小会话事件流。默认「已改码 + 上一轮正常结束」 */
function fakeSession({ turnEndKind = 'completed', cwd = CWD } = {}) {
  return {
    id: 'session-plugin-test',
    header: { cwd },
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { name: 'read', arguments: '{"filePath":"a.js"}' } },
      { type: 'tool/call', data: { name: 'edit', arguments: '{"filePath":"a.js"}' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '改完了' }] } } },
      { type: 'turn/end', data: { kind: turnEndKind } },
    ],
  }
}

/** 启动一个插件实例，返回注册出来的工具表 + 捕获到的常驻提示段 */
function boot(overrides = {}) {
  const tools = new Map()
  let section = null
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (name) => (name === 'systemPrompt' ? { section: (s) => { section = s } } : null),
    on: () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  const config = {
    autoRecall: true,
    autoRetro: true,
    matchThreshold: 0.35,
    maxInjectTemplates: 2,
    injectMaxChars: 4000,
    defaultScope: 'project',
    storageHome: '',
    storageRoot: 'workspace',
    retroMinToolCalls: 2,
    retroRequireCodeChange: true,
    strictDistill: true,
    ...overrides,
  }
  apply(ctx, config)
  return { tools, section, config }
}

const exec = (session) => ({ agent: { session } })

test('工具层：常驻提示段由契约渲染，含全部三态与提问白名单', () => {
  const { section } = boot()
  assert.ok(section, '应当注册常驻系统提示段')
  assert.equal(section.name, 'spec-forge:routing')
  for (const step of ['implement', 'confirm', 'triage']) {
    assert.ok(section.text.includes(`\`${step}\``), `常驻段缺少 ${step}`)
  }
  assert.ok(section.text.includes('ask_user_question'), '常驻段必须写明提问白名单')
  assert.ok(!/加按钮/.test(section.text), '容器型改动不得出现在常驻段里当 L1 直通')
})

test('工具层：spec_retro 写盘失败时不得把会话标记为"已沉淀"', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'spec-forge-plugin-'))
  try {
    // 用一个「父路径是文件」的位置当数据目录 → ensureDir 必然失败
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const { tools } = boot({ storageHome: join(blocker, 'spec-forge') })
    const session = fakeSession()

    const failed = await tools.get('spec_retro').execute(
      { name: '写盘必败的模板', approach: ['a'], acceptance: ['b'] },
      exec(session)
    )
    assert.equal(failed.saved, false, '必须如实回报失败')

    // 关键断言：失败之后，召回时仍然要提醒"本会话尚未沉淀"
    const recalled = await tools.get('spec_recall').execute({ requirement: '改一下这个文案', cwd: CWD }, exec(session))
    assert.ok(recalled.notice, '写盘失败后必须仍然提醒沉淀（retroDone 不能被置位）')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('工具层：上一轮没有正常结束时不得催沉淀（sessionComplete 真的接上了）', async () => {
  const { tools } = boot()
  const aborted = await tools.get('spec_recall').execute(
    { requirement: '改一下这个文案', cwd: CWD },
    exec(fakeSession({ turnEndKind: 'aborted' }))
  )
  assert.equal(aborted.notice, '', '未正常结束的会话不该出现沉淀提醒')

  const completed = await tools.get('spec_recall').execute(
    { requirement: '改一下这个文案', cwd: CWD },
    exec(fakeSession())
  )
  assert.ok(completed.notice, '已改码且正常结束的会话应当出现沉淀提醒')
})

test('工具层：home 模式没有"旧路径"，迁移不得自己复制自己', async () => {
  const { tools } = boot({ storageRoot: 'home' })
  const info = await tools.get('spec_library').execute({ action: 'info', cwd: CWD }, exec(fakeSession()))
  assert.ok(info.report.includes('与数据目录是同一个目录'), `实际报告：\n${info.report}`)
  assert.equal(info.legacy.hasData, false, '同路径时不应把现用库统计成旧路径数据')

  const migrated = await tools.get('spec_library').execute({ action: 'migrate', cwd: CWD }, exec(fakeSession()))
  assert.equal(migrated.migration, undefined, '同路径时不应执行任何复制')
  assert.ok(migrated.report.includes('没有独立旧路径'), `实际报告：\n${migrated.report}`)
})

test('工具层：strictDistill 真的生效——未声明禁区时警告可见且可关闭', async () => {
  const distill = boot().tools.get('spec_distill')
  const on = await distill.execute({ requirement: '给订单模块加导出' })
  assert.equal(on.missingConstraints, true)
  const textOn = distill.output.render({}, on)[0].text
  assert.ok(textOn.includes('missingConstraints=true'), 'missingConstraints 必须在模型可见的文本里')

  const off = boot({ strictDistill: false }).tools.get('spec_distill')
  const result = await off.execute({ requirement: '给订单模块加导出' })
  assert.equal(result.missingConstraints, false, '关掉 strictDistill 后不得再报缺禁区')
  assert.ok(!result.prompt.includes('警告：本次未声明禁区'), '关掉后提示词里不该再有警告')
})

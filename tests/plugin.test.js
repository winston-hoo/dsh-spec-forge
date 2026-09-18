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

/** 启动一个插件实例，返回注册出来的工具表 + 捕获到的常驻提示段 + 事件处理器 */
function boot(overrides = {}) {
  const tools = new Map()
  const handlers = new Map()
  let section = null
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (name) => (name === 'systemPrompt' ? { section: (s) => { section = s } } : null),
    on: (event, fn) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    logger: { info: () => {}, warn: () => {} },
  }
  const config = {
    autoRecall: true,
    autoRetro: true,
    matchThreshold: 0.35,
    maxInjectTemplates: 2,
    injectMaxChars: 4000,
    preStepRouting: true,
    defaultScope: 'project',
    storageHome: '',
    storageRoot: 'workspace',
    retroMinToolCalls: 2,
    retroRequireCodeChange: true,
    strictDistill: true,
    ...overrides,
  }
  apply(ctx, config)
  return { tools, section, handlers, config }
}

const exec = (session) => ({ agent: { session } })

/** 造一条"真实用户输入"消息：内置插件也用 source.kind === 'user' 判断用户输入 */
const userMessage = (text) => ({
  id: `u-${text.length}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** 驱动 agent/pre-step：payload 与内置插件收到的形状一致 */
async function runPreStep(handlers, messages, { turn = 1, payload = {} } = {}) {
  const preStep = (handlers.get('agent/pre-step') ?? [])[0]
  assert.ok(preStep, '必须注册 agent/pre-step 处理器')
  const decision = { kind: 'enter', messages }
  return preStep(
    { agent: { session: { id: 'session-pre-step' } }, turn, signal: { throwIfAborted() {} }, ...payload },
    async () => decision
  )
}

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

// ---------- pre-step 硬注入（0.5.0） ----------
//
// 这一层把"本轮该走哪条路"从"模型读了 spec_recall 返回值再自觉执行"变成
// "插件在请求发出前直接注入"。下面测的是注入的判定、内容与全部安全边界。

test('pre-step：L1 需求在请求发出前就拿到「一步直达」指令', async () => {
  const { handlers } = boot()
  const result = await runPreStep(handlers, [userMessage('@src/views/login/index.vue 登录页加个忘记密码按钮')])
  assert.equal(result.messages.length, 2, '应当追加一条注入消息')
  const injected = result.messages[1]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.plugin, 'dsh-spec-forge')
  assert.equal(injected.source.form, 'notice')
  const text = injected.content[0].text
  assert.ok(text.includes('L1 一步直达'), text)
  assert.ok(text.includes('spec_recall'), '注入必须保住"先召回"这一步（模板与禁区都靠它）')
  assert.ok(text.includes('spec_triage') && text.includes('spec_distill'), '必须明文禁止本轮多走流程')
  assert.ok(Object.isFrozen(injected), '注入消息应当不可变（与内置 createUserMessage 同形）')
})

test('pre-step：容器型缺内容需求在请求前就拿到「先问一次」指令', async () => {
  const { handlers } = boot()
  const result = await runPreStep(handlers, [userMessage('登录页加个按钮')])
  const text = result.messages.at(-1).content[0].text
  assert.ok(text.includes('缺少关键内容'), text)
  assert.ok(text.includes('ask_user_question'), text)
  assert.ok(text.includes('spec_recall'), '仍旧要先召回')
})

test('pre-step：普通问答不注入（不该花的 token 一分不花）', async () => {
  const { handlers } = boot()
  const messages = [userMessage('你好，今天几号？')]
  const result = await runPreStep(handlers, messages)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0], messages[0], '不注入时必须原样返回下游 messages')
})

test('pre-step：同一轮只注入一次，换一轮会重新判定', async () => {
  const { handlers } = boot()
  const req = '登录页加个忘记密码按钮'
  const once = await runPreStep(handlers, [userMessage(req)], { turn: 7 })
  assert.equal(once.messages.length, 2)

  const twice = await runPreStep(handlers, once.messages, { turn: 7 })
  assert.equal(twice.messages.length, 2, '同一轮内不得重复注入（多 step / 重放都要幂等）')

  const nextTurn = await runPreStep(handlers, once.messages, { turn: 8 })
  assert.equal(nextTurn.messages.length, 3, '换了一轮应当重新判定并注入')
})

test('pre-step：任何异常都原样放行，绝不拖垮本轮', async () => {
  const { handlers } = boot()
  const preStep = (handlers.get('agent/pre-step') ?? [])[0]

  const rejected = await preStep({ agent: {}, turn: 1 }, async () => ({ kind: 'reject' }))
  assert.equal(rejected.kind, 'reject', '下游 reject 必须原样透传')

  const noMessages = await preStep({ agent: {}, turn: 1 }, async () => ({ kind: 'enter' }))
  assert.equal(noMessages.kind, 'enter', 'decision 里没有 messages 也不能炸')

  const garbage = await preStep({ agent: {}, turn: 1 }, async () => ({ kind: 'enter', messages: [null, 42, {}] }))
  assert.equal(garbage.messages.length, 3, '垃圾消息不得被当成需求')

  const foreign = await runPreStep(handlers, [
    {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>别的插件的提示</system-reminder>' }],
      source: { kind: 'plugin', plugin: 'other-plugin' },
    },
  ])
  assert.equal(foreign.messages.length, 1, '别的插件的 system-reminder 不得被当成用户需求')
})

test('pre-step：关掉开关后不再注册注入（完全回到常驻段方案）', () => {
  const { handlers } = boot({ preStepRouting: false })
  assert.equal((handlers.get('agent/pre-step') ?? []).length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRetroDigest,
  collectPaths,
  extractSessionFacts,
  getEvents,
  isSessionComplete,
  messageText,
  parseToolArgs,
} from '../lib/extract.js'

/** 构造一个会话：envelope 自动补 seq */
function makeSession(events) {
  return { id: 'sess-1', events: events.map((e, i) => ({ seq: i + 1, ...e })) }
}

const USER = (text, kind = 'direct') => ({
  type: 'user/message',
  data: { content: text, source: { kind } },
})

const ASSISTANT = (text) => ({ type: 'assistant/message', data: { content: text, usage: { inputTokens: 10, outputTokens: 20 } } })

const TOOL_CALL = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
const TOOL_RESULT = () => ({ type: 'tool/result', data: { ok: true } })

/** 一个「完整结束」的标准会话 */
const COMPLETE_SESSION = makeSession([
  { type: 'turn/start', data: {} },
  USER('在 UserController 里新增一个分页查询接口'),
  TOOL_CALL('read_file', { path: 'src/main/java/UserController.java' }),
  TOOL_RESULT(),
  TOOL_CALL('edit_file', { path: 'src/main/java/UserController.java', content: '...' }),
  TOOL_RESULT(),
  ASSISTANT('已在 UserController 中新增分页查询接口，mvn test 通过。'),
  { type: 'turn/end', data: { kind: 'completed' } },
])

test('getEvents：按 seq 排序', () => {
  const events = getEvents({ events: [{ seq: 3 }, { seq: 1 }, { seq: 2 }] })
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
})

test('getEvents：空会话不抛错', () => {
  assert.deepEqual(getEvents(null), [])
  assert.deepEqual(getEvents({}), [])
})

test('parseToolArgs：解析 JSON 字符串参数', () => {
  assert.deepEqual(parseToolArgs({ data: { arguments: '{"path":"a/b.java"}' } }), { path: 'a/b.java' })
})

test('parseToolArgs：非法 JSON 不抛错，保留原文并标记', () => {
  const parsed = parseToolArgs({ data: { arguments: '{not json}' } })
  assert.equal(parsed._parseError, true)
})

test('parseToolArgs：非 JSON 字符串原样保留', () => {
  assert.deepEqual(parseToolArgs({ data: { arguments: 'plain text' } }), { _raw: 'plain text' })
})

test('messageText：兼容字符串与分片数组', () => {
  assert.equal(messageText({ data: { content: '你好' } }), '你好')
  assert.equal(messageText({ data: { content: [{ text: '你好' }, { text: '世界' }] } }), '你好\n世界')
})

test('extractSessionFacts：还原用户消息与工具调用', () => {
  const facts = extractSessionFacts(COMPLETE_SESSION)
  assert.equal(facts.userMessages.length, 1)
  assert.equal(facts.firstUserMessage, '在 UserController 里新增一个分页查询接口')
  assert.equal(facts.toolCallCount, 2)
  assert.deepEqual(facts.toolNames, ['read_file', 'edit_file'])
  assert.equal(facts.lastKind, 'completed')
})

test('extractSessionFacts：忽略插件注入的消息', () => {
  const session = makeSession([
    USER('真实需求'),
    USER('系统自动注入的提醒', 'plugin'),
    ASSISTANT('收到'),
  ])
  const facts = extractSessionFacts(session)
  assert.deepEqual(facts.userMessages, ['真实需求'])
})

test('extractSessionFacts：收集涉及的文件路径', () => {
  const facts = extractSessionFacts(COMPLETE_SESSION)
  assert.ok(facts.files.some((f) => f.includes('UserController.java')))
})

test('extractSessionFacts：汇总 token 用量', () => {
  const facts = extractSessionFacts(COMPLETE_SESSION)
  assert.equal(facts.usage.inputTokens, 10)
  assert.equal(facts.usage.outputTokens, 20)
})

test('collectPaths：从嵌套参数中递归收集路径', () => {
  const paths = collectPaths({ edits: [{ path: 'src/a.vue' }, { path: 'src/b.vue' }], note: 'x' })
  assert.deepEqual(paths, ['src/a.vue', 'src/b.vue'])
})

test('isSessionComplete：标准完成场景判定为完成', () => {
  const r = isSessionComplete(COMPLETE_SESSION)
  assert.equal(r.complete, true)
  assert.equal(r.reason, 'ok')
})

test('isSessionComplete：空会话未完成', () => {
  const r = isSessionComplete(makeSession([]))
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'empty-session')
})

test('isSessionComplete：turn 未正常结束不算完成', () => {
  for (const kind of ['aborted', 'error', 'max-tokens', 'blocked']) {
    const session = makeSession([
      { type: 'turn/start', data: {} },
      USER('改一下'),
      TOOL_CALL('edit_file', { path: 'a.java' }),
      TOOL_RESULT(),
      ASSISTANT('改好了'),
      { type: 'turn/end', data: { kind } },
    ])
    const r = isSessionComplete(session)
    assert.equal(r.complete, false, `kind=${kind} 不应判定为完成`)
    assert.equal(r.reason, `turn-not-completed:${kind}`)
  }
})

test('isSessionComplete：没有工具调用说明没真正动手', () => {
  const session = makeSession([
    { type: 'turn/start', data: {} },
    USER('什么是分页'),
    ASSISTANT('分页是一种……'),
    { type: 'turn/end', data: { kind: 'completed' } },
  ])
  const r = isSessionComplete(session)
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'no-tool-activity')
})

test('isSessionComplete：用户最后一条消息无人回应则未完成', () => {
  const session = makeSession([
    { type: 'turn/start', data: {} },
    USER('改一下 A'),
    TOOL_CALL('edit_file', { path: 'a.java' }),
    TOOL_RESULT(),
    ASSISTANT('改好了'),
    USER('再改一下 B'),
    { type: 'turn/end', data: { kind: 'completed' } },
  ])
  const r = isSessionComplete(session)
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'user-message-unanswered')
})

test('isSessionComplete：用户明确表示还要继续，推翻完成判定', () => {
  const session = makeSession([
    { type: 'turn/start', data: {} },
    USER('改一下'),
    TOOL_CALL('edit_file', { path: 'a.java' }),
    TOOL_RESULT(),
    ASSISTANT('改好了'),
    USER('等等，还有个地方也要改'),
    ASSISTANT('好的，马上改'),
    { type: 'turn/end', data: { kind: 'completed' } },
  ])
  const r = isSessionComplete(session)
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'user-continue-intent')
  assert.ok(r.signals.includes('user-continue-intent'))
})

test('isSessionComplete：用户明确收尾时标记为显式完成', () => {
  const session = makeSession([
    { type: 'turn/start', data: {} },
    USER('改一下'),
    TOOL_CALL('edit_file', { path: 'a.java' }),
    TOOL_RESULT(),
    ASSISTANT('改好了'),
    USER('可以了，就这样'),
    ASSISTANT('好的'),
    { type: 'turn/end', data: { kind: 'completed' } },
  ])
  const r = isSessionComplete(session)
  assert.equal(r.complete, true)
  assert.equal(r.reason, 'user-explicit-complete')
})

test('isSessionComplete：中间出现「完成」二字不误判', () => {
  const session = makeSession([
    { type: 'turn/start', data: {} },
    USER('把登录功能完成，另外注册页面也要改一下'),
    TOOL_CALL('edit_file', { path: 'a.java' }),
    TOOL_RESULT(),
    ASSISTANT('已处理'),
    { type: 'turn/end', data: { kind: 'completed' } },
  ])
  const r = isSessionComplete(session)
  assert.equal(r.reason, 'user-continue-intent', '「另外…也要改」是继续意图，不应判为完成')
})

test('buildRetroDigest：产出包含关键事实的摘要', () => {
  const digest = buildRetroDigest(COMPLETE_SESSION)
  assert.ok(digest.includes('在 UserController 里新增一个分页查询接口'))
  assert.ok(digest.includes('UserController.java'))
  assert.ok(digest.includes('edit_file'))
})

test('buildRetroDigest：超长内容被截断', () => {
  const digest = buildRetroDigest(COMPLETE_SESSION, 100)
  assert.ok(digest.length <= 100 + 20)
  assert.ok(digest.includes('已截断'))
})

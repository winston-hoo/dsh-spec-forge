// 会话事件流提取：把 dsh 的事件溯源日志还原成可复盘的结构化事实。
// 纯函数（只读 session 对象），无副作用，全部可单测。

const COMPLETE_SIGNALS = [
  '就这样', '就这些', '就到这里', '可以了', '没问题', '先这样', '不用改了',
  '没有别的', '没有其他', '搞定了', '收工', '完成了', '结束吧', '到此为止',
]

const CONTINUE_SIGNALS = [
  '等等', '还有', '另外', '再改', '不对', '错了', '重新来', '忘了', '补充一下', '但是',
]

/** 安全取事件数组，兼容不同版本的 session 结构 */
export function getEvents(session) {
  if (!session) return []
  const events = Array.isArray(session.events) ? session.events : []
  return [...events].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
}

function findLastIndex(events, predicate) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (predicate(events[i])) return i
  }
  return -1
}

/** 解析 tool/call 的参数（raw arguments 是 JSON 字符串，需自行 parse） */
export function parseToolArgs(event) {
  const raw = event?.data?.arguments ?? event?.data?.args ?? event?.data?.input
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { _raw: raw }
  try {
    return JSON.parse(trimmed)
  } catch {
    return { _raw: raw, _parseError: true }
  }
}

/** 判断用户消息是否是直接输入（排除插件注入） */
export function isDirectUserMessage(event) {
  if (event?.type !== 'user/message') return false
  const kind = event?.data?.source?.kind
  if (kind === undefined) return true // 老版本无此字段，一律视为直接输入
  return kind === 'direct'
}

/** 抽取消息文本，兼容 content 为字符串或分片数组 */
export function messageText(event) {
  const content = event?.data?.content
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/**
 * 从会话事件中提取全部结构化事实。
 */
export function extractSessionFacts(session) {
  const events = getEvents(session)
  const userMessages = events.filter(isDirectUserMessage).map(messageText).filter(Boolean)
  const assistantMessages = events
    .filter((e) => e?.type === 'assistant/message')
    .map(messageText)
    .filter(Boolean)

  const toolCalls = events
    .filter((e) => e?.type === 'tool/call')
    .map((e) => ({
      name: e?.data?.name ?? e?.data?.tool ?? 'unknown',
      args: parseToolArgs(e),
      seq: e?.seq ?? 0,
    }))

  const toolResults = events.filter((e) => e?.type === 'tool/result')

  const turnEnds = events.filter((e) => e?.type === 'turn/end')
  const lastTurnEnd = turnEnds[turnEnds.length - 1]
  const lastKind = lastTurnEnd?.data?.kind ?? null

  const todoEvents = events.filter((e) => e?.type === 'todo/write')
  const lastTodo = todoEvents.length > 0 ? todoEvents[todoEvents.length - 1]?.data : null

  const usage = events
    .filter((e) => e?.type === 'assistant/message')
    .map((e) => e?.data?.usage)
    .filter(Boolean)

  const files = [
    ...new Set(
      toolCalls
        .flatMap((call) => collectPaths(call.args))
        .filter(Boolean)
    ),
  ].slice(0, 200)

  return {
    sessionId: session?.id ?? null,
    eventCount: events.length,
    turns: turnEnds.length,
    userMessages,
    firstUserMessage: userMessages[0] ?? '',
    lastUserMessage: userMessages[userMessages.length - 1] ?? '',
    assistantMessages,
    lastAssistantMessage: assistantMessages[assistantMessages.length - 1] ?? '',
    toolCalls,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
    toolNames: [...new Set(toolCalls.map((c) => c.name))],
    files,
    lastKind,
    todo: lastTodo,
    usage: mergeUsage(usage),
  }
}

/** 从工具参数里递归收集看起来像文件路径的字符串 */
export function collectPaths(value, depth = 0) {
  const out = []
  if (depth > 4 || value == null) return out
  if (typeof value === 'string') {
    if (/(?:[\w.$-]+[\\/])+[\w.$-]+/.test(value) || /^[\w.-]+\.[a-z]{1,8}$/i.test(value)) {
      out.push(value.replace(/\\/g, '/'))
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectPaths(item, depth + 1))
    return out
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) out.push(...collectPaths(v, depth + 1))
  }
  return out
}

function mergeUsage(usageList) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  for (const u of usageList) {
    for (const key of Object.keys(total)) {
      const v = u?.[key]
      if (typeof v === 'number') total[key] += v
    }
  }
  return total
}

/**
 * 判定会话是否「完整结束」。
 * 单看 turn/end 不够：还要确认这一轮真干了活、用户已经拿到回应、没有被追问打断。
 */
export function isSessionComplete(session, options = {}) {
  const { requireToolActivity = true, requireAssistantReply = true } = options
  const events = getEvents(session)

  if (events.length === 0) {
    return { complete: false, reason: 'empty-session', signals: [] }
  }

  const lastTurnEndIdx = findLastIndex(events, (e) => e?.type === 'turn/end')
  if (lastTurnEndIdx < 0) {
    return { complete: false, reason: 'no-turn-end', signals: [] }
  }

  const kind = events[lastTurnEndIdx]?.data?.kind ?? null
  if (kind !== 'completed') {
    return { complete: false, reason: `turn-not-completed:${kind ?? 'unknown'}`, signals: [] }
  }

  const turnStartIdx = findLastIndex(events.slice(0, lastTurnEndIdx), (e) => e?.type === 'turn/start')
  const tail = events.slice(turnStartIdx >= 0 ? turnStartIdx : 0, lastTurnEndIdx + 1)

  if (requireToolActivity && !tail.some((e) => e?.type === 'tool/call')) {
    return { complete: false, reason: 'no-tool-activity', signals: [] }
  }

  if (requireAssistantReply) {
    const lastUserIdx = findLastIndex(tail, isDirectUserMessage)
    const hasReplyAfter =
      lastUserIdx < 0 || tail.slice(lastUserIdx + 1).some((e) => e?.type === 'assistant/message')
    if (!hasReplyAfter) {
      return { complete: false, reason: 'user-message-unanswered', signals: [] }
    }
  }

  const signals = []
  const lastUserText = (() => {
    const idx = findLastIndex(events, isDirectUserMessage)
    return idx >= 0 ? messageText(events[idx]) : ''
  })()

  if (matchAny(lastUserText, COMPLETE_SIGNALS)) signals.push('user-explicit-complete')
  if (matchAny(lastUserText, CONTINUE_SIGNALS)) signals.push('user-continue-intent')

  // 用户明确表示还要继续 → 推翻「结束」判定
  if (signals.includes('user-continue-intent')) {
    return { complete: false, reason: 'user-continue-intent', signals }
  }

  return { complete: true, reason: signals.includes('user-explicit-complete') ? 'user-explicit-complete' : 'ok', signals }
}

/** 末尾信号检测：只看消息尾部 40 字，避免中间出现「完成」二字就误判 */
function matchAny(text, words) {
  const tail = String(text).slice(-40)
  return words.some((w) => tail.includes(w))
}

/**
 * 生成供模型复盘用的结构化摘要（不落盘，只作为 spec_retro 的输入依据）。
 */
export function buildRetroDigest(session, maxChars = 6000) {
  const facts = extractSessionFacts(session)
  const complete = isSessionComplete(session)
  const lines = []

  lines.push(`## 会话事实`)
  lines.push(`- 会话 ID: ${facts.sessionId ?? '(未知)'}`)
  lines.push(`- 事件数: ${facts.eventCount}，回合数: ${facts.turns}`)
  lines.push(`- 结束状态: ${facts.lastKind ?? '(未知)'}，判定完成: ${complete.complete ? '是' : '否'}（${complete.reason}）`)
  lines.push(`- 工具调用: ${facts.toolCallCount} 次，涉及工具: ${facts.toolNames.join(', ') || '(无)'}`)

  if (facts.files.length > 0) {
    lines.push('')
    lines.push(`## 涉及文件`)
    for (const f of facts.files.slice(0, 40)) lines.push(`- ${f}`)
  }

  lines.push('')
  lines.push(`## 用户原始需求`)
  lines.push(facts.firstUserMessage || '(未捕获)')

  if (facts.userMessages.length > 1) {
    lines.push('')
    lines.push(`## 后续补充（共 ${facts.userMessages.length} 条用户消息）`)
    for (const m of facts.userMessages.slice(1)) lines.push(`- ${m}`)
  }

  if (facts.lastAssistantMessage) {
    lines.push('')
    lines.push(`## 助手最终答复`)
    lines.push(facts.lastAssistantMessage)
  }

  const digest = lines.join('\n')
  return digest.length > maxChars ? digest.slice(0, maxChars) + '\n…(已截断)' : digest
}

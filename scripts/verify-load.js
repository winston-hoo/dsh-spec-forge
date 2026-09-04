// 加载验证：不启动 dsh，用 mock ctx 执行 apply()。
// 用途：怀疑插件在真实环境没生效时，先跑这个排除「模块/注册层」问题。
//
//   node scripts/verify-load.js

import { apply } from '../index.js'

const TOOL_NAMES = ['spec_recall', 'spec_triage', 'spec_distill', 'spec_retro', 'spec_library']

const registered = []
const ctx = {
  // 最小 tools 服务：只记录注册，不执行
  tools: { register: (tool) => registered.push(tool) },
  // 不提供 systemPrompt / skills，验证可选依赖的降级路径
  get: () => null,
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
  retroMinToolCalls: 2,
  strictDistill: true,
}

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  [${mark}] ${label}${detail ? ` —— ${detail}` : ''}`)
}

try {
  apply(ctx, config)

  check('apply 不抛错', true)
  check('注册了 5 个工具', registered.length === 5, `实际 ${registered.length}`)

  for (const name of TOOL_NAMES) {
    const tool = registered.find((t) => t && t.name === name)
    check(`工具 ${name} 存在`, Boolean(tool), tool ? `description ${tool.description?.length ?? 0} 字` : '未注册')
  }

  const recall = registered.find((t) => t?.name === 'spec_recall')
  check('工具可执行', typeof recall?.execute === 'function')
  check('工具含参数 schema', Boolean(recall?.parameters))
  check('工具含输出 schema', Boolean(recall?.output?.schema))
  const out = recall.output.schema
  check(
    'object 输出 schema 满足 additionalProperties 要求',
    out?.type !== 'object' || out?.additionalProperties === true,
    `type=${out?.type}, additionalProperties=${out?.additionalProperties}`
  )

  console.log(`\n${'='.repeat(40)}`)
  console.log(failures === 0 ? '加载验证通过' : `加载验证失败 ${failures} 项`)
  console.log('='.repeat(40))
} catch (err) {
  failures++
  console.error('apply 抛错:', err)
  console.log('\n加载验证失败')
}

process.exit(failures === 0 ? 0 : 1)

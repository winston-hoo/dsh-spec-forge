// 端到端冒烟：验证「沉淀 → 召回 → 复用 → 禁区生效」这条主链路。
// 只依赖 lib 层，不加载 index.js，因此不需要 dsh 运行时即可运行。
//
//   node scripts/smoke.js

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fingerprint } from '../lib/fingerprint.js'
import { rankTemplates } from '../lib/match.js'
import { isSessionComplete } from '../lib/extract.js'
import {
  collectRedlines,
  listTemplates,
  recordHit,
  repoHash,
  templateId,
  writeProfile,
  writeTemplate,
} from '../lib/store.js'
import { renderInjection, renderTemplateMarkdown, triageRequirement } from '../lib/render.js'

const home = mkdtempSync(join(tmpdir(), 'spec-forge-smoke-'))
const cwd = 'C:/work/asset-warning-system'
const scope = repoHash(cwd)

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  [${mark}] ${label}${detail ? ` —— ${detail}` : ''}`)
}

try {
  console.log('\n=== 1. 沉淀：一次任务结束后写入模板 ===\n')

  const templateName = 'Spring Boot 新增分页查询接口'
  const id = templateId(templateName, scope)

  const body = renderTemplateMarkdown({
    name: templateName,
    category: 'feature/api',
    tags: ['java', 'spring-boot', 'pagination'],
    trigger: '当用户要求新增支持分页的查询接口时适用',
    clarify: ['分页参数用 pageNum/pageSize 还是 offset/limit？', '返回 VO 是否包含关联表字段？'],
    approach: ['XxxController 新增方法', 'XxxService 与 XxxServiceImpl 实现', 'Mapper XML 写查询 SQL'],
    redlines: ['不要修改 common/Result.java 的返回结构', '不要动 MybatisPlusConfig 的分页插件配置'],
    prompt: '按 Controller → Service → ServiceImpl → Mapper 四层实现，返回 Result<PageResult<XxxVO>>',
    acceptance: ['mvn -q test 通过', '新接口有单测覆盖'],
    repoName: 'asset-warning-system',
  })

  writeTemplate(
    home,
    scope,
    id,
    {
      name: templateName,
      category: 'feature/api',
      tags: ['java', 'spring-boot', 'pagination'],
      fingerprint: fingerprint(`${templateName} 分页查询接口 MyBatis-Plus`).map(({ token, weight }) => `${token}|${weight}`),
    },
    body
  )

  writeProfile(home, scope, {
    repoName: 'asset-warning-system',
    redlines: ['不要修改 common/Result.java 的返回结构'],
    conventions: ['Controller 层不写业务逻辑'],
    notes: '',
  })

  const stored = listTemplates(home, scope)
  check('模板已落盘', stored.length === 1, `当前 ${stored.length} 份`)
  check('模板 ID 合法', stored[0]?.id === id, stored[0]?.id)

  console.log('\n=== 2. 召回：同类需求应命中 ===\n')

  const similarQuery = '在 UserController 里加一个支持分页的查询接口'
  const similarResults = rankTemplates({
    queryFp: fingerprint(similarQuery),
    templates: listTemplates(home, scope),
    repoHash: scope,
    threshold: 0.35,
  })
  check('同类需求命中', similarResults[0]?.hit === true, `得分 ${similarResults[0]?.score}`)

  recordHit(home, scope, id)
  const afterHit = listTemplates(home, scope)[0]
  check('命中次数已累加', afterHit.hitCount === 1, `hitCount=${afterHit.hitCount}`)

  console.log('\n=== 3. 召回：异类需求不应命中 ===\n')

  const distantQuery = '修复微信小程序登录页面的样式错位'
  const distantResults = rankTemplates({
    queryFp: fingerprint(distantQuery),
    templates: listTemplates(home, scope),
    repoHash: scope,
    threshold: 0.35,
  })
  check('异类需求不命中', distantResults[0]?.hit === false, `得分 ${distantResults[0]?.score}`)

  console.log('\n=== 4. 注入：禁区必须出现在上下文里 ===\n')

  const redlines = collectRedlines(home, scope, [listTemplates(home, scope)[0]])
  const injection = renderInjection({ results: similarResults, redlines })
  check('项目禁区被注入', injection.includes('不要修改 common/Result.java 的返回结构'))
  check('澄清清单被注入', injection.includes('pageNum/pageSize'))
  check('标准改法被注入', injection.includes('XxxController 新增方法'))

  console.log('\n=== 5. 体检：模糊需求应被拦下 ===\n')

  const vague = triageRequirement('帮我改一下那个查询')
  check('模糊需求要求澄清', vague.needsClarify === true, `缺失 ${vague.missing.map((d) => d.label).join('/')}`)

  const precise = triageRequirement(
    '在 src/main/java/UserController.java 新增分页查询接口，不要改 common/Result.java，需要 mvn test 通过'
  )
  check('明确需求可直接开工', precise.ready === true)

  console.log('\n=== 6. 完成判定：区分「做完了」和「还要改」 ===\n')

  const done = isSessionComplete({
    events: [
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'user/message', data: { content: '加个分页接口', source: { kind: 'direct' } } },
      { seq: 3, type: 'tool/call', data: { name: 'edit_file', arguments: '{"path":"a.java"}' } },
      { seq: 4, type: 'assistant/message', data: { content: '已完成，测试通过' } },
      { seq: 5, type: 'turn/end', data: { kind: 'completed' } },
    ],
  })
  check('正常完成被识别', done.complete === true, done.reason)

  const notDone = isSessionComplete({
    events: [
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'user/message', data: { content: '加个分页接口', source: { kind: 'direct' } } },
      { seq: 3, type: 'tool/call', data: { name: 'edit_file', arguments: '{"path":"a.java"}' } },
      { seq: 4, type: 'assistant/message', data: { content: '已完成' } },
      { seq: 5, type: 'user/message', data: { content: '等等，还有个地方也要改', source: { kind: 'direct' } } },
      { seq: 6, type: 'assistant/message', data: { content: '好的' } },
      { seq: 7, type: 'turn/end', data: { kind: 'completed' } },
    ],
  })
  check('用户还要改时不误判为完成', notDone.complete === false, notDone.reason)

  console.log('\n=== 7. 幂等：同类需求再次沉淀应覆盖而非堆积 ===\n')

  writeTemplate(home, scope, id, { name: templateName, category: 'feature/api', tags: ['java'] }, body)
  check('同名需求不产生新模板', listTemplates(home, scope).length === 1, `当前 ${listTemplates(home, scope).length} 份`)

  console.log(`\n${'='.repeat(48)}`)
  console.log(failures === 0 ? '冒烟全部通过' : `冒烟失败 ${failures} 项`)
  console.log('='.repeat(48))
  console.log(`\n数据目录：${home}\n`)
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)

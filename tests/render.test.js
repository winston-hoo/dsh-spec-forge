import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SECTIONS, renderInjection, renderTemplateMarkdown, renderTriageReport, sectionOf, triageRequirement } from '../lib/render.js'
import { parseFrontmatter } from '../lib/store.js'

test('triageRequirement：过短的需求必须澄清', () => {
  const r = triageRequirement('帮我改一下')
  assert.equal(r.tooShort, true)
  assert.equal(r.needsClarify, true)
  assert.equal(r.ready, false)
})

test('triageRequirement：四要素齐全时判定为可直接开工', () => {
  const r = triageRequirement(
    '在 src/main/java/UserController.java 新增分页查询接口，不要修改 common/Result.java 的返回结构，需要 mvn test 通过'
  )
  assert.equal(r.needsClarify, false, `不应要求澄清，缺失项：${r.missing.map((d) => d.label).join(',')}`)
  assert.equal(r.ready, true)
  assert.equal(r.hasPath, true)
})

test('triageRequirement：未说明禁区时识别为缺失', () => {
  const r = triageRequirement('在 src/main/java/UserController.java 里加一个查询接口，要能分页')
  const boundary = r.dimensions.find((d) => d.key === 'boundary')
  assert.equal(boundary.status, 'missing')
  assert.equal(r.needsClarify, true)
})

test('triageRequirement：提到禁区关键词即判定为已明确', () => {
  const r = triageRequirement('改一下 a.vue 的样式，但不要动公共组件')
  const boundary = r.dimensions.find((d) => d.key === 'boundary')
  assert.equal(boundary.status, 'covered')
})

test('triageRequirement：没有路径时改动范围只能算部分明确', () => {
  const r = triageRequirement('给订单模块加一个导出功能，要用异步，需要测试通过')
  const approach = r.dimensions.find((d) => d.key === 'approach')
  assert.equal(approach.status, 'partial')
  assert.equal(r.hasPath, false)
})

test('triageRequirement：中英混排的验收信号都能识别', () => {
  assert.equal(triageRequirement('改一下 a，需要 mvn test 通过').dimensions.find((d) => d.key === 'goal').status, 'covered')
  assert.equal(triageRequirement('改一下 a，需要测试通过').dimensions.find((d) => d.key === 'goal').status, 'covered')
  assert.equal(triageRequirement('改一下 a').dimensions.find((d) => d.key === 'goal').status, 'missing')
})

test('triageRequirement：空输入不抛错', () => {
  const r = triageRequirement('')
  assert.equal(r.length, 0)
  assert.equal(r.needsClarify, true)
  assert.equal(r.ready, false)
})

test('renderTriageReport：输出表格与缺失项清单', () => {
  const r = triageRequirement('帮我改一下')
  const report = renderTriageReport(r)
  assert.ok(report.includes('需求完整度体检'))
  assert.ok(report.includes('需要先向你确认'))
  assert.ok(report.includes('要实现什么'))
  assert.ok(report.includes('要怎么改'))
  assert.ok(report.includes('哪些不能改'))
})

test('renderTriageReport：需求不完整时必须输出先问后查的急停指令', () => {
  const r = triageRequirement('帮我改一下')
  const report = renderTriageReport(r)
  assert.ok(report.includes('急停'), '必须出现急停标识')
  assert.ok(report.includes('先问后查'), '必须出现先问后查约束')
  assert.ok(report.includes('禁止调用任何文件类工具'), '必须列明禁止的文件工具')
  assert.ok(report.includes('read_file') && report.includes('grep'), '必须点名 read_file/grep 等具体工具')
})

test('renderTriageReport：需求齐全时不出现急停指令', () => {
  const r = triageRequirement('在 src/main/java/UserController.java 新增分页查询接口，不要修改 common/Result.java 的返回结构，需要 mvn test 通过')
  const report = renderTriageReport(r)
  assert.ok(!report.includes('急停'))
  assert.ok(report.includes('可以直接进入实现阶段'))
})

test('renderTriageReport：可以附带历史模板的追加确认项', () => {
  const r = triageRequirement('帮我改一下')
  const report = renderTriageReport(r, { templateHints: ['分页参数是 pageNum/pageSize 还是 offset/limit？'] })
  assert.ok(report.includes('历史模板建议追加确认'))
  assert.ok(report.includes('pageNum/pageSize'))
})

test('renderTemplateMarkdown：包含全部标准段落', () => {
  const md = renderTemplateMarkdown({
    name: '新增分页查询接口',
    category: 'feature/api',
    tags: ['java'],
    trigger: '要求加分页接口时',
    clarify: ['用 pageNum 还是 offset？'],
    approach: ['改 Controller', '改 Service'],
    redlines: ['不要改 Result.java'],
    prompt: '请按四层结构实现',
    acceptance: ['mvn test 通过'],
    repoName: 'demo',
  })
  for (const section of Object.values(SECTIONS)) {
    assert.ok(md.includes(`## ${section}`), `缺少段落：${section}`)
  }
  assert.ok(md.includes('不要改 Result.java'))
  assert.ok(md.includes('- [ ] mvn test 通过'))
  assert.ok(md.includes('1. 改 Controller'))
})

test('renderTemplateMarkdown：内容为空时给出占位而非留白', () => {
  const md = renderTemplateMarkdown({ name: '空模板' })
  assert.ok(md.includes('（待补充）'))
  assert.ok(md.includes('（本次未识别到明确禁区）'))
})

test('renderInjection：无命中时给出明确指引', () => {
  const out = renderInjection({ results: [], redlines: [] })
  assert.ok(out.includes('未命中任何历史模板'))
  assert.ok(out.includes('spec_retro'))
})

test('renderInjection：只注入三段关键内容以控制 token', () => {
  const template = {
    id: 'tpl-a1b2c3d4e5',
    name: '新增分页查询接口',
    score: 0.82,
    hit: true,
    body: [
      '## 触发场景',
      '',
      '要求分页时适用',
      '',
      '## 需求澄清清单',
      '',
      '- 用 pageNum 还是 offset？',
      '',
      '## 标准改法',
      '',
      '1. 改 Controller',
      '',
      '## 禁区',
      '',
      '- 不要改 Result.java',
      '',
      '## 提示词模板',
      '',
      '这段内容很长很长，不应该被注入进去，因为它只在用户主动打开模板时才需要……'.repeat(20),
      '',
      '## 验收标准',
      '',
      '- mvn test 通过',
    ].join('\n'),
  }

  const out = renderInjection({ results: [{ template, score: 0.82, hit: true }], redlines: ['不要动全局配置'] })

  assert.ok(out.includes('命中的历史模板'))
  assert.ok(out.includes('不要动全局配置'), '项目禁区必须出现')
  assert.ok(out.includes('用 pageNum 还是 offset？'), '澄清清单必须出现')
  assert.ok(out.includes('改 Controller'), '标准改法必须出现')
  assert.ok(!out.includes('这段内容很长很长'), '提示词模板正文不应注入，避免浪费 token')
})

test('renderInjection：超长内容被截断', () => {
  const template = {
    id: 'tpl-a1b2c3d4e5',
    name: 'x',
    body: `## 需求澄清清单\n\n${Array.from({ length: 100 }, (_, i) => `- 问题 ${i}`).join('\n')}`,
  }
  const out = renderInjection({ results: [{ template, score: 1, hit: true }], maxChars: 500 })
  assert.ok(out.length <= 520)
  assert.ok(out.includes('已截断'))
})

test('sectionOf：按标题提取段落', () => {
  const md = '## 禁区\n\n- 不要改 A\n\n## 约定\n\n- 用 4 空格\n'
  assert.ok(sectionOf(md, '禁区').includes('不要改 A'))
  assert.ok(!sectionOf(md, '禁区').includes('4 空格'))
})

test('端到端：沉淀出的模板能被再次解析回结构化段落', () => {
  const md = renderTemplateMarkdown({
    name: '新增分页查询接口',
    category: 'feature/api',
    tags: ['java'],
    clarify: ['用 pageNum 还是 offset？'],
    approach: ['改 Controller'],
    redlines: ['不要改 Result.java'],
    acceptance: ['mvn test 通过'],
  })
  const { body } = parseFrontmatter(md)
  assert.ok(sectionOf(body, SECTIONS.clarify).includes('pageNum'))
  assert.ok(sectionOf(body, SECTIONS.redlines).includes('Result.java'))
  assert.ok(sectionOf(body, SECTIONS.acceptance).includes('mvn test 通过'))
})

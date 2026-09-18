// 回归测试：0.4.7 修掉的真实缺陷（每条都对应一次实测复现）
//
// 这些用例不是"补覆盖率"，而是把每个已修 bug 的触发条件固定下来 ——
// 它们全都曾经在 204 条绿色测试下正常运行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyComplexity } from '../lib/classify.js'
import { SECTIONS, renderTemplateMarkdown, renderTriageReport, sectionOf, triageRequirement } from '../lib/render.js'
import { ID_PATTERN, bulletLines, listTemplates, repoHash, writeTemplate } from '../lib/store.js'

// ---------- ① 验收标准复选框叠层 ----------

test('回归：验收标准读写往返不得叠层（- [ ] x → - [ ] [ ] x）', () => {
  const first = renderTemplateMarkdown({ name: '示例', acceptance: ['npm test 通过', '无控制台报错'] })
  assert.ok(first.includes('- [ ] npm test 通过'), '落盘时是带复选框的')

  // 第二次沉淀：先读回旧条目，再与新条目合并重写（index.js 的 spec_retro 就是这么做的）
  const readBack = bulletLines(sectionOf(first, SECTIONS.acceptance))
  assert.deepEqual(readBack, ['npm test 通过', '无控制台报错'], '读回时必须剥掉复选框前缀')

  const merged = [...new Set([...readBack, '新增一条'])]
  const second = renderTemplateMarkdown({ name: '示例', acceptance: merged })
  assert.ok(!second.includes('[ ] [ ]'), `不得出现双层复选框：\n${second}`)
  assert.deepEqual(bulletLines(sectionOf(second, SECTIONS.acceptance)), [
    'npm test 通过',
    '无控制台报错',
    '新增一条',
  ])
})

// ---------- ② 「加列宽」被 ddl 正则误判为 L3 ----------

test('回归：样式类「加列宽」不得判成 L3（加列 子串误命中 ddl）', () => {
  for (const text of ['把表格增加列宽到 200px', '表格增加列宽自适应', '列表加列宽让它不换行']) {
    const r = classifyComplexity(text)
    assert.notEqual(r.level, 3, `「${text}」被判成 L3（信号 ${r.signals.join(',')}）`)
  }
})

test('回归：真正的建表/加列仍然是 L3（别把修复做成漏检）', () => {
  for (const text of ['给订单表加列 status', '新建一张订单明细表']) {
    assert.equal(classifyComplexity(text).level, 3, `「${text}」应当是 L3`)
  }
})

// ---------- ③ 条目提取三处实现漂移 ----------

test('回归：条目提取只有一份实现（支持编号行 / 剥复选框 / 滤占位）', () => {
  const md = ['- [ ] 甲', '1. 乙', '- 丙', '- （暂无）', '- （待补充）'].join('\n')
  assert.deepEqual(bulletLines(md), ['甲', '丙'], '默认只认 - 行，剥复选框，滤掉括号占位')
  assert.deepEqual(bulletLines(md, { keepNumber: true }), ['甲', '乙', '丙'], 'keepNumber 时认编号行')
})

// ---------- ④ 目录里混入非法 ID 文件时列表整体失败 ----------

test('回归：模板目录混入手工命名的非法 ID 文件时，列表整体不得失败', () => {
  const home = mkdtempSync(join(tmpdir(), 'spec-forge-regression-'))
  try {
    const scope = repoHash('D:/regression-demo')
    writeTemplate(home, scope, 'tpl-aaaaaaaaaa', { name: '正常模板', fingerprint: [] }, '# ok\n')
    writeFileSync(join(home, 'projects', scope, 'templates', '手动改的名字.md'), '# 用户手工放的文件\n')
    assert.ok(!ID_PATTERN.test('手动改的名字'), '该文件名确实是非法 ID，否则本用例无效')

    let list
    assert.doesNotThrow(() => {
      list = listTemplates(home, scope)
    }, '一个坏文件不得让整次召回失败')
    assert.ok(
      list.some((t) => t.id === 'tpl-aaaaaaaaaa'),
      '正常模板必须仍然出现在列表里'
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------- ⑤ L2 报告写死了与权威表相反的默认值 ----------

test('回归：L2 报告不得写死「列表展示默认展示」（权威表是不展示）', () => {
  const r = triageRequirement('在 UserController.java 帮我做一下用户列表的导出优化，需要支持 Excel 和 CSV')
  assert.equal(r.classification.level, 2)
  const report = renderTriageReport(r)
  assert.ok(!report.includes('列表展示默认展示'), '不得与 L1_DEFAULTS.listDisplay 相反')
  assert.ok(report.includes('不展示'), '应当直引 L1_DEFAULTS')
})

// ---------- ⑥ L1 徽标写死了与判级依据无关的理由 ----------

test('回归：L1 徽标的理由必须来自实际命中的信号', () => {
  const r = triageRequirement('登录页加个忘记密码按钮')
  assert.equal(r.classification.level, 1, `实际信号: ${r.classification.signals.join(',')}`)
  assert.ok(
    r.classification.signals.some((s) => s.startsWith('L1:atomic-edit')),
    `本例应命中原子小改路径，实际: ${r.classification.signals.join(',')}`
  )
  const report = renderTriageReport(r)
  assert.ok(report.includes('原子小改'), '徽标应标明是原子小改')
  assert.ok(!report.includes('组件/默认值明确'), '原子小改路径不得谎称「组件/默认值明确」')
})

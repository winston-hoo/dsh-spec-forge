// 行为契约回归（0.4.3）
//
// 背景：实测会话里，一条本该 L1 fastTrack 的简单需求（"参考 X 页面做一个物料页面"）
// 仍然触发了 spec_recall → spec_triage → spec_distill → spec_retro 四次调用。
// 根因不是分级器判错，而是行为契约含糊：SKILL.md 写着"第 2 步（必做）"，
// 模型据此无条件调用 spec_triage，忽略了 fastTrack 的跳过约定。
//
// 本文件把修好的契约钉死：spec_recall 必须给出模型可见的 nextStep 指令，
// 且 fastTrack 场景的正文必须明确禁止调用 spec_triage / spec_distill。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, schema } from '../index.js'

/** 用隔离的临时数据目录装载插件，返回按名字取工具的函数 */
function loadTools() {
  const dir = mkdtempSync(join(tmpdir(), 'spec-forge-routing-'))
  const registered = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    get: () => null,
    on: () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, schema({ storageHome: dir }))
  return {
    byName: (n) => registered.find((t) => t?.name === n),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('spec_recall：原子小改 => fastTrack + nextStep=implement，并明确禁止调用 spec_triage', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    assert.ok(recall, '未注册 spec_recall')
    return recall.execute({ requirement: '登录页加一个按钮' }).then((res) => {
      assert.equal(res.level, 1)
      assert.equal(res.fastTrack, true)
      assert.equal(res.nextStep, 'implement')
      assert.ok(res.context.includes('不要调用 `spec_triage`'), 'fastTrack 正文必须点明不要调用 spec_triage')
      assert.ok(res.context.includes('不要调用 `spec_distill`'), 'fastTrack 正文必须点明不要调用 spec_distill')
      // 未命中分支不得再无条件要求沉淀（旧文案「会话结束时请调用 spec_retro」是过度沉淀的诱因）
      assert.ok(!res.context.includes('会话结束时请调用'), '不应出现无条件沉淀指令')
      assert.ok(res.context.includes('原子小改、一次性任务跳过沉淀即可'), '未命中分支应与复用价值三问口径一致')
    })
  } finally {
    t.cleanup()
  }
})

test('spec_recall：自包含新建 + 参考物（真实踩坑用例）=> nextStep=implement', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    return recall
      .execute({
        requirement:
          '参考第三方对接文档页面，按照 design/materials.html 这个页面内容制作，一个线下物料页面（放在 example-admin 的 dynamic-routes 路由下）',
      })
      .then((res) => {
        assert.equal(res.fastTrack, true, `分级信号：${JSON.stringify(res.templates)}`)
        assert.equal(res.nextStep, 'implement')
      })
  } finally {
    t.cleanup()
  }
})

test('spec_recall：模糊 L2 需求 => nextStep=triage，并指明先体检', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    return recall.execute({ requirement: '帮我优化一下那个查询' }).then((res) => {
      assert.equal(res.fastTrack, false)
      assert.equal(res.nextStep, 'triage')
      assert.ok(res.context.includes('下一步调用 `spec_triage`'), 'L2 正文必须指明下一步是 spec_triage')
    })
  } finally {
    t.cleanup()
  }
})

test('spec_recall：L3 架构需求 => nextStep=triage，正文含先问后查', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    return recall.execute({ requirement: '把用户模块重构拆分为独立服务' }).then((res) => {
      assert.equal(res.level, 3)
      assert.equal(res.nextStep, 'triage')
      assert.ok(res.context.includes('先问后查'), 'L3 正文必须含先问后查约束')
      assert.ok(!res.context.includes('不要调用 `spec_triage`'), 'L3 不应出现禁止体检的措辞')
    })
  } finally {
    t.cleanup()
  }
})

test('spec_recall：输出 schema 声明 nextStep 为必填', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    const schema = recall.output.schema
    // 注意：defineTool 会把 output.schema 归一成标准 JSON Schema，
    // 必填项落在顶层的 required 数组里，而不是 properties.nextStep.required。
    assert.equal(schema.additionalProperties, true)
    assert.ok(Array.isArray(schema.required), 'required 应为数组')
    assert.ok(schema.required.includes('nextStep'), `required 应含 nextStep：${schema.required.join(',')}`)
    assert.ok(schema.required.includes('matched') && schema.required.includes('context'))
  } finally {
    t.cleanup()
  }
})

test('spec_triage：已去掉重复扫描，不再声明 cwd 参数且可仅凭 requirement 执行', () => {
  const t = loadTools()
  try {
    const triage = t.byName('spec_triage')
    assert.ok(triage, '未注册 spec_triage')
    const paramKeys = Object.keys(triage.parameters.properties ?? {})
    assert.deepEqual(paramKeys, ['requirement'], '0.4.3 起 spec_triage 不应再接收 cwd')
    return triage.execute({ requirement: '帮我优化一下那个查询' }).then((res) => {
      assert.equal(res.level, 2)
      assert.equal(res.needsClarify, true, '过短且零锚点应触发 L2 安全阀')
      assert.ok(res.report.includes('L2 信息不足'), res.report.slice(0, 120))
    })
  } finally {
    t.cleanup()
  }
})

test('spec_triage：fastTrack 需求被调用时仍返回 fast-track 模式（不报错）', () => {
  const t = loadTools()
  try {
    const triage = t.byName('spec_triage')
    return triage.execute({ requirement: '加个按钮' }).then((res) => {
      assert.equal(res.mode, 'fast-track')
      assert.equal(res.level, 1)
      assert.deepEqual(res.questions, [], 'fastTrack 不得回传追问清单')
      assert.ok(res.report.includes('直接执行清单'))
    })
  } finally {
    t.cleanup()
  }
})

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
    return recall.execute({ requirement: '改一下登录页的文案' }).then((res) => {
      assert.equal(res.level, 1)
      assert.equal(res.fastTrack, true)
      assert.equal(res.nextStep, 'implement')
      assert.deepEqual(res.contentGap, [])
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

test('spec_recall：容器型缺内容 => nextStep=confirm + contentGap 非空 + 明文要求先问（0.4.6）', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    // 真实的触发需求：带目标文件路径前缀。它 tooShort=false、hasAnchor=true，
    // L2 的 unactionable 安全阀不会响，必须靠 contentGap 独立拦截。
    const req = '@example-admin/src/views/login/index.vue 登录页加个按钮'
    return recall.execute({ requirement: req }).then((res) => {
      assert.equal(res.fastTrack, false)
      assert.equal(res.nextStep, 'confirm')
      assert.deepEqual(res.contentGap, ['按钮的文案与用途'], '必须告诉模型缺的是什么')
      assert.ok(res.context.includes('先确认再动手'), '正文必须给出 confirm 的执行路径')
      assert.ok(res.context.includes('按钮的文案与用途'), '正文必须把缺口写出来')
      assert.ok(res.context.includes('ask_user_question'), 'confirm 必须要求先问')
      assert.ok(
        !res.context.includes('禁止追问；**不要调用 `spec_triage`'),
        'confirm 不得复用 fastTrack 的"禁止追问"指令',
      )
    })
  } finally {
    t.cleanup()
  }
})

test('spec_recall：容器型已给内容 => 仍走 implement（闸门不得误伤）', () => {
  const t = loadTools()
  try {
    const recall = t.byName('spec_recall')
    return recall.execute({ requirement: '登录页加个忘记密码按钮，点击跳转注册页' }).then((res) => {
      assert.equal(res.fastTrack, true, `实际 signals: ${JSON.stringify(res.contentGap)}`)
      assert.equal(res.nextStep, 'implement')
      assert.deepEqual(res.contentGap, [])
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
    // 用"取值型"小改：容器型缺内容的需求 0.4.6 起不再判 fastTrack（见下一条）
    return triage.execute({ requirement: '改一下登录页的文案' }).then((res) => {
      assert.equal(res.mode, 'fast-track')
      assert.equal(res.level, 1)
      assert.deepEqual(res.questions, [], 'fastTrack 不得回传追问清单')
      assert.ok(res.report.includes('直接执行清单'))
    })
  } finally {
    t.cleanup()
  }
})

test('spec_triage：内容缺失的需求必须给"缺内容"说法，不得沿用"没有任何锚点"（0.4.6）', () => {
  const t = loadTools()
  try {
    const triage = t.byName('spec_triage')
    // 带路径前缀 → 有 inferredFile 锚点。旧文案会写"这条需求没有任何可动手的锚点"，
    // 与事实自相矛盾（正是 0.4.6 修掉的那类"文档自相矛盾"）。措辞必须分cause。
    const req = '@example-admin/src/views/login/index.vue 登录页加个按钮'
    return triage.execute({ requirement: req }).then((res) => {
      assert.equal(res.needsClarify, true, 'contentGap 非空必须要求澄清')
      assert.equal(res.level, 2)
      assert.ok(res.report.includes('需求缺内容'), res.report.slice(0, 200))
      assert.ok(res.report.includes('按钮的文案与用途'), '报告要点明缺的内容')
      assert.ok(
        !res.report.includes('没有任何可动手的锚点'),
        '不得再写"没有任何锚点"—— 这条需求是有锚点的（识别出了目标文件）',
      )
    })
  } finally {
    t.cleanup()
  }
})

// ---------- 常驻提示段的"防静默丢失"护栏（0.4.4） ----------
//
// 背景：为把常驻提示段压到审计脚本的参考线以内，曾做了一轮"为压缩而压缩"，
// 结果删掉了「报错排查」这条**只存在于本段**的约定（SKILL.md 里也没有），
// 并弱化了 ask_user_question 的排他性约束。而 dsh 的 renderPrompt 其实只做
// sections 排序 + join('\n\n')，**没有任何截断或长度上限**——超线只是多花 token。
// 因此这里把必须常驻的约束逐条钉死：允许改写措辞，但不允许悄悄删掉。

test('常驻提示段：关键约束不得在精简中丢失（回归护栏）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-forge-routing-'))
  const sections = []
  try {
    const ctx = {
      tools: { register: () => {} },
      get: (name) => (name === 'systemPrompt' ? { section: (s) => sections.push(s) } : null),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    }
    apply(ctx, schema({ storageHome: dir }))

    const routing = sections.find((s) => s.name === 'spec-forge:routing')
    assert.ok(routing, '未注册 spec-forge:routing 提示段')
    assert.ok(Number.isFinite(routing.order), 'order 必须是有限数（dsh 会直接抛错）')
    assert.equal(routing.order, 150)

    const text = routing.text
    const required = [
      ['nextStep', '按 nextStep 路由（0.4.3 的核心修复）'],
      ['`spec_triage`/`spec_distill`', 'fastTrack 必须明文禁止多余调用'],
      ['contentGap', 'confirm 分支必须点名缺什么（0.4.6）'],
      ['confirm', '必须有第三态执行路径，否则内容缺失的需求无处可去（0.4.6）'],
      ['问清', 'confirm 分支必须写明"先问清再实现"（0.4.6）'],
      ['ask_user_question', '提问权限要具名'],
      ['L2 安全阀', '提问权限必须仍写成"封闭列举"，不能放开成随便问（0.4.6 把 confirm 加进列举）'],
      ['提问前禁用任何文件类工具', '提问前禁用的工具要说明（勿弱化）'],
      ['read/grep/glob/bash/ls', '提问前禁用的工具要具名'],
      ['一次问完', '不得挤牙膏式反复追问'],
      ['直接做', '跳过词'],
      ['别问', '跳过词'],
      ['不要问', '跳过词'],
      ['极速模式', '跳过词'],
      ['报错排查', '不沉淀清单里的报错排查（SKILL.md 无此条，删了就真没了）'],
      ['只读诊断', '不沉淀清单'],
      ['环境修复', '不沉淀清单'],
      ['复用价值三问', '沉淀闸门'],
      ['>20K', '大文件纪律：严禁整读大文件'],
      ['先 grep 定位再分段读', '大文件纪律的具体做法'],
      ['禁区', '禁区是硬约束'],
    ]
    for (const [needle, why] of required) {
      assert.ok(text.includes(needle), `常驻提示段丢失了「${needle}」（${why}）`)
    }

    // 反向断言：常驻段不该长到失去"常驻"的意义（这里只提示量级，不做硬卡）
    assert.ok(text.length < 1400, `常驻段过长了（${text.length} 字符），每轮都要付这份 token`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

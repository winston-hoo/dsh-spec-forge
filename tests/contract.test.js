// 契约一致性护栏（0.4.7 新增）
//
// 为什么需要这个文件：
// 这份插件的「路由契约」（nextStep 三态）原先同时手写在四处 —— 常驻系统提示段、
// 5 个工具描述、`skills/spec-forge/SKILL.md`、`docs/*.md`。`docs/operations.md`
// 把「改契约必须同步四处」写成了流程要求，但 SKILL.md 实际上已经漂移：
// 它把「加按钮 / 加列 / 加路由」写成 L1 直通信号，与 0.4.6 的 confirm 判定相反 ——
// **模型读到的说明书在反向撤销代码里的修复，而当时 204 条测试没有一条会红。**
//
// 这里把「多处一致」变成机器可判定的断言：改契约时只改 `lib/render.js` 的
// ROUTING_CONTRACT，SKILL.md / README / 文档跟不上就会失败。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { L1_EXAMPLES } from '../lib/classify.js'
import { ROUTING_CONTRACT, renderPreStepNotice, renderRoutingLines } from '../lib/render.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const SKILL = read('skills/spec-forge/SKILL.md')
const README = read('README.md')
const OPS = read('docs/operations.md')
const INDEX = read('index.js')

/** 已知工具清单：新增/删除工具时同步这里，护栏会检查别处没引用不存在的工具 */
const TOOL_NAMES = ['spec_recall', 'spec_triage', 'spec_distill', 'spec_retro', 'spec_library']

/** 从 index.js 的 schema 定义里扫出全部配置键（配置的唯一事实来源） */
function schemaKeys() {
  const block = /export const schema = Schema\.object\(\{([\s\S]*?)\n\}\)/.exec(INDEX)
  assert.ok(block, '未能定位 index.js 的 schema 块（护栏失效，先修这里）')
  return [...block[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
}

test('契约：常驻段必须渲染出全部三种 nextStep', () => {
  const text = renderRoutingLines().join('\n')
  assert.deepEqual(
    ROUTING_CONTRACT.map((r) => r.nextStep),
    ['implement', 'confirm', 'triage'],
    'nextStep 只有三态，且顺序固定为 implement → confirm → triage'
  )
  for (const r of ROUTING_CONTRACT) {
    assert.ok(text.includes(`\`${r.nextStep}\``), `常驻段缺少 ${r.nextStep} 的动作指令`)
    assert.ok(r.action.length > 0, `${r.nextStep} 必须有明确动作`)
  }
})

test('契约：SKILL.md 必须写明全部三种 nextStep，且不得发明第四态', () => {
  const mentioned = new Set(
    [...SKILL.matchAll(/nextStep\s*[:=]\s*'?([a-z-]+)'?/g)].map((m) => m[1]),
  )
  for (const r of ROUTING_CONTRACT) {
    assert.ok(mentioned.has(r.nextStep), `SKILL.md 没有提到 nextStep=${r.nextStep}`)
  }
  const known = new Set(ROUTING_CONTRACT.map((r) => r.nextStep))
  for (const m of mentioned) {
    assert.ok(known.has(m), `SKILL.md 出现了契约里不存在的 nextStep=${m}`)
  }
})

test('契约：SKILL.md 的「原子小改（…）」示例必须在白名单内', () => {
  // 0.4.7 的真实事故：这里写着「加按钮/加列/加路由」，而代码已经把容器型原子改动
  // 判成 confirm。白名单在 lib/classify.js 的 L1_EXAMPLES。
  const groups = [...SKILL.matchAll(/原子小改（([^）]*)）/g)].map((m) => m[1])
  assert.ok(groups.length > 0, 'SKILL.md 应当给出原子小改的示例')
  for (const group of groups) {
    for (const item of group.split('/').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(
        L1_EXAMPLES.includes(item),
        `SKILL.md 把「${item}」当作 L1 原子小改示例，但白名单只有：${L1_EXAMPLES.join('/')}`
      )
    }
  }
})

test('契约：常驻段不得再把容器型改动写成 L1 直通', () => {
  const section = read('index.js')
  // 常驻段只允许通过 renderRoutingLines() 渲染三态，不允许再手写一份
  assert.ok(section.includes('...renderRoutingLines()'), '常驻段必须由契约渲染')
  assert.ok(
    !/原子小改（[^）]*加按钮/.test(section),
    '常驻提示段里又把「加按钮」写成原子小改示例了（容器型改动是 confirm）'
  )
})

test('契约：SKILL.md 与 README 引用的 spec_* 工具都必须存在', () => {
  for (const [name, text] of [['SKILL.md', SKILL], ['README.md', README]]) {
    for (const ref of new Set(text.match(/spec_[a-z]+/g) ?? [])) {
      assert.ok(TOOL_NAMES.includes(ref), `${name} 引用了不存在的工具 ${ref}`)
    }
  }
})

test('契约：README 的配置示例必须完整列出 schema 的全部键', () => {
  // 0.4.7 的真实事故：示例里只剩 matchThreshold + storageRoot 两个键，
  // 而它头顶的注释还写着「必须完整重述所有字段」—— 照抄示例的用户会把其余 9 项压回默认值。
  const keys = schemaKeys()
  assert.ok(keys.length >= 10, `schema 键扫描结果异常: ${keys.join(',')}`)
  const yaml = /```ya?ml([\s\S]*?)```/.exec(README)
  assert.ok(yaml, 'README 必须包含一个 yaml 配置示例')
  for (const key of keys) {
    assert.ok(yaml[1].includes(`${key}:`), `README 配置示例缺少 ${key}`)
  }
})

test('契约：docs/operations.md 必须覆盖 schema 的全部配置键', () => {
  for (const key of schemaKeys()) {
    assert.ok(OPS.includes(key), `docs/operations.md 缺少配置项 ${key}`)
  }
})

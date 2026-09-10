import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ELEMENT_COMPONENT_FOR_TYPE,
  FIELD_COMPONENT_HINTS,
  L1_DEFAULTS,
  L2_MAX_QUESTIONS,
  SKIP_TRIGGERS,
  classifyComplexity,
  extractDefaultValue,
  extractFieldName,
  extractFilePath,
  inferFieldComponent,
  inferQueryCategory,
} from '../lib/classify.js'

test('SKIP_TRIGGERS：包含六个常用跳过词', () => {
  for (const t of ['直接做', '速做', '不用问', '别问', '不要问', '极速模式']) {
    assert.ok(SKIP_TRIGGERS.includes(t), `缺少跳过词：${t}`)
  }
})

test('classifyComplexity：跳过词任意命中即强制 Level 1', () => {
  const cases = [
    '帮我看下这段代码，直接做',
    '这个改动速做',
    '改一下这个，不用问',
    '重写一下，别问',
    '调整这块，不要问',
    '本任务走极速模式',
  ]
  for (const text of cases) {
    const r = classifyComplexity(text)
    assert.equal(r.level, 1, `应判定为 Level 1：${text}`)
    assert.ok(r.signals.some((s) => s.startsWith('skip-trigger:')), '必须包含跳过词信号')
    assert.ok(typeof r.skipTrigger === 'string')
  }
})

test('classifyComplexity：单字段 + 组件 + 默认值 = Level 1（用户截图中的 case）', () => {
  const text =
    'index.vue 这个物业管理员管理页面的新增/修改接口增加一个主管管员字段 isMainAdmin，值为1是，0否，默认为否，这个字段用开关来显示，请帮我完成这个需求'
  const r = classifyComplexity(text)
  assert.equal(r.level, 1, `应判定为 Level 1，signals: ${r.signals.join(',')}`)
  assert.equal(r.inferredComponent, 'switch')
  assert.equal(r.inferredField, 'isMainAdmin')
  assert.equal(r.inferredDefaultValue, '否')
  assert.equal(r.inferredFile, 'index.vue')
  assert.ok(r.signals.includes('L1:crud-shape'))
  assert.ok(r.signals.includes('L1:component:switch'))
})

test('classifyComplexity：单字段 + 默认值但未指定组件 = Level 1', () => {
  const text = '在 form.vue 里新增 status 字段，默认值 draft'
  const r = classifyComplexity(text)
  assert.equal(r.level, 1)
  assert.equal(r.inferredField, 'status')
  assert.equal(r.inferredDefaultValue, 'draft')
  assert.equal(r.inferredComponent, null)
})

test('classifyComplexity：单字段 + 组件但未指定默认值 = Level 1', () => {
  const text = 'orders 表单加一个 category 下拉字段'
  const r = classifyComplexity(text)
  assert.equal(r.level, 1)
  assert.equal(r.inferredField, 'category')
  assert.equal(r.inferredComponent, 'select')
})

test('classifyComplexity：架构重构信号 = Level 3', () => {
  const cases = [
    '整体重构订单服务',
    '拆分用户模块为独立服务',
    '从 MySQL 迁移到 PostgreSQL',
    '建一张 user_logs 表',
    '新增一张 product_sku 表',
    '需要修改表结构',
    '这个改动跨文件，跨模块',
    '涉及多个模块的多处修改',
    '代码重构，分模块拆分',
  ]
  for (const text of cases) {
    const r = classifyComplexity(text)
    assert.equal(r.level, 3, `应判定为 Level 3：${text}`)
    assert.ok(r.signals.some((s) => s.startsWith('L3:')), '必须包含 L3 信号')
  }
})

test('classifyComplexity：默认 Level 2（无明显信号时）', () => {
  const r = classifyComplexity('帮我做一下那个优化')
  assert.equal(r.level, 2)
  assert.ok(r.signals.includes('L2:default'))
})

test('classifyComplexity：空输入默认 Level 2', () => {
  const r = classifyComplexity('')
  assert.equal(r.level, 2)
})

test('inferFieldComponent：识别常见 UI 组件关键词', () => {
  for (const [component, pattern] of Object.entries(FIELD_COMPONENT_HINTS)) {
    const samples = {
      switch: ['用开关来显示', 'boolean field', '0/1 数字', '是/否'],
      select: ['下拉框', 'select option', '枚举值', '字典选项'],
      radio: ['单选', 'radio group'],
      checkbox: ['多选', 'checkbox 复选'],
      date: ['日期选择', 'datetime picker'],
      number: ['数字输入', 'integer 整型'],
      textarea: ['多行文本', 'long text'],
      input: ['文本输入', 'textfield'],
    }
    for (const s of samples[component] || []) {
      assert.equal(inferFieldComponent(s), component, `应识别为 ${component}：${s}`)
    }
  }
})

test('inferFieldComponent：未命中时返回 null', () => {
  assert.equal(inferFieldComponent('帮我优化查询性能'), null)
})

test('extractFieldName：识别多种字段名写法', () => {
  assert.equal(extractFieldName('新增 isMainAdmin 字段'), 'isMainAdmin')
  assert.equal(extractFieldName('增加一个 isAdmin 字段'), 'isAdmin')
  assert.equal(extractFieldName('字段 isMainAdmin'), 'isMainAdmin')
  assert.equal(extractFieldName('字段名: userType'), 'userType')
  assert.equal(extractFieldName('orderStatus 字段'), 'orderStatus')
  assert.equal(extractFieldName('增加一个主管管员字段 isMainAdmin'), 'isMainAdmin')
  assert.equal(extractFieldName('帮我改一下那个查询'), null)
})

test('extractDefaultValue：识别默认值写法', () => {
  assert.equal(extractDefaultValue('默认为否'), '否')
  assert.equal(extractDefaultValue('默认是 0'), '0')
  assert.equal(extractDefaultValue('默认值 draft'), 'draft')
  assert.equal(extractDefaultValue('值为 1'), '1')
  assert.equal(extractDefaultValue('提交值为 true'), 'true')
  assert.equal(extractDefaultValue('随便改改'), null)
})

test('extractFilePath：识别文件路径', () => {
  assert.equal(extractFilePath('在 index.vue 里加个字段'), 'index.vue')
  assert.equal(extractFilePath('修改 src/views/UserForm.vue'), 'src/views/UserForm.vue')
  assert.equal(extractFilePath('改一下 UserController.java'), 'UserController.java')
  assert.equal(extractFilePath('帮我优化查询性能'), null)
})

test('ELEMENT_COMPONENT_FOR_TYPE：覆盖常见类型', () => {
  for (const t of ['switch', 'select', 'radio', 'checkbox', 'date', 'number', 'textarea', 'input']) {
    assert.ok(typeof ELEMENT_COMPONENT_FOR_TYPE[t] === 'string' && ELEMENT_COMPONENT_FOR_TYPE[t].length > 0)
  }
})

test('L1_DEFAULTS：包含三类保守默认（列表展示/校验/后端）', () => {
  assert.ok(typeof L1_DEFAULTS.listDisplay === 'string')
  assert.ok(typeof L1_DEFAULTS.validation === 'string')
  assert.ok(typeof L1_DEFAULTS.backend === 'string')
})

test('L2_MAX_QUESTIONS：默认为 3', () => {
  assert.equal(L2_MAX_QUESTIONS, 3)
})
// ---------- 查询侧类别推断（0.3.1） ----------

test('inferQueryCategory：报错类需求判为 bugfix', () => {
  assert.equal(inferQueryCategory('模块加载失败，控制台报 error 堆栈'), 'bugfix')
})

test('inferQueryCategory：重构迁移类判为 refactor', () => {
  assert.equal(inferQueryCategory('把用户模块重构拆分为独立服务'), 'refactor')
})

test('inferQueryCategory：前端页面组件类判为 frontend', () => {
  assert.equal(inferQueryCategory('在 Vue 管理页面给新增弹窗表单加一个开关字段'), 'frontend')
})

test('inferQueryCategory：后端接口类判为 feature', () => {
  assert.equal(inferQueryCategory('在 UserController 新增一个分页查询接口'), 'feature')
})

test('inferQueryCategory：判不出来返回 undefined（宁可不加分）', () => {
  assert.equal(inferQueryCategory(''), undefined)
  assert.equal(inferQueryCategory('随便聊聊天气'), undefined)
})

// ---------- fastTrack 快速通道（0.4.0） ----------

test('classifyComplexity：跳过词命中时 fastTrack=true（无条件快速通道）', () => {
  for (const text of SKIP_TRIGGERS.map((t) => `改一下这个，${t}`)) {
    const r = classifyComplexity(text)
    assert.equal(r.fastTrack, true, `跳过词必须 fastTrack：${text}`)
  }
})

test('classifyComplexity：L1 单字段 CRUD 的 fastTrack=true', () => {
  const r = classifyComplexity('增加一个主管管员字段 isMainAdmin，开关，默认否')
  assert.equal(r.level, 1)
  assert.equal(r.fastTrack, true)
})

test('classifyComplexity：自包含新建 + 参考物 => L1 fastTrack', () => {
  const cases = [
    '参考用户管理页面，新建一个订单列表页面',
    '参考 index.vue 新增一个搜索表单组件',
    '仿照现有的详情页做一个合同详情页',
    '参照 parking-materials.html 做一个类似的停车材料页面',
  ]
  for (const text of cases) {
    const r = classifyComplexity(text)
    assert.equal(r.level, 1, `应判 L1：${text}`)
    assert.equal(r.fastTrack, true, `应开启快速通道：${text}`)
    assert.ok(r.signals.includes('L1:self-contained'))
    assert.ok(r.signals.includes('L1:has-reference'))
  }
})

test('classifyComplexity：裸新建页面（无参考物）落到 L2，不误开快速通道', () => {
  for (const text of ['新建一个页面', '做一个新的报表页面', '新建一个数据表格页面']) {
    const r = classifyComplexity(text)
    assert.equal(r.level, 2, `无参考物应落 L2：${text}`)
    assert.equal(r.fastTrack, false, `不应 fastTrack：${text}`)
  }
})

test('classifyComplexity：L2 默认与 L3 架构均 fastTrack=false', () => {
  assert.equal(classifyComplexity('随便优化一下性能').fastTrack, false)
  assert.equal(classifyComplexity('把用户模块重构拆分为独立服务').fastTrack, false)
})

test('classifyComplexity：DDL 真信号仍判 L3', () => {
  for (const text of ['新建订单表', '建表 t_user', '新建用户表结构', '新增数据库', 'alter table user add col']) {
    const r = classifyComplexity(text)
    assert.equal(r.level, 3, `DDL 应判 L3：${text}`)
    assert.ok(r.signals.includes('L3:ddl'))
  }
})

test('classifyComplexity：DDL 不误伤"列表页/表单/报表/表格"等前端复合词（0.4.0 修复）', () => {
  const cases = [
    ['参考用户管理页面，新建一个订单列表页面', 'L1:self-contained'],
    ['参考 index.vue 新增一个搜索表单组件', 'L1:self-contained'],
    ['参考订单页做一个报表页面', 'L1:self-contained'],
    ['参考列表页新建一个数据表格页面', 'L1:self-contained'],
  ]
  for (const [text, signal] of cases) {
    const r = classifyComplexity(text)
    assert.notEqual(r.level, 3, `不应被误判为 L3/DDL：${text}`)
    assert.ok(r.signals.includes(signal), `应含 ${signal}：${text}`)
  }
})

test('classifyComplexity：DDL 前后视断言不影响"参考列表页做表格"一类的自包含判定', () => {
  const r = classifyComplexity('参考现有列表页，新建一个订单表格组件')
  assert.equal(r.level, 1)
  assert.equal(r.fastTrack, true)
})

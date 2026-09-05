// 需求复杂度分级 + 字段/组件类型推断
//
// 三级响应策略：
//   L1 原子操作  —— 单文件 CRUD + 组件/默认值明确 → 不追问，直接执行 + 风格自举
//   L2 模块变更  —— 允许追问，上限 3 个，每题必须给默认值
//   L3 架构重构  —— 完整 Grill-me 追问流程
//
// 跳过词（无条件 L1）：'直接做'、'速做'、'不用问'、'别问'、'不要问'、'极速模式'
//
// 设计目标：把"教条式追问"（模板填充型需求被当成架构变更）剔除出去，
// 同时保留对真复杂任务（重构、DDL、跨文件）的完整 Grill-me。

/** 用户显式跳过追问的关键词列表（任意一个命中即强制 L1） */
export const SKIP_TRIGGERS = ['直接做', '速做', '不用问', '别问', '不要问', '极速模式']

/** 组件类型 → 关键词正则。按优先级匹配，先命中者优先。
 *  注意：JS 默认 regex 的 \b 仅识别 ASCII 词边界，碰到中文时不工作，
 *  所以下面的 pattern 不使用 \b。 */
export const FIELD_COMPONENT_HINTS = {
  switch: /(开关|switch|布尔|boolean|启用|禁用|是\s*\/\s*否|否\s*\/\s*是|0\s*\/\s*1|1\s*\/\s*0)/i,
  select: /(下拉|下拉框|select|枚举|字典|选项|option|枚举值)/i,
  radio: /(单选|radio)/i,
  checkbox: /(多选|checkbox|复选)/i,
  date: /(日期|date|time|datetime|datepicker|timepicker)/i,
  number: /(数字|number|numeric|integer|整型)/i,
  textarea: /(文本域|textarea|多行文本|long\s*text)/i,
  input: /(输入|文本框|textfield|text\s*box|input)/i,
}

/** L3 信号：架构 / 重构 / DDL / 跨文件 */
const L3_PATTERNS = [
  { name: 'architecture', pattern: /(架构变更|架构调整|整体架构|技术选型|技术栈调整)/ },
  { name: 'refactor', pattern: /(整体.{0,6}重构|模块重构|服务重构|代码重构|拆分.{0,4}模块|拆分.{0,4}服务|重写整个|重做整个)/ },
  { name: 'migration', pattern: /(迁移到|迁移至|从\s*\w+\s*迁移\s*到|升级到|升级至|整体迁移|整体升级)/ },
  { name: 'ddl', pattern: /(建表|建库|建索引|加列|减列|修改表结构|新增表|删除表|新增索引|alter\s+table|create\s+table|drop\s+table|建[\u4e00-\u9fa5\s\w]{0,15}表|新建[\u4e00-\u9fa5\s\w]{0,15}表|新增[\u4e00-\u9fa5\s\w]{0,15}表|建库|新增数据库)/i },
  { name: 'cross-cutting', pattern: /(跨文件|跨模块|跨服务|跨组件|多个文件|多个模块|多处修改)/ },
]

/** L1 形状：单字段 CRUD 的常见写法（允许多个汉字在"新增"与"字段"之间） */
const L1_SHAPE_PATTERNS = [
  // "增加一个主管管员字段 isMainAdmin" / "新增字段 isMainAdmin" / "加一个 category 下拉字段"
  /(?:新增|增加|加|修改|改|加入|添加)\s*(?:一个|个|个新|项)?\s*[\u4e00-\u9fa5A-Za-z0-9_]*?\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框|列表项)/,
  // "isMainAdmin 字段"
  /\b[a-zA-Z_][a-zA-Z0-9_]*\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框|列表项)/,
  // "字段 isMainAdmin" 或 "字段名: isMainAdmin"
  /(?:字段|列|属性|参数)(?:\s*名)?\s*[:：]?\s*([a-zA-Z_][a-zA-Z0-9_]*)/,
]

/** 字段名提取模式（按优先级匹配） */
const FIELD_NAME_PATTERNS = [
  // "新增 isMainAdmin 字段"
  /(?:新增|增加|加|修改|改|加入|添加)\s*(?:一个|个|个新|项)?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框|列表项)/,
  // "新增字段 isMainAdmin"
  /(?:新增|增加|加|修改)\s*(?:一个|个|个新|项)?\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框)\s*(?:叫|名为|为|:|：)?\s*([a-zA-Z_][a-zA-Z0-9_]*)/,
  // "字段 isMainAdmin" 或 "字段名: isMainAdmin"
  /(?:字段|列|属性|参数)(?:\s*名)?\s*[:：]?\s*([a-zA-Z_][a-zA-Z0-9_]*)/,
  // "isMainAdmin 字段"
  /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框|列表项)/,
  ]

/** 默认值提取模式（按优先级匹配，长前缀优先匹配避免被"默认"拦截） */
const DEFAULT_VALUE_PATTERNS = [
  /(?:默认值(?:为|是)?|默认(?:为|是|取))\s*[`"']?([^`"'\s，。,;；）)\]]+)/,
  /(?:提交\s*值\s*(?:为|是)|传入\s*值\s*(?:为|是)|接口\s*值\s*(?:为|是)|值\s*(?:为|是)|提交\s*值|传入\s*值|接口\s*值)\s*[`"']?([^`"'\s，。,;；）)\]]+)/,
]

/** 目标文件路径提取（路径优先，含目录的优先；退化到单独文件名） */
const FILE_PATH_PATTERNS = [
  // 含目录的路径：src/views/UserForm.vue
  /[`"']?((?:[a-zA-Z_][\w.\-]*\/)+\w+\.[a-z]{1,8})[`"']?/,
  // 单独文件名：index.vue、UserController.java
  /[`"']?([\w.\-]+\.(?:vue|jsx|tsx|js|ts|java|kt|swift|m|c|cpp|h|hpp|py|rb|go|rs|php|html|css|scss|sass|less))[`"']?/i,
]

/**
 * 主入口：对需求做复杂度分级 + 字段/组件推断
 *
 * @param {string} requirement  用户原始需求文本
 * @returns {{
 *   level: 1|2|3,
 *   signals: string[],
 *   skipTrigger: string|null,
 *   inferredComponent: string|null,
 *   inferredField: string|null,
 *   inferredDefaultValue: string|null,
 *   inferredFile: string|null,
 * }}
 */
export function classifyComplexity(requirement) {
  const text = String(requirement ?? '').trim()

  const inferredComponent = inferFieldComponent(text)
  const inferredField = extractFieldName(text)
  const inferredDefaultValue = extractDefaultValue(text)
  const inferredFile = extractFilePath(text)

  // 1. 跳过词：最高优先级，无条件 L1
  const skipTrigger = SKIP_TRIGGERS.find((t) => text.includes(t)) || null
  if (skipTrigger) {
    return {
      level: 1,
      signals: [`skip-trigger:${skipTrigger}`],
      skipTrigger,
      inferredComponent,
      inferredField,
      inferredDefaultValue,
      inferredFile,
    }
  }

  // 2. L3 信号：架构 / 重构 / DDL / 跨文件
  for (const { name, pattern } of L3_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: 3,
        signals: [`L3:${name}`],
        skipTrigger: null,
        inferredComponent,
        inferredField,
        inferredDefaultValue,
        inferredFile,
      }
    }
  }

  // 3. L1 信号：单字段 CRUD + 字段名 + (组件/默认值) 明确
  const hasL1Shape = L1_SHAPE_PATTERNS.some((p) => p.test(text))
  if (hasL1Shape && inferredField && (inferredComponent || inferredDefaultValue)) {
    const signals = ['L1:crud-shape']
    if (inferredComponent) signals.push(`L1:component:${inferredComponent}`)
    if (inferredDefaultValue) signals.push('L1:default-value')
    return {
      level: 1,
      signals,
      skipTrigger: null,
      inferredComponent,
      inferredField,
      inferredDefaultValue,
      inferredFile,
    }
  }

  // 4. 默认 L2
  return {
    level: 2,
    signals: ['L2:default'],
    skipTrigger: null,
    inferredComponent,
    inferredField,
    inferredDefaultValue,
    inferredFile,
  }
}

/** 从文本推断 UI 组件类型；不命中返回 null */
export function inferFieldComponent(text) {
  for (const [component, pattern] of Object.entries(FIELD_COMPONENT_HINTS)) {
    if (pattern.test(text)) return component
  }
  return null
}

/** 从文本提取候选字段名；不命中返回 null */
export function extractFieldName(text) {
  for (const pat of FIELD_NAME_PATTERNS) {
    const m = pat.exec(text)
    if (m && m[1]) return m[1]
  }
  return null
}

/** 从文本提取默认值；不命中返回 null */
export function extractDefaultValue(text) {
  for (const pat of DEFAULT_VALUE_PATTERNS) {
    const m = pat.exec(text)
    if (m && m[1]) return m[1]
  }
  return null
}

/** 从文本提取目标文件路径；不命中返回 null */
export function extractFilePath(text) {
  for (const pat of FILE_PATH_PATTERNS) {
    const m = pat.exec(text)
    if (m && m[1]) return m[1]
  }
  return null
}

/** L2 报告允许的最大追问数 */
export const L2_MAX_QUESTIONS = 3

/** L1 报告默认采取的"保守默认"配置（不明确时直接套用） */
export const L1_DEFAULTS = {
  listDisplay: '不展示（保守方案；如需展示请主动告知）',
  validation: '不加业务校验，仅做基础必填/非空校验（用户需求中含"校验/唯一/必填"则启用）',
  backend: '默认已支持（仅前端改动；未支持请主动告知）',
}

/** 组件类型 → Element Plus 推荐实现的速查 */
export const ELEMENT_COMPONENT_FOR_TYPE = {
  switch: 'el-switch',
  select: 'el-select',
  radio: 'el-radio-group',
  checkbox: 'el-checkbox-group',
  date: 'el-date-picker',
  number: 'el-input-number',
  textarea: 'el-input(type=textarea)',
  input: 'el-input',
}
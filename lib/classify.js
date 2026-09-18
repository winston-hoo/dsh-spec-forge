// 需求复杂度分级 + 字段/组件类型推断
//
// 三级响应策略：
//   L1 原子操作  —— 单文件 CRUD + 组件/默认值明确 → 不追问，直接执行 + 风格自举
//   L2 模块变更  —— 允许追问，上限 3 个，每题必须给默认值
//   L3 架构重构  —— 完整 Grill-me 追问流程
//
// 跳过词（无条件 L1）：'直接做'、'速做'、'不用问'、'别问'、'不要问'、'极速模式'
//
// 0.4.3 起 L1 有三条独立通路（任一亮即 fastTrack）：
//   ① 跳过词强制
//   ② 自包含新建 + 参考物（新页面/组件）
//   ③ 原子小改（改文案/调样式/改默认值/字段改名/常量调整）；
//      注意：容器型原子改动（"加个按钮/加个路由/加一列"）虽然也走本类检测，
//      但内容不明时判 confirm 先问一次（0.4.6），不要在这里写成"一律 L1 直通"。
//
// 0.4.6 修正 ③ 的口径 —— 此前注释写「无字段名也能一轮做完」，等于把上面 L1 定义里的
//   「组件/默认值明确」这半个条件丢掉了，于是同一文件里 L1 有两个互相矛盾的定义。
//   现在原子小改要过四道闸，第四道是**内容可决性**：
//     ③a 改已有物的属性取值（改文案 / 调间距 / 改按钮样式 / 超时改成30s）→ 缺的是取值，放行；
//     ③b 增删容器（加个按钮 / 加个路由 / 加一列 / 加个菜单项）→ 必须说清新增物"是什么"，否则问一次。
//   判据一句话：**缺「新增物的身份」必问，缺「已有物的取值」自决。**
//
// 设计目标：把"教条式追问"（模板填充型需求被当成架构变更）剔除出去，
// 同时保留对真复杂任务（重构、DDL、跨文件）的完整 Grill-me，
// 也保留对"没说清要做什么"的小需求的必要确认。

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
  // 注意：不能简单用 `建[\s\S]{0,15}表` 匹配，否则"新建订单列表页面""新增搜索表单组件"
  // 会因"列表/表单"里的"表"被误判成 DDL。这里用前后视断言排除中文复合词：
  //   前视排除 - 列表(列)/报表(报)/图表(图)
  //   后视排除 - 表单(单)/表格(格)/表头表尾/表示表现表明/表面/表率/表白 等
  // 0.4.7：`加列` 必须排除 `加列宽` —— 「表格增加列宽自适应」这类**样式**需求
  //   被 `加列` 子串命中后判成 L3，代价最高（完整 Grill-me + 提问前禁止读文件）。
  { name: 'ddl', pattern: /(建表|建库|建索引|加列(?!宽)|减列|修改表结构|新增表|删除表|新增索引|alter\s+table|create\s+table|drop\s+table|(?:新建|新增|创建|建|加)[\u4e00-\u9fa5A-Za-z0-9_\s]{0,15}(?<![列报图])表(?!单|格|头|尾|示|现|明|演|决|情|面|率|白|达|盘|针|带|记|稿|述|扬|层)|新增数据库)/i },
  { name: 'cross-cutting', pattern: /(跨文件|跨模块|跨服务|跨组件|多个文件|多个模块|多处修改)/ },
]

/** L1 形状：单字段 CRUD 的常见写法（允许多个汉字在"新增"与"字段"之间） */
const L1_SHAPE_PATTERNS = [
  // "增加一个主管人员字段 isMainAdmin" / "新增字段 isMainAdmin" / "加一个 category 下拉字段"
  /(?:新增|增加|加|修改|改|加入|添加)\s*(?:一个|个|个新|项)?\s*[\u4e00-\u9fa5A-Za-z0-9_]*?\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框|列表项)/,
  // "isMainAdmin 字段"
  /\b[a-zA-Z_][a-zA-Z0-9_]*\s*(?:字段|列|属性|参数|表单项|搜索项|筛选项|菜单项|下拉|单选|多选|选项|输入框|文本框|列表项)/,
  // "字段 isMainAdmin" 或 "字段名: isMainAdmin"
  /(?:字段|列|属性|参数)(?:\s*名)?\s*[:：]?\s*([a-zA-Z_][a-zA-Z0-9_]*)/,
]

/**
 * L1 原子改动：单点小改，无需字段名/组件名也能一轮做完。
 * 0.4.3 新增 —— 补上「加按钮 / 改文案 / 调样式 / 加搜索项 / 加路由 / 改默认值 / 字段改名」
 * 这类高频小需求的快速通道。此前它们全部落 L2，每次都要多走一趟 spec_triage。
 *
 * 三道闸门（同时满足才启用，宁可不升也不误升）：
 *   ① 需求长度 ≤ ATOMIC_EDIT_MAX_LEN —— 长文本往往是多目标复合需求
 *   ② 不含多任务连接词（以及/同时/顺便…）—— 「加个按钮，同时重构列表」不是原子改动
 *   ③ 不含大范围限定词（整体/全局/所有/批量…）—— 「统一所有按钮文案」影响面不可控
 *
 * 注意中文正则的复合词误伤（历史坑，见 0.4.0 的 DDL 误判）：
 *   「列」必须排除「列表/列页/列格」，否则「改列表页」会被当成「改一列」。
 */
const ATOMIC_EDIT_MAX_LEN = 48

/** 多任务连接词：出现即说明这不是「单点原子改动」 */
const L2_MULTITASK_SIGNALS = /(以及|同时|顺便|还有|另外|并且|然后|一并|一起)/

/** 大范围限定词：出现即说明影响面不可控，保守留在 L2 */
const BROAD_SCOPE_SIGNALS = /(整体|全局|所有|全部|批量|每个|各个|多处|整个|全站|全量)/

export const L1_ATOMIC_EDIT_PATTERNS = [
  // 文案类（动词前置）：「改一下登录页的文案」「换标题」
  {
    family: 'copy',
    pattern:
      /(?:改|换|修改|调整|更新|优化|统一)[\u4e00-\u9fa5A-Za-z0-9_\s]{0,8}?(?:文案|文字|标题|副标题|标签|提示语|提示文字|占位符|placeholder|label)/i,
  },
  // 文案类（名词前置）：「标题换成…」「文案改一下」——中文常把宾语放动词前，必须单独覆盖
  {
    family: 'copy',
    pattern: /(?:文案|文字|标题|副标题|标签|提示语|提示文字|占位符|placeholder|label)\s*(?:换|改|改成|改为|换成|更新|统一)/i,
  },
  // 样式类（动词前置）：「调一下间距」「改一下颜色」
  {
    family: 'style',
    pattern:
      /(?:调|改|调整|修改|优化|微调)[\u4e00-\u9fa5A-Za-z0-9_\s]{0,8}?(?:样式|颜色|配色|间距|边距|内边距|外边距|字号|字体|字重|宽度|高度|圆角|背景色|对齐|图标大小|css|style|scss|less)/i,
  },
  // 样式类（名词前置）：「样式错位」「间距不统一」「字号调大」
  {
    family: 'style',
    pattern: /(?:样式|颜色|配色|间距|边距|字号|圆角|对齐)\s*(?:调整|微调|改一下|调一下|调大|调小|问题|错位|不统一|太大|太小)/,
  },
  // 按钮/图标类 —— 0.4.6 拆成两族，因为两族的闸门判据不同（见 CONTAINER_CONTENT_SPECS）：
  //   button      增删容器（「加个按钮」）→ 新增物身份未知 → 需内容
  //   button-attr 改已有按钮的属性（「改按钮样式」）→ 缺的是取值 → 放行
  // 同时放宽修饰语：「加个忘记密码按钮」在本版之前**根本不匹配**（正则要求"个"紧邻"按钮"），
  // 于是越具体的需求反而越被降级去问 —— 特异性倒挂，这次一并修掉。
  {
    family: 'button',
    pattern:
      /(?:加|新增|增加|添加|删|删除|去掉|移除)\s*(?:一个|个|这)?\s*[\u4e00-\u9fa5A-Za-z0-9_]{0,12}?\s*(?:按钮|图标|icon)/i,
  },
  // 「按钮文案/样式/位置」与「改按钮」——改的是已有物的属性，缺的只是取值
  { family: 'button-attr', pattern: /(?:按钮|图标|icon)\s*(?:文案|样式|位置|名称|顺序|换行|大小|颜色)/i },
  { family: 'button-attr', pattern: /(?:改|换|调整|修改|优化|调)\s*(?:一下|下|个|这)?\s*(?:按钮|图标|icon)/i },
  // 表格列/搜索项类（「列」排除 列表/列页/列格 复合词；「一列」本身是名词，不能塞进量词位）
  {
    family: 'column',
    pattern:
      /(?:加|新增|增加|添加|删|删除|去掉|移除|改|调整|修改)\s*(?:一个|个|这)?\s*(?:一列|列(?!表|页|格)|搜索项|筛选项|查询项|查询条件|表头|列宽|排序)/,
  },
  // 路由/菜单类（同样放宽修饰语：「加个报表路由」以前不匹配）
  {
    family: 'route',
    pattern:
      /(?:加|新增|增加|添加|注册|删|删除|去掉|移除|改|调整|修改)\s*(?:一个|个|这)?\s*[\u4e00-\u9fa5A-Za-z0-9_/-]{0,12}?\s*(?:路由|菜单项|菜单|导航项|子菜单)/,
  },
  // 默认值/常量类（动词前置）
  { family: 'constant', pattern: /(?:改|修改|调整|换)\s*(?:一下|下|个|这)?\s*(?:默认值|初始值|默认|常量|阈值|上限|下限|超时时间)/ },
  // 默认值/常量类（名词前置）：「超时时间改成 30s」「默认值改成草稿」
  { family: 'constant', pattern: /(?:默认值|初始值|默认|常量|阈值|上限|下限|超时时间)\s*(?:改|改成|改为|换成|调成|调整为)/ },
  // 字段/变量改名类（只认明确的改名动词，避免「字段改造」被误吞）
  { family: 'rename', pattern: /(?:字段|列|属性|参数|变量|方法|函数)(?:名|名称)?\s*(?:改成|改为|改名|重命名|换成|替换成|更名)/ },
  // 显式的小改限定词
  { family: 'tiny', pattern: /(?:小改|微调|小调整|只改|仅改|只调整|改个小)/ },
]

/**
 * 0.4.6 闸门④：内容可决性（container families only）
 *
 * 病灶：上面三道闸全是「范围」闸（多长 / 几件事 / 影响面多大），没有一道问
 * 「需求有没有说清这个新增物**是什么、干什么**」。于是「登录页加个按钮」7 字、
 * 单目标、无连接词 → 三闸全过 → fastTrack，而插件又明文禁止追问，模型只能自己
 * 替用户挑一个用途（实测挑了「忘记密码？」）—— 用户要的是被问一句，不是被猜一次。
 *
 * 判据（一句话）：
 *   缺的是「新增物的身份/用途」→ **必须问**；
 *   缺的是「已有物的属性取值」→ 自己定（可逆、可见，随便给个合理值都不算错）。
 *
 * 因此只有「增删容器」这一族需要拦：加按钮 / 加路由 / 加一列 / 加菜单项。
 * `改文案 / 调间距 / 改按钮样式 / 超时改成30s` 缺的都是取值，一律放行。
 *
 * 内容信号（命中任一即认为已给出"是什么"）：
 *   ① 容器名词前的修饰语 —— 「加个**忘记密码**按钮」
 *   ② 用途动词紧邻容器 —— 「加个**导出**按钮」
 *   ③ 点击行为 / 引号文本 —— 「加个按钮，**点击跳转注册页**」
 *
 * ⚠️ 刻意**不**把「路径」当内容信号：需求常带目标文件前缀
 * （`@…/login/index.vue 登录页加个按钮`），那是"改哪个文件"，不是"按钮做什么"。
 * 我实测踩过这个坑 —— 带上路径前缀后长度与锚点都变了，会误判成"内容已给"。
 */
const CONTAINER_CONTENT_SPECS = {
  button: {
    gap: ['按钮的文案与用途'],
    before:
      /(?:加|新增|增加|添加|删|删除|去掉|移除)\s*(?:一个|个|这)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})\s*(?:按钮|图标|icon)/i,
    extra:
      /(?:(?:提交|重置|保存|删除|移除|导出|下载|导入|上传|打印|刷新|返回|跳转|打开|关闭|登录|注册|退出|切换|复制|分享|发送|确认|取消|新增|添加|编辑|查看|绑定|解绑|重试|同步|清空|展开|收起|扫码|预览|打印)\s*(?:一个|个|这)?\s*(?:按钮|图标|icon))|(?:点击|按下|单击)[^，。；;]{0,24}|[「『“"'][^」』”"']{1,24}[」』”"']/i,
  },
  column: {
    gap: ['新增列对应的字段'],
    before:
      /(?:加|新增|增加|添加|删|删除|去掉|移除)\s*(?:一个|个|这)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})\s*(?:搜索项|筛选项|查询项|查询条件|表头|列宽|列)/,
    after:
      /(?:加|新增|增加|添加|删|删除|去掉|移除)\s*(?:一个|个|这)?\s*(?:一列|列(?!表|页|格))\s*的?\s*([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_]{0,11})/,
    extra: /[「『“"'][^」』”"']{1,24}[」』”"']/,
  },
  route: {
    gap: ['路由/菜单项的路径与目标页面'],
    before:
      /(?:加|新增|增加|添加|注册|删|删除|去掉|移除)\s*(?:一个|个|这)\s*([\u4e00-\u9fa5A-Za-z0-9_/-]{1,12})\s*(?:路由|菜单项|菜单|导航项|子菜单)/,
    // 「新增一个路由**指向物料页**」——目标是给了的
    extra:
      /(?:指向|跳到|通往|转到|到)\s*[\u4e00-\u9fa5A-Za-z0-9_/.-]{1,20}|[「『“"'][^」』”"']{1,24}[」』”"']/,
  },
}

/** 该族是否需要"内容"；返回缺失内容的可读说明（空数组=不需要或已给全） */
export function contentGapOf(family, text) {
  const spec = CONTAINER_CONTENT_SPECS[family]
  if (!spec) return []
  const t = String(text ?? '')
  const hasModifier = !!spec.before?.exec(t)?.[1]
  const hasAfter = !!spec.after?.exec(t)?.[1]
  const hasExtra = !!spec.extra?.test(t)
  return hasModifier || hasAfter || hasExtra ? [] : spec.gap.slice()
}

/** L1 自包含新建：新页面/组件，且有参考物 → 可一轮做完，不追问 */
const L1_SELF_CONTAINED_PATTERNS = [
  /(?:新建|新增|做一个|做个|做|制作|实现|开发|写|创建|加)\s*(?:一个|个)?\s*[\u4e00-\u9fa5A-Za-z0-9_]{0,12}?(?:页面|组件|弹窗|对话框|表单|列表页|详情页|卡片|视图)/,
  /(?:一个|个)\s*[\u4e00-\u9fa5A-Za-z0-9_]{0,12}?(?:页面|组件|弹窗|对话框)/,
]

/** 参考物信号：需求中给了可对照的样本（页面/文件/文档），足以自举实现细节 */
const REFERENCE_SIGNALS = /(参考|参照|仿照|按照|照搬|对标|类似|同款|依据|基于)/

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
 *   fastTrack: boolean,
 *   contentGap: string[],
 *   signals: string[],
 *   skipTrigger: string|null,
 *   inferredComponent: string|null,
 *   inferredField: string|null,
 *   inferredDefaultValue: string|null,
 *   inferredFile: string|null,
 * }}
 */
// ponytail: 全部判据是中文关键词表 + 正则，不调模型 —— 判错的代价只是"多问一句/少问一句"，
// 不会改错代码，却换来零延迟、零依赖、可离线单测。上限：同义改写认不出（"标题换个说法"）；
// 升级触发：真实会话里攒到判错样本，再考虑换模型分类（那时得连带解决 pre-step 的延迟与成本）。
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
      fastTrack: true,
      contentGap: [],
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
        fastTrack: false,
        contentGap: [],
        signals: [`L3:${name}`],
        skipTrigger: null,
        inferredComponent,
        inferredField,
        inferredDefaultValue,
        inferredFile,
      }
    }
  }

  // 3. L1 自包含新建：新页面/组件 + 有参考物 → 实现细节可从参考物自举，不追问
  const hasSelfContained = L1_SELF_CONTAINED_PATTERNS.some((p) => p.test(text))
  if (hasSelfContained && REFERENCE_SIGNALS.test(text)) {
    return {
      level: 1,
      fastTrack: true,
      contentGap: [],
      signals: ['L1:self-contained', 'L1:has-reference'],
      skipTrigger: null,
      inferredComponent,
      inferredField,
      inferredDefaultValue,
      inferredFile,
    }
  }

  // 4. L1 信号：单字段 CRUD + 字段名 + (组件/默认值) 明确
  const hasL1Shape = L1_SHAPE_PATTERNS.some((p) => p.test(text))
  if (hasL1Shape && inferredField && (inferredComponent || inferredDefaultValue)) {
    const signals = ['L1:crud-shape']
    if (inferredComponent) signals.push(`L1:component:${inferredComponent}`)
    if (inferredDefaultValue) signals.push('L1:default-value')
    return {
      level: 1,
      fastTrack: true,
      contentGap: [],
      signals,
      skipTrigger: null,
      inferredComponent,
      inferredField,
      inferredDefaultValue,
      inferredFile,
    }
  }

  // 5. L1 原子改动：单点小改（文案/样式/按钮/列/路由/常量/改名）。
  //    放在 crud-shape 之后：能拿到字段名+组件的需求走上面那条（信号更丰富），
  //    拿不到的原子小改才落到这里。三道范围闸门见 L1_ATOMIC_EDIT_PATTERNS 注释；
  //    0.4.6 起追加第四道闸「内容可决性」，见 CONTAINER_CONTENT_SPECS。
  //
  //    ⚠️ 两道闸门的**适用边界不同**，这是刻意的：
  //      · 内容闸门（缺内容→必须问）**不受长度约束**。只排除多任务/大范围信号。
  //        理由：长度闸门是"长文本≈多目标"的粗代理，而带长路径前缀的单点需求会被它误伤 ——
  //        实测那条 `@…/src/views/login/index.vue 登录页加个按钮` 恰好 48 字，
  //        路径再长一个字符，整个内容闸门就从缝里漏过去了。
  //      · 放行闸门（给 fastTrack）仍要求长度 ≤ 上限：长需求宁可走 L2 常规路径，
  //        免得把复合需求当小改。
  const noMultiTask = !L2_MULTITASK_SIGNALS.test(text)
  const noBroadScope = !BROAD_SCOPE_SIGNALS.test(text)
  const atomicHit = noMultiTask && noBroadScope ? L1_ATOMIC_EDIT_PATTERNS.find((p) => p.pattern.test(text)) : null
  if (atomicHit) {
    const contentGap = contentGapOf(atomicHit.family, text)
    if (contentGap.length > 0) {
      // 容器型且没说清"加的是什么" → 不给 fastTrack。降 L2 并带上缺失说明，
      // 由 spec_recall 转成 nextStep='confirm'（问一次再动手）。
      // 注意：这条缺口**独立于长度与锚点**，不能指望 L2 的 unactionable 安全阀 ——
      // 实测 `@…/login/index.vue 登录页加个按钮` 因带路径前缀而 tooShort=false、
      // hasAnchor=true，安全阀根本不会触发（0.4.6 的实测数据）。
      return {
        level: 2,
        fastTrack: false,
        contentGap,
        signals: ['L2:content-missing', `L2:content-missing:${atomicHit.family}`],
        skipTrigger: null,
        inferredComponent,
        inferredField,
        inferredDefaultValue,
        inferredFile,
      }
    }
    if (text.length <= ATOMIC_EDIT_MAX_LEN) {
      return {
        level: 1,
        fastTrack: true,
        contentGap,
        signals: ['L1:atomic-edit', `L1:atomic-edit:${atomicHit.family}`],
        skipTrigger: null,
        inferredComponent,
        inferredField,
        inferredDefaultValue,
        inferredFile,
      }
    }
  }

  // 6. 默认 L2
  //    注意 contentGap 只在第 5 条通路产出：多任务/超长需求即使命中容器族也不该被
  //    降成"问一句"，那些走 L2→spec_triage 的常规路径（否则会绕过体检）。
  return {
    level: 2,
    fastTrack: false,
    contentGap: [],
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

/**
 * L1 原子小改的**白名单示例**（0.4.7 新增，供 SKILL.md 一致性测试使用）。
 *
 * 存在理由：SKILL.md 曾把「加按钮 / 加列 / 加路由」写进 L1 信号括号里当作直通条件，
 * 而 0.4.6 起容器型原子改动（说了"加个按钮"却没说是什么按钮）要判 `confirm` 先问一次 ——
 * 说明书与代码相反，且没有任何测试会红。这份白名单让那种偏差变成失败测试。
 * 新增 L1 示例时：改这里 + 改 SKILL.md，两边必须同时改。
 */
export const L1_EXAMPLES = Object.freeze([
  '改文案',
  '调样式',
  '改默认值',
  '字段改名',
  '常量调整',
  '单字段 CRUD',
  '自包含新建',
])

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
/**
 * 推断需求的主类别（只返回一级：bugfix / refactor / frontend / feature）。
 *
 * 只取一级是有意为之：模板的 category 由模型沉淀时自由填写（如 feature/api、
 * bugfix/refactor、frontend/component），二级名不可预测，强行相等匹配命中率极低。
 * 打分侧按「一级相同」计分，兼顾命中率与准确性。
 *
 * 命中强信号才返回；判不出来返回 undefined（宁可不加分，也不误加分）。
 *
 * @returns {'bugfix'|'refactor'|'frontend'|'feature'|undefined}
 */
export function inferQueryCategory(requirement) {
  const text = String(requirement ?? '').trim()
  if (!text) return undefined
  const lower = text.toLowerCase()

  // 1) 修 Bug / 排错：报错、异常、警告、崩溃类信号最明确，优先判定
  const bugSignals = [
    '报错', '异常', '崩溃', '失败', '警告', '不生效', '无法', '不能', '出错',
    'error', 'exception', 'warning', 'bug', '堆栈', 'stack', 'trace',
  ]
  // 排除"修复完成后做验证"这类非 bug 表述的干扰：同时含新增类动作词则让位
  const hasBug = bugSignals.some((w) => lower.includes(w))

  // 2) 重构 / 迁移
  const refactorSignals = ['重构', '重写', '迁移', '改造', '拆分', '抽离', 'refactor', 'migrate']
  const hasRefactor = refactorSignals.some((w) => lower.includes(w))

  // 3) 前端：前端技术栈或前端文件/组件语义
  const frontendSignals = [
    'vue', 'react', 'angular', '小程序', '页面', '组件', '表单', '弹窗', '列表',
    '表格', '样式', '布局', '路由', '菜单', '按钮', '图标', 'props', 'emit',
    '.vue', '.tsx', '.jsx', '.wxss', '.wxml', 'scss', 'css',
  ]
  const hasFrontend = frontendSignals.some((w) => lower.includes(w))

  // 4) 后端/新功能：接口、分层组件、CRUD 动作
  const featureSignals = [
    '接口', 'api', 'controller', 'service', 'mapper', 'repository', 'dao',
    '新增', '添加', '创建', '查询', '分页', '导出', '导入', '字段', 'entity', 'dto',
  ]
  const hasFeature = featureSignals.some((w) => lower.includes(w))

  // 判定顺序：bug > refactor > frontend > feature
  // 只有在"新增类动作信号弱"时才判 bug，避免"新增字段后报错"被误判
  if (hasBug && !(hasRefactor || hasFrontend || hasFeature)) return 'bugfix'
  if (hasRefactor) return 'refactor'
  if (hasFrontend) return 'frontend'
  if (hasFeature) return 'feature'

  return undefined
}

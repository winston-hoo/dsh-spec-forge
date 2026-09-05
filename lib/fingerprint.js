// 文本指纹：把一段自然语言需求切成可比较的加权 token 集合。
// 纯函数，无 IO，全部可单测。

const STOP_CHARS = new Set(
  '的了是我和就不都很也到说要去你会着这那个有在把被给从向对与及以之其为于但而或如若因所然后么什怎样请帮再下上个里外中大小多少好新做用需要可以能不能'.split('')
)

const STOP_WORDS = new Set([
  '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '怎样', '为什么',
  '可以', '不能', '需要', '应该', '还是', '一个', '一下', '现在', '目前',
  '问题', '东西', '地方', '时候', '情况', '代码', '文件', '功能',
])

// 技术词典：命中即高权重，是召回质量的主要保障。
// 按长度降序匹配，保证「分页查询」优先于「分页」。
const TECH_DICT = [
  // 架构分层
  'controller', 'service', 'serviceimpl', 'mapper', 'repository', 'dao', 'entity',
  'dto', 'vo', 'pojo', 'model', 'middleware', 'interceptor', 'filter', 'aspect',
  'config', 'configuration', 'util', 'utils', 'helper', 'handler', 'listener',
  'scheduler', 'job', 'task', 'router', 'route', 'store', 'composable', 'hook',
  // 后端技术
  'springboot', 'spring', 'mybatis', 'mybatisplus', 'pagehelper', 'jpa', 'redis',
  'mysql', 'oracle', 'kafka', 'rabbitmq', 'jwt', 'oauth', 'shiro', 'security',
  'swagger', 'knife4j', 'maven', 'gradle', 'docker', 'nginx', 'linux',
  'transactional', 'transaction', 'async', 'cache', 'lock', 'thread', 'pool',
  // 前端技术
  'vue', 'vue3', 'react', 'angular', 'vite', 'webpack', 'elementui', 'elementplus',
  'antd', 'pinia', 'vuex', 'axios', 'typescript', 'javascript', 'scss', 'css',
  'tailwind', 'echarts', 'vant', 'uniapp', 'wechat', 'miniprogram', '小程序',
  // 动作
  '新增', '添加', '创建', '删除', '移除', '修改', '更新', '编辑', '查询', '搜索',
  '分页', '排序', '筛选', '过滤', '导出', '导入', '上传', '下载', '提交', '校验',
  '验证', '登录', '注册', '鉴权', '授权', '权限', '加密', '解密', '缓存', '异步',
  '定时', '重构', '优化', '迁移', '适配', '兼容', '修复', '调试', '部署', '发布',
  '回滚', '合并', '分支', '提交记录', '单元测试', '测试用例', '接口', '联调',
  '字段', '参数', '返回值', '异常', '报错', '日志', '监控', '告警', '预警',
  '表单', '列表', '弹窗', '抽屉', '表格', '树形', '下拉', '复选框', '单选',
  '路由', '菜单', '按钮', '图标', '主题', '样式', '布局', '响应式', '埋点',
  // 质量属性
  '性能', '并发', '幂等', '事务', '一致性', '安全性', '可维护', '可扩展', '向后兼容',
]

const TECH_SET = new Set(TECH_DICT)
const TECH_SORTED = [...new Set(TECH_DICT)].sort((a, b) => b.length - a.length)

// 中文词典单独预筛，避免每次循环都对整张表跑正则
const CJK = /[\u4e00-\u9fa5]/
const CN_TECH_SORTED = TECH_SORTED.filter((w) => CJK.test(w))

// 权重：文件路径最高（最能区分任务），技术词次之，普通词最低
export const WEIGHT_PATH = 4
export const WEIGHT_TECH = 3
export const WEIGHT_IDENT = 2
export const WEIGHT_GRAM = 1

// 目录噪声：这些分段几乎出现在所有 Java/前端项目里，对区分任务没有帮助
const STD_DIRS = new Set([
  'src', 'main', 'test', 'java', 'com', 'cn', 'org', 'net', 'io',
  'resources', 'static', 'public', 'assets', 'pages', 'views',
  'components', 'utils', 'node_modules', 'dist', 'build', 'target',
])

/** 全角转半角 + 小写 + 空白归一 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** 驼峰与分隔符拆分：getUserInfo -> ['get','user','info']；user-service -> ['user','service'] */
export function splitIdentifier(word) {
  return String(word)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

/** 抽出文件路径，返回 { paths, rest } */
export function extractPaths(text) {
  const paths = []
  const rest = String(text).replace(
    /(?:[\w.$-]+[\\/])+[\w.$-]+/g,
    (m) => {
      paths.push(m.replace(/\\/g, '/'))
      return ' '
    }
  )
  return { paths, rest }
}

/** 中文切分：技术词典最长匹配优先，残余部分做 2-gram 并过滤停用词 */
export function segmentChinese(text) {
  const out = []
  let rest = String(text)

  // 先用词典贪心切分
  let guard = 0
  while (rest.length > 0 && guard++ < 5000) {
    const hit = CN_TECH_SORTED.find((w) => rest.startsWith(w))
    if (hit) {
      out.push({ token: hit, weight: WEIGHT_TECH })
      rest = rest.slice(hit.length)
      continue
    }
    // 词典未命中，取首字
    const ch = rest[0]
    rest = rest.slice(1)
    out.push({ token: ch, weight: 0, raw: true })
  }

  // 把连续 raw 单字重新组装成 2-gram
  const grams = []
  let buf = []
  for (const item of out) {
    if (item.raw) {
      buf.push(item.token)
    } else {
      flushBuf(buf, grams)
      buf = []
      grams.push({ token: item.token, weight: item.weight })
    }
  }
  flushBuf(buf, grams)
  return grams
}

function flushBuf(buf, grams) {
  if (buf.length === 0) return
  if (buf.length === 1) {
    // 单字只有在非停用字时才保留
    if (!STOP_CHARS.has(buf[0])) grams.push({ token: buf[0], weight: WEIGHT_GRAM })
    return
  }
  for (let i = 0; i < buf.length - 1; i++) {
    const g = buf[i] + buf[i + 1]
    if (STOP_WORDS.has(g)) continue
    if (STOP_CHARS.has(buf[i]) || STOP_CHARS.has(buf[i + 1])) continue
    grams.push({ token: g, weight: WEIGHT_GRAM })
  }
}

/**
 * 生成加权 token 表。
 * @returns {Map<string, number>} token -> 权重
 */
export function tokenize(input) {
  const raw = String(input ?? '')
  const text = normalize(raw)
  const weights = new Map()

  const bump = (token, weight) => {
    if (!token || token.length === 0) return
    if (token.length === 1 && !/[a-z0-9]/.test(token)) return
    const prev = weights.get(token) ?? 0
    weights.set(token, Math.max(prev, weight))
  }

  // 路径必须从原始文本抽取：normalize 会抹掉大小写，而驼峰拆分依赖大小写信息
  const rawPaths = extractPaths(raw).paths
  const { rest } = extractPaths(text)

  for (const p of rawPaths) {
    const rawSeg = p.split('/')
    const normalizedPath = p.toLowerCase()
    const seg = normalizedPath.split('/')
    bump(normalizedPath, WEIGHT_PATH)
    bump(seg[seg.length - 1], WEIGHT_PATH)
    for (const part of seg.slice(0, -1)) {
      if (part && !STD_DIRS.has(part)) bump(part, WEIGHT_TECH)
    }
    // 用原始大小写的文件名拆驼峰：UserOrderController.java -> user, order, controller
    const rawLast = rawSeg[rawSeg.length - 1].replace(/\.[^.]+$/, '')
    for (const w of splitIdentifier(rawLast)) bump(w, TECH_SET.has(w) ? WEIGHT_TECH : WEIGHT_IDENT)
  }

  // 英文/数字 token
  const words = rest.match(/[a-z_][a-z0-9_]{0,63}/g) ?? []
  for (const w of words) {
    bump(w, TECH_SET.has(w) ? WEIGHT_TECH : WEIGHT_IDENT)
    const parts = splitIdentifier(w)
    if (parts.length > 1) for (const p of parts) bump(p, TECH_SET.has(p) ? WEIGHT_TECH : WEIGHT_IDENT)
  }

  // 中文
  const cnBlocks = rest.match(/[\u4e00-\u9fa5]+/g) ?? []
  for (const block of cnBlocks) {
    for (const g of segmentChinese(block)) bump(g.token, g.weight)
  }

  return weights
}

/**
 * 取权重最高的 n 个 token 作为指纹。
 * @returns {Array<{token:string, weight:number}>}
 */
export function fingerprint(input, limit = 24) {
  const weights = tokenize(input)
  return [...weights.entries()]
    .map(([token, weight]) => ({ token, weight }))
    .sort((a, b) => b.weight - a.weight || a.token.localeCompare(b.token))
    .slice(0, limit)
}

/** 从指纹数组还原成 Map，供打分使用 */
export function toWeightMap(fp) {
  if (fp instanceof Map) return fp
  return new Map(fp.map(({ token, weight }) => [token, weight]))
}

/**
 * 从需求原文推断候选标签，用于与模板 tags 做 jaccard 重叠。
 *
 * 形态刻意贴近沉淀时模型填写的 tags（小写英文、带连字符，如 vue / a-switch / table-column）：
 * 带连字符的复合词整体保留（否则 ant-design-vue 会被切碎成 ant/design/vue，与模板标签对不上）。
 * 结果按权重截断：标签集合过大会稀释 jaccard 分母，反而降低重叠率。
 *
 * @returns {string[]} 候选标签（数量不超过 limit）
 */
export function inferQueryTags(input, limit = 8) {
  const raw = String(input ?? '')
  const text = normalize(raw)
  const scores = new Map()

  const bump = (tag, weight) => {
    const key = String(tag ?? '').trim().toLowerCase()
    if (!key || key.length < 2) return
    const prev = scores.get(key) ?? 0
    if (prev < weight) scores.set(key, weight)
  }

  // 1) 带连字符的复合技术词：a-switch / el-switch / ant-design-vue —— 整体权重最高
  for (const m of text.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) ?? []) {
    bump(m, 5)
    for (const part of splitIdentifier(m)) bump(part, 2)
  }

  // 2) 路径片段：末段文件名 + 非噪声目录名
  const { paths } = extractPaths(text)
  for (const p of paths) {
    const segs = p.split('/').filter(Boolean)
    const last = segs[segs.length - 1] ?? ''
    bump(last.replace(/\.[^.]+$/, ''), 4)
    for (const s of segs.slice(0, -1)) if (!STD_DIRS.has(s)) bump(s, 3)
  }

  // 3) 技术词典命中（英文 token 与中文技术词）
  for (const m of text.match(/[a-z][a-z0-9_]{1,63}/g) ?? []) {
    if (TECH_SET.has(m)) bump(m, 4)
  }
  for (const block of text.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    for (const g of segmentChinese(block)) {
      if (g.weight >= WEIGHT_TECH) bump(g.token, 4)
    }
  }

  // 4) 驼峰标识符：整体与拆分部分都记，权重低于技术词
  for (const m of raw.match(/[A-Za-z_$][A-Za-z0-9_$]{1,63}/g) ?? []) {
    const parts = splitIdentifier(m)
    if (parts.length > 1) {
      bump(m.toLowerCase(), 3)
      for (const p of parts) bump(p, 2)
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag)
}

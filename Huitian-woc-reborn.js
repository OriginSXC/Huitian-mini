import plugin from '../../lib/plugins/plugin.js'
import sharp from 'sharp' 
import Config from './config/config.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('woc')

const BATCH_SIZE          = cfg.BATCH_SIZE || 5          
const DELAY_MS            = cfg.DELAY_MS || 1600       
const MAX_TOTAL           = cfg.MAX_TOTAL || 10         
const USE_SHARP           = cfg.USE_SHARP ?? true       
const FORCE_BASE64        = cfg.FORCE_BASE64 ?? true       
const PREFER_ICQQ_FORWARD = cfg.PREFER_ICQQ_FORWARD ?? true 
const FETCH_TIMEOUT_MS    = cfg.FETCH_TIMEOUT_MS || 100000  
const JPEG_WIDTH          = cfg.JPEG_WIDTH || 1080       
const JPEG_QUALITY        = cfg.JPEG_QUALITY || 70         
const API_TIMEOUT_MS      = cfg.API_TIMEOUT_MS || 15000
const DL_RETRY            = numOr(cfg.DOWNLOAD_RETRY, 2)           // 单张图重试次数（仅 429/5xx/超时）
const DL_RETRY_DELAY      = numOr(cfg.DOWNLOAD_RETRY_DELAY_MS, 1000) // 重试基础退避，指数增长
const DL_GAP_MS           = numOr(cfg.DOWNLOAD_GAP_MS, 250)        // 图间隔全局默认，各源可用 *_DOWNLOAD_GAP_MS 覆盖
const REFILL_BUDGET       = numOr(cfg.REFILL_BUDGET, 40)           // 单次 #woc 最多下载尝试次数（死链一直换图的安全上限）
const GROUP_RETRY         = numOr(cfg.GROUP_RETRY, 2)              // 整组全死链时，最多再换几组
const DEAD_STREAK         = numOr(cfg.DEAD_STREAK, 5)              // 连续几张死链就判定整组已失效，立刻放弃该组
const LIMIT_STREAK        = numOr(cfg.LIMIT_STREAK, 3)             // 连续几张被限流才放弃；单张 429 不代表整站都拿不到
const BYPASS_PHOTON       = cfg.BYPASS_PHOTON ?? true               // 把 i*.wp.com 代理链接还原成源站直链
const KUP_IMG_SIZE        = String(cfg.KUP_IMG_SIZE ?? 's0')        // 4kup 正文里是 400px 缩略图，s0=原图
const KHD_IMG_SIZE        = String(cfg.KHD_IMG_SIZE ?? 's0')        // 4khd 默认 w1300，s0=原图（注意 s1600 反而更小）
const CL_FULL_SIZE        = cfg.COSERLAB_FULL_SIZE ?? true          // coserlab 去掉 -scaled 取原图
const FAIL_LINK_ONLY_EMPTY= cfg.FAIL_LINK_ONLY_WHEN_EMPTY ?? true   // 只有一张图都没发出去时才发降级链接
const DROP_DEAD           = cfg.DROP_DEAD_IMAGES ?? true           // 死链直接剔除，不再降级发链接（链接本身也是死的）
const DEAD_STATUS         = listOr(cfg.DEAD_STATUS, [404, 410])    // 视为「永久失效」的状态码

// ---- 兜底 / R18 总开关 ----
const FALLBACK_ENABLE     = cfg.FALLBACK_ENABLE ?? true
const R18_ENABLE          = cfg.R18_ENABLE ?? false          // 关闭时只用各源的 cosplay 等非 R18 分类
const R18_PRIVATE_ONLY    = cfg.R18_PRIVATE_ONLY ?? true     // true：R18 分类只在私聊放开，群里自动降级回非 R18
const R18_RATE            = numOr(cfg.R18_RATE, 0.3)         // R18 允许时，本次真正走 R18 的概率（0~1）
const R18_PICK_ORDER      = String(cfg.R18_PICK_ORDER ?? 'random').toLowerCase()
const PICK_ORDER          = String(cfg.PICK_ORDER ?? 'random').toLowerCase()
                            // 一组图里怎么挑：random 随机 / reverse 倒序 / order 按原顺序

const SOURCE_ORDER        = (Array.isArray(cfg.SOURCE_ORDER) && cfg.SOURCE_ORDER.length)
                              ? cfg.SOURCE_ORDER.map(String)
                              : ['main', 'coserlab', 'mikagogo', '4khd', '4kup', 'bestgirlsexy']
const SOURCE_RANDOM       = String(cfg.SOURCE_PICK ?? 'random').toLowerCase() !== 'order'
const FAIL_COOLDOWN       = numOr(cfg.SOURCE_FAIL_COOLDOWN, 600)  // 某个源抓挂后冷却秒数，期间排到最后再试

// ---- 主站：shaonvzhi ----
const SNZ_BASE            = cfg.SNZ_BASE || 'https://shaonvzhi.top/wp-json/wp/v2'
const SNZ_GAP             = numOr(cfg.SNZ_DOWNLOAD_GAP_MS, DL_GAP_MS)

// ---- coserlab ----
const CL_ENABLE           = cfg.COSERLAB_ENABLE ?? true
const CL_BASE             = cfg.COSERLAB_BASE || 'https://coserlab.io/wp-json/wp/v2'
const CL_CATEGORIES       = listOr(cfg.COSERLAB_CATEGORIES, [1, 5])      // 1=cosplay 5=portrait
const CL_REFERER          = cfg.COSERLAB_REFERER || 'https://coserlab.io/'
const CL_POSTS_PER_PAGE   = cfg.COSERLAB_POSTS_PER_PAGE || 5
const CL_GAP              = numOr(cfg.COSERLAB_DOWNLOAD_GAP_MS, DL_GAP_MS)

// ---- mikagogo ----
const MK_ENABLE           = cfg.MIKAGOGO_ENABLE ?? true
const MK_BASE             = cfg.MIKAGOGO_BASE || 'https://mikagogo.com/wp-json/wp/v2'
const MK_CATEGORY         = cfg.MIKAGOGO_CATEGORY ?? 12                  // cosplay
const MK_POSTS_PER_PAGE   = cfg.MIKAGOGO_POSTS_PER_PAGE || 20
const MK_GAP              = numOr(cfg.MIKAGOGO_DOWNLOAD_GAP_MS, DL_GAP_MS)

// ---- 4khd（R18）----
const KHD_ENABLE          = cfg.KHD_ENABLE ?? true
const KHD_BASES           = arrOr(cfg.KHD_BASES, [
                              'https://www.4khd.com/wp-json/wp/v2',
                              'https://hecoq.uuss.uk/wp-json/wp/v2'      // 跳转站，主域被挡时顶上
                            ])
const KHD_CATEGORIES      = listOr(cfg.KHD_CATEGORIES, [4])              // 非 R18 档：4=cosplay
const KHD_CATEGORIES_R18  = listOr(cfg.KHD_CATEGORIES_R18, [3, 21, 9, 26]) // R18 档：3=photo 21=popular 9=misc 26=bare
const KHD_REFERER         = cfg.KHD_REFERER || 'https://www.4khd.com/'
const KHD_POSTS_PER_PAGE  = cfg.KHD_POSTS_PER_PAGE || 2
const KHD_GAP             = numOr(cfg.KHD_DOWNLOAD_GAP_MS, 800)   // i0.wp.com 限流紧，实测 800ms 才干净

// ---- 4kup ----
const KUP_ENABLE          = cfg.KUP_ENABLE ?? true
const KUP_BASE            = cfg.KUP_BASE || 'https://4kup.net/wp-json/wp/v2'
const KUP_CATEGORIES      = listOr(cfg.KUP_CATEGORIES, [2940, 10, 2939, 434, 2772])
                            // 2940=Coser 10=Chinese 2939=Asian 434=XIUREN 2772=Korean
const KUP_CATEGORIES_R18  = listOr(cfg.KUP_CATEGORIES_R18, [7064, 4524])
                            // 7064=内购无水印 4524=XR Uncensored
const KUP_EXCLUDE_CATS    = listOr(cfg.KUP_EXCLUDE_CATEGORIES,
                              [7253, 7295, 4450, 6780, 6723, 6649, 6648])
                            // AI 系分类，接口层直接 categories_exclude 掉
const KUP_REFERER         = cfg.KUP_REFERER || 'https://4kup.net/'
const KUP_POSTS_PER_PAGE  = cfg.KUP_POSTS_PER_PAGE || 3
const KUP_GAP             = numOr(cfg.KUP_DOWNLOAD_GAP_MS, DL_GAP_MS)

// ---- bestgirlsexy（R18）----
const BGS_ENABLE          = cfg.BGS_ENABLE ?? false                      // 源站当前 523 不可用，默认关
const BGS_BASES           = arrOr(cfg.BGS_BASES, ['https://bestgirlsexy.com/wp-json/wp/v2'])
const BGS_CATEGORIES      = listOr(cfg.BGS_CATEGORIES, [])               // 非 R18 档：cosplay 分类 ID（站点不可用，待补）
const BGS_CATEGORIES_R18  = listOr(cfg.BGS_CATEGORIES_R18, [])           // R18 档
const BGS_UNFILTERED_R18  = cfg.BGS_UNFILTERED_WHEN_R18 ?? true          // R18 开且上面都为空时，不带分类直接抓
const BGS_REFERER         = cfg.BGS_REFERER || 'https://bestgirlsexy.com/'
const BGS_POSTS_PER_PAGE  = cfg.BGS_POSTS_PER_PAGE || 3
const BGS_GAP             = numOr(cfg.BGS_DOWNLOAD_GAP_MS, DL_GAP_MS)
// ===================================================

const PIC_KEY = 'ys:woc:pic'

// R18 池和普通池分开存，避免私聊抓来的 R18 图被群聊那次请求消费掉
function picKey (r18) {
  return r18 ? `${PIC_KEY}:r18` : PIC_KEY
}

function isPrivateChat (e) {
  if (e?.isGroup === true) return false
  if (e?.group_id) return false
  if (e?.isPrivate === true) return true
  if (e?.message_type === 'private') return true
  return !!e?.friend && !e?.group
}

// 本次请求「允许」走 R18 分类吗（总开关 + 私聊限定）
function r18Allowed (e) {
  if (!R18_ENABLE) return false
  if (!R18_PRIVATE_ONLY) return true
  return isPrivateChat(e)
}

// 允许的前提下再掷一次骰子：R18_RATE 决定本次到底走不走 R18
function wantR18 (e) {
  if (!r18Allowed(e)) return false
  if (R18_RATE >= 1) return true
  if (R18_RATE <= 0) return false
  return Math.random() < R18_RATE
}

function numOr (v, def) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

function arrOr (v, def) {
  return (Array.isArray(v) && v.length) ? v : def
}

// 分类列表：允许显式配成空数组（空 = 该档没有可用分类）
function listOr (v, def) {
  return Array.isArray(v) ? v.map(Number).filter(n => !Number.isNaN(n)) : def
}

async function getSegment () {
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

async function loadSharp () {
  if (!USE_SHARP) return null
  try {
    const m = await import('sharp')
    return m.default || m
  } catch {
    Bot?.logger?.warn?.('[woc] 未找到 sharp，图片将不压缩直接 base64。')
    return null
  }
}

// ===================== 通用工具 =====================
async function fetchJson (url, { referer = '', timeoutMs = API_TIMEOUT_MS } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    if (referer) headers['Referer'] = referer

    const r = await fetch(url, { signal: ctl.signal, headers })
    const ct  = (r.headers.get('content-type') || '').toLowerCase()
    const raw = await r.text()

    if (!r.ok) throw new Error(`HTTP ${r.status} ct=${ct} head=${raw.slice(0, 120)}`)

    let j
    try {
      j = JSON.parse(raw)
    } catch {
      throw new Error(`接口非JSON ct=${ct} head=${raw.slice(0, 120)}`)
    }
    return { json: j, headers: r.headers }
  } finally {
    clearTimeout(t)
  }
}

function chunkArr (arr, size) {
  const out = []
  const n = Math.max(1, size)
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

function shuffleArr (arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 把各种失败翻译成人话，用于日志和降级提示
function describeErr (err) {
  if (err?.status === 429) return 'HTTP 429 限流'
  if (err?.status) return `HTTP ${err.status}`
  if (err?.name === 'AbortError') return '超时'
  const code = String(err?.cause?.code || err?.code || '')
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return '证书异常'
  if (code) return code
  return err?.message || String(err)
}

// 值得重试的：限流、请求超时、服务端错误
function isRetryable (status) {
  return status === 429 || status === 408 || status >= 500
}

function randInt (max) {
  return 1 + Math.floor(Math.random() * Math.max(1, Number(max) || 1))
}

function pickOne (arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// WordPress 的 Photon 图片代理（i0~i3.wp.com/<源站>/<路径>?w=...）经常对个别图返回 429，
// 且是按 URL 永久性的——换节点、等再久都一样，但源站直链是好的。实测源站 24/24，Photon 只有 16/24。
function bypassPhoton (u) {
  if (!BYPASS_PHOTON) return u
  const m = /^https?:\/\/i[0-3]\.wp\.com\/(.+)$/i.exec(u)
  if (!m) return u
  return 'https://' + m[1].split('?')[0]
}

// Google/Blogger 系图床（blogger.googleusercontent.com、pic.4khd.com）的路径里有个尺寸段，
// 形如 h600-e30 / w1300-rw / s1600；站点正文给的往往是缩略图，换成 s0 才是原图。
function rewriteGoogleSize (u, size) {
  if (!size) return u
  try {
    const url = new URL(u)
    const parts = url.pathname.split('/')
    const i = parts.length - 2                       // 尺寸段固定在文件名前一段
    if (i > 0 && /^[swh]\d+(-[A-Za-z0-9]+)?$/.test(parts[i])) {
      parts[i] = size
      url.pathname = parts.join('/')
      url.search = ''                                // 顺手去掉 ?w= 之类的缩放参数
      return url.toString()
    }
  } catch {}
  return u
}

// WordPress 上传超过阈值会生成 xxx-scaled.jpg，去掉后缀即原图
function stripWpScaled (u) {
  return u.replace(/-scaled(\.[A-Za-z0-9]+)(\?.*)?$/i, '$1')
}

// 从文章正文 HTML 里抠出图片直链（过滤主题/头像/表情等噪声）
function extractImgUrls (html) {
  if (typeof html !== 'string' || !html) return []
  const out = []
  const re = /<img[^>]+?(?:data-original|data-src|src)=["']([^"']+)["']/gi
  let m
  while ((m = re.exec(html))) {
    let u = (m[1] || '').trim()
    if (u.startsWith('//')) u = 'https:' + u
    if (!/^https?:\/\//i.test(u)) continue
    if (!/\.(jpe?g|png|webp|gif|bmp)(\?|$)/i.test(u)) continue
    if (/\/wp-content\/(themes|plugins)\//i.test(u)) continue
    if (/(gravatar|avatar|emoji|logo|icon|placeholder|loading|spacer|blank)/i.test(u)) continue
    out.push(bypassPhoton(u))
  }
  return Array.from(new Set(out))
}

// 总页数带 redis 缓存（12 小时）
async function cachedMaxPage (key, loader) {
  let v = await redis.get(key)
  if (!v) {
    v = await loader()
    await redis.set(key, String(v))
    await redis.expire(key, 43200)
  }
  return Number(v) || 20
}

// ===================== 图源工厂：WP 文章正文抠图 =====================
// 适用于「一篇文章内嵌整套图集」的站（coserlab / 4khd / bestgirlsexy）
function makeWpPostSource (opt) {
  const {
    key, name, bases, catsSfw = [], catsR18 = [], excludeCats = [], titleBlock = null,
    referer = '', gapMs = DL_GAP_MS, imgUpgrade = null,
    perPage = 5, useFields = true, enable = true, unfilteredWhenR18 = false
  } = opt

  const excludeQs = excludeCats.length ? `categories_exclude=${excludeCats.join(',')}&` : ''

  return {
    key, name, referer, gapMs, imgUpgrade, enable,

    // 两档互斥：r18=false 只用非 R18 分类；r18=true 只用 R18 分类，不掺 cosplay
    cats (r18) {
      return r18 ? catsR18.slice() : catsSfw.slice()
    },

    // 这一档没有任何分类可用时，本轮跳过这个源
    available (r18) {
      if (enable === false) return false
      if (this.cats(r18).length > 0) return true
      return !!r18 && unfilteredWhenR18
    },

    // 多域名依次尝试（主域被 WAF 挡了就换跳转站）
    async tryBases (path) {
      let lastErr = null
      for (const b of bases) {
        try {
          return await fetchJson(`${b}/${path}`, { referer })
        } catch (err) {
          lastErr = err
          Bot?.logger?.warn?.(`[woc] ${name} 域名 ${b} 失败：` + (err?.message || err))
        }
      }
      throw lastErr || new Error(`${name} 没有可用域名`)
    },

    catQs (cat) {
      return (cat != null ? `categories=${cat}&` : '') + excludeQs
    },

    async maxPage (cat) {
      return cachedMaxPage(`ys:woc:${key}:max_page:${cat ?? 'all'}`, async () => {
        try {
          // 探页数只要 id，_fields=id 各站都放行
          const { headers } = await this.tryBases(
            `posts?${this.catQs(cat)}per_page=${perPage}&page=1&_fields=id`
          )
          const tp = Number(headers.get('x-wp-totalpages'))
          if (tp > 0) return tp
        } catch (e) {
          Bot?.logger?.warn?.(`[woc] ${name} 获取总页数失败，用默认值：` + (e?.message || e))
        }
        return 20
      })
    },

    async page (p, cat) {
      // 注意：4khd 的 WAF 会拦截带 content 的 _fields，所以 useFields=false 时整个不带
      const fields = useFields ? '&_fields=id,title,content' : ''
      const { json: posts } = await this.tryBases(
        `posts?${this.catQs(cat)}per_page=${perPage}&page=${p}${fields}`
      )
      if (!Array.isArray(posts) || posts.length === 0) throw new Error(`${name} 文章列表为空`)

      const groups = []
      let blocked = 0
      for (const post of posts) {
        // 兜一层标题过滤：接口分类没标全的 AI 图在这里再拦一次
        const title = String(post?.title?.rendered || '')
        if (titleBlock && titleBlock.test(title)) { blocked++; continue }
        const urls = extractImgUrls(post?.content?.rendered)
        if (urls.length) groups.push(urls)
      }
      if (blocked) Bot?.logger?.mark?.(`[woc] ${name} 本页按标题拦掉 ${blocked} 篇`)
      const tag = cat != null ? ` 分类 ${cat}` : ''
      if (groups.length === 0) throw new Error(`${name}${tag} 第 ${p} 页没抠到图片`)

      Bot?.logger?.mark?.(`[woc] ${name}${tag} 第 ${p} 页，取到 ${groups.length} 组`)
      return shuffleArr(groups)
    }
  }
}

// ===================== 图源①：主站 shaonvzhi =====================
const srcShaonvzhi = {
  key: 'main',
  name: '主站 shaonvzhi',
  referer: '',
  gapMs: SNZ_GAP,
  enable: true,
  available (r18) { return !r18 && this.enable !== false },   // 没有 R18 分类，R18 轮次不参与
  cats () { return [] },

  async maxPage () {
    return cachedMaxPage('ys:woc:max_page', async () => {
      try {
        const { headers } = await fetchJson(`${SNZ_BASE}/media?media_type=image&per_page=100&_fields=id`)
        const tp = Number(headers.get('x-wp-totalpages'))
        if (tp > 0) {
          Bot?.logger?.mark?.(`[woc] 成功获取目标网站总页数：${tp} 页`)
          return tp
        }
      } catch (e) {
        Bot?.logger?.warn?.('[woc] 获取总页数失败，使用默认值: ' + (e?.message || e))
      }
      return 20
    })
  },

  async page (p) {
    const api =
      `${SNZ_BASE}/media` +
      `?media_type=image&per_page=100&page=${p}` +
      `&_fields=source_url,post,mime_type`

    const { json: j } = await fetchJson(api)

    if (!Array.isArray(j)) {
      const code = j?.code ? `code=${j.code}` : ''
      const msg  = j?.message ? `msg=${j.message}` : ''
      throw new Error(`媒体接口返回非数组 ${code} ${msg}`.trim())
    }

    // 同一篇文章的图片归为一组
    const byPost = new Map()
    for (const it of j) {
      const url = it?.source_url
      if (!url) continue
      const pid = Number(it?.post || 0)
      if (pid <= 0) continue
      const k = String(pid)
      if (!byPost.has(k)) byPost.set(k, [])
      byPost.get(k).push(url)
    }

    let urlsArr = Array.from(byPost.values()).map(arr => Array.from(new Set(arr)))

    if (urlsArr.length === 0) {
      const all = Array.from(new Set(j.map(x => x?.source_url).filter(Boolean)))
      if (all.length) urlsArr = [all]
    }

    return urlsArr
  }
}

// ===================== 图源②：coserlab =====================
const srcCoserlab = makeWpPostSource({
  key: 'coserlab',
  name: 'coserlab',
  bases: [CL_BASE],
  catsSfw: CL_CATEGORIES,
  referer: CL_REFERER,
  gapMs: CL_GAP,
  imgUpgrade: u => (CL_FULL_SIZE ? stripWpScaled(u) : u),
  perPage: CL_POSTS_PER_PAGE,
  useFields: true,
  enable: CL_ENABLE
})

// ===================== 图源③：mikagogo =====================
// 正文有图就按文章分组；正文没图则退回媒体库（用 parent[] 批量取文章封面）
const srcMikagogo = {
  key: 'mikagogo',
  name: 'mikagogo',
  referer: '',
  gapMs: MK_GAP,
  enable: MK_ENABLE,
  available (r18) { return !r18 && this.enable !== false },   // 同上
  cats () { return [] },

  async maxPage () {
    return cachedMaxPage('ys:woc:mk:max_page', async () => {
      try {
        const { headers } = await fetchJson(
          `${MK_BASE}/posts?categories=${MK_CATEGORY}&per_page=${MK_POSTS_PER_PAGE}&page=1&_fields=id`
        )
        const tp = Number(headers.get('x-wp-totalpages'))
        if (tp > 0) return tp
      } catch (e) {
        Bot?.logger?.warn?.('[woc] mikagogo 获取总页数失败，用默认值：' + (e?.message || e))
      }
      return 20
    })
  },

  async page (p) {
    const { json: posts } = await fetchJson(
      `${MK_BASE}/posts?categories=${MK_CATEGORY}&per_page=${MK_POSTS_PER_PAGE}&page=${p}&_fields=id,content`
    )
    if (!Array.isArray(posts) || posts.length === 0) throw new Error('mikagogo 文章列表为空')

    const groups = []
    for (const post of posts) {
      const urls = extractImgUrls(post?.content?.rendered)
      if (urls.length) groups.push(urls)
    }
    if (groups.length) return shuffleArr(groups)

    // 正文没图（该站部分 COSPLAY 文章是纯文字动态），退回媒体库取这些文章挂载的图
    const ids = posts.map(x => Number(x?.id)).filter(n => n > 0)
    if (ids.length === 0) throw new Error('mikagogo 未取到文章 ID')

    const q = ids.map(id => `parent%5B%5D=${id}`).join('&')
    const { json: media } = await fetchJson(
      `${MK_BASE}/media?media_type=image&per_page=100&${q}&_fields=source_url,post`
    )

    const urls = Array.from(new Set(
      (Array.isArray(media) ? media : [])
        .map(m => m?.source_url)
        .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
    ))
    if (urls.length === 0) throw new Error(`mikagogo 分类 ${MK_CATEGORY} 第 ${p} 页没有可用图片`)

    return chunkArr(shuffleArr(urls), MAX_TOTAL)
  }
}

// ===================== 图源④：4khd =====================
// cosplay 分类不受 R18 开关限制；photo/popular/misc/bare 只在 R18 打开时才接进来。
// 该站 WAF 会拦 _fields 里带 content 的请求，所以 useFields=false（拿全字段）
const src4khd = makeWpPostSource({
  key: '4khd',
  name: '4khd',
  bases: KHD_BASES,
  catsSfw: KHD_CATEGORIES,
  catsR18: KHD_CATEGORIES_R18,
  referer: KHD_REFERER,
  gapMs: KHD_GAP,
  imgUpgrade: u => rewriteGoogleSize(u, KHD_IMG_SIZE),
  perPage: KHD_POSTS_PER_PAGE,
  useFields: false,
  enable: KHD_ENABLE
})

// ===================== 图源⑤：4kup =====================
// AI 系分类在接口层用 categories_exclude 排掉，再加一道标题正则兜底
const src4kup = makeWpPostSource({
  key: '4kup',
  name: '4kup',
  bases: [KUP_BASE],
  catsSfw: KUP_CATEGORIES,
  catsR18: KUP_CATEGORIES_R18,
  excludeCats: KUP_EXCLUDE_CATS,
  titleBlock: /\bAI\b|AIGirl|AIgirls|AIPD|AI\s*Generated|AI\s*girls|AI\s*Enhanced/,
  referer: KUP_REFERER,
  gapMs: KUP_GAP,
  imgUpgrade: u => rewriteGoogleSize(u, KUP_IMG_SIZE),
  perPage: KUP_POSTS_PER_PAGE,
  useFields: true,
  enable: KUP_ENABLE
})

// ===================== 图源⑥：bestgirlsexy =====================
// 源站当前 523 打不开，分类 ID 摸不到：BGS_CATEGORIES 填上 cosplay 的 ID 后，
// 它就和 4khd 一样不受 R18 开关限制；不填则只有 R18 打开时才会不带分类去抓。
const srcBestgirlsexy = makeWpPostSource({
  key: 'bestgirlsexy',
  name: 'bestgirlsexy',
  bases: BGS_BASES,
  catsSfw: BGS_CATEGORIES,
  catsR18: BGS_CATEGORIES_R18,
  referer: BGS_REFERER,
  gapMs: BGS_GAP,
  perPage: BGS_POSTS_PER_PAGE,
  useFields: true,
  enable: BGS_ENABLE,
  unfilteredWhenR18: BGS_UNFILTERED_R18
})

const ALL_SOURCES = [srcShaonvzhi, srcCoserlab, srcMikagogo, src4khd, src4kup, srcBestgirlsexy]

// 按 yaml 里的 SOURCE_ORDER 排序，并过滤掉禁用 / R18 关闭时的 r18 源
// 候选图源：SOURCE_ORDER 里列了、没被禁用、且这一档有分类可用的
function candidateSources (r18) {
  const byKey = new Map(ALL_SOURCES.map(s => [s.key, s]))
  const list = []
  for (const k of SOURCE_ORDER) {
    const s = byKey.get(k)
    if (!s || list.includes(s)) continue
    if (typeof s.available === 'function' ? !s.available(r18) : s.enable === false) continue
    list.push(s)
  }
  if (list.length === 0) list.push(srcShaonvzhi)
  return list
}

// 抓挂过的源冷却一段时间：不丢掉，只排到最后，避免全挂时一个源都不剩
const failKey = k => `ys:woc:fail:${k}`

async function isCooling (src) {
  if (FAIL_COOLDOWN <= 0) return false
  try { return !!(await redis.get(failKey(src.key))) } catch { return false }
}

async function markFail (src) {
  if (FAIL_COOLDOWN <= 0) return
  try {
    await redis.set(failKey(src.key), '1')
    await redis.expire(failKey(src.key), FAIL_COOLDOWN)
  } catch {}
}

async function clearFail (src) {
  try {
    if (typeof redis.del === 'function') await redis.del(failKey(src.key))
    else await redis.expire(failKey(src.key), 1)
  } catch {}
}

// 本次尝试顺序：随机打乱，冷却中的排最后
async function pickOrder (r18) {
  const all = candidateSources(r18)
  if (!SOURCE_RANDOM) return all

  const hot = []
  const cold = []
  for (const s of all) {
    if (await isCooling(s)) cold.push(s)
    else hot.push(s)
  }
  return shuffleArr(hot).concat(shuffleArr(cold))
}

async function fetchFromSource (src, r18) {
  const cats = typeof src.cats === 'function' ? src.cats(r18) : []
  const cat  = cats.length ? pickOne(cats) : null
  const maxPage = await src.maxPage(cat)
  const p = randInt(maxPage)
  try {
    return await src.page(p, cat)
  } catch (err) {
    Bot?.logger?.warn?.(`[woc] ${src.name} 第 ${p} 页失败，降级抓第 1 页：` + (err?.message || err))
    return await src.page(1, cat)
  }
}

// 随机挑一个源开抓，挂了就换下一个，返回 { source, referer, r18, groups }
async function buildPool (r18) {
  let order = await pickOrder(r18)
  if (!FALLBACK_ENABLE) order = order.slice(0, 1)   // 关掉「换源」时只试一个

  Bot?.logger?.mark?.(
    `[woc] 本次尝试顺序（${SOURCE_RANDOM ? '随机' : '固定'}）：${order.map(s => s.name).join(' -> ')}` +
    `（R18 分类 ${r18 ? '放开' : '关闭'}）`
  )

  let lastErr = null
  for (const src of order) {
    try {
      const groups = await fetchFromSource(src, r18)
      if (Array.isArray(groups) && groups.length) {
        await clearFail(src)
        Bot?.logger?.mark?.(`[woc] 本次图源：${src.name}，共 ${groups.length} 组`)
        return {
          source: src.name, key: src.key, referer: src.referer || '',
          gapMs: numOr(src.gapMs, DL_GAP_MS), r18: !!r18, groups
        }
      }
      lastErr = new Error(`${src.name} 没有可用分组`)
    } catch (err) {
      lastErr = err
    }
    await markFail(src)
    Bot?.logger?.warn?.(`[woc] ${src.name} 抓取失败，换一个源：` + (lastErr?.message || lastErr))
  }

  throw lastErr || new Error('所有图源均不可用')
}

async function loadPool (r18) {
  const raw = await redis.get(picKey(r18))
  if (!raw) return null
  let d
  try { d = JSON.parse(raw) } catch { return null }
  // 兼容旧缓存（纯数组）
  if (Array.isArray(d)) d = { source: '主站 shaonvzhi', key: 'main', referer: '', gapMs: SNZ_GAP, r18: false, groups: d }
  if (!Array.isArray(d?.groups)) return null
  // 保险：R18 池绝不喂给不允许 R18 的场合
  if (d.r18 && !r18) return null

  // 缓存池的源可能已被改配置移出清单（改 SOURCE_ORDER / 禁用 / 不再服务这一档），
  // 这种池必须丢掉重抓，否则改完配置要等旧池耗尽才生效
  const live = candidateSources(r18).some(x => (d.key ? x.key === d.key : x.name === d.source))
  if (!live) {
    Bot?.logger?.warn?.(`[woc] 缓存池来自「${d.source}」，已不在当前图源清单内，丢弃并重抓`)
    return null
  }
  return d
}

async function savePool (pool) {
  await redis.set(picKey(pool.r18), JSON.stringify(pool))
}

// ===================== 下载 / 编码 / 发送 =====================
async function fetchOnce (url, referer, timeoutMs) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0' }
    if (referer) headers['Referer'] = referer
    const r = await fetch(url, { signal: ctl.signal, headers })
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`)
      err.status = r.status
      err.retryAfter = Number(r.headers.get('retry-after')) || 0
      throw err
    }
    return await r.arrayBuffer()
  } finally {
    clearTimeout(t)
  }
}

async function fetchArrayBuffer (url, referer = '', timeoutMs = FETCH_TIMEOUT_MS) {
  let lastErr = null
  for (let i = 0; i <= DL_RETRY; i++) {
    try {
      return await fetchOnce(url, referer, timeoutMs)
    } catch (err) {
      lastErr = err
      // 404/403 这类重试也没用，直接放弃
      if (err?.status && !isRetryable(err.status)) break
      if (i >= DL_RETRY) break

      // 服务端给了 Retry-After 就听它的，否则指数退避 + 抖动
      const wait = err?.retryAfter > 0
        ? Math.min(err.retryAfter * 1000, 10000)
        : Math.round(DL_RETRY_DELAY * Math.pow(2, i) * (0.8 + Math.random() * 0.4))

      Bot?.logger?.warn?.(`[woc] 下载失败（${describeErr(err)}），${wait}ms 后重试 ${i + 1}/${DL_RETRY}`)
      await sleep(wait)
    }
  }
  throw lastErr
}

async function toBase64DataURL (sharpLib, arrBuf) {
  try {
    if (sharpLib) {
      const out = await sharpLib(Buffer.from(arrBuf))
        .resize({ width: JPEG_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer()
      return `base64://${out.toString('base64')}`
    } else {
      return `base64://${Buffer.from(arrBuf).toString('base64')}`
    }
  } catch (e) {
    Bot?.logger?.warn?.('[woc] 压缩/编码失败：' + (e?.message || e))
    return null
  }
}

// 从候选队列里一张张取，直到凑够 want 张或队列耗尽。
// 死链（404/410）静默跳过继续换下一张；限流/超时则记下来，后面发链接。
async function collectImages (queue, want, referer, gapMs, sharpLib, upgrade = null) {
  const refs = []
  const linkFails = []
  let dropped = 0
  let tried = 0
  let streak = 0        // 连续死链计数
  let limited = 0       // 连续被限流计数

  while (refs.length < want && queue.length && tried < REFILL_BUDGET) {
    const raw = queue.shift()
    tried++

    // 站点正文给的常是缩略图，先试改写后的大图，挂了再退回原链接
    const big = upgrade ? upgrade(raw) : raw
    const tryUrls = big !== raw ? [big, raw] : [raw]

    let u = raw
    let ref = null
    let why = ''
    let status = 0
    for (let k = 0; k < tryUrls.length; k++) {
      u = tryUrls[k]
      why = ''
      status = 0
      try {
        const arr = await fetchArrayBuffer(u, referer)
        ref = await toBase64DataURL(sharpLib, arr)
        if (!ref) why = '解码/压缩失败'
      } catch (err) {
        why = describeErr(err)
        status = Number(err?.status) || 0
      }
      if (ref) break
      if (k < tryUrls.length - 1) {
        Bot?.logger?.warn?.(`[woc] 大图取失败（${why}），退回原尺寸：${raw}`)
      } else {
        Bot?.logger?.warn?.(`[woc] 拉取失败（${why}）：${u}`)
      }
    }

    if (ref) {
      refs.push(ref)
      streak = 0
      limited = 0
    } else if (DROP_DEAD && DEAD_STATUS.includes(status)) {
      dropped++
      streak++
      Bot?.logger?.warn?.(`[woc] 已失效（HTTP ${status}），跳过换下一张：${u}`)
      // 图集是整套传的，连着几张都没了基本就是整组被删，别把剩下几十张全试一遍
      if (DEAD_STREAK > 0 && streak >= DEAD_STREAK) {
        Bot?.logger?.warn?.(`[woc] 连续 ${streak} 张失效，判定该组已整体失效，提前放弃`)
        break
      }
    } else {
      // 非死链：URL 还是活的，留着发链接
      linkFails.push({ url: u, why })

      // 429：单张被限流不代表下一张也拿不到（重试已经等过几秒了），
      // 连续挨限流才说明整站真的在拦，那时候再停，免得火上浇油
      if (status === 429) {
        limited++
        if (LIMIT_STREAK > 0 && limited >= LIMIT_STREAK) {
          Bot?.logger?.warn?.(`[woc] 连续 ${limited} 张被限流，停止继续拉取`)
          break
        }
      } else {
        limited = 0
      }
    }

    if (gapMs > 0 && refs.length < want && queue.length) await sleep(gapMs)
  }

  if (tried >= REFILL_BUDGET) Bot?.logger?.warn?.(`[woc] 已达单次下载上限 ${REFILL_BUDGET} 次，停止换图`)
  return { refs, linkFails, dropped, tried }
}

async function sendForward (e, ctx, nodesOB, nodesIcqq) {
  if (PREFER_ICQQ_FORWARD && typeof ctx.makeForwardMsg === 'function') {
    const msg = await ctx.makeForwardMsg(nodesIcqq)
    if (typeof ctx.sendMsg === 'function') return await ctx.sendMsg(msg)
    return await e.reply(msg)
  }
  if (Array.isArray(nodesOB) && nodesOB.length > 0 && typeof ctx.sendForwardMsg === 'function') {
    return await ctx.sendForwardMsg(nodesOB)
  }
  for (const n of nodesOB) {
    if (typeof ctx.sendMsg === 'function') {
      await ctx.sendMsg(n.data.content)
    } else {
      await e.reply(n.data.content)
    }
    await new Promise(r => setTimeout(r, 800))
  }
}

function buildNodes (refs, batchIndex, batchCount, seg, uin, name) {
  const nodesOB = []
  const nodesIcqq = []
  for (let j = 0; j < refs.length; j++) {
    const ref = refs[j] 
    try {
      const imgSeg = seg.image(ref)
      const content = [
        `批次 ${batchIndex} / ${batchCount} - 第 ${j + 1} 张`,
        imgSeg
      ]
      nodesOB.push({ type: 'node', data: { name, uin, content } })
      nodesIcqq.push({ user_id: uin, nickname: name, message: content })
    } catch (e) {
      Bot?.logger?.warn?.(`[woc] segment.image 失败，跳过: ${e?.message || e}`)
    }
  }
  return { nodesOB, nodesIcqq }
}

export class example extends plugin {
  constructor () {
    super({
      name: 'ys-woc-Reborn',
      dsc: 'WP抓图→分批合并转发（强制base64 & 优先icqq，多图源自动兜底）',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?(?:[Ww][Oo][Cc]|卧槽)(?:$|\\s|[，。,.!?！？])', fnc: 'woc' }
      ]
    })
  }

  async woc (e) {
    try {
      const seg = await getSegment()

      let r18 = wantR18(e)
      if (r18 && candidateSources(true).length === 0) {
        Bot?.logger?.warn?.('[woc] 本次掷中 R18，但没有配了 R18 分类的可用图源，降级走非 R18')
        r18 = false
      }
      if (R18_ENABLE && !r18) {
        Bot?.logger?.mark?.(
          r18Allowed(e)
            ? `[woc] 本次未命中 R18（概率 ${R18_RATE}），走非 R18 分类`
            : '[woc] 群聊场景，R18 分类已自动降级为非 R18'
        )
      }

      let pool = await loadPool(r18)
      if (!pool || pool.groups.length === 0) {
        await e.reply('本小姐补魔中，一会就好！')
        try {
          pool = await buildPool(r18)
        } catch (err) {
          Bot?.logger?.error?.('[woc] 所有图源均失败: ' + (err?.stack || err))
          return e.reply('本小姐没有可用的资源，稍后再试~')
        }
      }

      const referer   = pool.referer || ''
      const gapMs     = numOr(pool.gapMs, DL_GAP_MS)   // 各源图床脾气不同，间隔按源走
      const pickOrder = pool.r18 ? R18_PICK_ORDER : PICK_ORDER

      const ctx = e.group || e.friend
      if (!ctx) return e.reply('不支持的会话类型')

      const sharpLib = await loadSharp()

      // 一直换图、必要时换组，直到真凑出图为止
      let refs = []
      let linkFails = []
      let dropped = 0
      let hosts = []

      for (let round = 0; round <= GROUP_RETRY; round++) {
        const group = pool.groups.shift()
        await savePool(pool)
        if (!group) break

        let queue = Array.from(new Set(group)).filter(u => /^https?:\/\//i.test(u))
        if (queue.length === 0) continue

        // 不总是取图集开头那几张（开头往往最平淡）
        if (queue.length > MAX_TOTAL) {
          if (pickOrder === 'random') queue = shuffleArr(queue)
          else if (pickOrder === 'reverse') queue = queue.slice().reverse()
        }

        try {
          hosts = Array.from(new Set(queue.slice(0, MAX_TOTAL).map(u => {
            try { return new URL(u).host } catch { return 'bad' }
          })))
        } catch {}

        const upgrade = ALL_SOURCES.find(x => x.key === pool.key)?.imgUpgrade || null
        const got = await collectImages(queue, MAX_TOTAL, referer, gapMs, sharpLib, upgrade)
        refs = got.refs
        linkFails = got.linkFails
        dropped += got.dropped

        if (refs.length > 0) break

        // 一张都没凑出来：如果是整组死链且池里还有下一组，换组再来
        if (got.dropped > 0 && pool.groups.length > 0) {
          Bot?.logger?.warn?.(`[woc] 整组 ${got.dropped} 张全失效，换下一组重试（第 ${round + 1} 轮）`)
          continue
        }
        break
      }

      if (refs.length === 0) {
        for (const f of linkFails) {
          await e.reply(`拉取失败（${f.why}），改为链接：${f.url}`)
          await sleep(500)
        }
        if (linkFails.length > 0) return
        return e.reply(dropped > 0 ? '连着几组图都失效了，再来一次~' : '这组没有有效图片，换一组吧~')
      }

      Bot?.logger?.warn?.(`[woc] 图源 ${pool.source}，本批图片域名：` + hosts.join(', '))
      await e.reply(`本小姐共找来 ${refs.length} 张（将分批发送）`)

      const uin  = String(e.member?.user_id ?? Bot.uin)
      const name = e.member?.nickname ?? (Bot.nickname || 'Yunzai')
      const batchCount = Math.ceil(refs.length / BATCH_SIZE)

      for (let i = 0; i < refs.length; i += BATCH_SIZE) {
        const batchRefs = refs.slice(i, i + BATCH_SIZE)
        const { nodesOB, nodesIcqq } = buildNodes(
          batchRefs, Math.floor(i / BATCH_SIZE) + 1, batchCount, seg, uin, name
        )

        let sent = false
        try {
          await sendForward(e, ctx, nodesOB, nodesIcqq)
          sent = true
        } catch (err) {
          Bot?.logger?.warn?.('本小姐合并转发失败，准备重试：' + (err?.message || err))
          await sleep(1200)
          try {
            await sendForward(e, ctx, nodesOB, nodesIcqq)
            sent = true
          } catch (err2) {
            Bot?.logger?.error?.('本小姐重试仍失败，降级为逐条图。')
            for (const n of nodesOB) {
              if (typeof ctx.sendMsg === 'function') await ctx.sendMsg(n.data.content)
              else await e.reply(n.data.content)
              await sleep(800)
            }
            sent = true
          }
        }
        if (!sent) await e.reply('这一批图片发送失败了~')

        if (i + BATCH_SIZE < refs.length) await sleep(DELAY_MS)
      }

      // 已经凑够图了，中途那些失败纯属内部噪音，记日志就行，别再发一堆打不开的链接
      if (FAIL_LINK_ONLY_EMPTY || refs.length >= MAX_TOTAL) {
        if (linkFails.length) {
          Bot?.logger?.mark?.(`[woc] 已发满 ${refs.length} 张，另有 ${linkFails.length} 张中途失败（不打扰用户）`)
        }
      } else {
        for (const f of linkFails) {
          await e.reply(`有 1 张拉取失败（${f.why}），改为链接：${f.url}`)
          await sleep(500)
        }
      }

      if (dropped > 0) {
        Bot?.logger?.mark?.(`[woc] 本次剔除 ${dropped} 张死链，实发 ${refs.length} 张`)
      }
    } catch (err) {
      Bot?.logger?.error?.('[woc] 发送失败: ' + (err?.stack || err))
      await e.reply('本小姐被风控/超时绊了一跤，等会儿再来~')
    }
  }
}

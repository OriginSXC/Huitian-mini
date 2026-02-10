/**
 * xjj-bot-Ultimate (稳定版)
 * - 保留“同类同批”
 * - 强制 Base64（可选 sharp 压缩）
 * - 取 URL：限并发 + 分波次补齐（解决 >3 张就“图图不够啦”）
 * - keep-alive：减少 443 连接风暴
 * - 合并转发失败：自动降级逐张发送
 */

import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import http from 'http'
import https from 'https'
import sharp from 'sharp' // 直接引用你刚才装的依赖！

// ================= 配置区域 =================
const BATCH_SIZE        = 3             // 每批合并转发张数（建议 3，更稳）
const IMG_COUNT_MIN     = 3
const IMG_COUNT_MAX     = 5

const USE_SHARP         = true
const SHARP_QUALITY     = 70
const SHARP_WIDTH       = 1080

const FETCH_TIMEOUT     = 8000
const DOWNLOAD_TIMEOUT  = 15000

// 取图 URL 的并发与重试（关键）
const API_WAVE_CONCURRENCY = 2          // 每波并发（你说 >3 就炸，先用 2）
const API_MAX_TRIES_FACTOR = 6          // 最多尝试 need*6 次（不足会提前返回）
const API_WAVE_SLEEP_MIN   = 200
const API_WAVE_SLEEP_MAX   = 450

// 正常浏览器 UA（不要用 Googlebot/bingbot/蜘蛛 UA）

//  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
//  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/123.0.0.0 Safari/537.36',
//  'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
//  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const USER_AGENT_LIST = [  
  'Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile Safari/10600.6.3 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (iPhone;CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
]

// API 地址（保持你的原版）
const API_CLASS    = 'https://www.onexiaolaji.cn/RandomPicture/api/?key=qq249663924&type=class'
const API_IMG_BASE = 'https://www.onexiaolaji.cn/RandomPicture/api/?key=qq249663924'
const API_VIDEO    = 'https://api.kuleu.com/api/MP4_xiaojiejie?type=json'
// ===========================================


// =============== keep-alive Agent（减少 443 连接风暴） ===============
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
const pickAgent = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent)

// =============== 工具函数 ===============
async function getSegment() {
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pickUA = () => USER_AGENT_LIST[randInt(0, USER_AGENT_LIST.length - 1)]
const cacheBuster = () => `${Date.now()}_${Math.random().toString(16).slice(2)}`

// 通用：fetch JSON（AbortController + keep-alive + content-type 校验）
async function fetchJson(url, timeoutMs = FETCH_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      agent: pickAgent(url),
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'Cache-Control': 'no-cache'
      }
    })

    if (!res.ok) return null

    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('application/json')) return null

    const data = await res.json()
    // 有些时候接口会返回 msg: “这会儿小姐姐图图不够啦”
    if (data && typeof data.msg === 'string') {
      Bot?.logger?.warn?.(`[xjj] API msg: ${data.msg}`)
    }
    return data
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// fetch binary buffer（AbortController + keep-alive）
async function fetchBuffer(url, timeoutMs = DOWNLOAD_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      agent: pickAgent(url),
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'Cache-Control': 'no-cache'
      }
    })
    if (!res.ok) return null

    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// [核心] URL -> base64:// （带 Sharp 压缩）
async function urlToBase64(url) {
  if (!url) return null

  try {
    let buffer = await fetchBuffer(url, DOWNLOAD_TIMEOUT)
    if (!buffer) return null

    if (USE_SHARP) {
      try {
        const sharp = (await import('sharp')).default
        buffer = await sharp(buffer)
          .rotate()
          .resize({ width: SHARP_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: SHARP_QUALITY })
          .toBuffer()
      } catch {
        // 没装 sharp 或压缩失败就直接用原图 buffer
      }
    }

    return `base64://${buffer.toString('base64')}`
  } catch {
    return null
  }
}

// 取图 URL：限并发 + 分波次补齐到 need（避免 Promise.all 直接打爆）
async function collectUniqueImgUrls({ need, typeParam }) {
  const urls = new Set()
  let tries = 0
  const maxTries = Math.max(need * API_MAX_TRIES_FACTOR, 12)

  while (urls.size < need && tries < maxTries) {
    const wave = Math.min(API_WAVE_CONCURRENCY, maxTries - tries)

    const tasks = Array.from({ length: wave }).map(() =>
      fetchJson(`${API_IMG_BASE}&class=${typeParam}&type=json&_=${cacheBuster()}`)
    )

    const results = await Promise.all(tasks)

    for (const r of results) {
      const u = r?.url || r?.img
      if (typeof u === 'string' && u.startsWith('http')) urls.add(u)
    }

    tries += wave

    if (urls.size < need) {
      await sleep(randInt(API_WAVE_SLEEP_MIN, API_WAVE_SLEEP_MAX))
    }
  }

  return Array.from(urls).slice(0, need)
}


// ================= 插件主体 =================
export class xjjUltimate extends plugin {
  constructor() {
    super({
      name: '小姐姐-极速完整版(稳定)',
      dsc: '分类准确+Base64秒发(限并发补齐+keepalive)',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: /^#?(小姐姐|xjj)$/, fnc: 'xjj' },
        { reg: /^#?((小姐姐|xjj)视频|xjjpro)$/, fnc: 'xjjVideo' }
      ]
    })
  }

  /**
   * 获取分类列表（Redis 缓存）
   */
  async getClassList() {
    const cacheKey = 'ys:xjj:classes'
    const cached = await redis.get(cacheKey)
    if (cached) {
      try { return JSON.parse(cached) } catch {}
    }

    Bot?.logger?.mark?.('[xjj] 正在更新分类缓存...')
    const data = await fetchJson(API_CLASS)
    if (!data || !data.class) return null

    const leaves = []
    const traverse = (node) => {
      if (typeof node !== 'object' || !node) return
      for (const [k, v] of Object.entries(node)) {
        if (['bing', 'video', '10', 'ad', 'author', 'Latest update time'].includes(k)) continue
        if (typeof v === 'string') {
          if (/^\d+$/.test(k)) leaves.push({ id: k, name: v })
        } else if (typeof v === 'object') {
          traverse(v)
        }
      }
    }
    traverse(data.class)

    if (leaves.length > 0) {
      await redis.set(cacheKey, JSON.stringify(leaves), { EX: 3600 })
    }
    return leaves
  }

  async xjj(e) {
    const classes = await this.getClassList()
    if (!classes || classes.length === 0) return e.reply('图片分类加载失败，请稍后再试。')

    const pick = classes[randInt(0, classes.length - 1)]
    const suffix = Math.random() < 0.5 ? 'p' : 'm'
    const typeParam = pick.id + suffix
    const count = randInt(IMG_COUNT_MIN, IMG_COUNT_MAX)

    await e.reply(`本小姐正在挑选 ${count} 张 [${pick.name}] 美图...`)

    // 1) 取 URL（限并发+补齐）
    const uniqueUrls = await collectUniqueImgUrls({ need: count, typeParam })
    if (uniqueUrls.length < Math.min(count, IMG_COUNT_MIN)) {
      return e.reply('这会儿小姐姐图图不够啦~ 稍后再试吧（接口限速/资源不足）')
    }

    // 2) Base64 转换 + 合并转发分批发送
    const seg = await getSegment()
    const uin = e.member?.user_id ?? Bot.uin
    const nick = e.member?.nickname ?? Bot.nickname
    const title = `${nick}｜${pick.name}精选`

    for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
      const batchUrls = uniqueUrls.slice(i, i + BATCH_SIZE)

      // 并发转换（用 allSettled 防止单个失败拖垮整批）
      const settled = await Promise.allSettled(batchUrls.map(u => urlToBase64(u)))
      const validBase64 = settled
        .filter(x => x.status === 'fulfilled' && x.value)
        .map(x => x.value)

      if (validBase64.length === 0) continue

      const nodes = validBase64.map((b64, idx) => ({
        user_id: uin,
        nickname: title,
        message: [
          `第 ${i + idx + 1} 张`,
          seg.image(b64)
        ]
      }))

      try {
        const makeFunc = e.group?.makeForwardMsg || e.friend?.makeForwardMsg
        if (makeFunc) {
          const msg = await makeFunc.call(e.group || e.friend, nodes)
          await e.reply(msg)
        } else {
          for (const node of nodes) await e.reply(node.message)
        }
      } catch (err) {
        Bot?.logger?.error?.(`[xjj] 合并转发失败，降级逐张发送: ${err?.message || err}`)
        for (const node of nodes) {
          try { await e.reply(node.message) } catch {}
        }
      }

      if (i + BATCH_SIZE < uniqueUrls.length) {
        await sleep(1000) // 防乱序/风控
      }
    }

    return true
  }

  async xjjVideo(e) {
    const seg = await getSegment()
    try {
      const res = await fetchJson(API_VIDEO)
      if (res && res.mp4_video) {
        // 视频体积大，不建议 base64
        await e.reply([seg.video(res.mp4_video)])
      } else {
        await e.reply('视频接口暂时没数据~')
      }
    } catch {
      await e.reply('视频获取出错了')
    }
    return true
  }
}

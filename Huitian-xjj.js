import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import http from 'http'
import https from 'https'
import sharp from 'sharp' 
import Config from './config/config.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('xjj')

const BATCH_SIZE           = cfg.BATCH_SIZE || 3             
const IMG_COUNT_MIN        = cfg.IMG_COUNT_MIN || 3
const IMG_COUNT_MAX        = cfg.IMG_COUNT_MAX || 5

const USE_SHARP            = cfg.USE_SHARP ?? true
const SHARP_QUALITY        = cfg.SHARP_QUALITY || 70
const SHARP_WIDTH          = cfg.SHARP_WIDTH || 1080

const FETCH_TIMEOUT        = cfg.FETCH_TIMEOUT || 8000
const DOWNLOAD_TIMEOUT     = cfg.DOWNLOAD_TIMEOUT || 30000 // 延长下载超时时间到 30 秒

const API_WAVE_CONCURRENCY = cfg.API_WAVE_CONCURRENCY || 2          
const API_MAX_TRIES_FACTOR = cfg.API_MAX_TRIES_FACTOR || 6          
const API_WAVE_SLEEP_MIN   = cfg.API_WAVE_SLEEP_MIN || 200
const API_WAVE_SLEEP_MAX   = cfg.API_WAVE_SLEEP_MAX || 450
// ===========================================

const USER_AGENT_LIST = [  
  'Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile Safari/10600.6.3 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (iPhone;CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
]

const API_CLASS    = 'https://www.onexiaolaji.cn/RandomPicture/api/?key=qq249663924&type=class'
const API_IMG_BASE = 'https://www.onexiaolaji.cn/RandomPicture/api/?key=qq249663924'
const API_VIDEO    = 'https://api.kuleu.com/api/MP4_xiaojiejie?type=json'

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
// 忽略 HTTPS 证书校验
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8, rejectUnauthorized: false })
const pickAgent = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent)

async function getSegment() {
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pickUA = () => USER_AGENT_LIST[randInt(0, USER_AGENT_LIST.length - 1)]
const cacheBuster = () => `${Date.now()}_${Math.random().toString(16).slice(2)}`

// 获取 JSON 数据
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

    if (!res.ok) {
      Bot?.logger?.error?.(`[xjj] API HTTP 状态码异常: ${res.status}`)
      return null
    }

    const data = await res.json()
    if (data && typeof data.msg === 'string') {
      Bot?.logger?.warn?.(`[xjj] API 提示: ${data.msg}`)
    }
    return data
  } catch (err) {
    Bot?.logger?.error?.(`[xjj] fetchJson 请求崩溃 (${url}): ${err.message}`)
    return null
  } finally {
    clearTimeout(t)
  }
}

// 获取图片 Buffer (移除了 agent 以防假死，增加了超时捕获)
async function fetchBuffer(url, timeoutMs = DOWNLOAD_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      agent: undefined, // 核心修复：不用 Keep-Alive，防止下载大图卡死
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.onexiaolaji.cn/' // 加上 Referer 防一部分盗链
      }
    })
    
    if (!res.ok) {
      Bot?.logger?.error?.(`[xjj] 图片 HTTP 错误: ${res.status} (${url})`)
      return null
    }

    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } catch (err) {
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      Bot?.logger?.error?.(`[xjj] 图片下载超时 (超过${timeoutMs/1000}秒): ${url}`)
    } else {
      Bot?.logger?.error?.(`[xjj] fetchBuffer 崩溃 (${url}): ${err.message}`)
    }
    return null
  } finally {
    clearTimeout(t)
  }
}

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
      } catch {}
    }

    return `base64://${buffer.toString('base64')}`
  } catch {
    return null
  }
}

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

export class xjjUltimate extends plugin {
  constructor() {
    super({
      name: '小姐姐-极速完整版(稳定)',
      dsc: '分类准确+Base64秒发(限并发补齐+防假死)',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: /^#?(小姐姐|xjj)$/, fnc: 'xjj' },
        { reg: /^#?((小姐姐|xjj)视频|xjjpro)$/, fnc: 'xjjVideo' }
      ]
    })
  }

  async getClassList() {
    const cacheKey = 'ys:xjj:classes'
    const cached = await redis.get(cacheKey)
    if (cached) {
      try { return JSON.parse(cached) } catch {}
    }

    Bot?.logger?.mark?.('[xjj] 正在更新分类缓存...')
    const data = await fetchJson(API_CLASS)
    
    if (!data || !data.class) {
       Bot?.logger?.error?.('[xjj] 获取分类接口返回异常')
       return null
    }

    const leaves = []
    
    // 递归解析层级 JSON，顺便继承父级名称
    const traverse = (node, parentName = '') => {
      if (typeof node !== 'object' || !node) return
      
      for (const [k, v] of Object.entries(node)) {
        if (['code', 'bing', 'video', '10', 'ad', 'author', 'Latest update time'].includes(k)) continue
        
        let currentCategoryName = parentName
        // 如果包含 "=>"，提取后半部分名字
        if (k.includes('=>')) {
          currentCategoryName = k.split('=>')[1]
        }

        if (typeof v === 'string') {
          // 只保留纯数字作为真实的分类 ID
          if (/^\d+$/.test(k)) {
            const fullName = currentCategoryName ? `${currentCategoryName} - ${v}` : v
            leaves.push({ id: k, name: fullName })
          }
        } else if (typeof v === 'object') {
          traverse(v, currentCategoryName)
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
    if (!classes || classes.length === 0) return e.reply('图片分类加载失败，请看后台控制台报错日志。')

    const pick = classes[randInt(0, classes.length - 1)]
    
    // 核心修复：直接传纯数字 ID，不再拼接错误的 p 或 m 后缀
    const typeParam = pick.id 
    const count = randInt(IMG_COUNT_MIN, IMG_COUNT_MAX)

    await e.reply(`本小姐正在挑选 ${count} 张 [${pick.name}] 美图...`)

    const uniqueUrls = await collectUniqueImgUrls({ need: count, typeParam })
    if (uniqueUrls.length < Math.min(count, IMG_COUNT_MIN)) {
      return e.reply('这会儿图库有点挤，只拿到部分图或获取失败，稍后再试吧~')
    }

    const seg = await getSegment()
    const uin = e.member?.user_id ?? Bot.uin
    const nick = e.member?.nickname ?? Bot.nickname
    const title = `${nick} ｜ ${pick.name} 精选`

    for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
      const batchUrls = uniqueUrls.slice(i, i + BATCH_SIZE)

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
        await sleep(1000) 
      }
    }

    return true
  }

  async xjjVideo(e) {
    const seg = await getSegment()
    try {
      const res = await fetchJson(API_VIDEO)
      if (res && res.mp4_video) {
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
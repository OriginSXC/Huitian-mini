import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import http from 'http'
import https from 'https'
import Config from './config/config.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('xjj')

const BATCH_SIZE           = cfg.BATCH_SIZE || 5             
const IMG_COUNT_MIN        = cfg.IMG_COUNT_MIN || 3
const IMG_COUNT_MAX        = cfg.IMG_COUNT_MAX || 5

const USE_SHARP            = cfg.USE_SHARP ?? true
const SHARP_QUALITY        = cfg.SHARP_QUALITY || 70
const SHARP_WIDTH          = cfg.SHARP_WIDTH || 1080

const FETCH_TIMEOUT        = cfg.FETCH_TIMEOUT || 8000
const DOWNLOAD_TIMEOUT     = cfg.DOWNLOAD_TIMEOUT || 30000 
// ===========================================

const USER_AGENT_LIST = [  
  'Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile Safari/10600.6.3 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (iPhone;CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
]

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8, rejectUnauthorized: false })
const pickAgent = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent)

async function getSegment() {
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pickUA = () => USER_AGENT_LIST[randInt(0, USER_AGENT_LIST.length - 1)]

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
      Bot?.logger?.error?.(`[xjj] API HTTP 状态码异常: ${res.status} (${url})`)
      return null
    }

    const data = await res.json()
    return data
  } catch (err) {
    Bot?.logger?.error?.(`[xjj] fetchJson 请求失败 (${url}): ${err.message}`)
    return null
  } finally {
    clearTimeout(t)
  }
}

// 获取图片 Buffer (移除了旧版特定的 Referer 以适配新图床)
async function fetchBuffer(url, timeoutMs = DOWNLOAD_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      agent: undefined, 
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'Cache-Control': 'no-cache'
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
      Bot?.logger?.error?.(`[xjj] 图片下载超时: ${url}`)
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

  // 修复部分 API 返回的双斜杠无协议 URL
  if (url.startsWith('//')) url = 'https:' + url
  
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

// ================= API 源配置 =================

const IMAGE_APIS = [
  // 1. imgapi.cn (单图)
  async (count) => {
    const tasks = Array.from({ length: count }).map(() => fetchJson('https://imgapi.cn/api.php?zd=zsy&fl=meizi&gs=json'))
    const res = await Promise.all(tasks)
    return { name: '随机妹子', urls: res.map(r => r?.imgurl).filter(Boolean) }
  },
  // 2. imgapi.cn (10张连包)
  async (count) => {
    const urls = ['https://imgapi.cn/cos.php?return=jsonpro', 'https://imgapi.cn/cos2.php?return=jsonpro']
    const pickUrl = urls[randInt(0, 1)]
    const res = await fetchJson(pickUrl)
    return { name: 'COS集锦', urls: (res?.imgurls || []).slice(0, count) }
  },
  // 3. 3650000.xyz (多分类单图)
  async (count) => {
    const modes = [
      { m: 1, n: '微博美女' }, { m: 2, n: 'IG图包' }, { m: 3, n: 'COS图' },
      { m: 5, n: 'Mtcos' }, { m: 7, n: '美腿' }, { m: 8, n: 'Coser分类' }, { m: 9, n: '兔玩映画' }
    ]
    const pick = modes[randInt(0, modes.length - 1)]
    const tasks = Array.from({ length: count }).map(() => fetchJson(`http://3650000.xyz/api/?type=json&mode=${pick.m}`))
    const res = await Promise.all(tasks)
    return { name: pick.n, urls: res.map(r => r?.url).filter(Boolean) }
  },
  // 4. v2.xxapi.cn (多分类单图)
  async (count) => {
    const endpoints = [
      { e: 'yscos', n: '原神COS' }, { e: 'heisi', n: '黑丝' }, 
      { e: 'baisi', n: '白丝' }, { e: 'jk', n: 'JK制服' }
    ]
    const pick = endpoints[randInt(0, endpoints.length - 1)]
    const tasks = Array.from({ length: count }).map(() => fetchJson(`https://v2.xxapi.cn/api/${pick.e}?return=json`))
    const res = await Promise.all(tasks)
    return { name: pick.n, urls: res.map(r => r?.data).filter(Boolean) }
  }
]

const VIDEO_APIS = [
  // 1. yujn.cn (带标题)
  async () => {
    const res = await fetchJson('https://api.yujn.cn/api/zzxjj.php?type=json')
    if (res && res.data) return { url: res.data, title: res.title || '' }
    return null
  },
  // 2. kuleu.com (无标题)
  async () => {
    const res = await fetchJson('https://api.kuleu.com/api/MP4_xiaojiejie?type=json')
    if (res && res.mp4_video) return { url: res.mp4_video, title: '' }
    return null
  }
]

// ============================================

export class xjjUltimate extends plugin {
  constructor() {
    super({
      name: '小姐姐-极速完整版(聚合重构)',
      dsc: '多接口聚合+分类准确+Base64秒发',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: /^#?(小姐姐|xjj)$/, fnc: 'xjj' },
        { reg: /^#?((小姐姐|xjj)视频|xjjpro)$/, fnc: 'xjjVideo' }
      ]
    })
  }

  async xjj(e) {
    const count = randInt(IMG_COUNT_MIN, IMG_COUNT_MAX)
    
    // 随机打乱 API 顺序，实现失败自动降级重试
    const shuffledApis = [...IMAGE_APIS].sort(() => Math.random() - 0.5)
    
    let result = null
    for (const apiFunc of shuffledApis) {
      try {
        const res = await apiFunc(count)
        // 确保获取到了足够的图片（至少一张）才跳出循环
        if (res && res.urls && res.urls.length > 0) {
          result = res
          break
        }
      } catch (err) {
        Bot?.logger?.warn?.(`[xjj] 某个图片接口请求失败，正在尝试切换...`)
      }
    }

    if (!result || result.urls.length === 0) {
      return e.reply('这会儿所有图库接口都拥挤或失效了，请稍后再试吧~')
    }

    await e.reply(`本小姐正在挑选 ${result.urls.length} 张 [${result.name}] 美图...`)

    const seg = await getSegment()
    const uin = e.member?.user_id ?? Bot.uin
    const nick = e.member?.nickname ?? Bot.nickname
    const title = `${nick} ｜ ${result.name} 精选`

    for (let i = 0; i < result.urls.length; i += BATCH_SIZE) {
      const batchUrls = result.urls.slice(i, i + BATCH_SIZE)

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

      if (i + BATCH_SIZE < result.urls.length) {
        await sleep(1000) 
      }
    }

    return true
  }

  async xjjVideo(e) {
    const seg = await getSegment()
    
    const shuffledApis = [...VIDEO_APIS].sort(() => Math.random() - 0.5)
    
    let result = null
    for (const apiFunc of shuffledApis) {
      try {
        const res = await apiFunc()
        if (res && res.url) {
          result = res
          break
        }
      } catch (err) {
        Bot?.logger?.warn?.(`[xjj] 某个视频接口请求失败，正在尝试切换...`)
      }
    }

    if (!result || !result.url) {
      return e.reply('视频接口暂时都没数据或挂掉了~')
    }

    try {
      // 视频带标题则拼接标题文本
      const replyMsg = []
      if (result.title) {
        replyMsg.push(`������ ${result.title.trim()}\n`)
      }
      replyMsg.push(seg.video(result.url))
      
      await e.reply(replyMsg)
    } catch (err) {
      Bot?.logger?.error?.(`[xjj] 视频发送异常: ${err.message}`)
      await e.reply('视频获取到了，但发送出错了')
    }
    
    return true
  }
}
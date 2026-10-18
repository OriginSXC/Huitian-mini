import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import Config from './config/config.js'
import { senderOf } from './utils/botcompat.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('xjj')

const BATCH_SIZE           = cfg.BATCH_SIZE || 3              // 每条合并转发几张，同时也是下载并发数
const IMG_COUNT_MIN        = cfg.IMG_COUNT_MIN || 3
const IMG_COUNT_MAX        = cfg.IMG_COUNT_MAX || 5

const USE_SHARP            = cfg.USE_SHARP ?? true
const SHARP_QUALITY        = cfg.SHARP_QUALITY || 70
const SHARP_WIDTH          = cfg.SHARP_WIDTH || 1080

const FETCH_TIMEOUT        = cfg.FETCH_TIMEOUT || 8000
const DOWNLOAD_TIMEOUT     = cfg.DOWNLOAD_TIMEOUT || 15000

const SOURCE_COOLDOWN_MIN  = cfg.SOURCE_COOLDOWN_MIN || 10    // 图源失败后的冷却分钟数，连续失败翻倍，最长 6 小时
const VIDEO_MAX_TRIES      = cfg.VIDEO_MAX_TRIES || 4         // 视频死链（对象存储 404）时最多换几条
// ===========================================

// ================= 混淆与配置区 =================

// yujn.cn 接口基础 (包含图片和视频)
const _0xYujnBase = "aHR0cHM6Ly9hcGkueXVqbi5jbi9hcGkv"; // https://api.yujn.cn/api/
const YUJN_BASE = Buffer.from(_0xYujnBase, 'base64').toString()

// 视频可用分类（数组 = 多个接口随机选一个）
const VID_YUJN_MAP = {
  "黑丝": "heisis.php?type=video", "白丝": "baisis.php?type=video",
  "漫展": "manzhan.php?type=video", "jk": "jksp.php?type=video",
  "甜妹": "tianmei.php?type=video", "萝莉": "luoli.php?type=video",
  "清纯": "qingchun.php?type=video", "吊带": "diaodai.php?type=video",
  "变装": ["ksbianzhuang.php?type=video", "bianzhuang.php?"],
  "女高": "nvgao.php?type=video", "双倍快乐": "sbkl.php?type=video",
  "怼脸自拍": "duilian.php?type=video", "穿搭": "chuanda.php?type=video",
  "完美身材": "wmsc.php?type=video", "慢摇": "manyao.php?type=video",
  "cos": "COS.php?type=video", "热舞": "rewu.php?type=video",
  "玉足": "yuzu.php?type=video", "美腿": "yuzu.php?type=video",
  "女大": "nvda.php?type=video", "古风": "hanfu.php?type=video",

  // 网红系列
  "瞳瞳": "tongtong.php?type=video", "鞠婧祎": "jjy.php?type=video",
  "潇潇": "xiaoxiao.php?", "杀猪饲料": "shejie.php?type=video",
  "章若楠": "zrn.php?type=video", "你的欲梦": "ndym.php?type=video"
};

// 不分类的随机视频接口（返回 JSON），只进盲盒
const VID_JSON_APIS = [
  { id: 'yujn:zzxjj', url: `${YUJN_BASE}zzxjj.php?type=json`, pick: j => j?.data && { url: j.data, title: j.title || '' } },
  { id: 'kuleu:mp4', url: 'https://api.kuleu.com/api/MP4_xiaojiejie?type=json', pick: j => j?.mp4_video && { url: j.mp4_video, title: '' } }
];

// 中英文别名映射器
const ALIAS_MAP = {
  "hs": "黑丝", "bs": "白丝", "jk": "jk", "cos": "cos",
  "xjj": "随机小姐姐", "小姐姐": "随机小姐姐"
};
const BLIND_BOX = '随机小姐姐'
// =============================================


const USER_AGENT_LIST = [
  'Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile Safari/10600.6.3 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (iPhone;CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)'
]

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8, rejectUnauthorized: false })
// 以函数形式交给 node-fetch：跳转跨协议（https 接口 302 到 http 图床）时按每一跳的地址选 agent
const pickAgent = (url) => (String(url?.href ?? url).startsWith('https:') ? httpsAgent : httpAgent)

async function getSegment() {
  if (global.segment) return global.segment
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

let sharpLib
async function loadSharp() {
  if (!USE_SHARP) return null
  if (sharpLib === undefined) {
    try { sharpLib = (await import('sharp')).default }
    catch { sharpLib = null; Bot?.logger?.warn?.('[xjj] 未找到 sharp，图片将不压缩直接发送') }
  }
  return sharpLib
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const pickOne = (arr) => arr[randInt(0, arr.length - 1)]
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pickUA = () => pickOne(USER_AGENT_LIST)
const nonce = () => Math.random().toString(36).substring(2)
const withNonce = (url) => `${url}${url.endsWith('?') ? '' : (url.includes('?') ? '&' : '?')}_r=${nonce()}`

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 限并发 map，结果顺序与输入一致
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let next = 0
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i) } }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker))
  return out
}

// NapCat/OneBot 抛的是响应对象，直接拼接会变成 [object Object]
function errText(err) {
  if (err instanceof Error) return err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, agent: pickAgent, headers: { 'User-Agent': pickUA() } })
    return res.ok ? await res.json() : null;
  } catch (err) { return null; } finally { clearTimeout(t); }
}

async function fetchBuffer(url, timeoutMs = DOWNLOAD_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, agent: pickAgent, redirect: 'follow', headers: { 'User-Agent': pickUA() } })
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch (err) { return null; } finally { clearTimeout(t); }
}

// 按文件头认图片：接口挂掉时常返回 HTML 错误页，原样发出去 QQ 会直接报错
function isImageBuffer(buf) {
  if (!buf || buf.length < 1024) return false
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true                // JPEG
  if (buf.readUInt32BE(0) === 0x89504e47) return true                                   // PNG
  if (buf.toString('ascii', 0, 3) === 'GIF') return true                                // GIF
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
}

// 下载并压缩成 base64；返回 { b64, hash }，失败返回 null
async function downloadImage(url) {
  if (!url) return null
  if (url.startsWith('//')) url = 'https:' + url
  let buffer = await fetchBuffer(url)
  if (!isImageBuffer(buffer)) return null
  const hash = crypto.createHash('md5').update(buffer).digest('hex')
  const sharp = await loadSharp()
  if (sharp) {
    try {
      buffer = await sharp(buffer).rotate().resize({ width: SHARP_WIDTH, withoutEnlargement: true }).jpeg({ quality: SHARP_QUALITY }).toBuffer()
    } catch {}
  }
  return { b64: `base64://${buffer.toString('base64')}`, hash }
}

// ================= 图源健康度（内存，重启清零） =================
// 失败的图源进冷却期，冷却中的只在其它图源一张都没拿到时才兜底尝试。
// 这样死掉 / 被网络黑洞的接口不会每次都白等一个超时。
const sourceHealth = new Map()

const isCooling = (id) => (sourceHealth.get(id)?.until || 0) > Date.now()

function markFail(id, why) {
  const fails = (sourceHealth.get(id)?.fails || 0) + 1
  const mins = Math.min(SOURCE_COOLDOWN_MIN * 2 ** (fails - 1), 360)
  sourceHealth.set(id, { fails, until: Date.now() + mins * 60e3 })
  Bot?.logger?.warn?.(`[xjj] 图源 ${id} 失败（${why}），连续 ${fails} 次，冷却 ${mins} 分钟`)
}

const markOk = (id) => sourceHealth.delete(id)

// ================= 图片图源 =================
// 每个图源：get(n) 返回最多 n 个待下载的图片地址
const yujnImg = (file) => ({
  id: `yujn:${file}`,
  get: async (n) => Array.from({ length: n }, () => withNonce(`${YUJN_BASE}${file}`))
})

const jsonImg = (id, url, pick) => ({
  id,
  get: async (n) => (await Promise.all(Array.from({ length: n }, () => fetchJson(url)))).map(pick).filter(Boolean)
})

const xxapiImg = (type) => jsonImg(`xxapi:${type}`, `https://v2.xxapi.cn/api/${type}?return=json`, r => r?.data)

const IMG_SOURCES = {
  "黑丝": [yujnImg('heisi.php'), xxapiImg('heisi')],
  "白丝": [yujnImg('baisi.php'), xxapiImg('baisi')],
  "jk":   [yujnImg('jk.php'), xxapiImg('jk')],
  "美腿": [yujnImg('tui.php'), jsonImg('3650000:mode7', 'http://3650000.xyz/api/?type=json&mode=7', r => r?.url)],
};

// 盲盒专用的不分类图源
const IMG_RANDOM_SOURCES = [
  jsonImg('imgapi:meizi', 'https://imgapi.cn/api.php?zd=zsy&fl=meizi&gs=json', r => r?.imgurl),
  {
    id: 'imgapi:cos',
    get: async (n) => {
      const res = await fetchJson(pickOne(['https://imgapi.cn/cos.php?return=jsonpro', 'https://imgapi.cn/cos2.php?return=jsonpro']))
      return shuffle(res?.imgurls || []).slice(0, n)
    }
  }
];

// 依次从图源里凑够 want 张；先试健康的，冷却中的只在一张都没拿到时兜底
async function collectImages(sources, want) {
  const images = []
  const seen = new Set()
  const healthy = shuffle(sources.filter(s => !isCooling(s.id)))
  const cooling = shuffle(sources.filter(s => isCooling(s.id)))

  for (const src of [...healthy, ...cooling]) {
    if (images.length >= want) break
    if (images.length > 0 && isCooling(src.id)) continue
    const need = want - images.length
    let urls = []
    try { urls = await src.get(need) } catch {}
    if (!urls.length) { markFail(src.id, '接口无数据'); continue }

    // 分波下载，第一波一张都没成就不再等后面几波
    let added = 0
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const got = (await mapLimit(urls.slice(i, i + BATCH_SIZE), BATCH_SIZE, downloadImage)).filter(Boolean)
      for (const img of got) {
        if (seen.has(img.hash)) continue
        seen.add(img.hash)
        images.push(img.b64)
        added++
      }
      if (added === 0) break
    }
    if (added > 0) markOk(src.id)
    else markFail(src.id, `${urls.length} 张全部下载失败`)
  }
  return images
}

// ================= 视频 =================
// 接口每次都 302 到一条随机视频，其中约一成是对象存储里已经删掉的（404 NoSuchKey）。
// 这里自己跟随跳转并探测最终地址，把验证过的直链交给协议端下载，
// 否则协议端再请求一次接口拿到的是另一条随机视频，探测就白做了。
// 只有 HTTP 层面的失败才算死链；跳到 CDN 后连不上（本机走代理时部分抖音节点不通）
// 不代表协议端也下不了，直接把这一跳的地址交出去。
async function resolveVideo(url) {
  let cur = url
  for (let hop = 0; hop < 6; hop++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    try {
      const res = await fetch(cur, {
        signal: ctrl.signal, agent: pickAgent, redirect: 'manual',
        headers: { 'User-Agent': pickUA(), 'Range': 'bytes=0-1023' }
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return null
        // 个别接口（bianzhuang）跳转地址里是 HTML 转义的 &amp;
        cur = new URL(loc.replace(/&amp;/g, '&'), cur).href
        continue
      }
      if (res.status !== 200 && res.status !== 206) return null
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      // 只读第一块，服务器不认 Range 时也不会把整条视频拉下来
      let head = Buffer.alloc(0)
      for await (const chunk of res.body) { head = chunk; break }
      const isMp4 = head.length >= 8 && head.toString('ascii', 4, 8) === 'ftyp'
      return (ct.startsWith('video/') || isMp4) ? cur : null
    } catch (err) {
      if (hop === 0) return null
      Bot?.logger?.mark?.(`[xjj] 视频地址本机探测不通（${errText(err)}），交给协议端直接下载`)
      return cur
    } finally { clearTimeout(t); ctrl.abort() }
  }
  return null
}

// 一次候选：返回 { url, title }，失败返回 null
function videoCandidate(category) {
  const path = VID_YUJN_MAP[category]
  return async () => {
    const url = await resolveVideo(withNonce(YUJN_BASE + (Array.isArray(path) ? pickOne(path) : path)))
    return url && { url, title: '' }
  }
}

function jsonVideoCandidate(api) {
  return async () => {
    const hit = api.pick(await fetchJson(api.url))
    const url = hit && await resolveVideo(hit.url)
    return url && { url, title: hit.title }
  }
}

// ================= 防刷屏：同一个群/私聊同时只跑一单 =================
const busy = new Map()
const BUSY_TTL = 3 * 60e3
const busyKey = (e) => e.group_id ? `g${e.group_id}` : `u${e.user_id}`

export class xjjUltimate extends plugin {
  constructor() {
    const keys = [...new Set([...Object.keys(VID_YUJN_MAP), ...Object.keys(IMG_SOURCES), ...Object.keys(ALIAS_MAP)])]
    const cate = keys.join('|')
    super({
      name: '小姐姐-极速完整版(智能盲盒版)',
      dsc: '多接口聚合+全库盲盒+跨界纠错防误触',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: new RegExp(`^#?(${cate})(图片|图)?$`, 'i'), fnc: 'xjj' },
        { reg: new RegExp(`^#?(${cate})(视频|pro)$`, 'i'), fnc: 'xjjVideo' }
      ]
    })
  }

  parseCommand(msg) {
    let raw = msg.trim().replace(/^#/, '').replace(/(图片|图|视频|pro)$/i, '').toLowerCase();
    return ALIAS_MAP[raw] || raw;
  }

  // 返回 false 表示放行给其它插件
  async runExclusive(e, fn) {
    const key = busyKey(e)
    const since = busy.get(key)
    if (since && Date.now() - since < BUSY_TTL) {
      await e.reply('上一单还在挑，稍等一下~')
      return true
    }
    busy.set(key, Date.now())
    try { return await fn() } finally { busy.delete(key) }
  }

  async xjj(e) {
    let categoryName = this.parseCommand(e.msg);

    // ====== 1. 类型跨界纠错 ======
    if (categoryName !== BLIND_BOX && !IMG_SOURCES[categoryName]) {
      // #cos 归米游社 COS 插件；不带 # 的口语（"cos"、"女大"）也别去搭话
      if (categoryName === 'cos' || !/^\s*#/.test(e.msg)) return false
      if (VID_YUJN_MAP[categoryName]) return e.reply(`[${categoryName}] 只有视频哦，请尝试发送 #${categoryName}视频`);
      return false
    }

    return this.runExclusive(e, async () => {
      const count = randInt(IMG_COUNT_MIN, IMG_COUNT_MAX)

      // ====== 2. 构建尝试计划：指定分类 or 盲盒（打乱各分类，最后兜底不分类图源） ======
      const plan = categoryName === BLIND_BOX
        ? [...shuffle(Object.keys(IMG_SOURCES)).map(name => ({ name, sources: IMG_SOURCES[name] })), { name: BLIND_BOX, sources: IMG_RANDOM_SOURCES }]
        : [{ name: categoryName, sources: IMG_SOURCES[categoryName] }]

      await e.reply(categoryName === BLIND_BOX ? '本小姐正在开盲盒挑选美图...' : `本小姐正在挑选 [${categoryName}] 美图...`)

      let images = []
      let name = categoryName
      for (const step of plan) {
        images = await collectImages(step.sources, count)
        if (images.length) { name = step.name; break }
      }

      if (!images.length) {
        return e.reply(`这会儿 [${categoryName}] 的图库都拥挤或失效了，请稍后再试吧~`)
      }

      const seg = await getSegment()
      const sender = senderOf(e)
      const title = `${sender.nickname} ｜ ${name} 精选`

      for (let i = 0; i < images.length; i += BATCH_SIZE) {
        const nodes = images.slice(i, i + BATCH_SIZE).map((b64, idx) => ({
          user_id: sender.uin, nickname: title, message: [`第 ${i + idx + 1} 张`, seg.image(b64)]
        }))

        try {
          const ctx = e.group || e.friend
          if (typeof ctx?.makeForwardMsg === 'function') {
            await e.reply(await ctx.makeForwardMsg(nodes))
          } else {
            for (const node of nodes) await e.reply(node.message)
          }
        } catch (err) {
          Bot?.logger?.warn?.(`[xjj] 合并转发失败，改逐条发送：${errText(err)}`)
          for (const node of nodes) { try { await e.reply(node.message) } catch {} }
        }
        if (i + BATCH_SIZE < images.length) await sleep(1000)
      }
      return true
    })
  }

  async xjjVideo(e) {
    let categoryName = this.parseCommand(e.msg);

    // ====== 1. 类型跨界纠错 ======
    if (categoryName !== BLIND_BOX && !VID_YUJN_MAP[categoryName]) {
      if (!/^\s*#/.test(e.msg)) return false
      if (IMG_SOURCES[categoryName]) return e.reply(`[${categoryName}] 只有图片哦，请尝试发送 #${categoryName}图片`);
      return false
    }

    return this.runExclusive(e, async () => {
      // ====== 2. 候选：指定分类就在该分类里换；盲盒在各分类 + 不分类接口里随机换 ======
      const blind = categoryName === BLIND_BOX
      const candidates = Array.from({ length: VIDEO_MAX_TRIES }, () => {
        if (!blind) return { name: categoryName, get: videoCandidate(categoryName) }
        const pool = [...Object.keys(VID_YUJN_MAP).map(name => ({ name, get: videoCandidate(name) })),
                      ...VID_JSON_APIS.map(api => ({ name: BLIND_BOX, get: jsonVideoCandidate(api) }))]
        return pickOne(pool)
      })

      await e.reply(blind ? '本小姐正在开盲盒挑选视频...' : `本小姐正在挑选 [${categoryName}] 视频...`)

      let video = null
      for (const [i, c] of candidates.entries()) {
        try { video = await c.get() } catch { video = null }
        if (video) { categoryName = c.name; break }
        Bot?.logger?.warn?.(`[xjj] [${c.name}] 视频第 ${i + 1} 次拿到死链，换一条`)
      }

      if (!video) {
        return e.reply('视频接口暂时都没数据或挂掉了~')
      }

      try {
        const seg = await getSegment()
        const replyMsg = []
        if (video.title?.trim()) replyMsg.push(`🎬 ${video.title.trim()}\n`)
        replyMsg.push(seg.video(video.url))
        await e.reply(replyMsg)
      } catch (err) {
        Bot?.logger?.warn?.(`[xjj] 视频发送失败：${errText(err)}`)
        await e.reply('视频获取到了，但发送出错了')
      }
      return true
    })
  }
}

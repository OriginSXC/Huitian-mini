import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import Config from './config/config.js'
import { senderOf, normalizeId } from './utils/botcompat.js'
import { rehashNodes, looksLikeQQBlock } from './utils/qq-rehash.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('mys_cos')
const SEND_REHASH           = cfg.SEND_REHASH ?? true   // 发送被 QQ 拦下时改图片哈希重投

const SEND_MODE_DEFAULT     = cfg.SEND_MODE_DEFAULT || 'forward-icqq'
const ALLOW_CMD_SWITCH_MODE = cfg.ALLOW_CMD_SWITCH_MODE ?? true
const BATCH_SIZE            = cfg.BATCH_SIZE || 10
const DELAY_MS              = cfg.DELAY_MS || 1500
const MAX_TOTAL             = cfg.MAX_TOTAL || 5
const SIZE_TIPS             = cfg.SIZE_TIPS ?? true
const SIZE_MB_TIP           = cfg.SIZE_MB_TIP || 15
const HEADER_IN_EACH_BATCH  = cfg.HEADER_IN_EACH_BATCH ?? true
const AUTO_CRON             = cfg.AUTO_CRON || '30 8 12 * * *'
const POSTLIST              = cfg.POSTLIST || {}

const SHARP_ENABLE          = cfg.SHARP_ENABLE ?? true
const SHARP_OUTPUT_FORMAT   = cfg.SHARP_OUTPUT_FORMAT || 'webp'
const SHARP_QUALITY_START   = cfg.SHARP_QUALITY_START || 82
const SHARP_QUALITY_MIN     = cfg.SHARP_QUALITY_MIN || 50
const SHARP_MAX_WIDTH       = cfg.SHARP_MAX_WIDTH || 1440
const SHARP_MAX_HEIGHT      = cfg.SHARP_MAX_HEIGHT || 1920
const SHARP_CROP_TO_RATIO   = cfg.SHARP_CROP_TO_RATIO ?? true
const SHARP_TARGET_RATIO    = cfg.SHARP_TARGET_RATIO || 0.75
const SHARP_MAX_BYTES       = cfg.SHARP_MAX_BYTES || 1.6 * 1024 * 1024
const SHARP_PROGRESSIVE_JPG = cfg.SHARP_PROGRESSIVE_JPG ?? true
const SHARP_POSITION        = cfg.SHARP_POSITION || 'attention'

const API_TIMEOUT_MS        = cfg.API_TIMEOUT_MS || 8000
const IMG_TIMEOUT_MS        = cfg.IMG_TIMEOUT_MS || 20000
const IMG_CONCURRENCY       = cfg.IMG_CONCURRENCY || 3
// ===================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 各游戏 COS 版块；gids 决定原帖链接的路径前缀
const FORUMS = [
  { forumId: '49', gids: '2', path: 'ys' },     // 原神
  { forumId: '62', gids: '6', path: 'sr' },     // 星穹铁道
  { forumId: '47', gids: '5', path: 'dby' },    // 大别野
  { forumId: '65', gids: '8', path: 'zzz' },    // 绝区零
]

// 最近发过的帖子，避免定时和指令反复抽到同一帖（内存，重启清零）
const RECENT_MAX = 60
const recentPosts = []

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getSegment() {
  if (global.segment) return global.segment
  try {
    const m = await import('icqq')
    return m.segment
  } catch {
    const m = await import('oicq')
    return m.segment
  }
}

let sharpLib
async function loadSharp() {
  if (!SHARP_ENABLE) return null
  if (sharpLib !== undefined) return sharpLib
  try {
    const m = await import('sharp')
    sharpLib = m?.default || m
  } catch (e) {
    sharpLib = null
    Bot.logger?.warn?.('[mys-cos] 未安装或无法加载 sharp，将改用原图 URL；' + (e?.message || e))
  }
  return sharpLib
}

// 带超时的 fetch，网络层失败重试（米游社两条线路都有丢包）
async function fetchWithRetry(url, { timeoutMs = API_TIMEOUT_MS, tries = 3 } = {}) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Referer': 'https://www.miyoushe.com/' } })
      if (resp.status >= 500) throw new Error(`HTTP ${resp.status}`)
      // body 也要在超时内读完
      return { resp, buf: Buffer.from(await resp.arrayBuffer()) }
    } catch (e) {
      lastErr = e
      if (i < tries) await sleep(500 * i)
    } finally {
      clearTimeout(t)
    }
  }
  throw lastErr
}

// 米游社图床（阿里云 OSS）支持服务端缩图：4K 原图动辄几 MB、下载 20s+，缩到发送尺寸只有一两百 KB
function ossResized(url) {
  try {
    const u = new URL(url)
    if (!/(^|\.)(miyoushe|mihoyo)\.com$/.test(u.hostname) || u.search) return url
    const longSide = Math.max(SHARP_MAX_WIDTH, SHARP_MAX_HEIGHT)
    return `${url}?x-oss-process=image/resize,l_${longSide}/format,jpg/quality,q_90`
  } catch {
    return url
  }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let next = 0
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i) } }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker))
  return out
}

function arrClean(a) { return (Array.isArray(a) ? a : [a]).filter(v => v !== undefined && v !== null) }

function getCtxByType(type, id) {
  // TRSS 下会话 id 不一定是数字（KOOK / QQ频道 / Telegram），不能硬 Number()
  const key = normalizeId(id)
  if (type === 'group') return Bot.pickGroup(key)
  if (typeof Bot.pickFriend === 'function') return Bot.pickFriend(key)
  return Bot.pickUser(key)
}

function parseModeFromMsg(msg, fallback = SEND_MODE_DEFAULT) {
  if (!ALLOW_CMD_SWITCH_MODE) return fallback
  const s = (msg || '').toLowerCase()
  if (/\b(ob|onebot)\b/.test(s)) return 'forward-onebot'
  if (/\b(ic|icqq)\b/.test(s))   return 'forward-icqq'
  if (/\b(auto)\b/.test(s))      return 'forward-auto'
  if (/\b(plain|单发|普通)\b/.test(s)) return 'plain'
  return fallback
}

async function sendByMode(ctx, mode, nodesOB, nodesIcqq) {
  const useOB   = Array.isArray(nodesOB)   && nodesOB.length   > 0 && typeof ctx.sendForwardMsg === 'function'
  const useICQQ = Array.isArray(nodesIcqq) && nodesIcqq.length > 0 && typeof ctx.makeForwardMsg === 'function'

  if (mode === 'forward-onebot') {
    if (!useOB) return false
    try {
      await ctx.sendForwardMsg(nodesOB)
      return true
    } catch (e) {
      if (!SEND_REHASH || !looksLikeQQBlock(e)) throw e
      Bot.logger?.warn?.('[mys-cos] OneBot 首投失败（' + (e?.message || e) + '），改哈希后重投')
      await ctx.sendForwardMsg(rehashNodes(nodesOB))
      return true
    }
  }
  if (mode === 'forward-icqq') {
    if (!useICQQ) return false
    try {
      const msg = await ctx.makeForwardMsg(nodesIcqq)
      await ctx.sendMsg(msg)
      return true
    } catch (e) {
      if (!SEND_REHASH || !looksLikeQQBlock(e)) throw e
      Bot.logger?.warn?.('[mys-cos] icqq 首投失败（' + (e?.message || e) + '），改哈希后重投')
      const msg = await ctx.makeForwardMsg(rehashNodes(nodesIcqq))
      await ctx.sendMsg(msg)
      return true
    }
  }
  if (mode === 'forward-auto') {
    if (useOB) {
      try {
        await ctx.sendForwardMsg(nodesOB)
        return true
      } catch (e) {
        Bot.logger?.warn?.('[mys-cos] OneBot 合并转发失败，尝试 icqq：' + (e?.message || e))
        if (SEND_REHASH && looksLikeQQBlock(e)) {
          try {
            await ctx.sendForwardMsg(rehashNodes(nodesOB))
            Bot.logger?.mark?.('[mys-cos] OneBot 改哈希重投成功')
            return true
          } catch (e2) {
            Bot.logger?.warn?.('[mys-cos] OneBot 改哈希重投仍失败：' + (e2?.message || e2))
          }
        }
      }
    }
    if (useICQQ) {
      try {
        const msg = await ctx.makeForwardMsg(nodesIcqq)
        await ctx.sendMsg(msg)
        return true
      } catch (e) {
        Bot.logger?.warn?.('[mys-cos] icqq 合并转发失败：' + (e?.message || e))
        if (SEND_REHASH && looksLikeQQBlock(e)) {
          try {
            const msg = await ctx.makeForwardMsg(rehashNodes(nodesIcqq))
            await ctx.sendMsg(msg)
            Bot.logger?.mark?.('[mys-cos] icqq 改哈希重投成功')
            return true
          } catch (e2) {
            Bot.logger?.warn?.('[mys-cos] icqq 改哈希重投仍失败：' + (e2?.message || e2))
          }
        }
      }
    }
    return false
  }
  if (mode === 'plain') {
    try {
      const pick = nodesOB?.length ? nodesOB : nodesIcqq
      for (const n of (pick || [])) {
        const content = n?.data?.content || n?.message
        if (!content) continue
        await ctx.sendMsg(arrClean(content))
        await new Promise(r => setTimeout(r, 500))
      }
      return true
    } catch (e) {
      Bot.logger?.warn?.('[mys-cos] plain 逐条发送失败：' + (e?.message || e))
      if (SEND_REHASH && looksLikeQQBlock(e)) {
        try {
          const pick = nodesOB?.length ? nodesOB : nodesIcqq
          for (const n of rehashNodes(pick || [])) {
            const content = n?.data?.content || n?.message
            if (!content) continue
            await ctx.sendMsg(arrClean(content))
            await new Promise(r => setTimeout(r, 500))
          }
          Bot.logger?.mark?.('[mys-cos] plain 改哈希重投成功')
          return true
        } catch (e2) {
          Bot.logger?.warn?.('[mys-cos] plain 改哈希重投仍失败：' + (e2?.message || e2))
        }
      }
      return false
    }
  }
  return false
}

function buildHeaderNodes(headerText, uin, name) {
  const content = arrClean([headerText])
  return {
    nodesOB:   [{ type: 'node', data: { name, uin, content } }],
    nodesIcqq: [{ user_id: uin, nickname: name, message: content }]
  }
}

async function prepareImageSegment(seg, url, sharp) {
  if (!url || typeof url !== 'string') return null
  url = ossResized(url)
  if (!sharp) return seg.image(url)

  try {
    const { resp, buf } = await fetchWithRetry(url, { timeoutMs: IMG_TIMEOUT_MS, tries: 2 })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    if (buf.length === 0) throw new Error('empty image buffer')

    let pipe = sharp(buf, { failOn: 'none', limitInputPixels: 268402689 })
      .rotate()
      .withMetadata({ orientation: 1 })
    const meta = await pipe.metadata().catch(() => ({}))

    if (SHARP_CROP_TO_RATIO && SHARP_TARGET_RATIO > 0 && meta?.width && meta?.height) {
      const srcW = meta.width, srcH = meta.height
      const wantW = Math.min(SHARP_MAX_WIDTH, srcW)
      const wantH = Math.min(SHARP_MAX_HEIGHT, srcH)
      let outW = wantW, outH = Math.round(outW / SHARP_TARGET_RATIO)
      if (outH > wantH) { outH = wantH; outW = Math.round(outH * SHARP_TARGET_RATIO) }

      pipe = pipe.resize({ width: outW, height: outH, fit: 'cover', position: SHARP_POSITION })
    } else {
      pipe = pipe.resize({ width: SHARP_MAX_WIDTH, height: SHARP_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
    }

    let q = SHARP_QUALITY_START
    let out

    while (true) {
      let cur = pipe.clone()
      if (SHARP_OUTPUT_FORMAT === 'jpeg') {
        cur = cur.jpeg({ quality: q, progressive: SHARP_PROGRESSIVE_JPG, optimizeCoding: true, mozjpeg: true })
      } else {
        cur = cur.webp({ quality: q, effort: 4, nearLossless: false })
      }
      out = await cur.toBuffer()

      if (out.length <= SHARP_MAX_BYTES || q <= SHARP_QUALITY_MIN) break
      q = Math.max(SHARP_QUALITY_MIN, q - 8)
    }

    const b64 = 'base64://' + out.toString('base64')
    return seg.image(b64)
  } catch (e) {
    // 本机下载失败时把地址交给协议端自己下（它不走代理，线路不一样）
    Bot.logger?.warn?.(`[mys-cos] 图片处理失败，改发链接：${url} → ${e?.message || e}`)
    return seg.image(url)
  }
}

function collectImageUrls(result) {
  const urls = new Set()
  if (Array.isArray(result?.image_list)) {
    for (const it of result.image_list) {
      const u = it?.url || it?.src || it?.path
      if (u && /^https?:\/\//i.test(u)) urls.add(u)
    }
  }
  if (Array.isArray(result?.post?.images)) {
    for (const u of result.post.images) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.add(u)
    }
  }
  return Array.from(urls)
}

function pickVideoInfo(result) {
  const vod = result?.vod_list?.at?.(-1)
  const res = vod?.resolutions?.at?.(-1)
  if (!res || !res.url) return null
  return {
    url:        res.url,
    size:       Number(res.size || 0),
    width:      Number(res.width || 0),
    height:     Number(res.height || 0),
    definition: res.definition || '',
    format:     res.format || '',
    codec:      res.codec || '',
  }
}

async function sendText(eOrCtx, text) {
  try {
    if (typeof eOrCtx.reply === 'function') return await eOrCtx.reply(text)
    return await eOrCtx.sendMsg(text)
  } catch (err) {
    Bot.logger?.warn?.('[mys-cos] 文本发送失败：' + (err?.message || err))
  }
}

async function fetchRandomMysPost() {
  // 换版块 / 排序多试几次：接口偶发失败，或整页都是最近发过的
  for (let attempt = 1; attempt <= 4; attempt++) {
    const forum   = FORUMS[Math.floor(Math.random() * FORUMS.length)]
    const sortType = Math.floor(Math.random() * 3) + 1
    const is_hot  = Math.random() < 0.5 ? 'true' : 'false'
    const url = `https://bbs-api.miyoushe.com/post/wapi/getForumPostList?forum_id=${forum.forumId}&gids=${forum.gids}&is_good=false&is_hot=${is_hot}&page_size=20&sort_type=${sortType}`

    try {
      const { buf } = await fetchWithRetry(url)
      const json = JSON.parse(buf.toString('utf8'))
      if (json?.retcode !== 0) throw new Error(`retcode=${json?.retcode} ${json?.message || ''}`)
      const list = (json?.data?.list || []).filter(p => p?.post?.post_id && !recentPosts.includes(p.post.post_id))
      // 有图的帖子优先，纯视频帖兜底
      const withImg = list.filter(p => collectImageUrls(p).length > 0)
      const pool = withImg.length ? withImg : list.filter(p => pickVideoInfo(p))
      if (!pool.length) continue
      const post = pool[Math.floor(Math.random() * pool.length)]
      recentPosts.push(post.post.post_id)
      if (recentPosts.length > RECENT_MAX) recentPosts.shift()
      post._linkPath = forum.path
      return post
    } catch (err) {
      Bot.logger?.warn?.(`[mys-cos] 获取米游社帖子失败（第 ${attempt} 次）：${err?.message || err}`)
    }
  }
  return null
}

async function runOnceSend(eOrCtx, which = 'cmd', sendMode = SEND_MODE_DEFAULT) {
  const seg   = await getSegment()
  const sharp = await loadSharp() 

  const notifyOnFail   = (which === 'cmd')
  const notifyNoImage  = (which === 'cmd')

  const result = await fetchRandomMysPost()
  if (!result) {
    if (notifyOnFail) return await sendText(eOrCtx, '未获取到米游社数据，请稍后再试~')
    Bot.logger?.error?.('[mys-cos][定时] 未获取到米游社数据，本次跳过')
    return
  }

  const subject = result?.post?.subject || '(无标题)'
  const postId  = result?.post?.post_id || ''
  const author  = result?.user?.nickname || '(佚名)'
  const link    = postId ? `https://www.miyoushe.com/${result._linkPath || 'ys'}/article/${postId}` : '(无链接)'
  const headerText = `标题：${subject}\n原帖地址：\n${link}\n作者：${author}`

  const urlsAll = collectImageUrls(result).slice(0, MAX_TOTAL)

  if (urlsAll.length === 0) {
    const vd = pickVideoInfo(result)
    if (!vd || !vd.url) return await sendText(eOrCtx, '未发现可发送的图片或视频资源~')
    const segVideo = seg.video(vd.url)
    const mb = (vd.size ? vd.size / 1024 / 1024 : 0).toFixed(2)
    if (SIZE_TIPS && Number(mb) > SIZE_MB_TIP) {
      await sendText(eOrCtx, `正在发送较大视频（约 ${mb} MB），可能较慢~`)
    }
    if (typeof eOrCtx.reply === 'function') return await eOrCtx.reply([segVideo])
    return await eOrCtx.sendMsg([segVideo])
  }

  const ctx = typeof eOrCtx.sendMsg === 'function' ? eOrCtx : (eOrCtx.group || eOrCtx.friend)
  if (!ctx) {
    if (typeof eOrCtx.reply === 'function') await eOrCtx.reply('不支持的会话上下文，无法发送~')
    return
  }

  // 定时推送时 ctx 没有 member，不能退到 Bot.uin（TRSS 下是数组，String 后成逗号串）
  const sender = senderOf(eOrCtx)
  const uin  = String(sender.uin)
  const name = sender.nickname || 'Yunzai'

  const batchCount = Math.ceil(urlsAll.length / BATCH_SIZE)
  for (let i = 0; i < urlsAll.length; i += BATCH_SIZE) {
    const batch = urlsAll.slice(i, i + BATCH_SIZE)
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1

    const nodesOB = []
    const nodesIcqq = []
    const segs = await mapLimit(batch, IMG_CONCURRENCY, url =>
      prepareImageSegment(seg, url, sharp).catch(e => {
        Bot.logger?.warn?.(`[mys-cos] 处理/构建图片段失败，已跳过：${url} → ${e?.message || e}`)
        return null
      }))
    segs.forEach((imgSeg, j) => {
      if (!imgSeg) return
      const content = arrClean([`批次 ${batchIndex}/${batchCount} - 第 ${j + 1} 张`, imgSeg])
      nodesOB.push({ type: 'node', data: { name, uin, content } })
      nodesIcqq.push({ user_id: uin, nickname: name, message: content })
    })

    if (!nodesOB.length) {
      if (notifyNoImage) {
        await sendText(eOrCtx, '这一批没有可发送的图片，已跳过~')
      } else {
        Bot.logger?.warn?.('[mys-cos] 这一批没有可发送的图片，已跳过（cron 静音）。')
      }
    } else {
      const needHeader = HEADER_IN_EACH_BATCH || i === 0
      let ob = nodesOB, iq = nodesIcqq
      if (needHeader) {
        const headerNodes = buildHeaderNodes(headerText, uin, name)
        ob = [...headerNodes.nodesOB, ...nodesOB]
        iq = [...headerNodes.nodesIcqq, ...nodesIcqq]
      }

      const ok = await sendByMode(ctx, sendMode, ob, iq)
      if (!ok) {
        Bot.logger?.error?.(`[mys-cos] 发送失败（模式=${sendMode}），已跳过该批。`)
        if (notifyOnFail) {
          await sendText(eOrCtx, `合并转发失败（模式=${sendMode}），该批已跳过~`)
        }
      }
    }

    if (i + BATCH_SIZE < urlsAll.length) {
      await new Promise(r => setTimeout(r, DELAY_MS))
    }
  }
}

export class example extends plugin {
  constructor () {
    super({
      name: 'mys-cos-reborn',
      dsc: '米游社cos：图片分批合并转发（可选模式，无兜底）+ 可选 sharp 压缩裁剪',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: /^#?(?:米游社|mys)?\s*cos(?:\s+(?:ob|icqq|auto|plain))?$/i, fnc: 'cos' },
      ]
    })

    // 交给框架的定时任务：插件类每次处理消息都会 new 一次，
    // 在构造函数里直接 scheduleJob 会越挂越多（加载时就 new 两次 → 每天推两遍）
    this.task = Object.keys(POSTLIST).length
      ? { name: 'mys-cos定时推送', cron: AUTO_CRON, fnc: () => this.cronPush() }
      : []
  }

  async cronPush () {
    for (const [id, type] of Object.entries(POSTLIST)) {
      try {
        const ctx = getCtxByType(type, id)
        if (!ctx) {
          Bot.logger?.warn?.(`[mys-cos][定时] 无法获取上下文：${type} ${id}`)
          continue
        }
        await runOnceSend(ctx, 'cron', SEND_MODE_DEFAULT)
      } catch (err) {
        Bot.logger?.error?.(`[mys-cos][定时] ${type} ${id} 失败：` + (err?.message || err))
      }
      await sleep(10_000)
    }
  }

  async cos (e) {
    try {
      const mode = parseModeFromMsg(e?.msg, SEND_MODE_DEFAULT)
      await runOnceSend(e, 'cmd', mode) 
    } catch (err) {
      Bot.logger?.error?.('[mys-cos] 指令失败：' + (err?.stack || err))
      await e.reply('本小姐被风控/超时绊了一跤，等会儿再来~')
    }
    return true
  }
}
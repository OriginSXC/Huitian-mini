import plugin from '../../lib/plugins/plugin.js'
import schedule from 'node-schedule'
import fetch from 'node-fetch'
import sharp from 'sharp'
import Config from './config/config.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('mys_cos')

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
// ===================================================

async function getSegment() {
  try {
    const m = await import('icqq')
    return m.segment
  } catch {
    const m = await import('oicq')
    return m.segment
  }
}

async function loadSharp() {
  if (!SHARP_ENABLE) return null
  try {
    const m = await import('sharp')
    return m?.default || m
  } catch (e) {
    Bot.logger?.warn?.('[mys-cos] 未安装或无法加载 sharp，将改用原图 URL；' + (e?.message || e))
    return null
  }
}

function arrClean(a) { return (Array.isArray(a) ? a : [a]).filter(v => v !== undefined && v !== null) }

function getCtxByType(type, id) {
  if (type === 'group') return Bot.pickGroup(Number(id))
  if (typeof Bot.pickFriend === 'function') return Bot.pickFriend(Number(id))
  return Bot.pickUser(Number(id))
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
    await ctx.sendForwardMsg(nodesOB)
    return true
  }
  if (mode === 'forward-icqq') {
    if (!useICQQ) return false
    const msg = await ctx.makeForwardMsg(nodesIcqq)
    await ctx.sendMsg(msg)
    return true
  }
  if (mode === 'forward-auto') {
    if (useOB) {
      try {
        await ctx.sendForwardMsg(nodesOB)
        return true
      } catch (e) {
        Bot.logger?.warn?.('[mys-cos] OneBot 合并转发失败，尝试 icqq：' + (e?.message || e))
      }
    }
    if (useICQQ) {
      try {
        const msg = await ctx.makeForwardMsg(nodesIcqq)
        await ctx.sendMsg(msg)
        return true
      } catch (e) {
        Bot.logger?.warn?.('[mys-cos] icqq 合并转发失败：' + (e?.message || e))
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
  if (!sharp) return seg.image(url)

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'mys-cos-bot/1.0' } })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const ab   = await resp.arrayBuffer()
    let buf    = Buffer.from(ab)
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
    Bot.logger?.warn?.(`[mys-cos] sharp 处理失败，改用原图：${url} → ${e?.message || e}`)
    return seg.image(url)
  }
}

function sumImagesMB(result) {
  if (!Array.isArray(result?.image_list)) return 0
  let total = 0
  for (const it of result.image_list) {
    const s = parseInt(it?.size || '0', 10)
    if (!Number.isNaN(s)) total += s
  }
  return total / 1024 / 1024
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
  const config = [
    { forumId: '49', gameType: '2' },
    { forumId: '62', gameType: '6' },
    { forumId: '47', gameType: '5' },
    { forumId: '65', gameType: '8' },
  ]
  const selected = config[Math.floor(Math.random() * config.length)]
  const pageNum  = Math.floor(Math.random() * 3) + 1
  const is_hot   = Math.random() < 0.5 ? 'true' : 'false'

  const url = `https://bbs-api.miyoushe.com/post/wapi/getForumPostList?forum_id=${selected.forumId}&gids=${selected.gameType}&is_good=false&is_hot=${is_hot}&page_size=20&sort_type=${pageNum}`

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'mys-cos-bot/1.0' } })
    const json = await resp.json()
    const list = json?.data?.list
    if (!Array.isArray(list) || list.length === 0) return null
    return list[Math.floor(Math.random() * list.length)]
  } catch (err) {
    Bot.logger?.error?.('[mys-cos] 获取/解析米游社失败：' + (err?.message || err))
    return null
  }
}

async function runOnceSend(eOrCtx, which = 'cmd', sendMode = SEND_MODE_DEFAULT) {
  const seg   = await getSegment()
  const sharp = await loadSharp() 

  const notifyOnFail   = (which === 'cmd')
  const notifyNoImage  = (which === 'cmd')

  const result = await fetchRandomMysPost()
  if (!result) return await sendText(eOrCtx, '未获取到米游社数据，请稍后再试~')

  const subject = result?.post?.subject || '(无标题)'
  const postId  = result?.post?.post_id || ''
  const author  = result?.user?.nickname || '(佚名)'
  const link    = postId ? `https://www.miyoushe.com/ys/article/${postId}` : '(无链接)'
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

  const totalMB = sumImagesMB(result).toFixed(2)
  if (SIZE_TIPS && Number(totalMB) > SIZE_MB_TIP) {
    await sendText(eOrCtx, `检测到原图总体积约 ${totalMB} MB，将进行${sharp ? '压缩' : '发送'}，请稍候~`)
  }

  const ctx = typeof eOrCtx.sendMsg === 'function' ? eOrCtx : (eOrCtx.group || eOrCtx.friend)
  if (!ctx) {
    if (typeof eOrCtx.reply === 'function') await eOrCtx.reply('不支持的会话上下文，无法发送~')
    return
  }

  const uin  = String(eOrCtx?.member?.user_id ?? Bot.uin)
  const name = eOrCtx?.member?.nickname ?? (Bot.nickname || 'Yunzai')

  const batchCount = Math.ceil(urlsAll.length / BATCH_SIZE)
  for (let i = 0; i < urlsAll.length; i += BATCH_SIZE) {
    const batch = urlsAll.slice(i, i + BATCH_SIZE)
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1

    const nodesOB = []
    const nodesIcqq = []
    for (let j = 0; j < batch.length; j++) {
      const url = batch[j]
      try {
        const imgSeg = await prepareImageSegment(seg, url, sharp)
        if (!imgSeg) continue
        const content = arrClean([`批次 ${batchIndex}/${batchCount} - 第 ${j + 1} 张`, imgSeg])
        nodesOB.push({ type: 'node', data: { name, uin, content } })
        nodesIcqq.push({ user_id: uin, nickname: name, message: content })
      } catch (e) {
        Bot.logger?.warn?.(`[mys-cos] 处理/构建图片段失败，已跳过：${url} → ${e?.message || e}`)
      }
    }

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
        { reg: /^#?(?:米游社|mys)?cos(?:\s+(?:ob|icqq|auto|plain))?$/i, fnc: 'cos' },
      ]
    })

    schedule.scheduleJob(AUTO_CRON, async () => {
      Bot.logger?.mark?.('[mys-cos][定时] 开始发送')
      try {
        for (const [id, type] of Object.entries(POSTLIST)) {
          const ctx = getCtxByType(type, id)
          if (!ctx) {
            Bot.logger?.warn?.(`[mys-cos][定时] 无法获取上下文：${type} ${id}`)
            continue
          }
          await runOnceSend(ctx, 'cron', SEND_MODE_DEFAULT) 
          await new Promise(r => setTimeout(r, 10_000))
        }
      } catch (err) {
        Bot.logger?.error?.('[mys-cos][定时] 失败：' + (err?.message || err))
      }
      Bot.logger?.mark?.('[mys-cos][定时] 结束')
    })
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
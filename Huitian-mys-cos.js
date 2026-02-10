/**
 * 指令：#cos / cos / 米游社cos / mys cos
 * 功能：随机抓取米游社（米游社 bbs-api）cos 图片，按批次合并转发（NapCat/OneBot 规范）
 * 设计：可选发送模式（无兜底）：OneBot 合并转发 / icqq 合并转发 / 纯单发；可选 sharp 压缩裁剪
 *
 * 更新要点：
 * 1) 关闭“发送方式兜底”，通过 SEND_MODE 选择其一；仅在 forward-auto 下才会双尝试。
 * 2) 可选 sharp 本地压缩裁剪，降低大图触发风控的概率与发送时延。
 * 3) [变更] 定时任务（which='cron'）静音以下提示：a) 合并转发失败；b) 这一批没有可发送的图片。
 */

import plugin from '../../lib/plugins/plugin.js'
import schedule from 'node-schedule'
import fetch from 'node-fetch'
import sharp from 'sharp' // 直接引用你刚才装的依赖！

// ===================== 可调参数 =====================
// —— 发送模式（默认不兜底）——
// 'forward-onebot' | 'forward-icqq' | 'forward-auto' | 'plain'
const SEND_MODE_DEFAULT = 'forward-icqq'

// 是否允许通过指令临时切换模式：#cos ob / icqq / auto / plain
const ALLOW_CMD_SWITCH_MODE = true

const BATCH_SIZE   = 10          // 每批几张图
const DELAY_MS     = 1500       // 批间隔（毫秒）
const MAX_TOTAL    = 5         // 单次最多图片数
const SIZE_TIPS    = true       // 提示大体积（来自源数据的估计）
const SIZE_MB_TIP  = 15         // 大体积阈值（MB）

// 是否把“标题/链接/作者”文本作为节点加入合并转发：
// true = 每一批前都带文字；false = 仅第一批带文字
const HEADER_IN_EACH_BATCH = true

// 定时推送目标：ID 映射类型
const POSTLIST = {
  //1719549416: { type: 'private' },
  857419755:  { type: 'group' },
}
// 秒 分 时 日 月 周  → 例：每天 12:08:30
const AUTO_CRON = '30 8 12 * * *'

// —— sharp 相关选项（可选启用）——
const SHARP_ENABLE          = true      // 开关：true 开启预处理，false 使用原图 URL
const SHARP_OUTPUT_FORMAT   = 'webp'    // 'webp' | 'jpeg'（webp 通常更省）
const SHARP_QUALITY_START   = 82        // 初始质量
const SHARP_QUALITY_MIN     = 50        // 质量下限
const SHARP_MAX_WIDTH       = 1440      // 最大宽
const SHARP_MAX_HEIGHT      = 1920      // 最大高
const SHARP_CROP_TO_RATIO   = true      // 是否裁剪到固定宽高比
const SHARP_TARGET_RATIO    = 3 / 4     // 目标宽高比（例如 3:4 适配竖图）
const SHARP_MAX_BYTES       = 1.6 * 1024 * 1024 // 单图最大体积约 1.6MB（QQ侧更稳）
const SHARP_PROGRESSIVE_JPG = true      // 若选 jpeg，采用渐进式
const SHARP_POSITION        = 'attention' // 'center' | 'attention' 裁剪关注主体
// ===================================================

// —— helpers ——

// 动态获取 segment（优先 icqq，再尝试 oicqq）
async function getSegment() {
  try {
    const m = await import('icqq')
    return m.segment
  } catch {
    const m = await import('oicq')
    return m.segment
  }
}

// 尝试动态引入 sharp（ESM 环境）
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

// 安全数组化：去掉 undefined / null
function arrClean(a) { return (Array.isArray(a) ? a : [a]).filter(v => v !== undefined && v !== null) }

// 取上下文（群 or 私聊）
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

/**
 * 合并转发发送（按模式，不兜底）：
 * - forward-onebot：只尝试 OneBot sendForwardMsg
 * - forward-icqq：  只尝试 icqq makeForwardMsg
 * - forward-auto：  先 OneBot，失败再 icqq（仅此模式允许“回退”）
 * - plain：         不合并，逐条普通消息（谨慎使用，可能更慢）
 */
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
    // 逐条普通消息（注意：这种模式通常更慢、也更容易被限流）
    try {
      // nodesOB/nodesIcqq 的 content 结构一致，这里优先 nodesOB
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

// —— 构建节点 ——

// 文本节点（放进合并转发）
function buildHeaderNodes(headerText, uin, name) {
  const content = arrClean([headerText])
  return {
    nodesOB:   [{ type: 'node', data: { name, uin, content } }],
    nodesIcqq: [{ user_id: uin, nickname: name, message: content }]
  }
}

// 处理单图（sharp 压缩 → base64 → seg.image），失败则回原 URL
async function prepareImageSegment(seg, url, sharp) {
  if (!url || typeof url !== 'string') return null

  // 未启用或未加载 sharp：直接用 URL
  if (!sharp) return seg.image(url)

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'mys-cos-bot/1.0' } })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const ab   = await resp.arrayBuffer()
    let buf    = Buffer.from(ab)
    if (buf.length === 0) throw new Error('empty image buffer')

    // 基础 pipeline
    let pipe = sharp(buf, { failOn: 'none', limitInputPixels: 268402689 }) // ~16k x 16k
      .rotate() // 修正 EXIF 方向
      .withMetadata({ orientation: 1 }) // 移除后续再设
    const meta = await pipe.metadata().catch(() => ({}))

    // 目标宽高与裁剪
    if (SHARP_CROP_TO_RATIO && SHARP_TARGET_RATIO > 0 && meta?.width && meta?.height) {
      // 先按比例计算目标框，再 cover
      const srcW = meta.width, srcH = meta.height
      const wantW = Math.min(SHARP_MAX_WIDTH, srcW)
      const wantH = Math.min(SHARP_MAX_HEIGHT, srcH)
      // 以目标比约束输出尺寸
      let outW = wantW, outH = Math.round(outW / SHARP_TARGET_RATIO)
      if (outH > wantH) { outH = wantH; outW = Math.round(outH * SHARP_TARGET_RATIO) }

      pipe = pipe.resize({
        width: outW,
        height: outH,
        fit: 'cover',
        position: SHARP_POSITION
      })
    } else {
      // 不裁剪，按最长边限制
      pipe = pipe.resize({
        width: SHARP_MAX_WIDTH,
        height: SHARP_MAX_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true
      })
    }

    // 输出格式与质量递减以满足大小限制
    let q = SHARP_QUALITY_START
    let out

    while (true) {
      let cur = pipe.clone()
      if (SHARP_OUTPUT_FORMAT === 'jpeg') {
        cur = cur.jpeg({
          quality: q,
          progressive: SHARP_PROGRESSIVE_JPG,
          optimizeCoding: true,
          mozjpeg: true
        })
      } else {
        // webp
        cur = cur.webp({
          quality: q,
          effort: 4,            // 0-6，越大越慢
          nearLossless: false
        })
      }
      out = await cur.toBuffer()

      if (out.length <= SHARP_MAX_BYTES || q <= SHARP_QUALITY_MIN) break
      q = Math.max(SHARP_QUALITY_MIN, q - 8) // 逐步降质
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

// { url, size, width, height, definition, format, codec } | null
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

// 文本消息（非合并转发）
async function sendText(eOrCtx, text) {
  try {
    if (typeof eOrCtx.reply === 'function') return await eOrCtx.reply(text)
    return await eOrCtx.sendMsg(text)
  } catch (err) {
    Bot.logger?.warn?.('[mys-cos] 文本发送失败：' + (err?.message || err))
  }
}

// ============ 米游社抓取 ============
async function fetchRandomMysPost() {
  const config = [
    { forumId: '49', gameType: '2' }, // 原神
    { forumId: '62', gameType: '6' }, // 星穹铁道
    { forumId: '47', gameType: '5' }, // 崩坏3
    { forumId: '65', gameType: '8' }, // 绝区零
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

// ============ 主流程（一次取一贴并发送） ============
async function runOnceSend(eOrCtx, which = 'cmd', sendMode = SEND_MODE_DEFAULT) {
  const seg   = await getSegment()
  const sharp = await loadSharp() // 可能为 null（未启用或未安装）

  // 仅指令触发时向用户提示失败/空批；定时任务静音，仅写日志
  const notifyOnFail   = (which === 'cmd')
  const notifyNoImage  = (which === 'cmd')

  const result = await fetchRandomMysPost()
  if (!result) return await sendText(eOrCtx, '未获取到米游社数据，请稍后再试~')

  const subject = result?.post?.subject || '(无标题)'
  const postId  = result?.post?.post_id || ''
  const author  = result?.user?.nickname || '(佚名)'
  // 不同区的路径可能不同（ys/sr/bh3/zzz），此处默认 ys，如需严格可按 gids 映射
  const link    = postId ? `https://www.miyoushe.com/ys/article/${postId}` : '(无链接)'
  const headerText = `标题：${subject}\n原帖地址：\n${link}\n作者：${author}`

  // 收集图片
  const urlsAll = collectImageUrls(result).slice(0, MAX_TOTAL)

  // 没有图片就尝试视频（视频不进合并转发/不裁剪）
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

  // 大体积提示（源估计）
  const totalMB = sumImagesMB(result).toFixed(2)
  if (SIZE_TIPS && Number(totalMB) > SIZE_MB_TIP) {
    await sendText(eOrCtx, `检测到原图总体积约 ${totalMB} MB，将进行${sharp ? '压缩' : '发送'}，请稍候~`)
  }

  // 获取上下文对象
  const ctx = typeof eOrCtx.sendMsg === 'function' ? eOrCtx : (eOrCtx.group || eOrCtx.friend)
  if (!ctx) {
    if (typeof eOrCtx.reply === 'function') await eOrCtx.reply('不支持的会话上下文，无法发送~')
    return
  }

  const uin  = String(eOrCtx?.member?.user_id ?? Bot.uin)
  const name = eOrCtx?.member?.nickname ?? (Bot.nickname || 'Yunzai')

  // 分批发送（每批都可带“文字首节点”）
  const batchCount = Math.ceil(urlsAll.length / BATCH_SIZE)
  for (let i = 0; i < urlsAll.length; i += BATCH_SIZE) {
    const batch = urlsAll.slice(i, i + BATCH_SIZE)
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1

    // 构建图片节点（先 sharp，再转 segment）
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
      // 仅指令触发时提示“这一批没有可发送的图片，已跳过~”；定时任务静音
      if (notifyNoImage) {
        await sendText(eOrCtx, '这一批没有可发送的图片，已跳过~')
      } else {
        Bot.logger?.warn?.('[mys-cos] 这一批没有可发送的图片，已跳过（cron 静音）。')
      }
    } else {
      // 是否在该批前插入“文字首节点”
      const needHeader = HEADER_IN_EACH_BATCH || i === 0
      let ob = nodesOB, iq = nodesIcqq
      if (needHeader) {
        const headerNodes = buildHeaderNodes(headerText, uin, name)
        ob = [...headerNodes.nodesOB, ...nodesOB]
        iq = [...headerNodes.nodesIcqq, ...nodesIcqq]
      }

      // 单次尝试发送（不重试、不跨模式兜底，除非 forward-auto）
      const ok = await sendByMode(ctx, sendMode, ob, iq)
      if (!ok) {
        Bot.logger?.error?.(`[mys-cos] 发送失败（模式=${sendMode}），已跳过该批。`)
        // 仅指令触发时提示失败；定时任务静音
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

// ============ 插件类 ============
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

    // 定时任务（可选）
    schedule.scheduleJob(AUTO_CRON, async () => {
      Bot.logger?.mark?.('[mys-cos][定时] 开始发送')
      try {
        for (const [id, info] of Object.entries(POSTLIST)) {
          const ctx = getCtxByType(info.type, id)
          if (!ctx) {
            Bot.logger?.warn?.(`[mys-cos][定时] 无法获取上下文：${info.type} ${id}`)
            continue
          }
          await runOnceSend(ctx, 'cron', SEND_MODE_DEFAULT) // 定时任务：which='cron' → 静音提示
          await new Promise(r => setTimeout(r, 10_000))
        }
      } catch (err) {
        Bot.logger?.error?.('[mys-cos][定时] 失败：' + (err?.message || err))
      }
      Bot.logger?.mark?.('[mys-cos][定时] 结束')
    })
  }

  // 指令触发
  async cos (e) {
    try {
      const mode = parseModeFromMsg(e?.msg, SEND_MODE_DEFAULT)
      await runOnceSend(e, 'cmd', mode) // 指令触发：which='cmd' → 保留提示
    } catch (err) {
      Bot.logger?.error?.('[mys-cos] 指令失败：' + (err?.stack || err))
      await e.reply('本小姐被风控/超时绊了一跤，等会儿再来~')
    }
    return true
  }
}

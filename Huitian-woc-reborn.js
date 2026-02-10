/**
 * ys-woc-Reborn – WP抓图 → 分批合并转发
 * 核心改动：
 * 1) FORCE_BASE64=true：彻底规避远端证书。
 * 2) PREFER_ICQQ_FORWARD=true：优先用 icqq 合并转发。
 * 3) 动态读取 X-WP-TotalPages，精准随机不越界，避免无限重复第1页。
 */

import plugin from '../../lib/plugins/plugin.js'
import sharp from 'sharp' 

// ===================== 可调参数 =====================
const BATCH_SIZE   = 5          // 每批张数
const DELAY_MS     = 1600       // 批间隔
const MAX_TOTAL    = 10         // 本次最多发送几张
const USE_SHARP    = true       // 使用 sharp 压缩
const FORCE_BASE64 = true       // 强制所有图片转 base64 发送
const PREFER_ICQQ_FORWARD = true // 优先 icqq 合并转发
const FETCH_TIMEOUT_MS = 100000  // 拉图超时
const JPEG_WIDTH   = 1080       // 压缩宽度
const JPEG_QUALITY = 70         // 压缩质量
// ===================================================

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

// === 新增：轻量级获取网站图片总页数 ===
async function getWpMaxPage () {
  try {
    // 只请求 1 条数据，速度极快，专为了骗取 Header 里的 X-WP-TotalPages
    const r = await fetch('https://shaonvzhi.top/wp-json/wp/v2/media?media_type=image&per_page=100', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const totalPages = Number(r.headers.get('x-wp-totalpages'))
    if (totalPages > 0) {
      Bot?.logger?.mark?.(`[woc] 成功获取目标网站总页数：${totalPages} 页`)
      return totalPages
    }
  } catch (e) {
    Bot?.logger?.warn?.('[woc] 获取总页数失败，使用默认值: ' + e)
  }
  return 20 // 兜底：如果获取失败，先猜它有20页
}

async function fetchWpImagesPage (page) {
  const perPage = 100
  const api =
    `https://shaonvzhi.top/wp-json/wp/v2/media` +
    `?media_type=image&per_page=${perPage}&page=${page}` +
    `&_fields=source_url,post,mime_type`

  const r = await fetch(api, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  })

  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const raw = await r.text()

  if (!r.ok) {
    throw new Error(`抓取媒体失败 HTTP ${r.status} ct=${ct} head=${raw.slice(0, 200)}`)
  }

  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw new Error(`媒体接口非JSON ct=${ct} head=${raw.slice(0, 200)}`)
  }

  if (!Array.isArray(j)) {
    const code = j?.code ? `code=${j.code}` : ''
    const msg  = j?.message ? `msg=${j.message}` : ''
    throw new Error(`媒体接口返回非数组 ${code} ${msg}`.trim())
  }

  const byPost = new Map()
  for (const it of j) {
    const url = it?.source_url
    if (!url) continue
    const pid = Number(it?.post || 0)
    if (pid <= 0) continue
    const key = String(pid)
    if (!byPost.has(key)) byPost.set(key, [])
    byPost.get(key).push(url)
  }

  let urlsArr = Array.from(byPost.values()).map(arr => Array.from(new Set(arr)))

  if (urlsArr.length === 0) {
    const all = Array.from(new Set(j.map(x => x?.source_url).filter(Boolean)))
    if (all.length) urlsArr = [all]
  }

  return urlsArr
}

async function fetchArrayBuffer (url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const buf = await r.arrayBuffer()
    return buf
  } finally {
    clearTimeout(t)
  }
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
      dsc: 'WP抓图→分批合并转发（强制base64 & 优先icqq）',
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

      // ===== 1) 读取/补充缓存 =====
      let redisPicArr = await redis.get('ys:woc:pic')
      if (!redisPicArr || redisPicArr === '[]') {
        await e.reply('本小姐补魔中，一会就好！')

        // --- 获取并缓存真实的最大页数 ---
        let maxPage = await redis.get('ys:woc:max_page')
        if (!maxPage) {
          maxPage = await getWpMaxPage()
          // 存入 Redis，有效期 12 小时 (43200秒)
          await redis.set('ys:woc:max_page', String(maxPage))
          await redis.expire('ys:woc:max_page', 43200) 
        }

        let urlsArr = []
        // 现在是在真实的页数范围内绝对均匀随机了！
        const randomPage = 1 + Math.floor(Math.random() * Number(maxPage))
        
        try {
          urlsArr = await fetchWpImagesPage(randomPage)
        } catch (err) {
          // 兜底：万一网站刚删了图导致页数变少，报 400 还是退回第 1 页
          if (String(err).includes('400') || String(err).includes('page_number')) {
            Bot?.logger?.warn?.(`[woc] 动态页码 ${randomPage} 超出，降级抓取第 1 页...`)
            urlsArr = await fetchWpImagesPage(1)
          } else {
            throw err
          }
        }

        await redis.set('ys:woc:pic', JSON.stringify(urlsArr))
        redisPicArr = await redis.get('ys:woc:pic')
      }

      // ===== 2) 取一组 URL =====
      const parseArr = JSON.parse(redisPicArr || '[]')
      if (!Array.isArray(parseArr) || parseArr.length === 0) {
        return e.reply('本小姐没有可用的资源，稍后再试~')
      }

      let urls = parseArr.shift() || []
      await redis.set('ys:woc:pic', JSON.stringify(parseArr))

      urls = Array.from(new Set(urls)).filter(u => /^https?:\/\//i.test(u)).slice(0, MAX_TOTAL)
      if (urls.length === 0) return e.reply('这组没有有效图片，换一组吧~')

      try {
        const hosts = Array.from(new Set(urls.map(u => { try { return new URL(u).host } catch { return 'bad' } })))
        Bot?.logger?.warn?.('[woc] 本批图片域名：' + hosts.join(', '))
      } catch {}

      await e.reply(`本小姐共找来 ${urls.length} 张（将分批发送）`)

      // ===== 3) 获取上下文 & 发送参数 =====
      const ctx  = e.group || e.friend
      if (!ctx) return e.reply('不支持的会话类型')

      const uin  = String(e.member?.user_id ?? Bot.uin)
      const name = e.member?.nickname ?? (Bot.nickname || 'Yunzai')
      const batchCount = Math.ceil(urls.length / BATCH_SIZE)
      const sharpLib = await loadSharp()

      // ===== 4) 分批发送 =====
      for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const batch = urls.slice(i, i + BATCH_SIZE)

        const refs = []
        for (const u of batch) {
          let dataUrl = null
          try {
            const arr = await fetchArrayBuffer(u)
            dataUrl = await toBase64DataURL(sharpLib, arr)
          } catch (err) {
            Bot?.logger?.warn?.(`[woc] 拉取/编码失败，改为文本链接：${u} -> ${err?.code || err?.message || err}`)
          }
          if (dataUrl) {
            refs.push(dataUrl)
          } else {
            refs.push(null)
          }
        }

        const realImgRefs = refs.filter(x => typeof x === 'string')
        const { nodesOB, nodesIcqq } = buildNodes(
          realImgRefs, Math.floor(i / BATCH_SIZE) + 1, batchCount, seg, uin, name
        )

        if (realImgRefs.length > 0) {
          let sent = false
          try {
            await sendForward(e, ctx, nodesOB, nodesIcqq)
            sent = true
          } catch (err) {
            Bot?.logger?.warn?.('本小姐合并转发失败，准备重试：' + (err?.message || err))
            await new Promise(r => setTimeout(r, 1200))
            try {
              await sendForward(e, ctx, nodesOB, nodesIcqq)
              sent = true
            } catch (err2) {
              Bot?.logger?.error?.('本小姐重试仍失败，降级为逐条图。')
              for (const n of nodesOB) {
                if (typeof ctx.sendMsg === 'function') {
                  await ctx.sendMsg(n.data.content)
                } else {
                  await e.reply(n.data.content)
                }
                await new Promise(r => setTimeout(r, 800))
              }
              sent = true
            }
          }
          if (!sent) await e.reply('这一批图片发送失败了~')
        }

        const failedUrls = batch.filter((_, idx) => !refs[idx])
        for (const bad of failedUrls) {
          await e.reply('有图片源站证书异常，改为链接：' + bad)
          await new Promise(r => setTimeout(r, 500))
        }

        if (i + BATCH_SIZE < urls.length) {
          await new Promise(r => setTimeout(r, DELAY_MS))
        }
      }
    } catch (err) {
      Bot?.logger?.error?.('[woc] 发送失败: ' + (err?.stack || err))
      await e.reply('本小姐被风控/超时绊了一跤，等会儿再来~')
    }
  }
}
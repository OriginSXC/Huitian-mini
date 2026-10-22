/**
 * Huitian-mini · xjj R18 扩展
 *
 * 图源 / 视频源：Fantasy Factory（h5ai 目录站，https://www.fantasyfactory.xyz/）
 * 站点是纯静态目录索引：顶层是月份文件夹（2018.10 ~ 2022.12），月份下是套图文件夹，
 * 少数月份和三个中文合集会直接平铺图片。没有 JSON 接口，直接解析 h5ai 的 fallback
 * HTML 表格（JS 渲染失败时输出的那份，结构稳定）。视频文件零星散落在部分目录里。
 *
 * 与 Huitian-xjj.js 的关系：命令前缀独立（#r18 / #xjjr18），不改动原插件逻辑。
 */
import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { execFile } from 'child_process'
import Config from './config/config.js'
import { senderOf } from './utils/botcompat.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('xjj_r18')

const numOr = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d)
const listOr = (v, d) => (Array.isArray(v) && v.length ? v.map(String) : d)

const ENABLE             = cfg.ENABLE ?? true
const PRIVATE_ONLY       = cfg.PRIVATE_ONLY ?? true   // true：R18 只在私聊放开，群聊不接话
const GROUP_SILENT       = cfg.GROUP_SILENT ?? false  // true：群里静默放行；false：回一句提示
const BASE_URL           = String(cfg.BASE_URL || 'https://www.fantasyfactory.xyz').replace(/\/+$/, '')

const IMG_COUNT_MIN      = numOr(cfg.IMG_COUNT_MIN, 3)
const IMG_COUNT_MAX      = numOr(cfg.IMG_COUNT_MAX, 6)
const BATCH_SIZE         = numOr(cfg.BATCH_SIZE, 4)
const DELAY_MS           = numOr(cfg.DELAY_MS, 1200)

const USE_SHARP          = cfg.USE_SHARP ?? true
const SHARP_QUALITY      = numOr(cfg.SHARP_QUALITY, 72)
const SHARP_WIDTH        = numOr(cfg.SHARP_WIDTH, 1080)
const SHARP_MAX_BYTES    = numOr(cfg.SHARP_MAX_BYTES, 1600 * 1024)

const FETCH_TIMEOUT      = numOr(cfg.FETCH_TIMEOUT, 15000)
const DOWNLOAD_TIMEOUT   = numOr(cfg.DOWNLOAD_TIMEOUT, 30000)
const DOWNLOAD_RETRY     = numOr(cfg.DOWNLOAD_RETRY, 2)
const DOWNLOAD_GAP_MS    = numOr(cfg.DOWNLOAD_GAP_MS, 200)
const REFILL_BUDGET      = numOr(cfg.REFILL_BUDGET, 20)
const PICK_ORDER         = String(cfg.PICK_ORDER ?? 'random').toLowerCase()

const INDEX_TTL_HOURS    = numOr(cfg.INDEX_TTL_HOURS, 24)
const INDEX_MAX_MONTHS   = numOr(cfg.INDEX_MAX_MONTHS, 0)   // 0 = 全部月份
const INDEX_CONCURRENCY  = numOr(cfg.INDEX_CONCURRENCY, 3)
const INDEX_GAP_MS       = numOr(cfg.INDEX_GAP_MS, 150)
const SET_MEDIA_TTL_MIN  = numOr(cfg.SET_MEDIA_TTL_MIN, 120)
const SET_CACHE_MAX      = numOr(cfg.SET_CACHE_MAX, 60)

const VIDEO_ENABLE       = cfg.VIDEO_ENABLE ?? true
const VIDEO_SYNTH        = cfg.VIDEO_SYNTH ?? true
const VIDEO_SYNTH_IMAGES = numOr(cfg.VIDEO_SYNTH_IMAGES, 10)
const VIDEO_SEC_PER_IMG  = numOr(cfg.VIDEO_SEC_PER_IMG, 2)
const VIDEO_WIDTH        = numOr(cfg.VIDEO_WIDTH, 1080)
const VIDEO_HEIGHT       = numOr(cfg.VIDEO_HEIGHT, 1920)
const FFMPEG_PATH        = String(cfg.FFMPEG_PATH || 'ffmpeg')
const FFMPEG_QUIET       = cfg.FFMPEG_QUIET ?? true   // 没有 ffmpeg 时只记一条 mark，不刷 warn
const VIDEO_TIMEOUT_MS   = numOr(cfg.VIDEO_TIMEOUT_MS, 180000)
const MAX_VIDEO_BYTES    = numOr(cfg.MAX_VIDEO_BYTES, 60 * 1024 * 1024)
const VIDEO_PREFER_BYTES = numOr(cfg.VIDEO_PREFER_BYTES, 25 * 1024 * 1024)  // 优先挑这个体积以下的，发得快
// 站点自带的视频是静态文件、路径固定，直接内置一份种子清单，省掉"随机翻 200 个目录找视频"。
// 想加就按 /2020.10/Special%20selfie/xxx.mp4 的格式往里塞。
const VIDEO_SEEDS        = listOr(cfg.VIDEO_SEEDS, [])
// =============================

const DATA_DIR  = path.join(process.cwd(), 'plugins', 'Huitian-mini', 'data')
const INDEX_FILE = path.join(DATA_DIR, 'xjj-r18-index.json')
const TMP_DIR   = path.join(process.cwd(), 'temp')

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i
const VID_EXT = /\.(mp4|m4v|mov|mkv|webm)$/i

const USER_AGENT_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
]

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8, rejectUnauthorized: false })
const pickAgent = (url) => (String(url?.href ?? url).startsWith('https:') ? httpsAgent : httpAgent)

// ====== 小工具 ======
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const pickOne = (arr) => arr[randInt(0, arr.length - 1)]
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const pickUA = () => pickOne(USER_AGENT_LIST)

function shuffle (arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function mapLimit (list, limit, fn) {
  const out = new Array(list.length)
  let next = 0
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i) } }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker))
  return out
}

function errText (err) {
  if (err instanceof Error) return err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

function decodeEnt (s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
}

const absolute = (href) => (/^https?:/i.test(href) ? href : BASE_URL + (href.startsWith('/') ? href : '/' + href))

// ====== HTTP ======
async function fetchText (url, timeoutMs = FETCH_TIMEOUT, retry = 1) {
  const abs = absolute(url)
  for (let i = 0; i <= retry; i++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(abs, {
        signal: ctrl.signal,
        agent: pickAgent,
        redirect: 'follow',
        headers: { 'User-Agent': pickUA(), 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
      })
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && i < retry) { await sleep(600 * (i + 1)); continue }
        return null
      }
      return await res.text()
    } catch {
      if (i < retry) { await sleep(500 * (i + 1)); continue }
      return null
    } finally { clearTimeout(t) }
  }
  return null
}

async function fetchBuffer (url, timeoutMs = DOWNLOAD_TIMEOUT, retry = DOWNLOAD_RETRY) {
  const abs = absolute(url)
  for (let i = 0; i <= retry; i++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(abs, {
        signal: ctrl.signal, agent: pickAgent, redirect: 'follow',
        headers: { 'User-Agent': pickUA(), 'Referer': BASE_URL + '/' }
      })
      if (!res.ok) {
        if ((res.status === 429 || res.status === 408 || res.status >= 500) && i < retry) {
          await sleep(800 * 2 ** i + randInt(0, 300))
          continue
        }
        return null
      }
      return Buffer.from(await res.arrayBuffer())
    } catch {
      if (i < retry) { await sleep(800 * 2 ** i + randInt(0, 300)); continue }
      return null
    } finally { clearTimeout(t) }
  }
  return null
}

function isImageBuffer (buf) {
  if (!buf || buf.length < 1024) return false
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf.readUInt32BE(0) === 0x89504e47) return true
  if (buf.toString('ascii', 0, 3) === 'GIF') return true
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
}

// ====== h5ai 目录解析 ======
// fallback table 形如：<td class="fb-n"><a href="/2022.12/fairy%20maid/">fairy maid</a>
const RE_ENTRY = /<td class="fb-n"><a href="([^"]+)"[^>]*>([^<]*)<\/a>/g

function parseListing (html, parentHref) {
  const dirs = []
  const files = []
  if (!html) return { dirs, files }
  let m
  RE_ENTRY.lastIndex = 0
  while ((m = RE_ENTRY.exec(html)) !== null) {
    const href = decodeEnt(m[1])
    const name = decodeEnt(m[2]).trim()
    if (!href || /^https?:/i.test(href) || href === '..' || href.endsWith('/..') || !name || name === '..') continue
    if (href.endsWith('/')) dirs.push({ name, href })
    else files.push({ name, href })
  }
  return { dirs, files }
}

async function listDir (href) {
  const html = await fetchText(href, FETCH_TIMEOUT, 1)
  return parseListing(html, href)
}

// ====== 索引 ======
let index = null

function loadIndexFromDisk () {
  try {
    if (!fs.existsSync(INDEX_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
    if (!raw || raw.base !== BASE_URL || !Array.isArray(raw.sets) || !raw.sets.length) return null
    return raw
  } catch (err) {
    Bot?.logger?.warn?.(`[xjj-r18] 索引读取失败：${errText(err)}`)
    return null
  }
}

function saveIndexToDisk (data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = INDEX_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, INDEX_FILE)
  } catch (err) {
    Bot?.logger?.warn?.(`[xjj-r18] 索引写入失败：${errText(err)}`)
  }
}

async function buildIndex (force = false) {
  const cached = loadIndexFromDisk()
  const fresh = cached && (Date.now() - cached.builtAt) < INDEX_TTL_HOURS * 3600e3
  if (cached && fresh && !force) return cached
  if (index && !force && (Date.now() - index.builtAt) < INDEX_TTL_HOURS * 3600e3) return index

  const root = await listDir('/')
  let months = root.dirs
  if (!months.length) {
    Bot?.logger?.warn?.('[xjj-r18] 根目录解析为空，站点结构可能变了')
    return cached || { base: BASE_URL, builtAt: Date.now(), months: [], sets: [] }
  }
  // 月份名形如 2022.12 的是主流目录，中文合集（島風 / 慾茶園 …）排后面，
  // 这样 INDEX_MAX_MONTHS 截断时保留的确实是最近的月份。
  const isMonth = (n) => /^\d{4}\.\d{2}/.test(n)
  months = months.slice().sort((a, b) => {
    const am = isMonth(a.name); const bm = isMonth(b.name)
    if (am !== bm) return am ? -1 : 1
    return b.name.localeCompare(a.name)
  })
  if (INDEX_MAX_MONTHS > 0) months = months.slice(0, INDEX_MAX_MONTHS)

  const sets = []
  const monthMeta = []
  await mapLimit(months, INDEX_CONCURRENCY, async (m) => {
    const body = await listDir(m.href)
    const images = body.files.filter(f => IMG_EXT.test(f.name))
    const videos = body.files.filter(f => VID_EXT.test(f.name))
    let count = 0

    if (body.dirs.length) {
      for (const d of body.dirs) sets.push({ month: m.name, name: d.name, href: d.href, flat: false })
      count = body.dirs.length
    }
    // 平铺目录（有的月份把整套图直接摊在月份文件夹里）
    if (images.length || videos.length) {
      sets.push({ month: m.name, name: m.name, href: m.href, flat: true, images: images.length, videos: videos.length })
      if (!body.dirs.length) count = 1
    }
    if (videos.length) {
      for (const v of videos) {
        sets.push({ month: m.name, name: v.name, href: v.href, flat: true, isVideo: true })
      }
    }
    if (!count && (images.length || videos.length)) count = 1
    monthMeta.push({ name: m.name, href: m.href, sets: count })
    await sleep(INDEX_GAP_MS)
  })

  // mapLimit 是并发跑的，monthMeta 保持抓取完成顺序，列表展示前按月份重新排一遍
  monthMeta.sort((a, b) => {
    const am = isMonth(a.name); const bm = isMonth(b.name)
    if (am !== bm) return am ? -1 : 1
    return b.name.localeCompare(a.name)
  })

  const data = { base: BASE_URL, builtAt: Date.now(), months: monthMeta, sets }
  index = data
  saveIndexToDisk(data)
  Bot?.logger?.mark?.(`[xjj-r18] 索引已更新：${data.months.length} 个月份 / ${sets.length} 个套图`)
  return data
}

async function getIndex () {
  if (index && (Date.now() - index.builtAt) < INDEX_TTL_HOURS * 3600e3) return index
  return await buildIndex(false)
}

// ====== 套图内媒体（带内存缓存） ======
const mediaCache = new Map() // href -> { at, images, videos }

async function getSetMedia (href) {
  const hit = mediaCache.get(href)
  if (hit && Date.now() - hit.at < SET_MEDIA_TTL_MIN * 60e3) return hit

  let body = await listDir(href)
  let images = body.files.filter(f => IMG_EXT.test(f.name)).map(f => f.href)
  let videos = body.files.filter(f => VID_EXT.test(f.name)).map(f => f.href)

  // 套图里再套一层（少数目录如此），往下走一层
  if (!images.length && !videos.length && body.dirs.length) {
    for (const d of body.dirs.slice(0, 3)) {
      const sub = await listDir(d.href)
      images = images.concat(sub.files.filter(f => IMG_EXT.test(f.name)).map(f => f.href))
      videos = videos.concat(sub.files.filter(f => VID_EXT.test(f.name)).map(f => f.href))
      await sleep(INDEX_GAP_MS)
    }
  }

  const entry = { at: Date.now(), images, videos }
  mediaCache.set(href, entry)
  if (mediaCache.size > SET_CACHE_MAX) {
    const oldest = [...mediaCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) mediaCache.delete(oldest[0])
  }
  return entry
}

// ====== 图片下载与压缩 ======
let sharpLib
async function loadSharp () {
  if (!USE_SHARP) return null
  if (sharpLib === undefined) {
    try { sharpLib = (await import('sharp')).default }
    catch { sharpLib = null; Bot?.logger?.warn?.('[xjj-r18] 未找到 sharp，图片将不压缩直接发送') }
  }
  return sharpLib
}

async function downloadImage (href) {
  let buffer = await fetchBuffer(href)
  if (!isImageBuffer(buffer)) return null

  const hash = crypto.createHash('md5').update(buffer).digest('hex')
  const sharp = await loadSharp()
  if (sharp) {
    try {
      let out = await sharp(buffer).rotate()
        .resize({ width: SHARP_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: SHARP_QUALITY, progressive: true, mozjpeg: true })
        .toBuffer()
      if (out.length > SHARP_MAX_BYTES) {
        out = await sharp(buffer).rotate()
          .resize({ width: Math.round(SHARP_WIDTH * 0.75), withoutEnlargement: true })
          .jpeg({ quality: Math.max(55, SHARP_QUALITY - 12), progressive: true })
          .toBuffer()
      }
      buffer = out
    } catch {}
  }
  return { b64: `base64://${buffer.toString('base64')}`, hash }
}

async function collectImages (hrefs, want) {
  const picked = PICK_ORDER === 'order'
    ? hrefs.slice(0, want)
    : PICK_ORDER === 'reverse'
      ? hrefs.slice(-want).reverse()
      : shuffle(hrefs).slice(0, want)

  const images = []
  const seen = new Set()
  let tried = 0
  for (let i = 0; i < picked.length && images.length < want; i += BATCH_SIZE) {
    const chunk = picked.slice(i, i + BATCH_SIZE)
    tried += chunk.length
    const got = (await mapLimit(chunk, BATCH_SIZE, downloadImage)).filter(Boolean)
    for (const img of got) {
      if (seen.has(img.hash)) continue
      seen.add(img.hash)
      images.push(img.b64)
    }
    if (DOWNLOAD_GAP_MS > 0 && images.length < want) await sleep(DOWNLOAD_GAP_MS)
    if (tried >= REFILL_BUDGET) break
  }
  return images
}

// ====== 视频 ======
function ffmpeg (args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    try {
      execFile(
        FFMPEG_PATH,
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => finish({
          ok: !err,
          err,
          missing: err?.code === 'ENOENT',
          out: String(stderr || stdout || '')
        })
      )
    } catch (err) {
      // 二进制根本不存在时连 execFile 都可能同步抛，直接当成"没有 ffmpeg"
      finish({ ok: false, err, missing: err?.code === 'ENOENT', out: '' })
    }
  })
}

// 没有 ffmpeg 不算故障：合成功能静默降级，站点自带的视频和图片照发。
// 只记一条 mark（不是 warn），装不上 ffmpeg 的机器上不会刷错误日志。
let ffmpegChecked = null
async function ffmpegAvailable () {
  if (ffmpegChecked !== null) return ffmpegChecked
  if (!VIDEO_ENABLE || !VIDEO_SYNTH) { ffmpegChecked = false; return false }
  const r = await ffmpeg(['-version'], 10000)
  ffmpegChecked = r.ok
  if (!r.ok) {
    const msg = `[xjj-r18] 没有可用的 ffmpeg（${FFMPEG_PATH}${r.missing ? ' 未安装' : ''}），视频合成自动跳过，其它功能照常`
    if (FFMPEG_QUIET) Bot?.logger?.mark?.(msg)
    else Bot?.logger?.warn?.(msg)
  }
  return ffmpegChecked
}

function ffmpegNote (msg) {
  if (FFMPEG_QUIET) Bot?.logger?.mark?.(msg)
  else Bot?.logger?.warn?.(msg)
}

// 用 Range 探一下文件总大小；站点里有 40MB+ 的老视频，直发容易把协议端拖死
async function probeSize (href) {
  try {
    const res = await fetch(absolute(href), {
      agent: pickAgent,
      headers: { 'User-Agent': pickUA(), 'Range': 'bytes=0-0', 'Referer': BASE_URL + '/' }
    })
    if (res.status !== 206 && !res.ok) return -1
    const cr = res.headers.get('content-range')
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr)
      if (m) return Number(m[1])
    }
    const cl = res.headers.get('content-length')
    return cl ? Number(cl) : -1
  } catch { return -1 }
}

// 从候选里挑一个体积合适的视频直链：
// 站点里有 48MB 的老视频和 .mov 文件，协议端发 .mov 常不认、发大文件容易超时，
// 所以先探体积，优先 mp4/webm、优先小文件。
async function pickSendableVideo (hrefs, limit = 6) {
  const rank = (h) => (/\.(mp4|webm)$/i.test(h) ? 0 : 1)
  const ordered = hrefs
    .map((h, i) => ({ h, i, r: rank(h) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map(x => x.h)

  const probed = []
  for (const href of ordered) {
    const size = await probeSize(href)
    if (size > 0 && size > MAX_VIDEO_BYTES) {
      Bot?.logger?.mark?.(`[xjj-r18] 跳过 ${(size / 1048576).toFixed(1)}MB 的大视频 ${href}`)
      continue
    }
    probed.push({ href, size: size > 0 ? size : Number.MAX_SAFE_INTEGER })
  }
  if (!probed.length) return null

  const light = probed.filter(p => p.size <= VIDEO_PREFER_BYTES)
  if (light.length) return pickOne(light).href
  probed.sort((a, b) => a.size - b.size)
  return probed[0].href
}

// 把一套图压成竖屏幻灯片 mp4：先统一尺寸，再用 concat demuxer 拼
async function synthesizeVideo (hrefs, label) {
  if (!VIDEO_ENABLE || !VIDEO_SYNTH) return null
  if (!await ffmpegAvailable()) return null
  const sharp = await loadSharp()
  if (!sharp) return null
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

  const frames = shuffle(hrefs).slice(0, VIDEO_SYNTH_IMAGES)
  if (!frames.length) return null

  const workDir = path.join(TMP_DIR, `xjjr18_${Date.now()}_${randInt(1000, 9999)}`)
  fs.mkdirSync(workDir, { recursive: true })
  const outFile = path.join(workDir, 'out.mp4')
  const listFile = path.join(workDir, 'list.txt')

  try {
    const frameFiles = []
    let idx = 0
    for (const href of frames) {
      const buf = await fetchBuffer(href)
      if (!isImageBuffer(buf)) continue
      const jpg = path.join(workDir, `f${String(idx).padStart(3, '0')}.jpg`)
      try {
        await sharp(buf).rotate()
          .resize({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT, fit: 'cover', position: 'attention' })
          .jpeg({ quality: 88 })
          .toFile(jpg)
        frameFiles.push(jpg)
        idx++
      } catch {}
      if (DOWNLOAD_GAP_MS > 0) await sleep(DOWNLOAD_GAP_MS)
    }
    if (frameFiles.length < 2) return null

    const lines = []
    for (const f of frameFiles) {
      lines.push(`file '${f.replace(/'/g, "'\\''")}'`)
      lines.push(`duration ${VIDEO_SEC_PER_IMG}`)
    }
    lines.push(`file '${frameFiles[frameFiles.length - 1].replace(/'/g, "'\\''")}'`)
    fs.writeFileSync(listFile, lines.join('\n'))

    const r = await ffmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', 'fps=25,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-movflags', '+faststart', '-an', outFile
    ], VIDEO_TIMEOUT_MS)
    if (!r.ok || !fs.existsSync(outFile)) {
      ffmpegNote(`[xjj-r18] 视频合成没成功（${r.missing ? 'ffmpeg 不可用' : r.out.slice(-200)}），本次跳过`)
      return null
    }
    const size = fs.statSync(outFile).size
    if (size > MAX_VIDEO_BYTES) {
      Bot?.logger?.mark?.(`[xjj-r18] 合成视频 ${(size / 1048576).toFixed(1)}MB 超出上限，丢弃`)
      return null
    }
    Bot?.logger?.mark?.(`[xjj-r18] 已合成视频 ${label} ${frameFiles.length} 帧 ${(size / 1048576).toFixed(1)}MB`)
    return outFile
  } catch (err) {
    ffmpegNote(`[xjj-r18] 视频合成异常，本次跳过：${errText(err)}`)
    return null
  }
}

// ====== R18 门控 ======
function isPrivateChat (e) {
  if (e?.isGroup === true) return false
  if (e?.group_id) return false
  if (e?.isPrivate === true) return true
  if (e?.message_type === 'private') return true
  return !!e?.friend && !e?.group
}

function r18Allowed (e) {
  if (!ENABLE) return false
  if (!PRIVATE_ONLY) return true
  return isPrivateChat(e)
}

// ====== 防刷屏 ======
const busy = new Map()
const BUSY_TTL = 4 * 60e3
const busyKey = (e) => (e.group_id ? `g${e.group_id}` : `u${e.user_id}`)

// ====== 选套图 ======
function pickSets (data, keyword) {
  const all = data.sets.filter(s => !s.isVideo)
  if (!all.length) return []
  if (!keyword) return all

  const kw = keyword.trim().toLowerCase()
  const hits = all.filter(s =>
    String(s.name).toLowerCase().includes(kw) || String(s.month).toLowerCase().includes(kw)
  )
  return hits
}

// ====== 发送 ======
async function getSegment () {
  if (global.segment) return global.segment
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

function assertSent (res, how) {
  const bad = res == null || res === false || res?.status === 'failed' || (res?.retcode != null && res.retcode !== 0)
  if (bad) throw new Error(`${how} 无有效回执`)
  return res
}

async function sendImages (e, images, title) {
  const seg = await getSegment()
  const sender = senderOf(e)
  const ctx = e.group || e.friend

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const nodes = images.slice(i, i + BATCH_SIZE).map((b64, k) => ({
      user_id: sender.uin,
      nickname: title,
      message: [`第 ${i + k + 1} 张`, seg.image(b64)]
    }))
    try {
      if (typeof ctx?.makeForwardMsg === 'function') {
        const msg = await ctx.makeForwardMsg(nodes)
        if (typeof ctx.sendMsg === 'function') assertSent(await ctx.sendMsg(msg), 'makeForwardMsg')
        else assertSent(await e.reply(msg), 'makeForwardMsg')
      } else {
        for (const n of nodes) assertSent(await e.reply(n.message), 'plain')
      }
    } catch (err) {
      Bot?.logger?.warn?.(`[xjj-r18] 合并转发失败，改逐条：${errText(err)}`)
      for (const n of nodes) { try { await e.reply(n.message) } catch {} }
    }
    if (i + BATCH_SIZE < images.length) await sleep(DELAY_MS)
  }
}

// 自检钩子：对象字面量没有 prototype，Yunzai loader 的 lodash.forEach 会直接跳过，
// 不会被当成插件类 new 出来。只给离线脚本用，运行时无副作用。
export const __internals = Object.freeze({
  ffmpegAvailable,
  synthesizeVideo,
  getIndex,
  listDir,
  collectImages,
  parseListing,
  pickSendableVideo
})

// ====== 命令前缀 ======
// 主命令：#r18xjj（图片）、#r18xjjpro（视频），与原 xjj 插件的 aaa / aaapro 风格一致
const CMD = String(cfg.CMD_PREFIX || 'r18xjj')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const CMD_RE = esc(CMD)
// 去掉命令前缀后剩下的关键词（pro 也一并吃掉）
const stripCmd = (msg) => String(msg || '')
  .replace(new RegExp(`^#?\\s*${CMD_RE}\\s*(?:pro)?\\s*`, 'i'), '')
  .trim()

// ====== 插件本体 ======
export class xjjR18 extends plugin {
  constructor () {
    super({
      name: '小姐姐-R18扩展(Fantasy Factory)',
      dsc: 'xjj 插件的 R18 档：随机套图 / 关键词检索 / 视频（pro）',
      event: 'message',
      priority: 5100,
      rule: [
        { reg: new RegExp(`^#?${CMD_RE}(?:列表|目录|月份|月份列表)\\s*$`, 'i'), fnc: 'r18List' },
        { reg: new RegExp(`^#?${CMD_RE}pro(?:\\s+\\S.*)?\\s*$`, 'i'), fnc: 'r18Video' },
        { reg: new RegExp(`^#?${CMD_RE}(?:视频|片|vid)\\s*$`, 'i'), fnc: 'r18Video' },
        { reg: new RegExp(`^#?${CMD_RE}(?:图片|图)?\\s*$`, 'i'), fnc: 'r18Random' },
        { reg: new RegExp(`^#?${CMD_RE}\\s+(\\S.*)$`, 'i'), fnc: 'r18Search' }
      ]
    })
  }

  async gate (e) {
    if (!r18Allowed(e)) {
      if (!GROUP_SILENT) await e.reply('R18 图源只在私聊开放，群里就别点了~')
      return false
    }
    return true
  }

  async runExclusive (e, fn) {
    const key = busyKey(e)
    const since = busy.get(key)
    if (since && Date.now() - since < BUSY_TTL) {
      await e.reply('上一单还在拉，稍等一下~')
      return true
    }
    busy.set(key, Date.now())
    try { return await fn() } finally { busy.delete(key) }
  }

  // #r18 列表
  async r18List (e) {
    if (!await this.gate(e)) return true
    return this.runExclusive(e, async () => {
      let data
      try { data = await buildIndex(false) } catch (err) {
        return e.reply(`索引拉取失败：${errText(err)}`)
      }
      if (!data.months.length) return e.reply('站点目录没解析出来，可能结构变了~')

      const lines = ['Fantasy Factory 目录：']
      for (const m of data.months.slice(0, 60)) lines.push(`${m.name}  ${m.sets} 套`)
      lines.push('')
      lines.push(`共 ${data.months.length} 个月份、${data.sets.filter(s => !s.isVideo).length} 个套图`)
      lines.push(`用法：#${CMD} 随机 / #${CMD} 关键词 / #${CMD}pro 视频 / #${CMD}列表`)
      return e.reply(lines.join('\n'))
    })
  }

  // #r18xjj / #r18xjj图片
  async r18Random (e) {
    if (!await this.gate(e)) return true
    return this.runExclusive(e, () => this.sendSetImages(e))
  }

  // #r18xjj 关键词
  async r18Search (e) {
    if (!await this.gate(e)) return true
    const keyword = stripCmd(e.msg)
    if (!keyword) return this.r18Random(e)
    return this.runExclusive(e, () => this.sendSetImages(e, keyword))
  }

  async sendSetImages (e, keyword) {
    let data
    try { data = await getIndex() } catch (err) {
      return e.reply(`索引拉取失败：${errText(err)}`)
    }

    let candidates = pickSets(data, keyword)
    if (!candidates.length) {
      // 索引可能过期，重建一次再找
      try { data = await buildIndex(true) } catch {}
      candidates = pickSets(data, keyword)
    }
    if (!candidates.length) {
      return e.reply(keyword ? `没找到包含「${keyword}」的套图，换个词试试~` : '站点里一个套图都没解析到~')
    }

    await e.reply(keyword ? `本小姐去找「${keyword}」的图了...` : '本小姐正在翻 R18 图库...')

    const want = randInt(IMG_COUNT_MIN, IMG_COUNT_MAX)
    let images = []
    let sourceName = ''
    const pool = shuffle(candidates).slice(0, 3)

    for (const set of pool) {
      try {
        const media = await getSetMedia(set.href)
        if (!media.images.length) continue
        images = await collectImages(media.images, want)
        if (images.length) { sourceName = `${set.month} / ${set.name}`; break }
      } catch (err) {
        Bot?.logger?.warn?.(`[xjj-r18] 套图 ${set.name} 拉取失败：${errText(err)}`)
      }
    }

    if (!images.length) return e.reply('这几套图都拉不动了，等会儿再试~')

    const title = `${senderOf(e).nickname} ｜ ${sourceName}`
    await sendImages(e, images, title)
    return true
  }

  // #r18视频
  async r18Video (e) {
    if (!await this.gate(e)) return true
    const keyword = stripCmd(e.msg)
    return this.runExclusive(e, async () => {
      let data
      try { data = await getIndex() } catch (err) {
        return e.reply(`索引拉取失败：${errText(err)}`)
      }

      await e.reply(keyword ? `本小姐去找「${keyword}」的视频了...` : '本小姐正在准备视频...')

      const seg = await getSegment()

      // pro 带了关键词就只在这个范围里挑，站点自带的种子视频不参与（它们和关键词无关）
      const scoped = keyword ? pickSets(data, keyword).filter(s => !s.isVideo) : null
      if (keyword && !scoped.length) {
        return e.reply(`没找到包含「${keyword}」的套图，换个词试试~`)
      }

      if (!keyword) {
        // 1) 内置种子清单（站点静态视频，路径固定，命中率最高）
        const seedHref = await pickSendableVideo(shuffle(VIDEO_SEEDS))
        if (seedHref) {
          try {
            await e.reply([seg.video(absolute(seedHref))])
            return true
          } catch (err) {
            Bot?.logger?.warn?.(`[xjj-r18] 种子视频发送失败 ${seedHref}：${errText(err)}`)
          }
        }

        // 2) 索引里扫到的视频（平铺在月份目录里的那些）
        const directVideos = data.sets.filter(s => s.isVideo).map(s => s.href)
        const directHref = await pickSendableVideo(shuffle(directVideos))
        if (directHref) {
          try {
            await e.reply([seg.video(absolute(directHref))])
            return true
          } catch (err) {
            Bot?.logger?.warn?.(`[xjj-r18] 直链视频发送失败：${errText(err)}`)
          }
        }
      }

      // 3) 随机翻套图找视频，翻不到就抽图合成幻灯片
      const hasDirect = !keyword && (data.sets.some(s => s.isVideo) || VIDEO_SEEDS.length > 0)
      // ffmpeg 不可用时合成这一档根本没戏，先探一次，省掉后面 6 次白抓目录
      const synthReady = await ffmpegAvailable()
      const pool = scoped || data.sets.filter(s => !s.isVideo)
      const candidates = shuffle(pool).slice(0, synthReady ? 6 : 4)
      for (const set of candidates) {
        try {
          const media = await getSetMedia(set.href)
          if (media.videos.length) {
            const href = await pickSendableVideo(media.videos)
            if (href) {
              await e.reply([seg.video(absolute(href))])
              return true
            }
          }
          if (!synthReady || !media.images.length) continue
          const file = await synthesizeVideo(media.images, `${set.month}/${set.name}`)
          if (!file) continue
          try {
            await e.reply([seg.video('file://' + file)])
            return true
          } finally {
            setTimeout(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch {} }, 60e3)
          }
        } catch (err) {
          Bot?.logger?.warn?.(`[xjj-r18] 视频流程失败：${errText(err)}`)
        }
      }
      return e.reply(hasDirect ? '视频没发出去，稍后再试~' : '这次没凑出视频，再试一次吧~')
    })
  }
}

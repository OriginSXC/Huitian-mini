import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import Config from './config/config.js'
import { normalizeId } from './utils/botcompat.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('daily')
const time = cfg.time || '0 30 9 * * *'
const groupList = cfg.groupList || []
const isAutoPush = cfg.isAutoPush ?? true

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getSegment() {
  if (global.segment) return global.segment
  return (await import('oicq')).segment
}

// 带超时的 JSON 请求
async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: controller.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

export class example extends plugin {
  constructor() {
    super({
      name: '今日早报',
      dsc: '推送今日早报',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#今日早报$',
          fnc: 'news'
        }
      ]
    })
    // 交给框架调度：插件类处理每条消息都会 new 一次，热更新也会重新 import，
    // 自己 scheduleJob 会重复挂任务
    this.task = (isAutoPush && groupList.length)
      ? { name: '回天mini-今日早报推送', cron: time, fnc: () => autoPush() }
      : []
  }
  async news(e) {
    await pushNews(e)
    return true
  }
}

/**
 * 判断接口返回的 image URL 是否是已知的 60s-static-host 格式
 * 已知格式:.../static/images/YYYY-MM-DD.(png|jpg|jpeg)
 */
function isKnownImageFormat(imageUrl, date) {
  if (!imageUrl || typeof imageUrl !== 'string') return false
  const pattern = new RegExp(`/static/images/${date}\\.(png|jpg|jpeg)$`)
  return pattern.test(imageUrl)
}

/**
 * 根据日期生成多个 CDN 镜像地址
 */
function buildImageUrls(date) {
  return [
    `https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/images/${date}.png`,
    `https://60s-static.viki.moe/images/${date}.png`,
    `https://cdn.jsdelivr.net/gh/vikiboss/60s-static-host@main/static/images/${date}.png`,
    `https://cdn.jsdmirror.com/gh/vikiboss/60s-static-host@main/static/images/${date}.png`
  ]
}

/**
 * 尝试多个 URL,返回第一个可用的
 */
async function getAvailableImage(urls, timeout = 5000) {
  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        logger.info(`[每日新闻] 使用镜像: ${url}`)
        return url
      }
      logger.warn(`[每日新闻] 镜像不可用 (${res.status}): ${url}`)
    } catch (err) {
      logger.warn(`[每日新闻] 镜像请求失败: ${url} - ${err.message}`)
    }
  }
  return null
}

/**
 * 推送新闻
 * @param e oicq传递的事件参数e
 * @param isAuto 是否为自动推送(0=用户触发,1=定时任务)
 */
async function pushNews(e, isAuto = 0) {
  if (e.msg) {
    logger.info('[用户命令]', e.msg)
  }
  let imgUrl, res, timeStr, originalImage
  try {
    imgUrl = await fetchJson('https://60s.crystelf.top/v2/60s')
    originalImage = imgUrl?.data?.image
    timeStr = imgUrl?.data?.date

    if (!originalImage) {
      logger.error('[每日新闻] 接口请求失败')
      if (!isAuto) e.reply('获取早报失败:接口没有返回图片,请稍后再试。')
      return
    }

    // ① 先判断日期 —— 不是今天直接返回,不浪费请求
    if (!isToday(timeStr)) {
      logger.info(`[每日新闻] 今日早报尚未更新,接口返回日期:${timeStr}`)
      if (!isAuto) {
        e.reply(`今天的早报尚未更新(当前最新:${timeStr}),请稍后再试。`)
      }
      // 自动推送场景:静默跳过,不推送旧图
      return
    }

    // ② 判断接口返回的 URL 是不是已知格式
    if (isKnownImageFormat(originalImage, timeStr)) {
      // 是已知格式 → 走多 CDN 容错
      const urls = buildImageUrls(timeStr)
      if (!urls.includes(originalImage)) urls.push(originalImage)
      res = await getAvailableImage(urls)

      if (!res) {
        logger.error('[每日新闻] 所有 CDN 镜像均不可用')
        if (!isAuto) e.reply('获取早报失败:所有图片镜像均不可用,请稍后再试。')
        return
      }
    } else {
      // 未知格式(可能接口换图床了)→ 直接用原始 URL,不瞎试镜像
      logger.warn(`[每日新闻] image URL 格式与预期不符,直接使用原始地址:${originalImage}`)
      res = originalImage
    }
  } catch (ex) {
    logger.error(`[每日新闻] 接口请求失败: ${ex?.message || ex}`)
    if (!isAuto) {
      e.reply('获取早报失败:接口暂时连不上,请稍后再试。')
    }
    return
  }

  // ③ 走到这里 res 一定是有效的图片 URL
  try {
    const segment = await getSegment()
    if (isAuto) {
      await e.sendMsg(segment.image(res))
    } else {
      await e.reply(segment.image(res))
    }
  } catch (err) {
    logger.error(`[每日新闻] 发送失败: ${err?.message || JSON.stringify(err)}`)
  }
}

/**
 * 定时推送
 */
async function autoPush() {
  logger.info('[每日新闻]开始自动推送...')
  for (const gid of groupList) {
    const group = Bot.pickGroup(normalizeId(gid))
    if (!group) {
      logger.warn(`[每日新闻]无法获取群 ${gid}`)
      continue
    }
    await pushNews(group, 1)
    await sleep(1000)
  }
}

/**
 * 判断给定日期字符串是否为今天
 */
// 按本地日期比字符串：new Date('YYYY-MM-DD') 是 UTC 零点，西半球时区会差一天
const isToday = dateString => {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return String(dateString || '').slice(0, 10) === today
}
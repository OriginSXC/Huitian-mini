import plugin from '../../lib/plugins/plugin.js'
import common from '../../lib/common/common.js'
import fetch from 'node-fetch'
import schedule from 'node-schedule'
import { segment } from 'oicq'
import Config from './config/config.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('daily')
const time = cfg.time || '0 30 9 * * ?'
const groupList = cfg.groupList || []
const isAutoPush = cfg.isAutoPush ?? true

autoTask()

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
  }
  async news(e) {
    pushNews(e)
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
    `https://60s-static.viki.moe/images/${date}.png`,
    `https://cdn.jsdelivr.net/gh/vikiboss/60s-static-host@main/static/images/${date}.png`,
    `https://cdn.jsdmirror.com/gh/vikiboss/60s-static-host@main/static/images/${date}.png`,
    `https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/images/${date}.png`
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
    const url = await fetch('https://60s-api-cf.viki.moe/v2/60s').catch(err => logger.error(err))
    imgUrl = await url.json()
    originalImage = imgUrl.data.image
    timeStr = imgUrl.data.date

    if (!originalImage) {
      logger.error('[每日新闻] 接口请求失败')
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
    if (!isAuto) {
      e.reply(`获取早报失败:${ex}`)
    }
    return
  }

  // ③ 走到这里 res 一定是有效的图片 URL
  if (isAuto) {
    e.sendMsg(segment.image(res))
  } else {
    e.reply(segment.image(res))
  }
}

/**
 * 定时任务
 */
function autoTask() {
  if (isAutoPush) {
    schedule.scheduleJob(time, () => {
      logger.info('[每日新闻]:开始自动推送...')
      for (let i = 0; i < groupList.length; i++) {
        let group = Bot.pickGroup(groupList[i])
        pushNews(group, 1)
        common.sleep(1000)
      }
    })
  }
}

/**
 * 判断给定日期字符串是否为今天
 */
const isToday = dateString => {
  const today = new Date()
  const date = new Date(dateString)
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  )
}
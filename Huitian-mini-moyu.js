import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import Config from './config/config.js'
import { normalizeId } from './utils/botcompat.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('moyu')
const time = cfg.time || '0 0 9 * * *'
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
      name: '摸鱼日历',
      dsc: '获取摸鱼日历',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#摸鱼日历$',
          fnc: 'news'
        }
      ]
    })
    // 交给框架调度：插件类处理每条消息都会 new 一次，热更新也会重新 import，
    // 自己 scheduleJob 会重复挂任务
    this.task = (isAutoPush && groupList.length)
      ? { name: '回天mini-摸鱼日历推送', cron: time, fnc: () => autoPush() }
      : []
  }

  async news(e) {
    await pushNews(e)
    return true
  }
}

/**
 * 推送日历
 * @param e oicq传递的事件参数e
 */
async function pushNews(e, isAuto = 0) {
  if (e.msg) {
    logger.info('[用户命令]', e.msg)
  }

  let res
  try {
    const j = await fetchJson('https://api.zxki.cn/api/myrl?type=json')
    // 接口现在把 url 放顶层，旧版放在 data.url，两种都兼容
    res = j?.url || j?.data?.url
  } catch (err) {
    logger.error(`[摸鱼人日历] 接口请求失败: ${err.message}`)
  }

  if (!res) {
    logger.error('[摸鱼人日历] 未拿到图片地址')
    if (!isAuto) e.reply('获取摸鱼日历失败,请稍后再试。')
    return
  }

  try {
    const segment = await getSegment()
    if (isAuto) {
      await e.sendMsg(segment.image(res))
    } else {
      await e.reply(segment.image(res))
    }
  } catch (err) {
    logger.error(`[摸鱼人日历] 发送失败: ${err?.message || JSON.stringify(err)}`)
  }
}

/**
 * 定时推送
 */
async function autoPush() {
  logger.info('[摸鱼人日历]开始自动推送...')
  for (const gid of groupList) {
    const group = Bot.pickGroup(normalizeId(gid))
    if (!group) {
      logger.warn(`[摸鱼人日历]无法获取群 ${gid}`)
      continue
    }
    await pushNews(group, 1)
    await sleep(1000)
  }
}

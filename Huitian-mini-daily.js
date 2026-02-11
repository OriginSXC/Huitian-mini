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
 * 推送新闻
 * @param e oicq传递的事件参数e
 */
async function pushNews(e, isAuto = 0) {
  if (e.msg) {
    logger.info('[用户命令]', e.msg)
  }

  let url, imgUrl, res, timeStr

  try {
    url = await fetch('https://60s.viki.moe/v2/60s').catch(err => logger.error(err))
    imgUrl = await url.json()
    res = await imgUrl.data.image
    timeStr = await imgUrl.data.date

    if (!res) {
      logger.error('[每日新闻] 接口请求失败')
      return
    }
  } catch (ex) {
    if (!isAuto) {
      e.reply(`获取早报失败：${ex}`)
    }
    return
  }

  if (isAuto) {
    e.sendMsg(segment.image(res))
  } else {
    if (isToday(timeStr)) {
      e.reply(segment.image(res))
    } else {
      e.reply(`今天（${timeStr}）的早报尚未更新。`)
    }
  }
}

/**
 * 定时任务
 */
function autoTask() {
  if (isAutoPush) {
    schedule.scheduleJob(time, () => {
      logger.info('[每日新闻]：开始自动推送...')
      for (let i = 0; i < groupList.length; i++) {
        let group = Bot.pickGroup(groupList[i])
        pushNews(group, 1)
        common.sleep(1000)
      }
    })
  }
}

const isToday = dateString => {
  const today = new Date()
  const date = new Date(dateString)
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  )
}
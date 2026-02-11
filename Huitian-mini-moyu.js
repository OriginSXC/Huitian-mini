import plugin from '../../lib/plugins/plugin.js'
import common from '../../lib/common/common.js'
import fetch from 'node-fetch'
import schedule from 'node-schedule'
import { segment } from 'oicq'
import Config from './config/config.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('moyu')
const time = cfg.time || '0 0 9 * * ?'
const groupList = cfg.groupList || []
const isAutoPush = cfg.isAutoPush ?? true

autoTask()

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
  }

  async news(e) {
    pushNews(e)
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

  let url = await fetch('https://api.zxki.cn/api/myrl?type=json').catch(err => logger.error(err))
  let imgUrl = await url.json()
  const res = await imgUrl.data.url

  if (!res) {
    logger.error('[摸鱼人日历] 接口请求失败')
  }

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
      logger.info('[摸鱼人日历]：开始自动推送...')
      for (let i = 0; i < groupList.length; i++) {
        let group = Bot.pickGroup(groupList[i])
        pushNews(group, 1)
        common.sleep(1000)
      }
    })
  }
}
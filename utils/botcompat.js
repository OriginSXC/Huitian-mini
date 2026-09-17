/**
 * Yunzai 多版本兼容小工具。
 *
 * TRSS-Yunzai 支持多个 Bot 同时在线，`Bot.uin` 是数组而非号码：
 *   String(Bot.uin)  →  "12345,ko_67890"   // Array.toString 逗号拼接
 *   Bot.uin.toJSON() →  随机返回其中一个
 * 直接拿它当 user_id 会得到无效值。Miao-Yunzai / Yunzai-Bot V3 只有单 Bot，
 * `Bot.uin` 就是号码本身，下面两个函数都会自然回落，行为不变。
 */

/** 确定性地取一个 Bot uin：优先纯数字（QQ），否则取第一个 */
function mainBotUin () {
  if (!Array.isArray(Bot?.uin)) return Bot?.uin
  const list = Array.from(Bot.uin).filter(v => v !== undefined && v !== null && v !== '')
  return list.find(v => /^\d+$/.test(String(v))) ?? list[0]
}

/**
 * 取「这条消息/这个会话该用谁的身份」，用于合并转发节点的 user_id / nickname。
 * 指令触发时走 e.member；定时推送没有 member，退到该会话所属 Bot，最后才是主 Bot。
 *
 * @param {object} [eOrCtx] 消息事件，或 pickGroup/pickFriend 得到的会话对象
 * @returns {{ uin: string|number, nickname: string }}
 */
export function senderOf (eOrCtx) {
  const uin = eOrCtx?.member?.user_id
    ?? eOrCtx?.self_id
    ?? eOrCtx?.bot?.uin
    ?? eOrCtx?.group?.self_id
    ?? mainBotUin()
  const bot = (uin !== undefined && Bot?.bots?.[uin]) || null
  const nickname = eOrCtx?.member?.nickname
    ?? bot?.nickname
    ?? bot?.info?.nickname
    ?? Bot?.nickname
  return { uin, nickname }
}

/**
 * 归一化会话 id。TRSS 下群号/用户号不一定是数字（KOOK `ko_xxx`、
 * QQ频道 `qg_xxx-xxx`、Telegram `123:AAxxx`），`Number()` 会变成 NaN，
 * 所以转不成数字时原样返回。
 *
 * @param {string|number} id
 * @returns {string|number}
 */
export function normalizeId (id) {
  return Number(id) || id
}

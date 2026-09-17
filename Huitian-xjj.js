import plugin from '../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import http from 'http'
import https from 'https'
import Config from './config/config.js'
import { senderOf } from './utils/botcompat.js'

// ====== 读取 YAML 配置 ======
const cfg = Config.get('xjj')

const BATCH_SIZE           = cfg.BATCH_SIZE || 5             
const IMG_COUNT_MIN        = cfg.IMG_COUNT_MIN || 3
const IMG_COUNT_MAX        = cfg.IMG_COUNT_MAX || 5

const USE_SHARP            = cfg.USE_SHARP ?? true
const SHARP_QUALITY        = cfg.SHARP_QUALITY || 70
const SHARP_WIDTH          = cfg.SHARP_WIDTH || 1080

const FETCH_TIMEOUT        = cfg.FETCH_TIMEOUT || 8000
const DOWNLOAD_TIMEOUT     = cfg.DOWNLOAD_TIMEOUT || 30000 
// ===========================================

// ================= 混淆与配置区 =================

// 1. 新版 yujn.cn 接口基础 (包含图片和视频)
const _0xYujnBase = "aHR0cHM6Ly9hcGkueXVqbi5jbi9hcGkv"; // https://api.yujn.cn/api/

// 视频可用分类
const VID_YUJN_MAP = {
  "黑丝": "heisis.php?type=video", "白丝": "baisis.php?type=video", 
  "漫展": "manzhan.php?type=video", "jk": "jksp.php?type=video", 
  "甜妹": "tianmei.php?type=video", "萝莉": "luoli.php?type=video", 
  "清纯": "qingchun.php?type=video", "吊带": "diaodai.php?type=video", 
  "变装": ["ksbianzhuang.php?type=video", "bianzhuang.php?"], 
  "女高": "nvgao.php?type=video", "双倍快乐": "sbkl.php?type=video", 
  "怼脸自拍": "duilian.php?type=video", "穿搭": "chuanda.php?type=video", 
  "完美身材": "wmsc.php?type=video", "慢摇": "manyao.php?type=video", 
  "cos": "COS.php?type=video", "热舞": "rewu.php?type=video", 
  "玉足": "yuzu.php?type=video", "美腿": "yuzu.php?type=video",
  "女大": "nvda.php?type=video", "古风": "hanfu.php?type=video",
  
  // 网红系列
  "瞳瞳": "tongtong.php?type=video", "鞠婧祎": "jjy.php?type=video", 
  "潇潇": "xiaoxiao.php?", "杀猪饲料": "shejie.php?type=video", 
  "章若楠": "zrn.php?type=video", "你的欲梦": "ndym.php?type=video"
};

const _decodeYujnVid = (key) => {
  let path = VID_YUJN_MAP[key];
  if (Array.isArray(path)) path = path[randInt(0, path.length - 1)];
  return Buffer.from(_0xYujnBase, 'base64').toString() + path;
};

// 新版 yujn.cn 图片分类
const IMG_YUJN_MAP = {
  "jk": "jk.php?", "黑丝": "heisi.php?", "白丝": "baisi.php?", "美腿": "tui.php?"
};
const _decodeYujnImg = (key) => Buffer.from(_0xYujnBase, 'base64').toString() + IMG_YUJN_MAP[key];

// 2. 老版 pt.tzjsy 图片接口
const _0xImgBase = "aHR0cDovL3B0LnR6anN5LmNuLw=="; // http://pt.tzjsy.cn/
const _0xImgSuf = "L2ltZy5waHA="; // /img.php

const IMG_TZ_MAP = {
  "美腿": "tui", "网红": "wh", "黑丝": "hs", "白丝": "bs"
};
const _decodeImg = (key) => Buffer.from(_0xImgBase, 'base64').toString() + IMG_TZ_MAP[key] + Buffer.from(_0xImgSuf, 'base64').toString();

// 中英文别名映射器
const ALIAS_MAP = {
  "hs": "黑丝", "bs": "白丝", "jk": "jk", "cos": "cos",
  "xjj": "随机小姐姐", "小姐姐": "随机小姐姐"
};

// 动态生成正则匹配规则
const categoryKeys = Object.keys(VID_YUJN_MAP).concat(Object.keys(IMG_TZ_MAP)).concat(Object.keys(IMG_YUJN_MAP)).concat(Object.keys(ALIAS_MAP));
const REGEX_CATE_STR = [...new Set(categoryKeys)].join('|');
// =============================================


const USER_AGENT_LIST = [  
  'Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile Safari/10600.6.3 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (iPhone;CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)'
]

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8, rejectUnauthorized: false })
const pickAgent = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent)

async function getSegment() {
  try { const m = await import('icqq'); return m.segment } catch {}
  const m = await import('oicq'); return m.segment
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pickUA = () => USER_AGENT_LIST[randInt(0, USER_AGENT_LIST.length - 1)]

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, agent: pickAgent(url), headers: { 'User-Agent': pickUA() } })
    return res.ok ? await res.json() : null;
  } catch (err) { return null; } finally { clearTimeout(t); }
}

async function fetchBuffer(url, timeoutMs = DOWNLOAD_TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, agent: undefined, redirect: 'follow', headers: { 'User-Agent': pickUA() } })
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch (err) { return null; } finally { clearTimeout(t); }
}

async function urlToBase64(url) {
  if (!url) return null
  if (url.startsWith('//')) url = 'https:' + url
  try {
    let buffer = await fetchBuffer(url, DOWNLOAD_TIMEOUT)
    if (!buffer) return null
    if (USE_SHARP) {
      try {
        const sharp = (await import('sharp')).default
        buffer = await sharp(buffer).rotate().resize({ width: SHARP_WIDTH, withoutEnlargement: true }).jpeg({ quality: SHARP_QUALITY }).toBuffer()
      } catch {}
    }
    return `base64://${buffer.toString('base64')}`
  } catch { return null; }
}

// ================= 旧版特定分类 API 映射 =================
const OLD_IMG_CATE_MAP = {
  "黑丝": async (count) => {
    const res = await Promise.all(Array.from({ length: count }).map(() => fetchJson(`https://v2.xxapi.cn/api/heisi?return=json`)));
    return res.map(r => r?.data).filter(Boolean);
  },
  "白丝": async (count) => {
    const res = await Promise.all(Array.from({ length: count }).map(() => fetchJson(`https://v2.xxapi.cn/api/baisi?return=json`)));
    return res.map(r => r?.data).filter(Boolean);
  },
  "jk": async (count) => {
    const res = await Promise.all(Array.from({ length: count }).map(() => fetchJson(`https://v2.xxapi.cn/api/jk?return=json`)));
    return res.map(r => r?.data).filter(Boolean);
  },
  "美腿": async (count) => {
    const res = await Promise.all(Array.from({ length: count }).map(() => fetchJson(`http://3650000.xyz/api/?type=json&mode=7`)));
    return res.map(r => r?.url).filter(Boolean);
  }
};

const OLD_IMAGE_RANDOM_APIS = [
  async (count) => {
    const res = await Promise.all(Array.from({ length: count }).map(() => fetchJson('https://imgapi.cn/api.php?zd=zsy&fl=meizi&gs=json')));
    return { name: '随机妹子', urls: res.map(r => r?.imgurl).filter(Boolean) };
  },
  async (count) => {
    const urls = ['https://imgapi.cn/cos.php?return=jsonpro', 'https://imgapi.cn/cos2.php?return=jsonpro'];
    const res = await fetchJson(urls[randInt(0, 1)]);
    return { name: '随机集锦', urls: (res?.imgurls || []).slice(0, count) };
  }
];

const MIXED_VIDEO_RANDOM_APIS = [
  async () => {
    const res = await fetchJson('https://api.yujn.cn/api/zzxjj.php?type=json')
    return (res && res.data) ? { url: res.data, title: res.title || '' } : null;
  },
  async () => {
    const res = await fetchJson('https://api.kuleu.com/api/MP4_xiaojiejie?type=json')
    return (res && res.mp4_video) ? { url: res.mp4_video, title: '' } : null;
  }
];
// ============================================

export class xjjUltimate extends plugin {
  constructor() {
    super({
      name: '小姐姐-极速完整版(智能盲盒版)',
      dsc: '多接口聚合+全库盲盒+跨界纠错防误触',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: new RegExp(`^#?(${REGEX_CATE_STR})(图片|图)?$`, 'i'), fnc: 'xjj' },
        { reg: new RegExp(`^#?(${REGEX_CATE_STR})(视频|pro)$`, 'i'), fnc: 'xjjVideo' }
      ]
    })
  }

  parseCommand(msg) {
    let raw = msg.replace(/^#/, '').replace(/(图片|图|视频|pro)$/i, '').toLowerCase();
    return ALIAS_MAP[raw] || raw;
  }

  async xjj(e) {
    const count = randInt(IMG_COUNT_MIN, IMG_COUNT_MAX)
    let categoryName = this.parseCommand(e.msg);

    // ====== 1. 盲盒模式与类型跨界纠错 ======
    if (categoryName === '随机小姐姐') {
      // 提取所有可用的图片分类名并去重
      const allImgKeys = [...new Set([
        ...Object.keys(IMG_YUJN_MAP), 
        ...Object.keys(IMG_TZ_MAP), 
        ...Object.keys(OLD_IMG_CATE_MAP)
      ])];
      categoryName = allImgKeys[randInt(0, allImgKeys.length - 1)];
    } else {
      // 检查该分类是否属于“只有视频，没有图片”
      const isImg = IMG_YUJN_MAP[categoryName] || IMG_TZ_MAP[categoryName] || OLD_IMG_CATE_MAP[categoryName];
      const isVid = VID_YUJN_MAP[categoryName];
      
      if (!isImg && isVid) {
        return e.reply(`[${categoryName}] 只有视频哦，请尝试发送 #${categoryName}视频`);
      }
    }

    // ====== 2. 构建请求池 ======
    let apisToTry = [];

    if (IMG_YUJN_MAP[categoryName]) {
      apisToTry.push(async (c) => {
        const apiUrl = _decodeYujnImg(categoryName);
        const joiner = apiUrl.includes('?') ? '&' : '?';
        const urls = Array.from({ length: c }).map(() => `${apiUrl}${joiner}_r=${Math.random().toString(36).substring(2)}`);
        return { name: categoryName, urls: urls };
      });
    }

    if (IMG_TZ_MAP[categoryName]) {
      apisToTry.push(async (c) => {
        const apiUrl = _decodeImg(categoryName);
        const urls = Array.from({ length: c }).map(() => `${apiUrl}?_r=${Math.random().toString(36).substring(2)}`);
        return { name: categoryName, urls: urls };
      });
    }

    if (OLD_IMG_CATE_MAP[categoryName]) {
      apisToTry.push(async (c) => {
        const urls = await OLD_IMG_CATE_MAP[categoryName](c);
        return { name: categoryName, urls: urls };
      });
    }

    // 如果连盲盒都匹配失败，最后的回退底线
    if (apisToTry.length === 0) apisToTry = [...OLD_IMAGE_RANDOM_APIS];

    apisToTry.sort(() => Math.random() - 0.5);
    let result = null;
    
    for (const apiFunc of apisToTry) {
      try {
        const res = await apiFunc(count);
        if (res && res.urls && res.urls.length > 0) {
          result = { name: res.name || categoryName, urls: res.urls };
          break;
        }
      } catch (err) { }
    }

    if (!result || result.urls.length === 0) {
      return e.reply(`这会儿 [${categoryName}] 的图库都拥挤或失效了，请稍后再试吧~`)
    }

    await e.reply(`本小姐正在挑选 ${result.urls.length} 张 [${result.name}] 美图...`)

    const seg = await getSegment()
    const sender = senderOf(e)
    const uin = sender.uin
    const nick = sender.nickname
    const title = `${nick} ｜ ${result.name} 精选`

    for (let i = 0; i < result.urls.length; i += BATCH_SIZE) {
      const batchUrls = result.urls.slice(i, i + BATCH_SIZE)
      const settled = await Promise.allSettled(batchUrls.map(u => urlToBase64(u)))
      
      const validBase64 = [];
      settled.forEach((x, index) => {
        if (x.status === 'fulfilled' && x.value) {
          validBase64.push(x.value);
        } else {
          Bot?.logger?.warn?.(`[xjj] 第 ${i + index + 1} 张图片下载或处理失败，被过滤`);
        }
      });

      if (validBase64.length === 0) continue

      const nodes = validBase64.map((b64, idx) => ({
        user_id: uin, nickname: title, message: [`第 ${i + idx + 1} 张`, seg.image(b64)]
      }))

      try {
        const makeFunc = e.group?.makeForwardMsg || e.friend?.makeForwardMsg
        if (makeFunc) {
          const msg = await makeFunc.call(e.group || e.friend, nodes)
          await e.reply(msg)
        } else {
          for (const node of nodes) await e.reply(node.message)
        }
      } catch (err) {
        for (const node of nodes) { try { await e.reply(node.message) } catch {} }
      }
      if (i + BATCH_SIZE < result.urls.length) await sleep(1000) 
    }
    return true
  }

  async xjjVideo(e) {
    const seg = await getSegment()
    let categoryName = this.parseCommand(e.msg);
    let targetApi = null;

    // ====== 1. 盲盒模式与类型跨界纠错 ======
    if (categoryName === '随机小姐姐') {
      // 提取所有可用的视频分类名并去重，开启盲盒
      const allVidKeys = [...Object.keys(VID_YUJN_MAP)];
      categoryName = allVidKeys[randInt(0, allVidKeys.length - 1)];
    } else {
      // 检查该分类是否属于“只有图片，没有视频”
      const isVid = VID_YUJN_MAP[categoryName];
      const isImg = IMG_YUJN_MAP[categoryName] || IMG_TZ_MAP[categoryName] || OLD_IMG_CATE_MAP[categoryName];
      
      if (!isVid && isImg) {
        return e.reply(`[${categoryName}] 只有图片哦，请尝试发送 #${categoryName}图片`);
      }
    }

    // ====== 2. 匹配对应分类 ======
    if (VID_YUJN_MAP[categoryName]) {
      targetApi = { url: _decodeYujnVid(categoryName), title: "" };
    } else {
      // 极少发生的回退逻辑：去老库捞一条
      const shuffledApis = [...MIXED_VIDEO_RANDOM_APIS].sort(() => Math.random() - 0.5);
      for (const apiFunc of shuffledApis) {
        try {
          const res = await apiFunc();
          if (res && res.url) { targetApi = res; break; }
        } catch (err) { }
      }
    }

    if (!targetApi || !targetApi.url) {
      return e.reply('视频接口暂时都没数据或挂掉了~')
    }

    await e.reply(`本小姐正在挑选 [${categoryName}] 视频...`)

    try {
      const replyMsg = []
      if (targetApi.title) replyMsg.push(`🎬 ${targetApi.title.trim()}\n`)
      replyMsg.push(seg.video(targetApi.url))
      await e.reply(replyMsg)
    } catch (err) {
      await e.reply('视频获取到了，但发送出错了')
    }
    return true
  }
}
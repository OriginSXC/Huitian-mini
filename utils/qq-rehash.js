// QQ 侧发图被风控时的「改哈希」工具。
//
// 背景：那句「本小姐被风控/超时绊了一跤」多数不是图源站的问题，是 QQ 把这次
// 投递拦了。QQ 服务端对图片按 MD5 做去重和风控缓存，同一份字节反复发就会被
// 拦，换账号、换群都沒用。解法是让字节变、画面不变：
//
//   JPEG  → 在 EOI 前插一个 COM(注释)段，解码器直接跳过，像素一个不差
//   PNG   → 在 IEND 前插一个 tEXt 块（带正确 CRC）
//   GIF   → 在 trailer 前插注释扩展块
//   MP4/MOV → 尾部追加一个 free box，播放器按规范忽略
//   WEBP  → RIFF 尾部追加未知 chunk 并修正 RIFF size
//
// 全部是无损改动：不重编码、不掉画质、不占 CPU，只让 MD5/文件大小变掉。
// 感知哈希（pHash）那一层这里不处理，那需要真的改像素，属于最后手段。

import crypto from 'node:crypto'

// ---------- CRC32（PNG chunk 必需） ----------
let CRC_TABLE = null
function crcTable () {
  if (CRC_TABLE) return CRC_TABLE
  CRC_TABLE = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c >>> 0
  }
  return CRC_TABLE
}
function crc32 (buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const randHex = (n = 12) => crypto.randomBytes(n).toString('hex')

// ---------- 格式识别 ----------
function sniff (buf) {
  if (!buf || buf.length < 16) return 'unknown'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png'
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  if (buf.toString('latin1', 4, 8) === 'moov' || buf.toString('latin1', 4, 8) === 'mdat') return 'mp4'
  return 'unknown'
}

// ---------- JPEG：EOI 前插 COM 段 ----------
function rehashJpeg (buf) {
  const payload = Buffer.from(`xjj:${randHex(16)}`, 'latin1')
  const seg = Buffer.alloc(4 + payload.length)
  seg.writeUInt16BE(0xfffe, 0)              // COM marker
  seg.writeUInt16BE(payload.length + 2, 2)  // 段长度（含长度字段本身）
  payload.copy(seg, 4)

  // 从尾部找最后一个 FFD9，那才是真正的 EOI
  let end = -1
  for (let i = buf.length - 2; i >= Math.max(0, buf.length - 1 << 20); i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) { end = i; break }
  }
  if (end < 4) return null
  return Buffer.concat([buf.subarray(0, end), seg, buf.subarray(end)])
}

// ---------- PNG：IEND 前插 tEXt ----------
function rehashPng (buf) {
  const data = Buffer.concat([
    Buffer.from('Comment', 'latin1'),
    Buffer.from([0]),
    Buffer.from(`xjj:${randHex(12)}`, 'latin1')
  ])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)

  const iend = buf.lastIndexOf(Buffer.from('IEND', 'latin1'))
  if (iend < 4) return null
  const at = iend - 4                            // IEND 的 length 字段起点
  return Buffer.concat([buf.subarray(0, at), chunk, buf.subarray(at)])
}

// ---------- GIF：trailer 前插注释扩展 ----------
function rehashGif (buf) {
  const text = Buffer.from(`xjj:${randHex(12)}`, 'latin1')
  const block = Buffer.concat([
    Buffer.from([0x21, 0xfe, text.length]),
    text,
    Buffer.from([0x00])
  ])
  const at = buf.length - 1                      // 最后一个字节是 0x3B trailer
  if (buf[at] !== 0x3b) return null
  return Buffer.concat([buf.subarray(0, at), block, buf.subarray(at)])
}

// ---------- WEBP：RIFF 尾部追加 chunk + 修正 size ----------
function rehashWebp (buf) {
  const data = Buffer.from(`xjj:${randHex(12)}`, 'latin1')
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
  const chunk = Buffer.alloc(8 + data.length + pad.length)
  chunk.write('XXXX', 0, 'latin1')               // 未知 chunk，解析器按规范跳过
  chunk.writeUInt32LE(data.length, 4)
  data.copy(chunk, 8)
  pad.copy(chunk, 8 + data.length)

  const out = Buffer.concat([buf, chunk])
  out.writeUInt32LE(out.length - 8, 4)           // RIFF size = 总长 - 8
  return out
}

// ---------- MP4/MOV：尾部追加 free box ----------
function rehashMp4 (buf) {
  const data = Buffer.from(`xjj:${randHex(12)}`, 'latin1')
  const box = Buffer.alloc(8 + data.length)
  box.writeUInt32BE(box.length, 0)
  box.write('free', 4, 'latin1')
  data.copy(box, 8)
  return Buffer.concat([buf, box])
}

/**
 * 改一份媒体数据的哈希，画面/音轨不变。
 * @param {Buffer} buf
 * @param {'auto'|string} kind 不传就自动识别
 * @returns {Buffer|null} 改不动返回 null（调用方应退化成重编码或放弃）
 */
function rehashBuffer (buf, kind = 'auto') {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null
  const t = kind === 'auto' ? sniff(buf) : kind
  try {
    switch (t) {
      case 'jpeg': return rehashJpeg(buf)
      case 'png': return rehashPng(buf)
      case 'gif': return rehashGif(buf)
      case 'webp': return rehashWebp(buf)
      case 'mp4': return rehashMp4(buf)
      default: return null
    }
  } catch {
    return null
  }
}

/**
 * 直接改 `base64://...` 字符串。协议端拿到的就是这种形式，改完即可重发。
 * @returns {string|null}
 */
function rehashBase64 (b64) {
  if (typeof b64 !== 'string') return null
  const m = /^base64:\/\/([\s\S]*)$/.exec(b64)
  if (!m) return null
  let buf
  try { buf = Buffer.from(m[1], 'base64') } catch { return null }
  const out = rehashBuffer(buf)
  return out ? `base64://${out.toString('base64')}` : null
}

/**
 * 批量改哈希，返回新数组（改不动的原样保留）。
 */
function rehashAll (list) {
  return (Array.isArray(list) ? list : []).map(v => (typeof v === 'string' ? (rehashBase64(v) || v) : v))
}

/**
 * 视频文件换一个哈希名字。协议端按 file:// 读本地文件时，文件名也参与缓存判断。
 */
function rehashFileName (file) {
  if (typeof file !== 'string') return file
  const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(file)
  if (!m) return file
  return `${m[1]}-${randHex(6)}${m[2]}`
}

/**
 * 给 URL 加盐，让协议端/服务端把它当成一条新资源。
 */
function rehashUrl (url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url
  try {
    const u = new URL(url)
    u.searchParams.set('_r', randHex(5))
    return u.toString()
  } catch {
    return url
  }
}

/**
 * 判断一个发送返回值/异常像不像 QQ 侧拦截。
 * 命中就值得改哈希重发；明显是「群不存在 / 无权限」这类就没必要。
 */
const HOPELESS = /(群.*不存在|不在群|被禁言|禁言中|无权限|权限不足|not\s*found|forbidden|kicked|已解散|account\s*not)/i
const LIKELY_BLOCK = /(风控|risk|拦截|block|屏蔽|敏感|安全|发送失败|发送超时|timeout|频率|频繁|too\s*many|retcode|无有效回执|回执|upload|上传失败)/i

function looksLikeQQBlock (errOrRes) {
  const text = errOrRes instanceof Error
    ? `${errOrRes.message || ''} ${errOrRes.stack || ''}`
    : (() => { try { return JSON.stringify(errOrRes) } catch { return String(errOrRes) } })()
  if (!text) return false
  if (HOPELESS.test(text)) return false
  if (LIKELY_BLOCK.test(text)) return true
  // 拿不到明确信息时按「可能是风控」处理：改哈希重试的成本只有几十 KB 的流量
  return true
}


/**
 * 递归换掉节点里所有 base64:// 图片。
 * segment.image('base64://...') 把字符串原样放在 data.file 里，深搜替换即可，
 * 不用关心各插件自己的 node 结构。
 * 返回新对象，原 nodes 保持不变（后面还要用它逐条降级发送）。
 */
function rehashNodes (nodes) {
  const seen = new Set()
  const walk = (v) => {
    if (typeof v === 'string') return v.startsWith('base64://') ? (rehashBase64(v) || v) : v
    if (!v || typeof v !== 'object') return v
    if (seen.has(v)) return v
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out = {}
    for (const k of Object.keys(v)) out[k] = walk(v[k])
    return out
  }
  return walk(nodes)
}

export {
  rehashNodes,
  rehashBuffer,
  rehashBase64,
  rehashAll,
  rehashFileName,
  rehashUrl,
  looksLikeQQBlock,
  sniff
}

<div align="center">

# Huitian-mini

轻量级 **Yunzai / TRSS / Miao / NapCat(OneBot v11)** 插件合集  
**早报 · 摸鱼日历 · 米游社 COS · WP 抓图 · 随机图/视频**

[![license](https://img.shields.io/github/license/OriginSXC/Huitian-mini)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
[![stars](https://img.shields.io/github/stars/OriginSXC/Huitian-mini?style=flat)](https://github.com/OriginSXC/Huitian-mini/stargazers)
[![issues](https://img.shields.io/github/issues/OriginSXC/Huitian-mini)](https://github.com/OriginSXC/Huitian-mini/issues)
[![gitee](https://img.shields.io/badge/Gitee-%E9%95%9C%E5%83%8F-C71D23?logo=gitee)](https://gitee.com/OriginSXC/Huitian-mini)

**GitHub**：<https://github.com/OriginSXC/Huitian-mini> ｜ **Gitee 镜像**：<https://gitee.com/OriginSXC/Huitian-mini>

</div>

## 功能一览

- ✅ **指令触发 + 定时推送**（node-schedule）
- ✅ **合并转发**（OneBot / icqq），支持分批发送降低风控
- ✅ **可选 sharp 压缩/裁剪**：降低大图体积与发送失败概率
- ✅ **不稳定源站增强**：Base64 强制发送、限并发拉取、keep-alive 等
- ✅ **WOC 多图源容错**：随机选源、挂了自动换源并冷却、死链自动换图换组
- ✅ **R18 档默认只在私聊**：`#r18xjj` 系列群聊静默，缺 ffmpeg 时合成档自动降级、不刷错误日志

## 插件列表

| 插件 | 指令 | 定时推送 | 依赖 | 简述 |
|---|---|---:|---|---|
| 今日早报 | `#今日早报` | ✅（默认 09:30） | `node-fetch` `node-schedule` | 拉取“60s 早报”图片并推送 |
| 摸鱼日历 | `#摸鱼日历` | ✅（默认 09:00） | `node-fetch` `node-schedule` | 拉取摸鱼人日历并推送 |
| 米游社 COS（reborn） | `#cos` / `mys cos`（可加 `ob/icqq/auto/plain`） | ✅（默认 12:08:30） | `node-fetch` `node-schedule` `sharp` | 随机抓取米游社贴子图片，分批合并转发 |
| WOC 抓图（reborn） | `#woc` / `#卧槽` | ❌ | `sharp` | 多站 WP 接口抓图 → 强制 Base64 → 分批合并转发（优先 icqq）；随机选源、死链自动换图、可选 R18 分档 |
| XJJ 极速增强版 | `#xjj` / `#黑丝`；视频：`#xjjpro` / `#jk视频` 等 | ❌ | `node-fetch` `sharp` | 多接口聚合，支持中英文别名分类（JK/黑丝/美腿/变装/网红系列等）；图源失败自动换源并冷却、视频死链自动换条、同群防并发刷屏 |
| XJJ R18 扩展 | `#r18xjj`；视频：`#r18xjjpro` | ❌ | `node-fetch` `sharp` `ffmpeg`（可选） | 静态目录站（h5ai）抓图，按月份/套图名检索；站点视频直链优先，无 ffmpeg 时跳过合成；默认仅私聊 |

---

## 安装

在 **云崽根目录** 执行：

```bash
# GitHub（海外推荐）
git clone https://github.com/OriginSXC/Huitian-mini.git ./plugins/Huitian-mini

# Gitee 镜像（国内推荐）
git clone https://gitee.com/OriginSXC/Huitian-mini.git ./plugins/Huitian-mini
```

### 安装依赖

推荐直接使用 pnpm 的过滤器功能为插件安装依赖：

```bash
pnpm install --filter=Huitian-mini
```

> 如果运行时报 “缺少 sharp”，说明它们没被装进当前的 `node_modules`，执行上述命令补充安装即可。

### 重启

重启 Bot 后即可。

---

## 配置说明 (全新 YAML 配置)

为了防止 `git pull` 更新代码时产生冲突，并保护您的隐私数据（如推送群号），所有插件已全面升级为 **YAML 配置文件**，**请勿直接修改 JS 源码文件**！

### 如何修改配置？

1. **查看默认配置**：插件的所有默认参数均位于 `config/default.yaml`。**（⚠️ 请勿直接修改此文件，以免后续更新产生代码冲突）**
2. **生成用户配置**：当您首次启动机器人时，系统会自动在 `config/` 目录下生成一个 `config.yaml` 文件。（您也可以手动新建此文件）
3. **自定义覆盖**：打开 `config/config.yaml`，您只需要在里面写入您想要修改的参数即可！未写入的参数将自动使用 `default.yaml` 中的默认值。该文件已被加入 `.gitignore`，绝对不会在您更新或上传代码时被覆盖或泄露。

### `config.yaml` 配置示例：

```yaml
# 每日早报配置
daily:
  time: '0 30 9 * * *'
  groupList: ['12345678', '87654321'] # 填入您的推送群号
  isAutoPush: true

# 米游社Cos配置
mys_cos:
  # 推送目标：群号写 'group'，QQ号写 'private'
  POSTLIST:
    12345678: 'group'
    87654321: 'private' 
  SEND_MODE_DEFAULT: 'forward-icqq' # 合并转发模式，可选 forward-onebot / forward-auto / plain
```

> **常见配置项说明**：
> * **定时推送时间**：`time` / `AUTO_CRON`
> * **定时推送开关**：`isAutoPush`
> * **推送目标**：`groupList` / `POSTLIST`
> * **合并转发模式**：`SEND_MODE_DEFAULT`
> * **Sharp 压缩设置**：`SHARP_ENABLE` / `JPEG_QUALITY` / `SHARP_MAX_BYTES` 等

> **💡 Cron 小贴士**：若 `node-schedule` 不认 `?`（Quartz 风格），请在 `config.yaml` 中把定时表达式从 `0 30 9 * * ?` 改成 `0 30 9 * * *`（把 `?` 替换为 `*` 即可）。

### WOC 抓图的配置要点

WOC 从多个 WordPress 站点的公开 REST 接口抓图，**一次 `#woc` 的若干张图来自同一个站的同一篇文章**（整套图集），不会跨站拼凑。

**图源选取**

```yaml
woc:
  SOURCE_ORDER: [main, coserlab, 4khd, 4kup, bestgirlsexy]  # 候选图源清单，删掉某项即不用它
  SOURCE_PICK: random          # random=每次随机挑一个（默认）；order=按上面顺序依次试
  FALLBACK_ENABLE: true        # 某个源挂了就换下一个
  SOURCE_FAIL_COOLDOWN: 600    # 抓挂的源冷却 600 秒，期间排到队尾而不是直接丢掉
```

**取图顺序**：图集开头往往最平淡，默认不取前几张。

```yaml
  PICK_ORDER: random           # random=随机 / reverse=倒序 / order=按原顺序
  R18_PICK_ORDER: random       # R18 档单独配
```

**R18 分档（默认全关）**：每个源的分类拆成「非 R18 档」和「R18 档」两组，三层开关递进控制。

```yaml
  R18_ENABLE: false            # 总开关；关闭时各源只用非 R18 分类（cosplay 那档）
  R18_PRIVATE_ONLY: true       # 只在私聊放开，群聊自动降级回非 R18
  R18_RATE: 0.3                # 出图概率。掷中时只从配了 R18 分类的源里挑，
                               # 且只用 R18 分类，所以这就是实打实的出图率
```

> ⚠️ R18 相关分类默认全部关闭。是否开启、在什么场合开启，由使用者自行判断并承担责任。

**下载容错**

```yaml
  DOWNLOAD_RETRY: 2            # 只对 429/408/5xx/超时重试；404/403 直接放弃
  DOWNLOAD_GAP_MS: 250         # 图间隔全局默认，各源可用 <前缀>_DOWNLOAD_GAP_MS 覆盖
  DROP_DEAD_IMAGES: true       # 404/410 死链直接剔除并换下一张（链接点开也是 404）
  DEAD_STREAK: 5               # 连续 5 张死链 → 判定整组已被删，立刻换下一组
  GROUP_RETRY: 2               # 整组死链时最多再换几组
  BYPASS_PHOTON: true          # 把 i*.wp.com 图片代理还原成源站直链
```

> **关于 `BYPASS_PHOTON`**：WordPress 的 Photon 图片代理（`i0~i3.wp.com`）会对部分图片**永久**返回 `429`——换节点、等再久都一样，但源站直链是好的。开启后自动还原，实测可把某站的取图成功率从 16/24 提到 24/24。

---

### XJJ R18 扩展（Fantasy Factory）的配置要点

`Huitian-xjj-r18.js` 单独挂 `#r18xjj` / `#r18xjjpro` 前缀，不改动原 `#xjj` 的任何逻辑：`#黑丝`、`#jk`、`#xjjpro` 仍然归原插件，两条命令互不抢占。

图源是公开的静态目录站（h5ai 索引），没有 JSON 接口，插件直接解析目录页表格拿文件列表，不需要任何 API Key 或 Cookie。

**命令**

| 命令 | 作用 |
|---|---|
| `#r18xjj` / `#r18xjj图片` | 随机一套图（3~6 张，合并转发） |
| `#r18xjj 关键词` | 按套图名或月份筛选，如 `#r18xjj 2022.06` |
| `#r18xjjpro` | 视频 |
| `#r18xjjpro 关键词` | 在指定范围内找视频 |
| `#r18xjj列表` | 列出已索引的月份目录 |

**默认只开私聊**

```yaml
xjj_r18:
  CMD_PREFIX: 'r18xjj'      # 主命令前缀
  ENABLE: true
  PRIVATE_ONLY: true        # 群聊不提供服务
  GROUP_SILENT: true        # 群里完全不接话；改成 false 则回一句提示
```

**目录索引**

```yaml
  INDEX_TTL_HOURS: 24       # 索引有效期（小时），过期自动重建
  INDEX_MAX_MONTHS: 0       # 0=索引全部月份；只想要最近的填 N
  INDEX_CONCURRENCY: 3      # 抓目录的并发，别调太高
  INDEX_GAP_MS: 150         # 每个请求之间的间隔
  SET_MEDIA_TTL_MIN: 120    # 单个套图文件列表的内存缓存时间
```

> 首次使用会花十几秒抓一遍目录（几十个请求），之后走 `data/xjj-r18-index.json` 缓存，单次出图稳定在数秒内。索引文件是运行期缓存，已在 `.gitignore` 中排除。

**视频**

```yaml
  VIDEO_ENABLE: true
  VIDEO_SYNTH: true         # 站点里翻不到视频时，用一套图合成竖屏幻灯片
  VIDEO_SYNTH_IMAGES: 10    # 合成用几张图
  VIDEO_SEC_PER_IMG: 2      # 每张停留秒数
  MAX_VIDEO_BYTES: 62914560 # 超过这个体积的视频直接跳过
  VIDEO_PREFER_BYTES: 26214400  # 优先挑这个体积以下的，发得快
  FFMPEG_PATH: 'ffmpeg'
  FFMPEG_QUIET: true        # 没装 ffmpeg 时只记一条 MARK，不刷 WARN / ERROR
```

> **没装 ffmpeg 不会报错**：探测一次后记住结果，合成档自动跳过，站点自带的视频和图片照常发送。需要合成功能时 `apt install ffmpeg` 再重启 Bot 即可。

> ⚠️ 该图源为成人向内容，默认只在私聊开放。是否启用、在什么场合启用，由使用者自行判断并承担责任。

## 指令示例

* **早报**：`#今日早报`
* **摸鱼**：`#摸鱼日历`
* **COS**：`#cos` / `#mys cos`
* **指定模式**：`#cos icqq` / `#cos ob` / `#cos auto` / `#cos plain`
* **WOC**：`#woc` / `#卧槽`
* **XJJ 图片**：`#小姐姐` / `#xjj` / `#黑丝` / `#jk` / `#美腿图片`（支持数十种中英分类匹配，混合随机接口）
* **XJJ 视频**：`#小姐姐视频` / `#xjjpro` / `#黑丝视频` / `#鞠婧祎pro` / `#慢摇视频`（聚合多图床与网红分类直连）
* **XJJ-R18 图片**：`#r18xjj` / `#r18xjj 2022.06` / `#r18xjj Calliope`（默认仅私聊，群聊静默不响应）
* **XJJ-R18 视频**：`#r18xjjpro` / `#r18xjjpro 关键词`（站点直链优先，翻不到再合成；群聊静默）

## 免责声明

* **开源性质**：Huitian-mini 为永久免费项目，基于 **GNU Affero General Public License v3.0** (简称 AGPL v3.0) 协议向公众开放。
* **项目定位**：本项目主要面向 Yunzai-Bot 用户群体，旨在促进内部技术交流与学习。用户在使用过程中应严格遵守 AGPL v3.0 开源协议及当地法律法规。
* **第三方服务**：本项目所引用的第三方 API 均尽力遵循其官方使用准则。开发者不对该等 API 及其内容的合法性、准确性或稳定性作任何形式的担保。用户应自行评估并承担因调用第三方服务而产生的法律及相关风险。

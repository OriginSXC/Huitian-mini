<div align="center">

# Huitian-mini

轻量级 **Yunzai / TRSS / Miao / NapCat(OneBot v11)** 插件合集  
**早报 · 摸鱼日历 · 米游社 COS · WP 抓图 · 随机图/视频**

<p>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/github/license/OriginSXC/Huitian-mini"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen">
  <a href="https://github.com/OriginSXC/Huitian-mini/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/OriginSXC/Huitian-mini?style=flat"></a>
  <a href="https://github.com/OriginSXC/Huitian-mini/issues"><img alt="issues" src="https://img.shields.io/github/issues/OriginSXC/Huitian-mini"></a>
</p>
</div>

## 功能一览

- ✅ **指令触发 + 定时推送**（node-schedule）
- ✅ **合并转发**（OneBot / icqq），支持分批发送降低风控
- ✅ **可选 sharp 压缩/裁剪**：降低大图体积与发送失败概率
- ✅ **不稳定源站增强**：Base64 强制发送、限并发拉取、keep-alive 等

## 插件列表

| 插件 | 指令 | 定时推送 | 依赖 | 简述 |
|---|---|---:|---|---|
| 今日早报 | `#今日早报` | ✅（默认 09:30） | `node-fetch` `node-schedule` | 拉取“60s 早报”图片并推送 |
| 摸鱼日历 | `#摸鱼日历` | ✅（默认 09:00） | `node-fetch` `node-schedule` | 拉取摸鱼人日历并推送 |
| 米游社 COS（reborn） | `#cos` / `mys cos`（可加 `ob/icqq/auto/plain`） | ✅（默认 12:08:30） | `node-fetch` `node-schedule` `sharp` | 随机抓取米游社贴子图片，分批合并转发 |
| WOC 抓图（reborn） | `#woc` / `#卧槽` | ❌ | `sharp` | WP 媒体库抓图 → 强制 Base64 → 分批合并转发（优先 icqq） |
| XJJ 稳定版 | `#小姐姐` / `#xjj`；视频：`#小姐姐视频`/`#xjjpro` | ❌ | `node-fetch` `sharp` | 限并发补齐、keep-alive、失败自动降级逐张发送 |

---

## 安装

在 **云崽根目录** 执行：

```bash
git clone https://github.com/OriginSXC/Huitian-mini.git ./plugins/Huitian-mini
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


## 配置

所有插件目前都采用「文件内常量」配置（简单直观），通常会改这些：

* **定时推送时间**：`time` / `AUTO_CRON`
* **定时推送开关**：`isAutoPush`
* **推送目标**：`groupList` / `POSTLIST`
* **合并转发模式**：`SEND_MODE_DEFAULT`（forward-onebot / forward-icqq / forward-auto / plain）
* **sharp**：`SHARP_ENABLE` / `JPEG_QUALITY` / `SHARP_MAX_BYTES` 等

> **Cron 小贴士**：若 `node-schedule` 不认 `?`（Quartz 风格），把 `0 30 9 * * ?` 改成 `0 30 9 * * *`（把 `?` 当作 `*`）。

---

## 指令示例

* **早报**：`#今日早报`
* **摸鱼**：`#摸鱼日历`
* **COS**：`#cos` / `#mys cos`
* **指定模式**：`#cos icqq` / `#cos ob` / `#cos auto` / `#cos plain`
* **WOC**：`#woc` / `#卧槽`
* **XJJ**：`#小姐姐` / `#xjj`
* **XJJ 视频**：`#小姐姐视频` / `#xjjpro`

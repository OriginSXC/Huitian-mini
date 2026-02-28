<div align="center">

# Huitian-mini

轻量级 **Yunzai / TRSS / Miao / NapCat(OneBot v11)** 插件合集  
**早报 · 摸鱼日历 · 米游社 COS · WP 抓图 · 随机图/视频**

<p>
  <a href="./LICENSE"><img alt="license" src="[https://img.shields.io/github/license/OriginSXC/Huitian-mini](https://img.shields.io/github/license/OriginSXC/Huitian-mini)"></a>
  <img alt="node" src="[https://img.shields.io/badge/node-%3E%3D18-brightgreen](https://img.shields.io/badge/node-%3E%3D18-brightgreen)">
  <a href="[https://github.com/OriginSXC/Huitian-mini/stargazers](https://github.com/OriginSXC/Huitian-mini/stargazers)"><img alt="stars" src="[https://img.shields.io/github/stars/OriginSXC/Huitian-mini?style=flat](https://img.shields.io/github/stars/OriginSXC/Huitian-mini?style=flat)"></a>
  <a href="[https://github.com/OriginSXC/Huitian-mini/issues](https://github.com/OriginSXC/Huitian-mini/issues)"><img alt="issues" src="[https://img.shields.io/github/issues/OriginSXC/Huitian-mini](https://img.shields.io/github/issues/OriginSXC/Huitian-mini)"></a>
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
| XJJ 极速增强版 | `#xjj` / `#黑丝`；视频：`#xjjpro` / `#jk视频` 等 | ❌ | `node-fetch` `sharp` | 多接口聚合，支持全量中英文别名分类（JK/黑丝/网红/变装等），内置防缓存与过滤排错机制 |

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

## 指令示例

* **早报**：`#今日早报`
* **摸鱼**：`#摸鱼日历`
* **COS**：`#cos` / `#mys cos`
* **指定模式**：`#cos icqq` / `#cos ob` / `#cos auto` / `#cos plain`
* **WOC**：`#woc` / `#卧槽`
* **XJJ 图片**：`#小姐姐` / `#xjj` / `#黑丝` / `#jk` / `#美腿图片`（支持数十种中英分类匹配，混合随机接口）
* **XJJ 视频**：`#小姐姐视频` / `#xjjpro` / `#黑丝视频` / `#鞠婧祎pro` / `#慢摇视频`（聚合多图床与网红分类直连）

## 免责声明

* **开源性质**：Huitian-mini 为永久免费项目，基于 **GNU Affero General Public License v3.0** (简称 AGPL v3.0) 协议向公众开放。
* **项目定位**：本项目主要面向 Yunzai-Bot 用户群体，旨在促进内部技术交流与学习。用户在使用过程中应严格遵守 AGPL v3.0 开源协议及当地法律法规。
* **第三方服务**：本项目所引用的第三方 API 均尽力遵循其官方使用准则。开发者不对该等 API 及其内容的合法性、准确性或稳定性作任何形式的担保。用户应自行评估并承担因调用第三方服务而产生的法律及相关风险。

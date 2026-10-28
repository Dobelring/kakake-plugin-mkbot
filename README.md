# kakake-plugin-mkbot（补丁发行版 / patched dist）

> 本分支是 [tc-404/kakake-plugin-mkbot](https://github.com/tc-404/kakake-plugin-mkbot) **v2.3.12**（commit `da0d327`，MIT 许可，作者：三个句号）**编译发行版**的个人修改版本。
> `main` 分支保持上游源码原样；本分支 `patched-dist` 存放修改后、可直接部署的插件文件（与实际运行环境一致）。

## 与上游 2.3.12 的差异（6 处补丁）

针对 SnowLuma（NTQQ 注入式 OneBot v11 协议端）+ 咔咔珂（kakake）的实际部署环境：

| # | 文件 | 修改 | 原因 |
|---|---|---|---|
| 1 | `lib/api/blbl.mjs` | B站 API 请求自动补 `buvid3`（官方 spi 指纹接口获取，6 小时缓存，失败随机兜底）+ 永远携带 `Referer` + 遇 412 换 buvid3 重试一次 | 机房 IP（阿里云等）无 Cookie 裸请求 api.bilibili.com 会被 WAF 直接拦（HTTP 412） |
| 2 | `index.mjs` | `视频解析群聊回应解析成功()` 改为直接 return | 不再给检测到链接的消息贴表情回应（`set_msg_emoji_like`，emoji_id 324） |
| 3 | `index.mjs` | `视频解析构建音频文件节点()` 开头直接 `return null` | 解析结果不再附带 MP3 音频节点（顺带省去音频下载流量） |
| 4 | `index.mjs` | 图片/视频节点的 label 过滤 `[1/2]`、`【1/2】` 形态的序号 | 多图聊天记录不再显示序号标记，只发图片（元数据文本保留） |
| 5 | `index.mjs` | 纯视频平台（抖音/B站/快手/YouTube/TikTok）的视频段放进聊天记录节点，元数据在前、视频随后，不再先单独发一条视频消息 | 解析结果只发一条聊天记录，内含元数据+视频 |
| 6 | `index.mjs` | 图集/实况混排时主视频段同样放进聊天记录 | 同上 |

补丁 5/6 均带兜底：若协议端拒绝「聊天记录内带视频」，自动退回单独发送视频 / 原链接，不会静默失败。

## 安装

1. 本分支页面右上角 **Code → Download ZIP**，解压得到 `kakake-plugin-mkbot/` 目录；
2. 放入 kakake 的 `plugins/` 目录，重启 kakake；
3. 运行时依赖 sharp（在插件目录或宿主根目录 `npm install sharp` 即可，国内可用 `--registry=https://registry.npmmirror.com`）。

## 升级上游后重打补丁

上游发新版后，下载新 release 解压到插件目录，然后在插件目录执行：

```bash
python3 patches/patch_mkbot.py <插件目录>/index.mjs
python3 patches/patch_video_inside.py <插件目录>/index.mjs
```

补丁 1（blbl.mjs）建议直接参考本分支 `lib/api/blbl.mjs` 移植。

脚本内置唯一性断言：上游代码变动导致匹配失败时会报错退出而**不会误改**，此时需人工比对新版代码调整匹配串。首次执行会在同目录生成 `index.mjs.bak-orig` 备份（已存在则不覆盖）。

## 许可

上游项目 MIT 许可（© 三个句号），本修改版同样以 MIT 发布。仅供学习与自用，请遵守上游使用声明，禁止违法违规使用。

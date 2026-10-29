"""
kakake-plugin-mkbot 补丁：通用分享卡片解析（json 卡片提取跳转链接）
上游 json 分支只认「哔哩哔哩」标题卡片；本补丁对其余卡片（小红书等）
从 meta.news.jumpUrl 等字段提取链接并按域名设置解析方向。
"""
import sys

P = sys.argv[1] if len(sys.argv) > 1 else '/home/admin/kakake/plugins/kakake-plugin-mkbot/index.mjs'
s = open(P, encoding='utf-8').read()
n = 0

old1 = '''        let 标题 = jsonData?.meta?.detail_1?.title;
        if (标题 == "哔哩哔哩") {
          解析链接 = jsonData?.meta?.detail_1?.qqdocurl;
          解析方向 = "哔哩哔哩";
        }
      }'''
new1 = '''        let 标题 = jsonData?.meta?.detail_1?.title;
        if (标题 == "哔哩哔哩") {
          解析链接 = jsonData?.meta?.detail_1?.qqdocurl;
          解析方向 = "哔哩哔哩";
        }
        // 通用分享卡片（小红书等）：从卡片 JSON 提取跳转链接
        if (解析链接 == ``) {
          let 卡片链接 = String(jsonData?.meta?.news?.jumpUrl || jsonData?.meta?.news?.url || jsonData?.meta?.detail_1?.qqdocurl || "").trim();
          if (!卡片链接) {
            let 卡片串 = typeof event.message[0].data.data === "string" ? event.message[0].data.data : JSON.stringify(jsonData);
            卡片链接 = String(卡片串).replace(/\\\\\\//g, "/").match(/https?:\\/\\/[^\\s"'<>\\\\]+/i)?.[0] || "";
          }
          if (卡片链接) {
            解析链接 = 卡片链接;
            if (/b23\\.tv|bilibili\\.com/i.test(卡片链接)) 解析方向 = "哔哩哔哩";
            else if (/xhslink\\.|xiaohongshu\\.com/i.test(卡片链接)) 解析方向 = "小红书";
            else if (/douyin\\.com|iesdouyin\\.com/i.test(卡片链接)) 解析方向 = "抖音";
            else if (/kuaishou\\.com/i.test(卡片链接)) 解析方向 = "快手";
            else if (/youtube\\.com|youtu\\.be/i.test(卡片链接)) 解析方向 = "YouTube";
            else if (/tiktok\\.com/i.test(卡片链接)) 解析方向 = "TikTok";
          }
        }
      }'''
c = s.count(old1)
if c == 1:
    s = s.replace(old1, new1)
    n += 1
else:
    print(f'xhs-card skip (count={c})')

open(P, 'w', encoding='utf-8').write(s)
print(f'XHS-CARD-PATCH: {n}/1 applied')

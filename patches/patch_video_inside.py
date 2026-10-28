"""
kakake-plugin-mkbot v2.3.12 补丁：视频放进聊天记录（不再先单独发一条视频消息）

用法: python3 patch_video_inside.py <插件目录>/index.mjs
首次执行生成 index.mjs.bak-orig 备份（已存在则不覆盖）。
带兜底：若协议端拒绝转发内视频，自动退回单独发送。
"""
import os
import shutil
import sys

if len(sys.argv) < 2:
    print('usage: python3 patch_video_inside.py <path/to/index.mjs>')
    sys.exit(1)
P = sys.argv[1]
s = open(P, encoding='utf-8').read()

if not os.path.exists(P + '.bak-orig'):
    shutil.copy(P, P + '.bak-orig')
    print('backup ->', P + '.bak-orig')
else:
    print('backup already exists, keep it')

changed = 0

# 分支1（纯视频：抖音/快手/B站/YouTube/TikTok）：视频塞进聊天记录，不再先单独发
old1 = '''        const 下载结果 = await Promise.all(下载任务);
        const vseg = 下载结果[0];
        if (!vseg) return false;
        let 已发出2 = false;
        let 视频已发2 = false;
        try {
          视频已发2 = await 发消息(event2, [vseg]) ? true : false;
        } catch {
          视频已发2 = false;
        }
        if (视频已发2) {
          已发出2 = true;
        } else {
          try {
            if (await 发消息(event2, [段_文本(视频链接)])) 已发出2 = true;
          } catch {
          }
        }
        const 转发节点 = [];
        if (信息2 || 封面2) {
          const content = [];
          if (信息2) content.push(段_文本(信息2));
          const 封面段 = 封面2 ? 下载结果[1] : null;
          if (封面段) content.push(封面段);
          if (!content.length) content.push(段_文本(""));
          转发节点.push(合并节点(prefix, event2.self_id, content));
        }'''
new1 = '''        const 下载结果 = await Promise.all(下载任务);
        const vseg = 下载结果[0];
        if (!vseg) return false;
        let 已发出2 = false;
        const 转发节点 = [];
        if (信息2 || 封面2) {
          const content = [];
          if (信息2) content.push(段_文本(信息2));
          const 封面段 = 封面2 ? 下载结果[1] : null;
          if (封面段) content.push(封面段);
          if (!content.length) content.push(段_文本(""));
          转发节点.push(合并节点(prefix, event2.self_id, content));
        }
        转发节点.push(合并节点(prefix, event2.self_id, [vseg]));'''
c = s.count(old1)
if c == 1:
    s = s.replace(old1, new1)
    changed += 1
else:
    print(f'patch-video-1 skip (count={c})')

# 分支1尾：转发失败时兜底单独发视频/链接
old2 = '''        if (转发节点.length) {
          try {
            if (await 视频解析发出合并转发(event2, ctx2, { platform, title, nodes: 转发节点 })) 已发出2 = true;
          } catch {
          }
        }
        return 已发出2;
      }
      const 封面 = String(cover || "").trim();'''
new2 = '''        if (转发节点.length) {
          try {
            if (await 视频解析发出合并转发(event2, ctx2, { platform, title, nodes: 转发节点 })) 已发出2 = true;
          } catch {
          }
        }
        if (!已发出2) {
          try {
            if (await 发消息(event2, [vseg])) 已发出2 = true;
          } catch {
          }
        }
        if (!已发出2) {
          try {
            if (await 发消息(event2, [段_文本(视频链接)])) 已发出2 = true;
          } catch {
          }
        }
        return 已发出2;
      }
      const 封面 = String(cover || "").trim();'''
c = s.count(old2)
if c == 1:
    s = s.replace(old2, new2)
    changed += 1
else:
    print(f'patch-video-2 skip (count={c})')

# 分支2（图集/实况混排）：主视频段也塞进聊天记录
old3 = '''      if (主视频段 && String(主视频段.type || "") !== "video") {
        nodes.push(合并节点(prefix, event2.self_id, [主视频段]));
        主视频段 = null;
      }'''
new3 = '''      let 视频段兜底 = null;
      if (主视频段) {
        视频段兜底 = 主视频段;
        nodes.push(合并节点(prefix, event2.self_id, [主视频段]));
        主视频段 = null;
      }'''
c = s.count(old3)
if c == 1:
    s = s.replace(old3, new3)
    changed += 1
else:
    print(f'patch-video-3 skip (count={c})')

# 分支2尾：转发失败时兜底单独发视频
old4 = '''      if (发送任务.length) await Promise.all(发送任务);
      let 已发出 = 转发已发 || 视频已发;'''
new4 = '''      if (发送任务.length) await Promise.all(发送任务);
      let 已发出 = 转发已发 || 视频已发;
      if (视频段兜底 && !转发已发) {
        try {
          if (await 发消息(event2, [视频段兜底])) 已发出 = true;
        } catch {
        }
      }'''
c = s.count(old4)
if c == 1:
    s = s.replace(old4, new4)
    changed += 1
else:
    print(f'patch-video-4 skip (count={c})')

open(P, 'w', encoding='utf-8').write(s)
print(f'PATCH-VIDEO-OK: {changed}/4 patches applied')

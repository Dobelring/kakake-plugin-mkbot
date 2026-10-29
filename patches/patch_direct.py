"""
kakake-plugin-mkbot 补丁：单视频结果直接发（元数据文本+视频两条普通消息），
不再包聊天记录；多图/实况等多媒体仍用聊天记录。单图也直接发。
"""
import os
import shutil
import sys

P = sys.argv[1] if len(sys.argv) > 1 else '/home/admin/kakake/plugins/kakake-plugin-mkbot/index.mjs'
s = open(P, encoding='utf-8').read()
if not os.path.exists(P + '.bak-orig'):
    shutil.copy(P, P + '.bak-orig')
n = 0

# ---------- 分支1（纯视频）：直接发 元数据文本 + 视频 ----------
old1 = '''        let 已发出2 = false;
        const 转发节点 = [];
        if (信息2 || 封面2) {
          const content = [];
          if (信息2) content.push(段_文本(信息2));
          const 封面段 = 封面2 ? 下载结果[1] : null;
          if (封面段) content.push(封面段);
          if (!content.length) content.push(段_文本(""));
          转发节点.push(合并节点(prefix, event2.self_id, content));
        }
        转发节点.push(合并节点(prefix, event2.self_id, [vseg]));
        if (music) {
          const 音频节点 = 下载结果[封面2 ? 2 : 1];
          if (音频节点) 转发节点.push(音频节点);
        }
        if (转发节点.length) {
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
        return 已发出2;'''
new1 = '''        let 已发出2 = false;
        // 按用户要求：单视频结果直接发（元数据文本 + 视频），不走聊天记录
        if (信息2) {
          try {
            if (await 发消息(event2, [段_文本(信息2)])) 已发出2 = true;
          } catch {
          }
        }
        try {
          if (await 发消息(event2, [vseg])) 已发出2 = true;
        } catch {
        }
        if (!已发出2) {
          try {
            if (await 发消息(event2, [段_文本(视频链接)])) 已发出2 = true;
          } catch {
          }
        }
        return 已发出2;'''
c = s.count(old1)
if c == 1:
    s = s.replace(old1, new1)
    n += 1
else:
    print(f'branch1 skip (count={c})')

# ---------- 分支2（图集/实况/混合）：单媒体直发，多媒体保留聊天记录 ----------
old2 = '''        主视频段 = null;
      }
      let 转发已发 = false;'''
new2 = '''        主视频段 = null;
      }
      // 按用户要求：仅一条媒体（如单图）直接发；多图/实况等多媒体才用聊天记录
      const 图数 = Array.isArray(images) ? images.length : 0;
      const 实况数 = Array.isArray(liveItems) ? liveItems.length : 0;
      if (图数 + 实况数 <= 1 && !视频链接) {
        let 直发媒体段 = null;
        for (let i = 0; i < jobs.length; i++) {
          if (jobs[i].kind === "node" && results[i] && Array.isArray(results[i].content) && results[i].content.length) {
            直发媒体段 = results[i].content[0];
            break;
          }
        }
        let 直发已发出 = false;
        if (信息) {
          try {
            if (await 发消息(event2, [段_文本(信息)])) 直发已发出 = true;
          } catch {
          }
        }
        if (直发媒体段) {
          try {
            if (await 发消息(event2, [直发媒体段])) 直发已发出 = true;
          } catch {
          }
        }
        if (!直发已发出 && 图数 === 1) {
          try {
            if (await 发消息(event2, [段_文本(images[0])])) 直发已发出 = true;
          } catch {
          }
        }
        return 直发已发出;
      }
      let 转发已发 = false;'''
c = s.count(old2)
if c == 1:
    s = s.replace(old2, new2)
    n += 1
else:
    print(f'branch2 skip (count={c})')

open(P, 'w', encoding='utf-8').write(s)
print(f'DIRECT-PATCH: {n}/2 applied')

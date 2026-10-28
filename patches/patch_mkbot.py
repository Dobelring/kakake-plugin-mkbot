"""
kakake-plugin-mkbot v2.3.12 补丁：B站解析外其余行为调整（表情回应/MP3节点/[1/2]标记）

用法: python3 patch_mkbot.py <插件目录>/index.mjs
首次执行生成 index.mjs.bak-orig 备份（已存在则不覆盖）。
"""
import os
import shutil
import sys

if len(sys.argv) < 2:
    print('usage: python3 patch_mkbot.py <path/to/index.mjs>')
    sys.exit(1)
P = sys.argv[1]
s = open(P, encoding='utf-8').read()

if not os.path.exists(P + '.bak-orig'):
    shutil.copy(P, P + '.bak-orig')
    print('backup ->', P + '.bak-orig')
else:
    print('backup already exists, keep it')

changed = 0

# 1) 关闭「链接消息贴表情 324」：视频解析群聊回应解析成功 -> 直接返回
old1 = '''  async function 视频解析群聊回应解析成功(event2, ctx2) {
    if (event2.message_type !== "group") return;
    await reactFakeChatCommandMessage(ctx2, event2.message_id, FAKE_CHAT_EMOJI_REACT_PARSE_OK, BOTAPI);
  }'''
new1 = '''  async function 视频解析群聊回应解析成功(event2, ctx2) {
    return;
  }'''
c = s.count(old1)
if c == 1:
    s = s.replace(old1, new1)
    changed += 1
else:
    print(f'patch1 skip (count={c})')

# 2) 不再构建 MP3 音频节点（解析结果只含元数据+视频/图片）
old2 = '''  async function 视频解析构建音频文件节点(event2, {
    nodeName = "音频",
    music,
    title = "",
    timeoutMs,
    cleanup
  }) {
    const url = 视频解析取音频链接(music);'''
new2 = '''  async function 视频解析构建音频文件节点(event2, {
    nodeName = "音频",
    music,
    title = "",
    timeoutMs,
    cleanup
  }) {
    return null;
    const url = 视频解析取音频链接(music);'''
c = s.count(old2)
if c == 1:
    s = s.replace(old2, new2)
    changed += 1
else:
    print(f'patch2 skip (count={c})')

# 3) 图片/视频节点不再附加 [1/2] 之类序号标记（元数据 label 保留）
old3 = '''    if (label) content.push(段_文本(label));'''
new3 = '''    if (label && !/^[\\[【]\\d+\\/\\d+[\\]】]$/.test(String(label).trim())) content.push(段_文本(label));'''
c = s.count(old3)
if c == 2:
    s = s.replace(old3, new3)
    changed += 1
else:
    print(f'patch3 skip (count={c}, expect 2)')

open(P, 'w', encoding='utf-8').write(s)
print(f'PATCH-OK: {changed}/3 patches applied')

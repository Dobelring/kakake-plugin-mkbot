"""
kakake-plugin-mkbot 代理补丁修正：yt/tt 调度调用补传 mkVideoApiCtx()
（否则 ctx?.proxy 为 undefined，代理不生效，回退直连 fetch failed）
"""
import sys

IDX = sys.argv[1]
s = open(IDX, encoding='utf-8').read()
n = 0

old1 = 'const API_shuju = await callLocalVideoApi(PLUGIN_DIR, "yt", 解析链接);'
new1 = 'const API_shuju = await callLocalVideoApi(PLUGIN_DIR, "yt", 解析链接, mkVideoApiCtx());'
c = s.count(old1)
if c == 1:
    s = s.replace(old1, new1)
    n += 1
else:
    print(f'yt-callsite skip (count={c})')

old2 = 'const API_shuju = await callLocalVideoApi(PLUGIN_DIR, "tt", 解析链接);'
new2 = 'const API_shuju = await callLocalVideoApi(PLUGIN_DIR, "tt", 解析链接, mkVideoApiCtx());'
c = s.count(old2)
if c == 1:
    s = s.replace(old2, new2)
    n += 1
else:
    print(f'tt-callsite skip (count={c})')

open(IDX, 'w', encoding='utf-8').write(s)
print(f'CTX-FIX: {n}/2 applied')

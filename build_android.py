"""把 PWA 源码同步到 Capacitor 的 www 目录，不打包 node_modules / .git。"""
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = ROOT
DST = os.path.join(ROOT, 'www')
ITEMS = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'assets']

if not os.path.isdir(DST):
    os.makedirs(DST, exist_ok=True)

# 覆盖式同步：不整目录删除，避免误删与文件数阈值告警；已删除的旧文件可能残留
for name in ITEMS:
    s = os.path.join(SRC, name)
    d = os.path.join(DST, name)
    if os.path.isdir(s):
        shutil.copytree(s, d, dirs_exist_ok=True)
    elif os.path.isfile(s):
        shutil.copy2(s, d)
    else:
        raise SystemExit(f'缺少待打包文件: {name}')

total = sum(
    os.path.getsize(os.path.join(r, f))
    for r, _, fs in os.walk(DST)
    for f in fs
)
print(f'已同步 {len(ITEMS)} 项到 www/（{total:,} bytes）')

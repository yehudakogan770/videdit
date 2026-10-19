#!/usr/bin/env python3
"""Bundle index.html + style.css + app.js into one self-contained HTML file.

This is the file the user actually downloads and double-clicks.
Usage: python3 tools/build_single_file.py [output]   (default: dist/VidEdit.html)
"""
import os
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'dist', 'VidEdit.html')


def read(name):
    with open(os.path.join(root, name), encoding='utf-8') as f:
        return f.read()


html = read('index.html')
css, js = read('style.css'), read('app.js')
assert '</script' not in js, 'app.js must not contain a closing script tag'
html = html.replace('<link rel="stylesheet" href="style.css" />', '<style>\n' + css + '</style>')
html = html.replace('<script src="app.js"></script>', '<script>\n' + js + '</script>')
assert 'href="style.css"' not in html and 'src="app.js"' not in html, 'index.html structure changed; update this script'

os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, 'w', encoding='utf-8') as f:
    f.write(html)
print(f'Wrote {out} ({len(html):,} bytes)')

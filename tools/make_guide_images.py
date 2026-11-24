# 圖文教學截圖加工：遮蓋個資、裁掉狀態列、加橘色標記框與編號，輸出到 img/guide/
# 原始截圖（iPhone 全螢幕截圖 946×2047；放在 test/，git 忽略，不公開）：
#   時間軸教學 tl-ios-*：test/guide_src/1.jpg～8.jpg
#   備份教學   bk-ios-*：test/guide_import/1.jpg～4.jpg
# 用法：python tools/make_guide_images.py
#
# 個資一律「蓋掉」而不只是模糊：姓名、Email、地址、聯絡人、檔名、照片 → 實心色塊＋灰色示意圖形；
# 地圖 → 重度模糊再疊一層灰，看不出街道。全部輸出成同一尺寸，翻頁時版面不跳動。
import io
import time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'test'
OUT = ROOT / 'img' / 'guide'
ORANGE = (255, 77, 26)          # 同 css/theme.css 的 --c-accent（淺色）
GHOST = (214, 218, 224)         # 示意圖形的灰
WIDTH = 720                     # 輸出寬度
CROP = (0, 113, 946, 2047)      # 裁掉狀態列；8 張同一範圍 → 同一尺寸
FONT = 'C:/Windows/Fonts/arialbd.ttf'
K = 946 / 924                   # 下面座標以 924 寬的預覽量測，乘上 K 換成原圖像素

# 操作（依序執行；keep 先存原圖、最後貼回）：
#   ('map', box)                 地圖：重度模糊＋疊灰
#   ('blur', box)                一般模糊（縮圖、App 圖示）
#   ('fill', box, (x, y))        用 (x, y) 那點的顏色實心蓋掉
#   ('round', box, (x, y))       同上，但畫成膠囊形（重畫搜尋列）
#   ('text', box)                示意文字條（兩條灰色圓角條）
#   ('avatar', (cx, cy), r)      示意大頭貼
#   ('tile', box)                示意檔案／照片方塊（方塊＋下方兩條字）
#   ('keep', box)                這塊保留原樣（例如地圖上的搜尋列）
# 標記：(編號, box)；編號在每份教學內連續（時間軸 1–9、備份 1–4），和 js/guide.js 文字裡的編號對應
JOBS = {
    # 1 地圖首頁：點右上角大頭貼
    'tl-ios-1': dict(src='guide_src/1.jpg', ops=[
        ('keep', (60, 140, 780, 236)),                 # 搜尋列內容（不含大頭貼）
        ('map', (0, 0, 924, 1650)),
        ('round', (30, 132, 895, 244), (450, 1700)),   # 重畫搜尋列底（圓角，不露出地圖）
        ('avatar', (838, 187), 40),
    ], marks=[(1, (792, 135, 886, 240))]),
    # 2 帳戶選單：你的時間軸
    'tl-ios-2': dict(src='guide_src/2.jpg', ops=[
        ('map', (0, 0, 924, 150)),
        ('fill', (240, 290, 720, 420), (600, 280)),    # 姓名、Email
        ('text', (258, 312, 560, 400)),
        ('fill', (70, 280, 225, 425), (600, 280)),     # 大頭貼
        ('avatar', (143, 348), 66),
    ], marks=[(2, (38, 938, 886, 1072))]),
    # 3 時間軸：右上角 ⋯
    'tl-ios-3': dict(src='guide_src/3.jpg', ops=[
        ('map', (0, 367, 924, 1000)),
        ('fill', (125, 1315, 760, 1445), (300, 1500)), # 造訪地點、地址、時間
        ('text', (138, 1325, 640, 1435)),
    ], marks=[(3, (684, 156, 766, 238))]),
    # 4 ⋯ 選單：位置和隱私權設定
    'tl-ios-4': dict(src='guide_src/4.jpg', ops=[
        ('map', (0, 367, 924, 1000)),
    ], marks=[(4, (18, 1238, 906, 1352))]),
    # 5 位置和隱私權：匯出時間軸資料
    'tl-ios-5': dict(src='guide_src/5.jpg', ops=[], marks=[(5, (18, 1310, 906, 1418))]),
    # 6 分享選單：儲存到檔案
    'tl-ios-6': dict(src='guide_src/6.jpg', ops=[
        ('blur', (80, 858, 192, 1018)),                # 檔案縮圖（JSON 內容）
        ('fill', (24, 1062, 902, 1362), (460, 1060)),  # 聯絡人照片、名字、群組
        *[op for x in (160, 361, 563, 765) for op in (('avatar', (x, 1165), 74), ('text', (x - 55, 1258, x + 55, 1302)))],
        ('blur', (282, 1405, 442, 1625)),              # 第三方 App
    ], marks=[(6, (478, 1690, 648, 1950))]),
    # 7 存檔：選資料夾、按儲存
    'tl-ios-7': dict(src='guide_src/7.jpg', ops=[
        ('fill', (0, 395, 924, 1765), (460, 390)),     # 照片縮圖、檔名
        *[('tile', (x, y, x + 200, y + 150)) for y in (460, 930, 1400) for x in (64, 362, 660)],
        ('blur', (112, 1786, 204, 1910)),              # 檔案縮圖
        ('fill', (66, 1890, 858, 1935), (560, 1800)),  # 存檔列是半透明的，下緣透出照片
        ('fill', (0, 1925, 924, 2000), (460, 390)),    # 存檔列下方、兩側露出的照片
        ('fill', (0, 1765, 64, 1925), (460, 390)),
        ('fill', (860, 1765, 924, 1925), (460, 390)),
    ], marks=[(7, (150, 160, 412, 250)), (8, (722, 145, 892, 258))]),
    # 8 選檔：Timeline.json
    'tl-ios-8': dict(src='guide_src/8.jpg', ops=[
        ('fill', (20, 390, 300, 800), (320, 820)),     # 其他檔案（第一列左）
        ('tile', (90, 400, 240, 600)),
        ('fill', (0, 840, 924, 2000), (320, 820)),     # 第二列以後全部
        *[('tile', (x, y, x + 150, y + 200)) for y in (870, 1340) for x in (90, 385, 685)],
        ('blur', (686, 398, 838, 600)),                # Timeline.json 縮圖（JSON 內容）
    ], marks=[(9, (632, 392, 892, 748))]),

    # ---- 備份（跨裝置）：在原本的裝置匯出 → 存起來／傳過去 → 在另一台裝置匯入 ----
    # 1 已匯入的資料：匯出備份
    'bk-ios-1': dict(src='guide_import/1.jpg', ops=[
        ('fill', (212, 700, 860, 870), (800, 800)),    # 來源名稱與筆數
        ('text', (218, 712, 640, 810)),
        ('fill', (212, 905, 860, 1080), (800, 960)),
        ('text', (218, 925, 700, 1020)),
    ], marks=[(1, (602, 452, 868, 544))]),
    # 2 確認提醒：好
    'bk-ios-2': dict(src='guide_import/2.jpg', ops=[], marks=[(2, (748, 1060, 840, 1134))]),
    # 3 分享選單：儲存到檔案
    'bk-ios-3': dict(src='guide_import/3.jpg', ops=[
        ('fill', (212, 700, 600, 800), (600, 760)),    # 分享選單後面露出的來源名稱
        ('text', (218, 712, 500, 795)),
        ('blur', (100, 862, 212, 1010)),               # 檔案縮圖（JSON 內容）
        ('fill', (24, 1062, 902, 1362), (460, 1060)),  # 聯絡人照片、名字、群組
        *[op for x in (160, 361, 563, 765) for op in (('avatar', (x, 1165), 74), ('text', (x - 55, 1258, x + 55, 1302)))],
    ], marks=[(3, (280, 1688, 444, 1950))]),
    # 4 另一台裝置選檔：台灣旅遊護照備份-日期.json（其他檔案、資料夾全部蓋掉）
    'bk-ios-4': dict(src='guide_import/4.jpg', ops=[
        ('fill', (0, 285, 924, 815), (460, 300)),
        ('fill', (0, 815, 322, 1235), (460, 300)),
        ('fill', (604, 815, 924, 1235), (460, 300)),
        ('fill', (0, 1235, 924, 2000), (460, 300)),
        *[('tile', (x, y, x + 150, y + 200)) for (x, y) in
          [(90, 360), (385, 360), (685, 360), (90, 830), (685, 830), (90, 1300), (385, 1300), (685, 1300)]],
        ('blur', (384, 826, 542, 1030)),               # 備份檔縮圖（JSON 內容）
    ], marks=[(4, (326, 818, 600, 1228))]),
}


def px(v):
    return tuple(round(c * K) for c in v)


def do_map(img, box):
    region = img.crop(box)
    w, h = region.size
    small = region.resize((max(1, w // 48), max(1, h // 48)), Image.BILINEAR)
    region = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(30))
    region = Image.blend(region, Image.new('RGB', (w, h), (150, 158, 150)), 0.45)
    img.paste(region, box[:2])


def do_blur(img, box):
    region = img.crop(box)
    w, h = region.size
    small = region.resize((max(1, w // 16), max(1, h // 16)), Image.BILINEAR)
    img.paste(small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(10)), box[:2])


def bars(draw, box):
    x0, y0, x1, y1 = box
    h = (y1 - y0) / 2
    r = round(h * 0.22)
    draw.rounded_rectangle((x0, y0 + h * 0.2, x0 + (x1 - x0) * 0.62, y0 + h * 0.75), radius=r, fill=GHOST)
    draw.rounded_rectangle((x0, y0 + h * 1.2, x1, y0 + h * 1.75), radius=r, fill=GHOST)


def avatar(draw, c, r):
    cx, cy = c
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GHOST)
    hr = r * 0.36   # 頭
    draw.ellipse((cx - hr, cy - r * 0.55, cx + hr, cy - r * 0.55 + hr * 2), fill='white')
    draw.chord((cx - r * 0.62, cy + r * 0.2, cx + r * 0.62, cy + r * 1.3), 180, 360, fill='white')


def tile(draw, box):
    x0, y0, x1, y1 = box
    th = (y1 - y0) * 0.68
    draw.rounded_rectangle((x0, y0, x1, y0 + th), radius=round((x1 - x0) * 0.06), fill=GHOST)
    bars(draw, (x0 + (x1 - x0) * 0.1, y0 + th + (y1 - y0) * 0.05, x1 - (x1 - x0) * 0.1, y1))


def mark(draw, n, box):
    lw = 7
    draw.rounded_rectangle(box, radius=22, outline=ORANGE, width=lw)
    r = 30
    # 圓點放在框的右上角（壓在框線上），不蓋到框內文字
    cx, cy = box[2] - 24, box[1]
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ORANGE, outline='white', width=4)
    draw.text((cx, cy), str(n), fill='white', font=ImageFont.truetype(FONT, 36), anchor='mm')


def make(name, job):
    img = Image.open(SRC / job['src']).convert('RGB')
    assert img.size == (946, 2047), f"{job['src']} 尺寸 {img.size}，座標是照 946×2047 量的"
    orig = img.copy()
    keeps = []
    draw = ImageDraw.Draw(img)
    for op in job['ops']:
        kind, a = op[0], op[1]
        if kind == 'keep': keeps.append(px(a))
        elif kind == 'map': do_map(img, px(a))
        elif kind == 'blur': do_blur(img, px(a))
        elif kind == 'fill': draw.rectangle(px(a), fill=orig.getpixel(px(op[2])))
        elif kind == 'round':
            b = px(a)
            draw.rounded_rectangle(b, radius=(b[3] - b[1]) // 2, fill=orig.getpixel(px(op[2])))
        elif kind == 'text': bars(draw, px(a))
        elif kind == 'avatar': avatar(draw, px(a), round(op[2] * K))
        elif kind == 'tile': tile(draw, px(a))
    for b in keeps:
        img.paste(orig.crop(b), b[:2])
    for n, box in job['marks']:
        mark(draw, n, px(box))
    img = img.crop(CROP)
    img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=80, method=6)   # 不帶 EXIF／中繼資料
    # Windows 上檔案偶爾被其他程式短暫鎖住（防毒、預覽），重試幾次
    for i in range(5):
        try:
            (OUT / f'{name}.webp').write_bytes(buf.getvalue())
            break
        except OSError:
            if i == 4: raise
            time.sleep(0.5)
    print(name, img.size, len(buf.getvalue()), 'bytes')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, job in JOBS.items():
        make(name, job)


if __name__ == '__main__':
    main()

# 時間軸教學截圖加工：模糊隱私區域、裁掉狀態列、加橘色標記框與編號，輸出到 img/guide/
# 原始截圖放 test/guide_src/（git 忽略，不公開）
# 用法：python tools/make_guide_images.py
import io
import time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'test' / 'guide_src'
OUT = ROOT / 'img' / 'guide'
ORANGE = (255, 77, 26)   # 同 css/theme.css 的 --c-accent（淺色）
WIDTH = 720           # 輸出寬度
FONT = 'C:/Windows/Fonts/arialbd.ttf'

# 編號整份教學連續（1–8），和 js/guide.js 文字裡的編號對應
# 每張：來源、模糊區 (x0,y0,x1,y1)、標記 [(編號, 框)]、裁切 (x0,y0,x1,y1)；座標皆為原圖像素
JOBS = {
    'tl-ios-1': dict(src='1.jpg', blur=[], marks=[(1, (48, 585, 1122, 752))], crop=(0, 0, 1170, 1110)),
    'tl-ios-2': dict(src='2.jpg', blur=[(0, 372, 946, 1030)],
                     marks=[(2, (696, 158, 788, 246)), (3, (18, 1266, 928, 1386))], crop=(0, 115, 946, 1990)),
    'tl-ios-3': dict(src='3.jpg', blur=[],
                     marks=[(4, (18, 1346, 928, 1450))], crop=(0, 113, 946, 1966)),
    'tl-ios-4': dict(src='4.jpg', blur=[], marks=[(5, (606, 36, 820, 350))], crop=(0, 0, 1170, 392)),
    'tl-ios-5': dict(src='5.jpg', blur=[(0, 405, 946, 1808), (0, 1980, 946, 2047)],
                     marks=[(6, (150, 160, 412, 250)), (7, (738, 148, 914, 262))], crop=(0, 113, 946, 2047)),
    # 檔案縮圖裡是 JSON 內容（可能有座標）、左邊檔名是編碼過的中文：都模糊
    'tl-ios-6': dict(src='6.jpg', blur=[(0, 480, 420, 1005), (842, 506, 1060, 760)],
                     marks=[(8, (812, 488, 1124, 950))], crop=(0, 125, 1170, 1005)),
}


def blur(img, box):
    region = img.crop(box)
    w, h = region.size
    # 先縮小再放大＋高斯模糊：人臉、地名、街道都看不出來
    small = region.resize((max(1, w // 24), max(1, h // 24)), Image.BILINEAR)
    region = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(18))
    img.paste(region, box[:2])


def mark(draw, n, box, scale):
    lw = max(4, round(7 * scale))
    draw.rounded_rectangle(box, radius=round(22 * scale), outline=ORANGE, width=lw)
    r = round(30 * scale)
    # 圓點放在框的右上角（壓在框線上），不蓋到框內文字
    cx, cy = box[2] - round(24 * scale), box[1]
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ORANGE, outline='white', width=max(3, lw // 2))
    font = ImageFont.truetype(FONT, round(36 * scale))
    draw.text((cx, cy), str(n), fill='white', font=font, anchor='mm')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, j in JOBS.items():
        img = Image.open(SRC / j['src']).convert('RGB')
        for b in j['blur']:
            blur(img, b)
        draw = ImageDraw.Draw(img)
        scale = img.width / 946
        for n, box in j['marks']:
            mark(draw, n, box, scale)
        img = img.crop(j['crop'])
        if img.width > WIDTH:
            img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
        # 不帶 EXIF／中繼資料
        buf = io.BytesIO()
        img.save(buf, 'WEBP', quality=80, method=6)
        # Windows 上檔案偶爾被其他程式短暫鎖住（防毒、預覽），重試幾次
        for i in range(5):
            try:
                (OUT / f'{name}.webp').write_bytes(buf.getvalue())
                break
            except OSError:
                if i == 4: raise
                time.sleep(0.5)
        print(name, img.size, (OUT / f'{name}.webp').stat().st_size, 'bytes')


if __name__ == '__main__':
    main()

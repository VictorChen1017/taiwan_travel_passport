# 迷霧地圖放大彈窗的水系圖層：有名稱的河川（含支流）、大型水庫與湖泊 → data/map_water.json
#
# 來源：經濟部水利署開放資料（政府資料開放授權條款）的河川面 shapefile（riverpoly，TWD97 TM2 二度分帶，屬性 UTF-8：RIVER_NAME、RIVER_TYPE、RIVER_CODE、RIVER_FROM）
# 用法：python tools/export_water.py <riverpoly.shp 的路徑（不含副檔名也可）>
#   需要 Python 3 與 shapely 2
#
# 不經 PostGIS：photo_monitor 資料庫只能下 SELECT，不能匯入新圖層，所以直接讀 shapefile（純 Python 解析 .shp／.dbf）
# 輸出座標與 map_*.json 相同：x＝經度 × MAP_KX、y＝－緯度；路徑格式同 ST_AsSVG（M 絕對座標、l 相對座標、z），
# 小數 4 位（約 10 公尺；河川窄，3 位約 100 公尺會變形）

import json
import math
import os
import re
import struct
import sys

from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

MAP_KX = 0.9135   # 同 tools/export_static.php

# 河川：有名稱的河川（含支流，例如新店溪、基隆河、翡翠水庫上下游的北勢溪），以「名稱＋流入的河川」區分同名河川，
# 水面總面積 ≥ RIVER_MIN 的才畫（2026-11-26 維護者回饋：只畫主流太少）。名稱括號裡的別名忽略（濁水溪(西螺溪)＝濁水溪）
RIVER_MIN = 0.3e6       # 平方公尺：0.3 約 170 條（0.5 約 100 條，會少掉景美溪）
PART_MIN = 0.05e6       # 平方公尺：同一條河相距 LINK 以內的區段連成一群，比這小的群丟掉（多半是別處的同名小溪、零星水塘）
LAKE_WORDS = ('水庫', '潭', '湖', '埤')   # 名稱含這些字（但去掉括號後不以「溪」結尾）且面積夠大的算水庫、湖泊
LAKE_MIN = 0.4e6        # 平方公尺
LINK = 300              # 公尺：相距這麼近的區段算連在一起（橋、攔河堰處常斷開）
SIMPLIFY = 30           # 公尺：簡化容許值（維護者試過 50 公尺後決定用 30；村里放到最大約 7 公里寬，約 4 像素）
MIN_PART = 20000        # 平方公尺：簡化後更小的碎塊丟掉

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'map_water.json')


# ---------- 讀 shapefile ----------

def read_dbf(path):
    with open(path, 'rb') as f:
        n, hlen, rlen = struct.unpack('<IHH', f.read(32)[4:12])
        fields = []
        while True:
            d = f.read(32)
            if d[0] == 0x0D:
                break
            fields.append((d[:11].split(b'\0')[0].decode(), d[16]))
        f.seek(hlen)
        rows = []
        for _ in range(n):
            r = f.read(rlen)
            pos, row = 1, {}
            for name, ln in fields:
                row[name] = r[pos:pos + ln].decode('utf-8', 'replace').strip()
                pos += ln
            rows.append(row)
    return rows


def read_shp(path):
    """多邊形（type 5）：每筆回傳 shapely Polygon／MultiPolygon（依環的方向分外環、內環）或 None"""
    out = []
    with open(path, 'rb') as f:
        f.seek(100)
        while True:
            h = f.read(8)
            if len(h) < 8:
                break
            _, ln = struct.unpack('>2i', h)
            rec = f.read(ln * 2)
            if struct.unpack('<i', rec[:4])[0] == 0:
                out.append(None)
                continue
            nparts, npts = struct.unpack('<2i', rec[36:44])
            parts = list(struct.unpack('<%di' % nparts, rec[44:44 + 4 * nparts])) + [npts]
            off = 44 + 4 * nparts
            xy = struct.unpack('<%dd' % (2 * npts), rec[off:off + 16 * npts])
            shells, holes = [], []
            for k in range(nparts):
                ring = [(xy[2 * j], xy[2 * j + 1]) for j in range(parts[k], parts[k + 1])]
                if len(ring) < 4:
                    continue
                s = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))
                (shells if s < 0 else holes).append(ring)   # shapefile 外環順時針（面積為負）
            polys = [Polygon(s) for s in shells]
            for hole in holes:   # 內環放進包住它的外環
                hp = Polygon(hole)
                for i, p in enumerate(polys):
                    if p.contains(hp.representative_point()):
                        polys[i] = Polygon(p.exterior, list(p.interiors) + [hole])
                        break
            g = MultiPolygon(polys) if len(polys) > 1 else (polys[0] if polys else None)
            out.append(g.buffer(0) if g is not None and not g.is_valid else g)
    return out


# ---------- TWD97 TM2（中央經線 121°）→ 經緯度 ----------

A, F = 6378137.0, 1 / 298.257222101
E2 = F * (2 - F)
K0, LON0, FE = 0.9999, math.radians(121), 250000.0


def tm2_to_lonlat(x, y):
    """橫麥卡托反算（Snyder 公式，誤差在公分以下）"""
    ep2 = E2 / (1 - E2)
    m = y / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    c1 = ep2 * math.cos(p1) ** 2
    t1 = math.tan(p1) ** 2
    n1 = A / math.sqrt(1 - E2 * math.sin(p1) ** 2)
    r1 = A * (1 - E2) / (1 - E2 * math.sin(p1) ** 2) ** 1.5
    d = (x - FE) / (n1 * K0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                          + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lon), math.degrees(lat)


# ---------- 輸出路徑 ----------

def ring_d(coords):
    pts = [tm2_to_lonlat(x, y) for x, y in coords[:-1]]
    q = [(round(lon * MAP_KX, 4), round(-lat, 4)) for lon, lat in pts]
    d = ['M%s %s' % (fmt(q[0][0]), fmt(q[0][1])), 'l']
    for (x0, y0), (x1, y1) in zip(q, q[1:]):
        d.append('%s %s' % (fmt(x1 - x0), fmt(y1 - y0)))
    return ' '.join(d) + 'z'


def fmt(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def geom_d(g):
    polys = [g] if isinstance(g, Polygon) else list(g.geoms)
    out = []
    for p in polys:
        if p.area < MIN_PART:
            continue
        out.append(ring_d(list(p.exterior.coords)))
        out.extend(ring_d(list(r.coords)) for r in p.interiors)
    return ' '.join(out)


def clean(g):
    g = g.simplify(SIMPLIFY, preserve_topology=True)
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    return unary_union([x for x in getattr(g, 'geoms', []) if isinstance(x, (Polygon, MultiPolygon))])


def main():
    sys.stdout.reconfigure(encoding='utf-8')   # Windows 主控台預設 cp950，印河川名稱會出錯
    if len(sys.argv) < 2:
        sys.exit('用法：python tools/export_water.py <riverpoly.shp>')
    base = re.sub(r'\.shp$', '', sys.argv[1], flags=re.I)
    rows, geoms = read_dbf(base + '.dbf'), read_shp(base + '.shp')
    assert len(rows) == len(geoms), '.dbf 與 .shp 筆數不同'
    base_name = lambda s: s.split('(')[0].strip()

    # 水庫湖泊：名稱（含括號裡的別名，例如大鵬灣(大潭)）有 LAKE_WORDS，且去掉括號後不以「溪」結尾
    is_lake = lambda full: not base_name(full).endswith('溪') and any(w in full for w in LAKE_WORDS)
    by = {}   # (名稱, 流入的河川) → 多邊形；港口（type 0）、沒名稱、水庫湖泊另外處理
    for r, g in zip(rows, geoms):
        nm = base_name(r['RIVER_NAME'])
        if g is None or r['RIVER_TYPE'] == '0' or not nm or is_lake(r['RIVER_NAME']):
            continue
        by.setdefault((nm, r['RIVER_FROM']), []).append(g)
    rivers = []
    for (name, into), gs in sorted(by.items(), key=lambda kv: kv[0]):
        u = unary_union(gs)
        if u.area < RIVER_MIN:
            continue
        # 相距 LINK 以內的區段連成一群，只留面積夠大的群
        groups = list(getattr(u.buffer(LINK), 'geoms', [u.buffer(LINK)]))
        parts = [p for p in (u.intersection(gr) for gr in groups) if p.area >= PART_MIN]
        if not parts:
            continue
        d = geom_d(clean(unary_union(parts)))
        if d:
            rivers.append({'name': name, 'd': d})
    print(f'河川 {len(rivers)} 條')

    lakes = {}
    for r, g in zip(rows, geoms):
        nm = r['RIVER_NAME']
        if g is None or r['RIVER_TYPE'] == '0' or not is_lake(nm):
            continue
        lakes.setdefault(nm, []).append(g)
    lake_out = []
    for nm, gs in sorted(lakes.items()):
        u = unary_union(gs)
        if u.area < LAKE_MIN:
            continue
        lake_out.append({'name': nm, 'd': geom_d(clean(u))})
        print(f'{nm}: {u.area / 1e6:.2f} km²')

    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'rivers': rivers, 'lakes': lake_out}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'寫入 {os.path.normpath(OUT)}：{len(rivers)} 條河川、{len(lake_out)} 個水庫湖泊，{os.path.getsize(OUT) / 1024:.0f} KB')

    # version.json 補上這個檔的雜湊與大小（前端用 ?v= 避開快取）；不動 version（水系不影響計算，不必讓使用者重算）
    # tools/export_static.php 之後重跑時會依全部檔案重算雜湊，結果一致
    import hashlib
    vf = os.path.join(os.path.dirname(OUT), 'version.json')
    with open(vf, encoding='utf-8') as f:
        ver = json.load(f)
    with open(OUT, 'rb') as f:
        ver['files']['map_water.json'] = hashlib.md5(f.read()).hexdigest()[:8]
    ver.setdefault('sizes', {})['map_water.json'] = os.path.getsize(OUT)
    for k in ('files', 'sizes'):   # 照檔名排序（同 export_static.php 的 glob 順序）
        ver[k] = dict(sorted(ver[k].items()))
    with open(vf, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(ver, f, ensure_ascii=False, separators=(',', ':'))
    print('已更新 version.json 的 map_water.json 雜湊')


if __name__ == '__main__':
    main()

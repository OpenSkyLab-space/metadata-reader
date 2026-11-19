# Generates extra synthetic test files metadata-reader_t*.* (illustrative, not real captures)
import struct, zlib, io
from PIL import Image, PngImagePlugin, TiffImagePlugin
import os, sys
S = os.path.join(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)), "")  # output directory
img = Image.new("RGB", (64, 48), (90, 140, 80))
for x in range(64):
    for y in range(48): img.putpixel((x, y), (60 + x * 2, 100 + y, 70))
XMP = ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:osl="http://example.org/osl/1.0/" xmp:CreatorTool="OpenSkyLab test" xmp:CreateDate="2026-06-02T09:15:00+02:00">'
       '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Synthetic test</rdf:li><rdf:li xml:lang="cs">Syntetický test</rdf:li></rdf:Alt></dc:title>'
       '<dc:subject><rdf:Bag><rdf:li>uav</rdf:li><rdf:li>test</rdf:li></rdf:Bag></dc:subject><osl:Note>custom namespace</osl:Note>'
       '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
# EXIF block via Pillow
ex = Image.Exif()
ex[0x010f] = "OpenSkyLab"; ex[0x0110] = "PNG-Test"; ex[0x0131] = "metadata-reader_mk.py"
ex[0x0132] = "2026:06:02 09:15:00"
gps = {1: "N", 2: (49.0, 12.0, 30.5), 3: "E", 4: (16.0, 36.0, 10.25), 5: b"\x00", 6: 250.5}
ex[0x8825] = gps
# 1 PNG with tEXt, iTXt (XMP), zTXt, eXIf, pHYs
pi = PngImagePlugin.PngInfo()
pi.add_text("Title", "Synthetic PNG")
pi.add_text("Comment", "Illustrative test file, not a real capture")
pi.add_itxt("XML:com.adobe.xmp", XMP, zip=False)
pi.add_itxt("Description", "Popis s diakritikou: žluťoučký kůň", lang="cs", tkey="Popis", zip=True)
pi.add_text("Software", "OpenSkyLab", zip=True)
img.save(S + "metadata-reader_t1.png", pnginfo=pi, exif=ex.tobytes(), dpi=(300, 300))
# 2 WebP with EXIF + XMP
img.save(S + "metadata-reader_t2.webp", exif=ex.tobytes(), xmp=XMP.encode("utf-8"), quality=80)
# 3 baseline JPEG without EXIF, with JFIF + COM + ICC (sRGB-like minimal profile from Pillow ImageCms if available)
try:
    from PIL import ImageCms
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
except Exception as e:
    icc = None
buf = io.BytesIO(); img.save(buf, "JPEG", quality=90, icc_profile=icc, comment=b"OpenSkyLab synthetic JPEG without EXIF")
open(S + "metadata-reader_t3.jpg", "wb").write(buf.getvalue())

# ---- generic TIFF writer: ifds = [(name, [(tag, type, values)])]; a value "@name" for type 4 means offset of that IFD
TS = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 7: ("B", 1), 8: ("h", 2), 9: ("i", 4), 10: ("ii", 8), 11: ("f", 4), 12: ("d", 8)}
def enc(bo, typ, vals):
    if typ == 2:
        b = vals.encode("utf-8") + b"\0"; return b, len(b)
    if typ == 7:
        return bytes(vals), len(vals)
    if not isinstance(vals, (list, tuple)): vals = [vals]
    out = b""
    for v in vals:
        if typ in (5, 10):
            if isinstance(v, tuple): n, d = v
            else:
                d = 1000000; n = int(round(v * d))
            out += struct.pack(bo + TS[typ][0], n, d)
        else: out += struct.pack(bo + TS[typ][0], v)
    return out, len(vals)
def build_tiff(bo, ifds, image=b"", chain=None):
    bom = b"MM" if bo == ">" else b"II"
    # pass 1: sizes
    pos = 8; offs = {}
    for name, ents in ifds:
        offs[name] = pos
        pos += 2 + 12 * len(ents) + 4
        for tag, typ, vals in ents:
            b, c = enc(bo, typ, 0 if isinstance(vals, str) and vals.startswith("@") else vals)
            if len(b) > 4: pos += len(b) + (len(b) & 1)
    img_off = pos
    out = bytearray(bom + struct.pack(bo + "HI", 42, 8))
    for i, (name, ents) in enumerate(ifds):
        assert len(out) == offs[name]
        ents = sorted(ents, key=lambda e: e[0])
        extra = bytearray(); ebase = offs[name] + 2 + 12 * len(ents) + 4
        body = bytearray(struct.pack(bo + "H", len(ents)))
        for tag, typ, vals in ents:
            if isinstance(vals, str) and vals.startswith("@"):
                vals = offs[vals[1:]] if vals != "@IMAGE" else img_off
            b, c = enc(bo, typ, vals)
            if len(b) <= 4: body += struct.pack(bo + "HHI", tag, typ, c)[:8] + b.ljust(4, b"\0")
            else:
                body += struct.pack(bo + "HHII", tag, typ, c, ebase + len(extra)); extra += b
                if len(extra) & 1: extra += b"\0"
        nxt = offs[chain[name]] if chain and name in chain else 0
        body += struct.pack(bo + "I", nxt)
        out += body + extra
    out += image
    return bytes(out)
# 4 big-endian TIFF (MM) 8x6 RGB, Exif sub-IFD, GPS with Exif 3.0 GPSAltitudeRef 2, OffsetTimeOriginal
W4, H4 = 8, 6
pix = bytes([(x * 30) % 256 for x in range(W4 * H4 * 3)])
ifd0 = [(0x100, 3, W4), (0x101, 3, H4), (0x102, 3, [8, 8, 8]), (0x103, 3, 1), (0x106, 3, 2), (0x10f, 2, "OpenSkyLab"), (0x110, 2, "BE-TIFF synthetic"),
        (0x111, 4, "@IMAGE"), (0x115, 3, 3), (0x116, 3, H4), (0x117, 4, len(pix)), (0x11c, 3, 1), (0x131, 2, "metadata-reader_mk.py"), (0x8769, 4, "@ExifIFD"), (0x8825, 4, "@GPS")]
exif = [(0x829a, 5, [(1, 2000)]), (0x829d, 5, [(40, 10)]), (0x8827, 3, 400), (0x9000, 7, b"0300"), (0x9003, 2, "2026:06:02 13:20:05"), (0x9011, 2, "+02:00"),
        (0x9291, 2, "25"), (0x920a, 5, [(240, 10)]), (0xa405, 3, 35), (0xa431, 2, "BE0001")]
gps = [(0x0, 1, [2, 4, 0, 0]), (0x1, 2, "N"), (0x2, 5, [(49, 1), (35, 1), (1234, 100)]), (0x3, 2, "E"), (0x4, 5, [(17, 1), (15, 1), (5678, 100)]),
       (0x5, 1, 2), (0x6, 5, [(2155, 10)]), (0x7, 5, [(11, 1), (20, 1), (5, 1)]), (0x1d, 2, "2026:06:02"), (0x1f, 5, [(25, 10)])]
open(S + "metadata-reader_t4.tif", "wb").write(build_tiff(">", [("IFD0", ifd0), ("ExifIFD", exif), ("GPS", gps)], pix))
# 5 GeoTIFF (II), 10x8 float32 DEM-like, EPSG:32633, PixelScale 0.05 m, tie point, GDAL NoData, vertical CS EGM2008 (3855)
W5, H5 = 10, 8
dem = b"".join(struct.pack("<f", 300.0 + 0.5 * x + 0.25 * y) for y in range(H5) for x in range(W5))
geokeys = [1, 1, 0, 6,  1024, 0, 1, 1,  1025, 0, 1, 1,  1026, 34737, 22, 0,  3072, 0, 1, 32633,  3076, 0, 1, 9001,  4096, 0, 1, 3855]
gtifc = "WGS 84 / UTM zone 33N|"
ifd5 = [(0x100, 3, W5), (0x101, 3, H5), (0x102, 3, 32), (0x103, 3, 1), (0x106, 3, 1), (0x111, 4, "@IMAGE"), (0x115, 3, 1), (0x116, 3, H5), (0x117, 4, len(dem)),
        (0x11c, 3, 1), (0x131, 2, "OpenSkyLab synthetic sample"), (0x153, 3, 3), (0x830e, 12, [0.05, 0.05, 0.0]), (0x8482, 12, [0.0, 0.0, 0.0, 459200.0, 5553400.0, 0.0]),
        (0x87af, 3, geokeys), (0x87b1, 2, gtifc), (0xa481, 2, "-9999")]
open(S + "metadata-reader_t5.tif", "wb").write(build_tiff("<", [("IFD0", ifd5)], dem))
# 6 JPEG with IPTC (APP13 Photoshop 3.0) and DJI-style MakerNote (Make DJI, MakerNote IFD with Speed/Pitch/Yaw/Roll floats), Exif II
def iptc(rec, ds, val):
    b = val.encode("utf-8"); return struct.pack(">BBBH", 0x1c, rec, ds, len(b)) + b
ip = iptc(1, 90, "\x1b%G") + iptc(2, 0, "\x00\x04")[:-2] + b"\x00\x04" if False else iptc(1, 90, "\x1b%G") + struct.pack(">BBBH", 0x1c, 2, 0, 2) + b"\x00\x04" + iptc(2, 5, "Testovací snímek") + iptc(2, 25, "uav") + iptc(2, 25, "ortofoto") + iptc(2, 80, "OpenSkyLab") + iptc(2, 116, "CC BY 4.0") + iptc(2, 55, "20260602") + iptc(2, 60, "091500+0200")
irb = b"8BIM" + struct.pack(">H", 0x0404) + b"\0\0" + struct.pack(">I", len(ip)) + ip + (b"\0" if len(ip) & 1 else b"")
app13 = b"Photoshop 3.0\0" + irb
mn = [(0x1, 2, "DJI"), (0x3, 11, 5.5), (0x4, 11, -1.25), (0x5, 11, 0.0), (0x6, 11, -3.5), (0x7, 11, 121.0), (0x8, 11, 1.5), (0x9, 11, -90.0), (0xa, 11, 121.2), (0xb, 11, 0.0)]
# MakerNote needs offsets relative to TIFF header: build TIFF with MakerNote IFD as an IFD placed inside the data, referenced by 0x927c as UNDEFINED.
def build_exif_with_mn():
    bo = "<"
    # build IFDs normally, then append maker note IFD bytes; compute offsets manually
    ifd0 = [(0x10f, 2, "DJI"), (0x110, 2, "FC3411 synthetic"), (0x131, 2, "metadata-reader_mk.py"), (0x8769, 4, "@ExifIFD"), (0x8825, 4, "@GPS")]
    exif = [(0x829a, 5, [(1, 640)]), (0x829d, 5, [(28, 10)]), (0x8827, 3, 100), (0x9003, 2, "2026:06:02 09:15:00"), (0x920a, 5, [(88, 10)]), (0xa405, 3, 24),
            (0xa002, 4, 5472), (0xa003, 4, 3648), (0x927c, 7, b"\0" * 126)]
    gps = [(0x0, 1, [2, 3, 0, 0]), (0x1, 2, "N"), (0x2, 5, [(49, 1), (12, 1), (3050, 100)]), (0x3, 2, "E"), (0x4, 5, [(16, 1), (36, 1), (1025, 100)]), (0x5, 1, 0), (0x6, 5, [(3011, 10)])]
    t = bytearray(build_tiff(bo, [("IFD0", ifd0), ("ExifIFD", exif), ("GPS", gps)]))
    # locate the 126 zero bytes of MakerNote: find entry 0x927c in ExifIFD
    exif_off = struct.unpack("<I", t[4:8])[0]
    # parse IFD0 to find ExifIFD
    n0 = struct.unpack("<H", t[8:10])[0]
    for i in range(n0):
        tag, typ, cnt, val = struct.unpack("<HHII", t[10 + 12 * i: 22 + 12 * i])
        if tag == 0x8769: exif_off = val
    ne = struct.unpack("<H", t[exif_off:exif_off + 2])[0]
    for i in range(ne):
        p = exif_off + 2 + 12 * i
        tag, typ, cnt, val = struct.unpack("<HHII", t[p:p + 12])
        if tag == 0x927c: mn_off = val
    body = bytearray(struct.pack("<H", len(mn))); extra = bytearray(); ebase = mn_off + 2 + 12 * len(mn) + 4
    for tag, typ, vals in mn:
        b, c = enc("<", typ, vals)
        if len(b) <= 4: body += struct.pack("<HHI", tag, typ, c) + b.ljust(4, b"\0")
        else: body += struct.pack("<HHII", tag, typ, c, ebase + len(extra)); extra += b
    body += b"\0\0\0\0"; blob = body + extra
    assert len(blob) <= 126, len(blob)
    t[mn_off:mn_off + len(blob)] = blob
    return bytes(t)
exb = b"Exif\0\0" + build_exif_with_mn()
buf = io.BytesIO(); img.save(buf, "JPEG", quality=75); j = buf.getvalue()
def seg(m, d): return b"\xff" + bytes([m]) + struct.pack(">H", len(d) + 2) + d
j6 = j[:2] + seg(0xe1, exb) + seg(0xed, app13) + j[2:]
# append an MP4-like trailer to test trailer detection
j6 += struct.pack(">I", 24) + b"ftypisom" + b"\0\0\0\0" + b"isommp41"
open(S + "metadata-reader_t6.jpg", "wb").write(j6)
# 7 minimal MP4/QuickTime-like file: ftyp + moov(mvhd, trak(tkhd, mdia(mdhd, hdlr)), udta(©xyz)) + mdat
def box(t, d): return struct.pack(">I", len(d) + 8) + t + d
T0 = 3863155200  # seconds 1904 -> 2026-06-02 approx
T0 = int((__import__("datetime").datetime(2026, 6, 2, 7, 15, 0) - __import__("datetime").datetime(1904, 1, 1)).total_seconds())
mvhd = box(b"mvhd", b"\0\0\0\0" + struct.pack(">IIII", T0, T0, 1000, 12500) + b"\0" * 80)
tkhd = box(b"tkhd", b"\0\0\0\x03" + struct.pack(">IIII", T0, T0, 1, 0) + struct.pack(">I", 12500) + b"\0" * 52 + struct.pack(">II", 3840 << 16, 2160 << 16))
mdhd = box(b"mdhd", b"\0\0\0\0" + struct.pack(">IIII", T0, T0, 30000, 375000) + b"\0\0\0\0")
hdlr = box(b"hdlr", b"\0\0\0\0" + b"\0\0\0\0" + b"vide" + b"\0" * 12 + b"VideoHandler\0")
xyz = box(b"\xa9xyz", struct.pack(">HH", 18, 0) + b"+49.2051+016.6061/")
mak = box(b"\xa9mak", struct.pack(">HH", 10, 0) + b"OpenSkyLab")
moov = box(b"moov", mvhd + box(b"trak", tkhd + box(b"mdia", mdhd + hdlr)) + box(b"udta", xyz + mak))
mp4 = box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41") + moov + box(b"mdat", b"\0" * 64)
open(S + "metadata-reader_t7.mp4", "wb").write(mp4)
print("done")
# ---- 8: synthetic flight of 8 DJI-style JPEGs (two lines of a grid), with deliberate anomalies for the batch checks
import math, json, base64, datetime
def flight():
    lat0, lon0, h_to = 50.12960, 14.37020, 329.80  # take-off ellipsoidal height (synthetic)
    hd = 32.0; R = 6378137.0
    out = {}
    t0 = datetime.datetime(2026, 5, 14, 10, 30, 0)
    k = 0
    for line in range(2):
        for i in range(4):
            k += 1
            fwd = (i if line == 0 else 3 - i) * 32.0; side = line * 52.0
            hdg = hd if line == 0 else hd + 180
            a = math.radians(hd)
            dn = fwd * math.cos(a) - side * math.sin(a); de = fwd * math.sin(a) + side * math.cos(a)
            lat = lat0 + math.degrees(dn / R); lon = lon0 + math.degrees(de / (R * math.cos(math.radians(lat0))))
            rel = 80.0 + [0.0, 0.2, -0.1, 0.3, 0.1, -0.2, 0.0, 0.4][k - 1]
            t = t0 + datetime.timedelta(seconds=(k - 1) * 4.2 + (18 if line == 1 else 0))
            sub = "%03d" % (int(t.microsecond / 1000))
            rtk, sx, sy, sz = (50, 0.0112, 0.0105, 0.0189)
            iso, et, gp, mode = 100, (1, 800), -89.9, 0
            if k == 6: rtk, sx, sy, sz = (34, 0.284, 0.301, 0.512)
            if k == 7: iso, et, mode = 200, (1, 400), 1
            if k == 8: gp = -60.0
            vx = 7.0 * math.cos(math.radians(hdg)); vy = 7.0 * math.sin(math.radians(hdg))
            def dmsr(v):
                v = abs(v); d = int(v); m = int((v - d) * 60); s = (v - d - m / 60) * 3600
                return [(d, 1), (m, 1), (int(round(s * 10000)), 10000)]
            ds = t.strftime("%Y:%m:%d %H:%M:%S")
            ifd0 = [(0x10e, 2, "SYNTHETIC SAMPLE FLIGHT - OpenSkyLab, image %d of 8" % k), (0x10f, 2, "DJI"), (0x110, 2, "FC6310R"), (0x112, 3, 1),
                    (0x131, 2, "OpenSkyLab synthetic sample"), (0x132, 2, ds), (0x8769, 4, "@ExifIFD"), (0x8825, 4, "@GPS")]
            exif = [(0x829a, 5, [et]), (0x829d, 5, [(56, 10)]), (0x8822, 3, 2), (0x8827, 3, iso), (0x9000, 7, b"0230"), (0x9003, 2, ds), (0x9004, 2, ds),
                    (0x9291, 2, sub), (0x920a, 5, [(88, 10)]), (0xa002, 4, 5472), (0xa003, 4, 3648), (0xa402, 3, mode), (0xa405, 3, 24), (0xa431, 2, "SYN0000000001")]
            gps = [(0x0, 1, [2, 3, 0, 0]), (0x1, 2, "N"), (0x2, 5, dmsr(lat)), (0x3, 2, "E"), (0x4, 5, dmsr(lon)), (0x5, 1, 0),
                   (0x6, 5, [(int(round((h_to + rel) * 1000)), 1000)]), (0x12, 2, "WGS-84")]
            tiff = build_tiff("<", [("IFD0", ifd0), ("ExifIFD", exif), ("GPS", gps)])
            xmp = ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                   '<rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" tiff:Make="DJI" tiff:Model="FC6310R" '
                   'drone-dji:GpsLatitude="%.8f" drone-dji:GpsLongtitude="%.8f" drone-dji:AbsoluteAltitude="%+.3f" drone-dji:RelativeAltitude="%+.3f" '
                   'drone-dji:GimbalRollDegree="+0.00" drone-dji:GimbalYawDegree="%+.2f" drone-dji:GimbalPitchDegree="%+.2f" drone-dji:FlightRollDegree="%+.2f" '
                   'drone-dji:FlightYawDegree="%+.2f" drone-dji:FlightPitchDegree="%+.2f" drone-dji:FlightXSpeed="%+.2f" drone-dji:FlightYSpeed="%+.2f" drone-dji:FlightZSpeed="+0.00" '
                   'drone-dji:RtkFlag="%d" drone-dji:RtkStdLon="%.5f" drone-dji:RtkStdLat="%.5f" drone-dji:RtkStdHgt="%.5f" drone-dji:CalibratedFocalLength="3666.666504" '
                   'drone-dji:CalibratedOpticalCenterX="2736.000000" drone-dji:CalibratedOpticalCenterY="1824.000000"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>') % (
                lat, lon, h_to + rel, rel, (hdg + 0.4 + 180) % 360 - 180, gp, 1.2 if line == 0 else -1.0, (hdg + 180) % 360 - 180, -5.2, vx, vy, rtk, sx, sy, sz)
            im = Image.new("RGB", (48, 32))
            for x in range(48):
                for y in range(32): im.putpixel((x, y), (70 + (x * 3 + k * 9) % 60, 110 + (y * 2 + k * 5) % 50, 60 + (x + y) % 30))
            b = io.BytesIO(); im.save(b, "JPEG", quality=60); j = b.getvalue()
            def seg2(m, d): return b"\xff" + bytes([m]) + struct.pack(">H", len(d) + 2) + d
            data = j[:2] + seg2(0xe1, b"Exif\0\0" + tiff) + seg2(0xe1, b"http://ns.adobe.com/xap/1.0/\0" + xmp.encode("utf-8")) + j[2:]
            fn = "DJI_%04d.JPG" % (100 + k)
            open(S + "metadata-reader_f%02d.jpg" % k, "wb").write(data)
            out[fn] = base64.b64encode(data).decode()
    json.dump(out, open(S + "metadata-reader_flight.json", "w"))
flight()
print("flight done")

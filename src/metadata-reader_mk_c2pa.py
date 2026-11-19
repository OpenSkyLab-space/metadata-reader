# Builds the synthetic, UNSIGNED C2PA sample (sample 6) and C2PA test variants for the node tests.
# Everything here is illustrative: no certificate, no signature, values marked as synthetic.
#   metadata-reader_s6_c2pa.jpg   small JPEG, APP11 JPEG-XT box with a JUMBF C2PA manifest store (one segment)
#   metadata-reader_t8_split.jpg  same store split over several APP11 segments (reassembly test)
#   metadata-reader_t9.webp       WebP (t2) + RIFF "C2PA" chunk
#   metadata-reader_t10.mp4       MP4 (t7) + top-level C2PA uuid box (purpose "manifest")
import hashlib, io, math, os, struct, sys
from PIL import Image, ImageDraw, ImageFont

S = os.path.dirname(os.path.abspath(__file__)) + "/"

# ---- minimal CBOR encoder (RFC 8949, definite lengths)
def _head(mt, n):
    if n < 24: return bytes([mt << 5 | n])
    if n < 256: return bytes([mt << 5 | 24, n])
    if n < 65536: return bytes([mt << 5 | 25]) + struct.pack(">H", n)
    if n < 2 ** 32: return bytes([mt << 5 | 26]) + struct.pack(">I", n)
    return bytes([mt << 5 | 27]) + struct.pack(">Q", n)
def cbor(o):
    if o is None: return b"\xf6"
    if o is True: return b"\xf5"
    if o is False: return b"\xf4"
    if isinstance(o, int): return _head(0, o) if o >= 0 else _head(1, -1 - o)
    if isinstance(o, float): return b"\xfb" + struct.pack(">d", o)
    if isinstance(o, bytes): return _head(2, len(o)) + o
    if isinstance(o, str): b = o.encode("utf-8"); return _head(3, len(b)) + b
    if isinstance(o, (list, tuple)): return _head(4, len(o)) + b"".join(cbor(x) for x in o)
    if isinstance(o, dict): return _head(5, len(o)) + b"".join(cbor(k) + cbor(v) for k, v in o.items())
    raise TypeError(type(o))

# ---- JUMBF (ISO/IEC 19566-5) boxes
TAIL = bytes.fromhex("00110010800000aa00389b71")
def box(t, d): return struct.pack(">I", len(d) + 8) + t + d
def jumd(t4, label, toggles=3): return box(b"jumd", t4 + TAIL + bytes([toggles]) + label.encode("utf-8") + b"\0")
def superbox(t4, label, *content): return box(b"jumb", jumd(t4, label) + b"".join(content))
def cbor_assertion(label, obj): return superbox(b"cbor", label, box(b"cbor", cbor(obj)))

MANIFEST = "urn:c2pa:00000000-0000-4000-8000-000000000006"
AGENT = {"name": "OpenSkyLab synthetic sample", "version": "1.0"}
IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/"

def build_store(data_hash, excl):
    actions = cbor_assertion("c2pa.actions.v2", {"actions": [
        {"action": "c2pa.created", "when": "2025-06-14T09:12:30Z", "softwareAgent": AGENT, "digitalSourceType": IPTC + "digitalCapture"},
        {"action": "c2pa.edited", "when": "2025-06-14T09:20:05Z", "softwareAgent": AGENT, "description": "synthetic edit for teaching, no real processing"}]})
    hashdata = cbor_assertion("c2pa.hash.data", {"exclusions": [{"start": excl[0], "length": excl[1]}], "name": "jumbf manifest", "alg": "sha256", "hash": data_hash, "pad": bytes(8)})
    vendor = cbor_assertion("org.openskylab.synthetic", {"purpose": "teaching sample", "signed": False, "sample": 6})
    store_as = superbox(b"c2as", "c2pa.assertions", actions, hashdata, vendor)
    ref = lambda lab, b: {"url": "self#jumbf=c2pa.assertions/" + lab, "hash": hashlib.sha256(b).digest()}
    claim = {"instanceID": "xmp:iid:00000000-0000-4000-8000-000000000060", "claim_generator_info": AGENT,
             "signature": "self#jumbf=/c2pa/" + MANIFEST + "/c2pa.signature",
             "created_assertions": [ref("c2pa.actions.v2", actions), ref("c2pa.hash.data", hashdata), ref("org.openskylab.synthetic", vendor)],
             "dc:title": "C2PA synthetic sample (unsigned)", "alg": "sha256"}
    # no c2cs signature box: the reader must report that the manifest is not signed
    return superbox(b"c2pa", "c2pa", superbox(b"c2ma", MANIFEST, store_as, superbox(b"c2cl", "c2pa.claim.v2", box(b"cbor", cbor(claim)))))

def app11(store, en=1, chunk=None):
    """JPEG-XT APP11 segments: CI 'JP', En, Z, box data; continuation segments repeat the 8-byte LBox/TBox header."""
    chunk = chunk or 65535 - 2 - 8
    segs, hdr, p, z = [], store[:8], 0, 1
    while p < len(store):
        if z == 1: part = store[p:p + chunk]
        else: part = hdr + store[p:p + chunk - 8]
        p += len(part) - (0 if z == 1 else 8)
        d = b"JP" + struct.pack(">HI", en, z) + part
        segs.append(b"\xff\xeb" + struct.pack(">H", len(d) + 2) + d)
        z += 1
    return b"".join(segs)

# ---- the base JPEG: synthetic picture + small EXIF (no GPS)
W, H = 240, 160
img = Image.new("RGB", (W, H))
px = img.load()
for y in range(H):
    for x in range(W):
        px[x, y] = (int(60 + 120 * x / W), int(110 + 60 * math.sin(y / 18.0)), int(150 - 70 * y / H))
dr = ImageDraw.Draw(img)
dr.rectangle([18, 18, 98, 70], outline=(255, 255, 255), width=3)
dr.ellipse([140, 70, 210, 140], outline=(255, 240, 200), width=3)
dr.text((150, 22), "C2PA", fill=(255, 255, 255), font=ImageFont.load_default(size=26))
ex = Image.Exif()
ex[0x010f] = "OpenSkyLab"; ex[0x0110] = "Synthetic C2PA sample"; ex[0x0131] = "OpenSkyLab synthetic sample"; ex[0x0132] = "2025:06:14 11:20:05"
ifd = ex.get_ifd(0x8769); ifd[0x9003] = "2025:06:14 11:12:30"; ifd[0x9011] = "+02:00"
buf = io.BytesIO(); img.save(buf, "JPEG", quality=80, exif=ex.tobytes()); base = buf.getvalue()
assert base[:2] == b"\xff\xd8"

def stamp(base, chunk=None):
    excl = (2, 0)
    for _ in range(5):  # the exclusion length is inside the store: iterate until stable
        st0 = build_store(bytes(32), excl); seg = app11(st0, chunk=chunk)
        if len(seg) == excl[1]: break
        excl = (2, len(seg))
    out0 = base[:2] + seg + base[2:]
    h = hashlib.sha256(out0[:excl[0]] + out0[excl[0] + excl[1]:]).digest()
    st = build_store(h, excl); assert len(st) == len(st0)
    seg = app11(st, chunk=chunk); assert len(seg) == excl[1]
    return base[:2] + seg + base[2:], st

s6, store = stamp(base)
open(S + "metadata-reader_s6_c2pa.jpg", "wb").write(s6)
t8, _ = stamp(base, chunk=300)
open(S + "metadata-reader_t8_split.jpg", "wb").write(t8)

# WebP with a C2PA chunk
w = open(S + "metadata-reader_t2.webp", "rb").read()
assert w[:4] == b"RIFF" and w[8:12] == b"WEBP"
ch = b"C2PA" + struct.pack("<I", len(store)) + store + (b"\0" if len(store) & 1 else b"")
w2 = w[:12] + w[12:] + ch
w2 = w2[:4] + struct.pack("<I", len(w2) - 8) + w2[8:]
open(S + "metadata-reader_t9.webp", "wb").write(w2)

# MP4 with a top-level C2PA uuid box (UUID d8fec3d6-1b0e-483c-9297-5828877ec481, version/flags, "manifest\0", 8-byte offset, JUMBF)
m = open(S + "metadata-reader_t7.mp4", "rb").read()
u = bytes.fromhex("d8fec3d61b0e483c92975828877ec481") + b"\0\0\0\0" + b"manifest\0" + struct.pack(">Q", 0) + store
open(S + "metadata-reader_t10.mp4", "wb").write(m + box(b"uuid", u))
print("s6", len(s6), "store", len(store), "t8", len(t8), "t9", len(w2), "t10", len(m) + len(u) + 8)

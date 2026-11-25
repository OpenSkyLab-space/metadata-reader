/*OSL-META-READER-START*/
/* OSLMeta 1.0.0 - image metadata reader (OpenSkyLab). Pure JavaScript, no dependencies.
   OSLMeta.parse(input, fileName, opts) -> Promise<Result>
     input: ArrayBuffer | TypedArray | Blob/File (files over 64 MB are read by byte ranges only)
     opts:  { height: flight height in m for GSD (default drone-dji:RelativeAltitude), xml: "auto"|"builtin", maxWhole: bytes }
   Result: { file:{name,size,type,mime,ext}, groups:[{id, ns?, tags:[{name,id,value,display,type,count,offset, from?, note?, binary?}]}],
             warnings:[{code,text,offset}], structure:[{segment,kind,offset,length,note,depth}], previews:[{kind,offset,length,mime}],
             raster:{...}|null, summary:{...} }
   Helpers: OSLMeta.derive(result,opts), OSLMeta.imageLog(result), OSLMeta.toExiftoolJSON(results,{raw}), OSLMeta.toCSV(result),
            OSLMeta.solarPosition(dateUTC,lat,lon), OSLMeta.IMAGE_LOG_COLUMNS, OSLMeta.cborDecode(bytes) (bounded CBOR, RFC 8949).
   C2PA / JUMBF: manifest stores in JPEG APP11, PNG caBX, TIFF tag 0xcd41, WebP C2PA chunk and the ISO BMFF C2PA uuid box are listed and decoded
   (groups C2PA, C2PA:Assertions, JUMBF); signatures, certificate chains and hashes are NOT validated.
   Tag names follow ExifTool (exiftool.org/TagNames); unknown numeric tags are reported as "Tag 0xABCD". DOMParser (XMP) and
   DecompressionStream (zlib) are used when available, with a built-in XML parser as fallback. Never throws on bad input. */
(function (G) {
"use strict";
const VERSION = "1.0.0";
const LIM = { whole: 64 * 1048576, ifdEntries: 1000, arr: 4096, offs: 262144, str: 1048576, bin: 16 * 1048576, warnings: 300, structure: 3000, tags: 20000, boxes: 20000 };

/* ---------------------------------------------------------------- small helpers */
const hex = (n, w) => "0x" + (Number(n) >>> 0).toString(16).padStart(w || 4, "0");
const DV = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
function latin1(b, o, n) { o = o || 0; const e = Math.min(b.length, o + (n == null ? b.length : n)); let s = ""; for (let i = o; i < e; i++) s += String.fromCharCode(b[i]); return s; }
let TDF = null, TDL = null;
try { TDF = new TextDecoder("utf-8", { fatal: true }); TDL = new TextDecoder("utf-8"); } catch (e) { /* no TextDecoder */ }
function utf8(b) { if (!b.length) return ""; if (!TDF) return latin1(b); try { return TDF.decode(b); } catch (e) { return latin1(b); } }
function utf8loose(b) { if (!TDL) return latin1(b); try { return TDL.decode(b); } catch (e) { return latin1(b); } }
function utf16(b, le) { let s = ""; for (let i = 0; i + 1 < b.length; i += 2) { const c = le ? b[i] | b[i + 1] << 8 : b[i] << 8 | b[i + 1]; if (c === 0) break; s += String.fromCharCode(c); } return s; }
function cstr(b) { let e = b.indexOf(0); if (e < 0) e = b.length; return utf8(b.subarray(0, e)).replace(/\s+$/, ""); }
function hexstr(b, n) { let s = ""; const e = Math.min(b.length, n == null ? b.length : n); for (let i = 0; i < e; i++) s += b[i].toString(16).padStart(2, "0"); return s; }
const rnd = (x, d) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
function num(x, sig) { if (typeof x !== "number") return String(x); if (!isFinite(x)) return isNaN(x) ? "undef" : (x > 0 ? "inf" : "-inf"); return String(Number(x.toPrecision(sig || 10))); }
const ucfirst = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const isNum = v => typeof v === "number" && isFinite(v);
const toNum = v => { if (Array.isArray(v)) v = v[0]; if (typeof v === "number") return v; if (typeof v === "string") { const q = /^\s*([-+]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v); if (q) return +q[2] ? +q[1] / +q[2] : NaN; const m = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(v); return m ? parseFloat(m[0]) : NaN; } return NaN; };
function u32be(b, o) { return b[o] * 16777216 + (b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]); }
function u16be(b, o) { return b[o] << 8 | b[o + 1]; }

/* ---------------------------------------------------------------- byte sources (whole buffer or ranged reads from a Blob) */
function clampSub(u8, o, n) { o = Math.max(0, Math.min(Math.floor(o), u8.length)); return u8.subarray(o, Math.min(u8.length, o + Math.max(0, Math.floor(n)))); }
function memSource(u8) { return { size: u8.length, whole: u8, read: async (o, n) => clampSub(u8, o, n) }; }
function blobSource(blob) {
  const C = 1 << 16, cache = new Map(), size = blob.size;
  async function chunk(i) { let c = cache.get(i); if (!c) { if (cache.size > 512) cache.clear(); c = new Uint8Array(await blob.slice(i * C, Math.min(size, (i + 1) * C)).arrayBuffer()); cache.set(i, c); } return c; }
  return { size, whole: null, async read(o, n) {
    o = Math.max(0, Math.min(Math.floor(o), size)); n = Math.max(0, Math.min(Math.floor(n), size - o));
    if (n > 4 * C) return new Uint8Array(await blob.slice(o, o + n).arrayBuffer());
    const out = new Uint8Array(n); let p = 0;
    while (p < n) { const i = Math.floor((o + p) / C), c = await chunk(i), s = o + p - i * C, k = Math.min(n - p, c.length - s); if (k <= 0) break; out.set(c.subarray(s, s + k), p); p += k; }
    return p < n ? out.subarray(0, p) : out; } };
}

/* ---------------------------------------------------------------- result context */
class Ctx {
  constructor(src, name, opts) { this.src = src; this.name = name; this.opts = opts || {}; this.gmap = new Map(); this.groups = []; this.warnings = []; this.structure = []; this.previews = []; this.info = {}; this.nTags = 0; this.raster = null; this.pendingComposite = []; this.extXMP = new Map(); this.xmpCount = 0; }
  group(id, ns) { let g = this.gmap.get(id); if (!g) { g = { id, tags: [] }; this.gmap.set(id, g); this.groups.push(g); } if (ns && !g.ns) g.ns = ns; return g; }
  add(gid, t) { if (++this.nTags > LIM.tags) { if (this.nTags === LIM.tags + 1) this.warn("tag-cap", "more than " + LIM.tags + " tags"); return t; } if (t.display === undefined) t.display = autoDisp(t.value); if (t.type === undefined) t.type = ""; if (t.count === undefined) t.count = Array.isArray(t.value) ? t.value.length : 1; if (t.offset === undefined) t.offset = null; this.group(gid).tags.push(t); return t; }
  warn(code, text, offset) { if (this.warnings.length < LIM.warnings) this.warnings.push({ code, text: text || "", offset: offset == null ? null : offset }); }
  seg(segment, kind, offset, length, note, depth) { if (this.structure.length < LIM.structure) this.structure.push({ segment, kind, offset, length, note: note || "", depth: depth || 0 }); }
  bin(gid, name, id, offset, length, extra) { return this.add(gid, Object.assign({ name, id, value: null, display: "(binary, " + length + " bytes)", type: "undef", count: length, offset, binary: { offset, length } }, extra || {})); }
}
function autoDisp(v) {
  if (v == null) return "";
  if (Array.isArray(v)) { const s = v.slice(0, 24).map(x => typeof x === "number" ? num(x, 10) : String(x)); return s.join(v.every(x => typeof x === "number") ? " " : ", ") + (v.length > 24 ? " … (" + v.length + " values)" : ""); }
  if (typeof v === "number") return num(v, 10);
  return String(v);
}

/* ---------------------------------------------------------------- tag tables (ExifTool names, exiftool.org/TagNames) */
function mk(str) { const a = str.trim().split(/\s+/), o = {}; for (let i = 0; i + 1 < a.length; i += 2) o[parseInt(a[i], 16)] = a[i + 1]; return o; }
const EXIF_T = mk(`0001 InteropIndex 0002 InteropVersion 000b ProcessingSoftware 00fe SubfileType 00ff OldSubfileType 0100 ImageWidth 0101 ImageHeight
0102 BitsPerSample 0103 Compression 0106 PhotometricInterpretation 0107 Thresholding 0108 CellWidth 0109 CellLength 010a FillOrder 010d DocumentName
010e ImageDescription 010f Make 0110 Model 0111 StripOffsets 0112 Orientation 0115 SamplesPerPixel 0116 RowsPerStrip 0117 StripByteCounts 0118 MinSampleValue
0119 MaxSampleValue 011a XResolution 011b YResolution 011c PlanarConfiguration 011d PageName 011e XPosition 011f YPosition 0120 FreeOffsets 0121 FreeByteCounts
0122 GrayResponseUnit 0123 GrayResponseCurve 0124 T4Options 0125 T6Options 0128 ResolutionUnit 0129 PageNumber 012c ColorResponseUnit 012d TransferFunction
0131 Software 0132 ModifyDate 013b Artist 013c HostComputer 013d Predictor 013e WhitePoint 013f PrimaryChromaticities 0140 ColorMap 0141 HalftoneHints
0142 TileWidth 0143 TileLength 0144 TileOffsets 0145 TileByteCounts 0146 BadFaxLines 0147 CleanFaxData 0148 ConsecutiveBadFaxLines 014a SubIFD 014c InkSet
014d InkNames 014e NumberofInks 0150 DotRange 0151 TargetPrinter 0152 ExtraSamples 0153 SampleFormat 0154 SMinSampleValue 0155 SMaxSampleValue 0156 TransferRange
0157 ClipPath 0158 XClipPathUnits 0159 YClipPathUnits 015a Indexed 015b JPEGTables 015f OPIProxy 0190 GlobalParametersIFD 0191 ProfileType 0192 FaxProfile
0193 CodingMethods 0194 VersionYear 0195 ModeNumber 01b1 Decode 01b2 DefaultImageColor 01b3 T82Options 01b5 JPEGTables 0200 JPEGProc 0201 ThumbnailOffset
0202 ThumbnailLength 0203 JPEGRestartInterval 0205 JPEGLosslessPredictors 0206 JPEGPointTransforms 0207 JPEGQTables 0208 JPEGDCTables 0209 JPEGACTables
0211 YCbCrCoefficients 0212 YCbCrSubSampling 0213 YCbCrPositioning 0214 ReferenceBlackWhite 022f StripRowCounts 02bc ApplicationNotes 0303 RenderingIntent
03e7 USPTOMiscellaneous 1000 RelatedImageFileFormat 1001 RelatedImageWidth 1002 RelatedImageHeight 4746 Rating 4747 XP_DIP_XML 4748 StitchInfo 4749 RatingPercent
7000 SonyRawFileType 7010 SonyToneCurve 7031 VignettingCorrection 7032 VignettingCorrParams 7034 ChromaticAberrationCorrection 7035 ChromaticAberrationCorrParams
7036 DistortionCorrection 7037 DistortionCorrParams 7038 SonyRawImageSize 7310 BlackLevel 7313 WB_RGGBLevels 74c7 SonyCropTopLeft 74c8 SonyCropSize 800d ImageID
80e3 Matteing 80e4 DataType 80e5 ImageDepth 80e6 TileDepth 827d Model2 828d CFARepeatPatternDim 828e CFAPattern2 828f BatteryLevel 8290 KodakIFD 8298 Copyright
829a ExposureTime 829d FNumber 830e PixelScale 83bb IPTC-NAA 8482 ModelTiePoint 8546 SEMInfo 8568 AFCP_IPTC 85d7 JPLCartoIFD 85d8 ModelTransform 8602 WB_GRGBLevels
8606 LeafData 8649 PhotoshopSettings 8769 ExifOffset 8773 ICC_Profile 877f TIFF_FXExtensions 8780 MultiProfiles 8781 SharedData 8782 T88Options 87ac ImageLayer
87af GeoTiffDirectory 87b0 GeoTiffDoubleParams 87b1 GeoTiffAsciiParams 87be JBIGOptions 8822 ExposureProgram 8824 SpectralSensitivity 8825 GPSInfo 8827 ISO
8828 Opto-ElectricConvFactor 8829 Interlace 882a TimeZoneOffset 882b SelfTimerMode 8830 SensitivityType 8831 StandardOutputSensitivity 8832 RecommendedExposureIndex
8833 ISOSpeed 8834 ISOSpeedLatitudeyyy 8835 ISOSpeedLatitudezzz 885c FaxRecvParams 885d FaxSubAddress 885e FaxRecvTime 8871 FedexEDR 888a LeafSubIFD 9000 ExifVersion
9003 DateTimeOriginal 9004 CreateDate 9009 GooglePlusUploadCode 9010 OffsetTime 9011 OffsetTimeOriginal 9012 OffsetTimeDigitized 9101 ComponentsConfiguration
9102 CompressedBitsPerPixel 9201 ShutterSpeedValue 9202 ApertureValue 9203 BrightnessValue 9204 ExposureCompensation 9205 MaxApertureValue 9206 SubjectDistance
9207 MeteringMode 9208 LightSource 9209 Flash 920a FocalLength 920b FlashEnergy 920c SpatialFrequencyResponse 920d Noise 920e FocalPlaneXResolution
920f FocalPlaneYResolution 9210 FocalPlaneResolutionUnit 9211 ImageNumber 9212 SecurityClassification 9213 ImageHistory 9214 SubjectArea 9215 ExposureIndex
9216 TIFF-EPStandardID 9217 SensingMethod 923a CIP3DataFile 923b CIP3Sheet 923c CIP3Side 923f StoNits 927c MakerNoteUnknown 9286 UserComment 9290 SubSecTime
9291 SubSecTimeOriginal 9292 SubSecTimeDigitized 932f MSDocumentText 9330 MSPropertySetStorage 9331 MSDocumentTextPosition 935c ImageSourceData
9400 AmbientTemperature 9401 Humidity 9402 Pressure 9403 WaterDepth 9404 Acceleration 9405 CameraElevationAngle 9c9b XPTitle 9c9c XPComment 9c9d XPAuthor
9c9e XPKeywords 9c9f XPSubject a000 FlashpixVersion a001 ColorSpace a002 ExifImageWidth a003 ExifImageHeight a004 RelatedSoundFile a005 InteropOffset
a010 SamsungRawPointersOffset a011 SamsungRawPointersLength a101 SamsungRawByteOrder a20b FlashEnergy a20c SpatialFrequencyResponse a20d Noise
a20e FocalPlaneXResolution a20f FocalPlaneYResolution a210 FocalPlaneResolutionUnit a211 ImageNumber a212 SecurityClassification a213 ImageHistory
a214 SubjectLocation a215 ExposureIndex a216 TIFF-EPStandardID a217 SensingMethod a300 FileSource a301 SceneType a302 CFAPattern a401 CustomRendered
a402 ExposureMode a403 WhiteBalance a404 DigitalZoomRatio a405 FocalLengthIn35mmFormat a406 SceneCaptureType a407 GainControl a408 Contrast a409 Saturation
a40a Sharpness a40b DeviceSettingDescription a40c SubjectDistanceRange a420 ImageUniqueID a430 OwnerName a431 SerialNumber a432 LensInfo a433 LensMake
a434 LensModel a435 LensSerialNumber a436 ImageTitle a437 Photographer a438 ImageEditor a439 CameraFirmware a43a RAWDevelopingSoftware a43b ImageEditingSoftware
a43c MetadataEditingSoftware a460 CompositeImage a461 CompositeImageCount a462 CompositeImageExposureTimes a480 GDALMetadata a481 GDALNoData a500 Gamma
afc0 ExpandSoftware afc1 ExpandLens afc2 ExpandFilm afc3 ExpandFilterLens afc4 ExpandScanner afc5 ExpandFlashLamp bc01 PixelFormat bc02 Transformation
bc03 Uncompressed bc04 ImageType bc80 ImageWidth bc81 ImageHeight bc82 WidthResolution bc83 HeightResolution bcc0 ImageOffset bcc1 ImageByteCount
bcc2 AlphaOffset bcc3 AlphaByteCount bcc4 ImageDataDiscard bcc5 AlphaDataDiscard c427 OceScanjobDesc c428 OceApplicationSelector c429 OceIDNumber
c42a OceImageLogic c44f Annotations c4a5 PrintIM c51b HasselbladExif c573 OriginalFileName c580 USPTOOriginalContentType c5e0 CR2CFAPattern c612 DNGVersion
c613 DNGBackwardVersion c614 UniqueCameraModel c615 LocalizedCameraModel c616 CFAPlaneColor c617 CFALayout c618 LinearizationTable c619 BlackLevelRepeatDim
c61a BlackLevel c61b BlackLevelDeltaH c61c BlackLevelDeltaV c61d WhiteLevel c61e DefaultScale c61f DefaultCropOrigin c620 DefaultCropSize c621 ColorMatrix1
c622 ColorMatrix2 c623 CameraCalibration1 c624 CameraCalibration2 c625 ReductionMatrix1 c626 ReductionMatrix2 c627 AnalogBalance c628 AsShotNeutral
c629 AsShotWhiteXY c62a BaselineExposure c62b BaselineNoise c62c BaselineSharpness c62d BayerGreenSplit c62e LinearResponseLimit c62f CameraSerialNumber
c630 DNGLensInfo c631 ChromaBlurRadius c632 AntiAliasStrength c633 ShadowScale c634 DNGPrivateData c635 MakerNoteSafety c640 RawImageSegmentation
c65a CalibrationIlluminant1 c65b CalibrationIlluminant2 c65c BestQualityScale c65d RawDataUniqueID c660 AliasLayerMetadata c68b OriginalRawFileName
c68c OriginalRawFileData c68d ActiveArea c68e MaskedAreas c68f AsShotICCProfile c690 AsShotPreProfileMatrix c691 CurrentICCProfile c692 CurrentPreProfileMatrix
c6bf ColorimetricReference c6c5 SRawType c6d2 PanasonicTitle c6d3 PanasonicTitle2 c6f3 CameraCalibrationSig c6f4 ProfileCalibrationSig c6f5 ProfileIFD
c6f6 AsShotProfileName c6f7 NoiseReductionApplied c6f8 ProfileName c6f9 ProfileHueSatMapDims c6fa ProfileHueSatMapData1 c6fb ProfileHueSatMapData2
c6fc ProfileToneCurve c6fd ProfileEmbedPolicy c6fe ProfileCopyright c714 ForwardMatrix1 c715 ForwardMatrix2 c716 PreviewApplicationName
c717 PreviewApplicationVersion c718 PreviewSettingsName c719 PreviewSettingsDigest c71a PreviewColorSpace c71b PreviewDateTime c71c RawImageDigest
c71d OriginalRawFileDigest c71e SubTileBlockSize c71f RowInterleaveFactor c725 ProfileLookTableDims c726 ProfileLookTableData c740 OpcodeList1 c741 OpcodeList2
c74e OpcodeList3 c761 NoiseProfile c763 TimeCodes c764 FrameRate c772 TStop c789 ReelName c791 OriginalDefaultFinalSize c792 OriginalBestQualitySize
c793 OriginalDefaultCropSize c7a1 CameraLabel c7a3 ProfileHueSatMapEncoding c7a4 ProfileLookTableEncoding c7a5 BaselineExposureOffset c7a6 DefaultBlackRender
c7a7 NewRawImageDigest c7a8 RawToPreviewGain c7aa CacheVersion c7b5 DefaultUserCrop c7d5 NikonNEFInfo c7e9 DepthFormat c7ea DepthNear c7eb DepthFar c7ec DepthUnits
c7ed DepthMeasureType c7ee EnhanceParams cd2d ProfileGainTableMap cd2e SemanticName cd30 SemanticInstanceID cd31 CalibrationIlluminant3 cd32 CameraCalibration3
cd33 ColorMatrix3 cd34 ForwardMatrix3 cd35 IlluminantData1 cd36 IlluminantData2 cd37 IlluminantData3 cd38 MaskSubArea cd39 ProfileHueSatMapData3
cd3a ReductionMatrix3 cd3b RGBTables cd41 JUMBF ea1c Padding ea1d OffsetSchema fde8 OwnerName fde9 SerialNumber fdea Lens`);
const GPS_T = mk(`0000 GPSVersionID 0001 GPSLatitudeRef 0002 GPSLatitude 0003 GPSLongitudeRef 0004 GPSLongitude 0005 GPSAltitudeRef 0006 GPSAltitude 0007 GPSTimeStamp
0008 GPSSatellites 0009 GPSStatus 000a GPSMeasureMode 000b GPSDOP 000c GPSSpeedRef 000d GPSSpeed 000e GPSTrackRef 000f GPSTrack 0010 GPSImgDirectionRef
0011 GPSImgDirection 0012 GPSMapDatum 0013 GPSDestLatitudeRef 0014 GPSDestLatitude 0015 GPSDestLongitudeRef 0016 GPSDestLongitude 0017 GPSDestBearingRef
0018 GPSDestBearing 0019 GPSDestDistanceRef 001a GPSDestDistance 001b GPSProcessingMethod 001c GPSAreaInformation 001d GPSDateStamp 001e GPSDifferential
001f GPSHPositioningError`);
const DJI_T = mk(`0001 Make 0003 SpeedX 0004 SpeedY 0005 SpeedZ 0006 Pitch 0007 Yaw 0008 Roll 0009 CameraPitch 000a CameraYaw 000b CameraRoll`);
const MPF_T = mk(`b000 MPFVersion b001 NumberOfImages b002 MPImageList b003 ImageUIDList b004 TotalFrames b101 MPIndividualNum b201 PanOrientation b202 PanOverlapH
b203 PanOverlapV b204 BaseViewpointNum b205 ConvergenceAngle b206 BaselineLength b207 VerticalDivergence b208 AxisDistanceX b209 AxisDistanceY b20a AxisDistanceZ
b20b YawAngle b20c PitchAngle b20d RollAngle`);
const TABLES = { EXIF: EXIF_T, GPS: GPS_T, DJI: DJI_T, MPF: MPF_T };
const GEOKEY = { 1: "GeoTiffVersion", 1024: "GTModelType", 1025: "GTRasterType", 1026: "GTCitation", 2048: "GeographicType", 2049: "GeogCitation", 2050: "GeogGeodeticDatum",
  2051: "GeogPrimeMeridian", 2052: "GeogLinearUnits", 2053: "GeogLinearUnitSize", 2054: "GeogAngularUnits", 2055: "GeogAngularUnitSize", 2056: "GeogEllipsoid",
  2057: "GeogSemiMajorAxis", 2058: "GeogSemiMinorAxis", 2059: "GeogInvFlattening", 2060: "GeogAzimuthUnits", 2061: "GeogPrimeMeridianLong", 3072: "ProjectedCSType",
  3073: "PCSCitation", 3074: "Projection", 3075: "ProjCoordTrans", 3076: "ProjLinearUnits", 3077: "ProjLinearUnitSize", 3078: "ProjStdParallel1", 3079: "ProjStdParallel2",
  3080: "ProjNatOriginLong", 3081: "ProjNatOriginLat", 3082: "ProjFalseEasting", 3083: "ProjFalseNorthing", 3084: "ProjFalseOriginLong", 3085: "ProjFalseOriginLat",
  3086: "ProjFalseOriginEasting", 3087: "ProjFalseOriginNorthing", 3088: "ProjCenterLong", 3089: "ProjCenterLat", 3090: "ProjCenterEasting", 3091: "ProjCenterNorthing",
  3092: "ProjScaleAtNatOrigin", 3093: "ProjScaleAtCenter", 3094: "ProjAzimuthAngle", 3095: "ProjStraightVertPoleLong", 3096: "ProjRectifiedGridAngle",
  4096: "VerticalCSType", 4097: "VerticalCitation", 4098: "VerticalDatum", 4099: "VerticalUnits" };
/* GeoTIFF 1.1 (OGC 19-008r4) key names for the renamed keys */
const GEOKEY11 = { 2048: "GeodeticCRSGeoKey", 2050: "GeodeticDatumGeoKey", 3072: "ProjectedCRSGeoKey", 3074: "ProjectionGeoKey", 4096: "VerticalGeoKey" };
/* EPSG names (EPSG Geodetic Parameter Dataset) for codes common in Central European drone work */
const EPSG = { 4326: "WGS 84", 4258: "ETRS89", 4979: "WGS 84 (3D)", 4937: "ETRS89 (3D)", 3857: "WGS 84 / Pseudo-Mercator", 5514: "S-JTSK / Krovak East North",
  2065: "S-JTSK (Ferro) / Krovak", 4156: "S-JTSK", 32633: "WGS 84 / UTM zone 33N", 32634: "WGS 84 / UTM zone 34N", 32632: "WGS 84 / UTM zone 32N",
  25833: "ETRS89 / UTM zone 33N", 25834: "ETRS89 / UTM zone 34N", 25832: "ETRS89 / UTM zone 32N", 3035: "ETRS89-extended / LAEA Europe", 5705: "Baltic 1977 height",
  3855: "EGM2008 height", 5773: "EGM96 height", 8357: "Baltic 1957 height", 6326: "World Geodetic System 1984", 6258: "European Terrestrial Reference System 1989",
  6156: "System of the Unified Trigonometrical Cadastral Network", 7030: "WGS 84", 7019: "GRS 1980" };

const FLASH = { 0: "No Flash", 1: "Fired", 5: "Fired, Return not detected", 7: "Fired, Return detected", 8: "On, Did not fire", 9: "On, Fired", 13: "On, Return not detected",
  15: "On, Return detected", 16: "Off, Did not fire", 20: "Off, Did not fire, Return not detected", 24: "Auto, Did not fire", 25: "Auto, Fired", 29: "Auto, Fired, Return not detected",
  31: "Auto, Fired, Return detected", 32: "No flash function", 48: "Off, No flash function", 65: "Fired, Red-eye reduction", 69: "Fired, Red-eye reduction, Return not detected",
  71: "Fired, Red-eye reduction, Return detected", 73: "On, Red-eye reduction", 77: "On, Red-eye reduction, Return not detected", 79: "On, Red-eye reduction, Return detected",
  80: "Off, Red-eye reduction", 88: "Auto, Did not fire, Red-eye reduction", 89: "Auto, Fired, Red-eye reduction", 93: "Auto, Fired, Red-eye reduction, Return not detected",
  95: "Auto, Fired, Red-eye reduction, Return detected" };
const NORTH = { M: "Magnetic North", T: "True North" };
const UNITS = { 9001: "Linear Meter", 9002: "Linear Foot", 9003: "Linear Foot US Survey", 9004: "Linear Foot Modified American", 9005: "Linear Foot Clarke", 9006: "Linear Foot Indian",
  9007: "Linear Link", 9008: "Linear Link Benoit", 9009: "Linear Link Sears", 9010: "Linear Chain Benoit", 9101: "Angular Radian", 9102: "Angular Degree", 9103: "Angular Arc Minute",
  9104: "Angular Arc Second", 9105: "Angular Grad", 9106: "Angular Gon", 9107: "Angular DMS", 9108: "Angular DMS Hemisphere", 32767: "User Defined" };
const E = {
  Orientation: { 1: "Horizontal (normal)", 2: "Mirror horizontal", 3: "Rotate 180", 4: "Mirror vertical", 5: "Mirror horizontal and rotate 270 CW", 6: "Rotate 90 CW", 7: "Mirror horizontal and rotate 90 CW", 8: "Rotate 270 CW" },
  ResolutionUnit: { 1: "None", 2: "inches", 3: "cm" },
  FocalPlaneResolutionUnit: { 1: "None", 2: "inches", 3: "cm", 4: "mm", 5: "um" },
  YCbCrPositioning: { 1: "Centered", 2: "Co-sited" },
  PlanarConfiguration: { 1: "Chunky", 2: "Planar" },
  Predictor: { 1: "None", 2: "Horizontal differencing", 3: "Floating point", 34892: "Horizontal difference X2", 34893: "Horizontal difference X4", 34894: "Floating point X2", 34895: "Floating point X4" },
  SampleFormat: { 1: "Unsigned", 2: "Signed", 3: "Float", 4: "Undefined", 5: "Complex int", 6: "Complex float" },
  ExtraSamples: { 0: "Unspecified", 1: "Associated Alpha", 2: "Unassociated Alpha" },
  FillOrder: { 1: "Normal", 2: "Reversed" },
  GrayResponseUnit: { 1: "0.1", 2: "0.001", 3: "0.0001", 4: "1e-05", 5: "1e-06" },
  SubfileType: { 0: "Full-resolution image", 1: "Reduced-resolution image", 2: "Single page of multi-page image", 3: "Single page of multi-page reduced-resolution image", 4: "Transparency mask",
    5: "Transparency mask of reduced-resolution image", 6: "Transparency mask of multi-page image", 7: "Transparency mask of reduced-resolution multi-page image", 8: "Depth map",
    9: "Depth map of reduced-resolution image", 16: "Enhanced image data", 65537: "Alternate reduced-resolution image", 65540: "Semantic Mask", 4294967295: "invalid" },
  PhotometricInterpretation: { 0: "WhiteIsZero", 1: "BlackIsZero", 2: "RGB", 3: "RGB Palette", 4: "Transparency Mask", 5: "CMYK", 6: "YCbCr", 8: "CIELab", 9: "ICCLab", 10: "ITULab",
    32803: "Color Filter Array", 32844: "Pixar LogL", 32845: "Pixar LogLuv", 32892: "Sequential Color Filter", 34892: "Linear Raw", 51177: "Depth Map", 52527: "Semantic Mask" },
  Compression: { 1: "Uncompressed", 2: "CCITT 1D", 3: "T4/Group 3 Fax", 4: "T6/Group 4 Fax", 5: "LZW", 6: "JPEG (old-style)", 7: "JPEG", 8: "Adobe Deflate", 9: "JBIG B&W", 10: "JBIG Color",
    32766: "Next", 32769: "Epson ERF Compressed", 32771: "CCIRLEW", 32773: "PackBits", 32809: "Thunderscan", 32895: "IT8CTPAD", 32896: "IT8LW", 32897: "IT8MP", 32898: "IT8BL",
    32908: "PixarFilm", 32909: "PixarLog", 32946: "Deflate", 32947: "DCS", 34661: "JBIG", 34676: "SGILog", 34677: "SGILog24", 34712: "JPEG 2000", 34713: "Nikon NEF Compressed",
    65000: "Kodak DCR Compressed", 65535: "Pentax PEF Compressed" },
  ExposureProgram: { 0: "Not Defined", 1: "Manual", 2: "Program AE", 3: "Aperture-priority AE", 4: "Shutter speed priority AE", 5: "Creative (Slow speed)", 6: "Action (High speed)", 7: "Portrait", 8: "Landscape", 9: "Bulb" },
  SensitivityType: { 0: "Unknown", 1: "Standard Output Sensitivity", 2: "Recommended Exposure Index", 3: "ISO Speed", 4: "Standard Output Sensitivity and Recommended Exposure Index",
    5: "Standard Output Sensitivity and ISO Speed", 6: "Recommended Exposure Index and ISO Speed", 7: "Standard Output Sensitivity, Recommended Exposure Index and ISO Speed" },
  MeteringMode: { 0: "Unknown", 1: "Average", 2: "Center-weighted average", 3: "Spot", 4: "Multi-spot", 5: "Multi-segment", 6: "Partial", 255: "Other" },
  LightSource: { 0: "Unknown", 1: "Daylight", 2: "Fluorescent", 3: "Tungsten (Incandescent)", 4: "Flash", 9: "Fine Weather", 10: "Cloudy", 11: "Shade", 12: "Daylight Fluorescent",
    13: "Day White Fluorescent", 14: "Cool White Fluorescent", 15: "White Fluorescent", 16: "Warm White Fluorescent", 17: "Standard Light A", 18: "Standard Light B", 19: "Standard Light C",
    20: "D55", 21: "D65", 22: "D75", 23: "D50", 24: "ISO Studio Tungsten", 255: "Other" },
  Flash: FLASH,
  SensingMethod: { 1: "Not defined", 2: "One-chip color area", 3: "Two-chip color area", 4: "Three-chip color area", 5: "Color sequential area", 7: "Trilinear", 8: "Color sequential linear" },
  FileSource: { 1: "Film Scanner", 2: "Reflection Print Scanner", 3: "Digital Camera" },
  SceneType: { 1: "Directly photographed" },
  CustomRendered: { 0: "Normal", 1: "Custom" },
  ExposureMode: { 0: "Auto", 1: "Manual", 2: "Auto bracket" },
  WhiteBalance: { 0: "Auto", 1: "Manual" },
  SceneCaptureType: { 0: "Standard", 1: "Landscape", 2: "Portrait", 3: "Night", 4: "Other" },
  GainControl: { 0: "None", 1: "Low gain up", 2: "High gain up", 3: "Low gain down", 4: "High gain down" },
  Contrast: { 0: "Normal", 1: "Low", 2: "High" }, Saturation: { 0: "Normal", 1: "Low", 2: "High" }, Sharpness: { 0: "Normal", 1: "Soft", 2: "Hard" },
  SubjectDistanceRange: { 0: "Unknown", 1: "Macro", 2: "Close", 3: "Distant" },
  ColorSpace: { 1: "sRGB", 2: "Adobe RGB", 65535: "Uncalibrated" },
  GPSLatitudeRef: { N: "North", S: "South" }, GPSLongitudeRef: { E: "East", W: "West" }, GPSDestLatitudeRef: { N: "North", S: "South" }, GPSDestLongitudeRef: { E: "East", W: "West" },
  GPSAltitudeRef: { 0: "Above Sea Level", 1: "Below Sea Level", 2: "Positive Sea Level (sea-level ref)", 3: "Negative Sea Level (sea-level ref)" },
  GPSStatus: { A: "Measurement Active", V: "Measurement Void" }, GPSMeasureMode: { 2: "2-Dimensional Measurement", 3: "3-Dimensional Measurement" },
  GPSSpeedRef: { K: "km/h", M: "mph", N: "knots" }, GPSTrackRef: NORTH, GPSImgDirectionRef: NORTH, GPSDestBearingRef: NORTH,
  GPSDestDistanceRef: { K: "Kilometers", M: "Miles", N: "Nautical Miles" }, GPSDifferential: { 0: "No Correction", 1: "Differential Corrected" },
  GTModelType: { 1: "Projected", 2: "Geographic", 3: "Geocentric", 32767: "User Defined" }, GTRasterType: { 1: "Pixel Is Area", 2: "Pixel Is Point", 32767: "User Defined" },
  ProjLinearUnits: UNITS, GeogLinearUnits: UNITS, GeogAngularUnits: UNITS, VerticalUnits: UNITS, GeogAzimuthUnits: UNITS,
  EncodingProcess: { 0: "Baseline DCT, Huffman coding", 1: "Extended sequential DCT, Huffman coding", 2: "Progressive DCT, Huffman coding", 3: "Lossless, Huffman coding",
    5: "Sequential DCT, differential Huffman coding", 6: "Progressive DCT, differential Huffman coding", 7: "Lossless, Differential Huffman coding", 9: "Extended sequential DCT, arithmetic coding",
    10: "Progressive DCT, arithmetic coding", 11: "Lossless, arithmetic coding", 13: "Sequential DCT, differential arithmetic coding", 14: "Progressive DCT, differential arithmetic coding",
    15: "Lossless, differential arithmetic coding" },
  ColorTransform: { 0: "Unknown (RGB or CMYK)", 1: "YCbCr", 2: "YCCK" },
  RenderingIntent: { 0: "Perceptual", 1: "Media-Relative Colorimetric", 2: "Saturation", 3: "ICC-Absolute Colorimetric" },
  ProfileClass: { abst: "Abstract Profile", cenc: "ColorEncodingSpace Profile", link: "DeviceLink Profile", "mid ": "MultiplexIdentification Profile", mlnk: "MultiplexLink Profile",
    mntr: "Display Device Profile", mvis: "MultiplexVisualization Profile", nkpf: "Nikon Input Device Profile (NON-STANDARD!)", nmcl: "NamedColor Profile", prtr: "Output Device Profile",
    scnr: "Input Device Profile", spac: "ColorSpace Conversion Profile" },
  PrimaryPlatform: { APPL: "Apple Computer Inc.", MSFT: "Microsoft Corporation", "SGI ": "Silicon Graphics Inc.", SUNW: "Sun Microsystems Inc.", TGNT: "Taligent Inc." },
  ColorType: { 0: "Grayscale", 2: "RGB", 3: "Palette", 4: "Grayscale with Alpha", 6: "RGB with Alpha" }, Interlace: { 0: "Noninterlaced", 1: "Adam7 Interlace" },
  PixelUnits: { 0: "Unknown", 1: "meters" },
  AlphaIsUsed: { 0: "No", 1: "Yes" },
  MPImageFormat: { 0: "JPEG" },
  MPImageType: { 0: "Undefined", 0x10001: "Large Thumbnail (VGA equivalent)", 0x10002: "Large Thumbnail (full HD equivalent)", 0x10003: "Large Thumbnail (4K equivalent)",
    0x10004: "Large Thumbnail (8K equivalent)", 0x10005: "Large Thumbnail (16K equivalent)", 0x20001: "Multi-frame Panorama", 0x20002: "Multi-frame Disparity", 0x20003: "Multi-angle",
    0x30000: "Baseline MP Primary Image", 0x40000: "Original Preservation Image", 0x50000: "Gain Map Image" }
};
const JFIF_RES = { 0: "None", 1: "inches", 2: "cm" };

/* ---------------------------------------------------------------- print conversions (ExifTool-like display) */
function expTime(t) { if (!isNum(t)) return num(t); if (t <= 0) return num(t); if (t < 0.25001) return "1/" + num(Math.round(1 / t * 10) / 10, 6); return num(rnd(t, 1), 6); }
function frac(v) { if (!isNum(v)) return num(v); if (v === 0) return "0"; const s = v > 0 ? "+" : "-", a = Math.abs(v); for (const d of [2, 3]) { const n = Math.round(a * d); if (Math.abs(n / d - a) < 0.005) { const w = Math.floor(n / d), r = n % d; return s + (r === 0 ? w : (w ? w + " " : "") + r + "/" + d); } } return s + num(rnd(a, 2)); }
function dms(v) { if (!Array.isArray(v) || v.length < 3) return autoDisp(v); const d = v[0] + v[1] / 60 + v[2] / 3600; return dmsDeg(d); }
function dmsDeg(d) { d = Math.abs(d); let D = Math.floor(d), m = Math.floor((d - D) * 60), s = (d - D - m / 60) * 3600; if (s >= 59.995) { s = 0; m++; } if (m >= 60) { m = 0; D++; } return D + " deg " + m + "' " + s.toFixed(2) + '"'; }
function hms(v) { if (!Array.isArray(v) || v.length < 3) return autoDisp(v); const s = v[2], si = Math.floor(s), f = s - si; return String(v[0]).padStart(2, "0") + ":" + String(v[1]).padStart(2, "0") + ":" + String(si).padStart(2, "0") + (f > 1e-6 ? String(rnd(f, 6)).slice(1) : ""); }
function lensInfo(v) { if (!Array.isArray(v) || v.length < 4) return autoDisp(v); const f = (a, b) => a === b || !isNum(b) || b === 0 ? num(a, 4) : num(a, 4) + "-" + num(b, 4); return f(v[0], v[1]) + "mm f/" + (isNum(v[2]) && v[2] ? f(v[2], v[3]) : "?"); }
const PRINT = {
  ExposureTime: expTime, ShutterSpeedValue: v => expTime(Math.pow(2, -v)), FNumber: v => isNum(v) ? v.toFixed(1) : num(v),
  ApertureValue: v => Math.pow(2, v / 2).toFixed(1), MaxApertureValue: v => Math.pow(2, v / 2).toFixed(1),
  FocalLength: v => isNum(v) ? v.toFixed(1) + " mm" : num(v), FocalLengthIn35mmFormat: v => num(v) + " mm", ExposureCompensation: frac, SubjectDistance: v => num(v) + " m",
  GPSLatitude: dms, GPSLongitude: dms, GPSDestLatitude: dms, GPSDestLongitude: dms, GPSTimeStamp: hms, GPSAltitude: v => num(v, 8) + " m", GPSHPositioningError: v => num(v) + " m",
  GPSVersionID: v => Array.isArray(v) ? v.join(".") : num(v), LensInfo: lensInfo, DNGLensInfo: lensInfo, DNGVersion: v => Array.isArray(v) ? v.join(".") : num(v),
  DNGBackwardVersion: v => Array.isArray(v) ? v.join(".") : num(v), ComponentsConfiguration: v => Array.isArray(v) ? v.map(x => ["-", "Y", "Cb", "Cr", "R", "G", "B"][x] || x).join(", ") : num(v),
  AmbientTemperature: v => num(v, 6) + " C", Humidity: v => num(v, 6) + " %", Pressure: v => num(v, 6) + " hPa", WaterDepth: v => num(v, 6) + " m", CameraElevationAngle: v => num(v, 6)
};

/* ---------------------------------------------------------------- TIFF / EXIF reader (TIFF, BigTIFF, DNG, Exif in JPEG/PNG/WebP/HEIC, MPF) */
const TT = { 1: [1, "int8u"], 2: [1, "string"], 3: [2, "int16u"], 4: [4, "int32u"], 5: [8, "rational64u"], 6: [1, "int8s"], 7: [1, "undef"], 8: [2, "int16s"], 9: [4, "int32s"],
  10: [8, "rational64s"], 11: [4, "float"], 12: [8, "double"], 13: [4, "ifd"], 16: [8, "int64u"], 17: [8, "int64s"], 18: [8, "ifd64"], 129: [1, "utf8"] };
function decodeVals(b, type, n, le) {
  const dv = DV(b), out = [], sz = TT[type][0]; n = Math.min(n, Math.floor(b.length / sz));
  for (let i = 0; i < n; i++) {
    const o = i * sz; let v;
    switch (type) {
      case 1: case 7: v = b[o]; break; case 6: v = dv.getInt8(o); break;
      case 3: v = dv.getUint16(o, le); break; case 8: v = dv.getInt16(o, le); break;
      case 4: case 13: v = dv.getUint32(o, le); break; case 9: v = dv.getInt32(o, le); break;
      case 5: { const p = dv.getUint32(o, le), q = dv.getUint32(o + 4, le); v = q ? p / q : (p ? Infinity : NaN); break; }
      case 10: { const p = dv.getInt32(o, le), q = dv.getInt32(o + 4, le); v = q ? p / q : (p ? (p > 0 ? Infinity : -Infinity) : NaN); break; }
      case 11: v = dv.getFloat32(o, le); break; case 12: v = dv.getFloat64(o, le); break;
      case 16: case 18: v = Number(dv.getBigUint64(o, le)); break; case 17: v = Number(dv.getBigInt64(o, le)); break;
    }
    out.push(v);
  }
  return out;
}
function charsetText(b) { /* UserComment / GPSProcessingMethod: 8-byte character code prefix */
  if (b.length < 8) return cstr(b);
  const code = latin1(b, 0, 8), rest = b.subarray(8);
  if (code.startsWith("UNICODE")) { const le = !(rest[0] === 0 && rest[1] !== 0); return utf16(rest, le).trim(); }
  if (code.startsWith("ASCII") || code === "\0\0\0\0\0\0\0\0") return cstr(rest).trim();
  return cstr(rest).trim();
}
function ifdGroup(name) { return ({ IFD0: "EXIF:IFD0", IFD1: "EXIF:IFD1", ExifIFD: "EXIF:ExifIFD", GPS: "EXIF:GPS", Interop: "EXIF:Interop" })[name] || ("EXIF:" + name); }
function tagName(table, tag, q) {
  if (q.table === "EXIF") {
    if (tag === 0x0201 || tag === 0x0202) {
      const st = tag === 0x0201;
      if (/^IFD[01]$/.test(q.name)) return st ? "ThumbnailOffset" : "ThumbnailLength";
      if (/^SubIFD/.test(q.name)) return st ? "JpgFromRawStart" : "JpgFromRawLength";
      return st ? "OtherImageStart" : "OtherImageLength";
    }
  }
  const t = TABLES[q.table] || EXIF_T;
  return t[tag] || ("Tag " + hex(tag));
}
const SUBDIR = { 0x8769: ["ExifIFD", "EXIF"], 0x8825: ["GPS", "GPS"], 0xa005: ["Interop", "EXIF"] };

async function readTIFF(ctx, base, o) {
  o = o || {};
  const src = ctx.src, h = await src.read(base, 16);
  if (h.length < 8) { ctx.warn("truncated", "TIFF header", base); return null; }
  const bo = latin1(h, 0, 2);
  if (bo !== "II" && bo !== "MM") { ctx.warn("bad-tiff", "byte order " + JSON.stringify(bo), base); return null; }
  const le = bo === "II", dv = DV(h), magic = dv.getUint16(2, le);
  let big = false, first;
  if (magic === 43) { if (h.length < 16) { ctx.warn("truncated", "BigTIFF header", base); return null; } big = true; first = Number(dv.getBigUint64(8, le)); }
  else if (magic === 42 || magic === 0x55 || magic === 0x4f52 || magic === 0x5352) first = dv.getUint32(4, le);
  else { ctx.warn("bad-tiff", "TIFF magic " + magic, base); return null; }
  const T = { le, big, base, magic, seen: new Set(), o, depth: o.depth || 0, ifds: {} };
  if (!o.noOrder && !ctx.info.byteOrder) ctx.info.byteOrder = bo;
  if (o.headerSeg) ctx.seg(o.headerSeg, "header", base, big ? 16 : 8, bo + (big ? " BigTIFF" : magic === 42 ? "" : " magic " + magic), T.depth);
  if (o.single) { await readIFD(ctx, T, { off: first, name: o.name || "IFD0", table: o.table || "EXIF", group: o.group }); return T; }
  let off = first, idx = 0;
  while (off && idx < 64) {
    const name = idx === 0 ? (o.name || "IFD0") : "IFD" + idx;
    off = await readIFD(ctx, T, { off, name, table: o.table || "EXIF", group: idx === 0 ? o.group : null });
    idx++;
  }
  return T;
}

async function readIFD(ctx, T, q) {
  const src = ctx.src, abs = T.base + q.off;
  if (q.off < 8 || abs >= src.size) { ctx.warn("bad-offset", q.name + " @" + hex(q.off, 8), abs); return 0; }
  if (T.seen.has(abs)) { ctx.warn("ifd-loop", q.name + " @" + hex(q.off, 8), abs); return 0; }
  T.seen.add(abs);
  if (T.seen.size > 256) { ctx.warn("ifd-cap", "more than 256 IFDs", abs); return 0; }
  const nb = T.big ? 8 : 2, es = T.big ? 20 : 12, ps = T.big ? 8 : 4;
  const cb = await src.read(abs, nb);
  if (cb.length < nb) { ctx.warn("truncated", q.name, abs); return 0; }
  let n = T.big ? Number(DV(cb).getBigUint64(0, T.le)) : DV(cb).getUint16(0, T.le);
  if (n > LIM.ifdEntries) { ctx.warn("ifd-entries", q.name + ": " + n + " entries", abs); return 0; }
  const buf = await src.read(abs + nb, n * es + ps);
  if (buf.length < n * es) { ctx.warn("truncated", q.name + " (" + n + " entries)", abs); n = Math.floor(buf.length / es); }
  const dv = DV(buf), gid = q.group || ifdGroup(q.name), le = T.le;
  ctx.group(gid);
  if (q.table !== "DJI") ctx.seg(q.name, q.table === "MPF" ? "mpf" : "exif", abs, nb + n * es + ps, n + " entries", T.depth + (T.o.headerSeg ? 1 : 0));
  const E2 = {}; /* tag -> {value, voff, total, type} for post-processing */
  for (let i = 0; i < n; i++) {
    const p = i * es, tag = dv.getUint16(p, le), type = dv.getUint16(p + 2, le);
    const cnt = T.big ? Number(dv.getBigUint64(p + 4, le)) : dv.getUint32(p + 4, le);
    const tt = TT[type], name = tagName(null, tag, q);
    if (!tt) { ctx.warn("bad-type", q.name + " " + hex(tag) + " type " + type, abs + nb + p); continue; }
    const total = tt[0] * cnt;
    let voff, inl = total <= ps;
    if (inl) voff = abs + nb + p + (T.big ? 12 : 8);
    else {
      const rel = T.big ? Number(dv.getBigUint64(p + 12, le)) : dv.getUint32(p + 8, le);
      voff = (q.mnBase != null ? q.mnBase : T.base) + rel;
      if (voff >= src.size || voff < 0) { ctx.warn("bad-offset", q.name + " " + name, voff); ctx.add(gid, { name, id: hex(tag), value: null, display: "(bad offset)", type: tt[1], count: cnt, offset: voff }); continue; }
      if (voff + total > src.size) ctx.warn("truncated", q.name + " " + name, voff);
    }
    try { await readEntry(ctx, T, q, gid, { tag, type, cnt, total, voff, name, tt, inl, bytes: inl ? buf.subarray(p + (T.big ? 12 : 8), p + (T.big ? 12 : 8) + total) : null }, E2); }
    catch (err) { ctx.warn("entry", q.name + " " + name + ": " + (err && err.message), voff); }
  }
  let next = 0;
  if (buf.length >= n * es + ps) next = T.big ? Number(DV(buf).getBigUint64(n * es, le)) : DV(buf).getUint32(n * es, le);
  /* post-processing of this IFD */
  T.ifds[q.name] = E2;
  if (E2[0x0201] && E2[0x0202] && isNum(E2[0x0201].value) && isNum(E2[0x0202].value) && E2[0x0202].value > 0) {
    const off = T.base + E2[0x0201].value, len = E2[0x0202].value;
    if (off + len <= src.size) {
      const kind = /^IFD[01]$/.test(q.name) ? "ThumbnailImage" : /^SubIFD/.test(q.name) ? "JpgFromRaw" : "OtherImage";
      ctx.previews.push({ kind, offset: off, length: len, mime: "image/jpeg", from: q.name });
      ctx.seg(kind + " (" + q.name + ")", "thumb", off, len, "JPEG", T.depth + 1);
      if (kind === "ThumbnailImage") ctx.pendingComposite.push({ name: "ThumbnailImage", id: "ThumbnailImage", value: null, display: "(binary, " + len + " bytes)", type: "undef", count: len, offset: off, binary: { offset: off, length: len }, from: [gid + ":ThumbnailOffset", gid + ":ThumbnailLength"] });
    } else ctx.warn("bad-offset", q.name + " thumbnail", off);
  }
  if (E2[0x87af]) decodeGeoKeys(ctx, E2[0x87af].value, E2[0x87b0] ? E2[0x87b0].value : null, E2[0x87b1] ? E2[0x87b1].value : null);
  if (T.o.fileLevel && (E2[0x0111] || E2[0x0144])) {
    const so = E2[0x0111] || E2[0x0144], sc = E2[0x0117] || E2[0x0145];
    const offs = [].concat(so.value), cnts = sc ? [].concat(sc.value) : [];
    if (offs.length && cnts.length) {
      let mn = Infinity, mx = 0, sum = 0;
      for (let i = 0; i < Math.min(offs.length, cnts.length); i++) { mn = Math.min(mn, offs[i]); mx = Math.max(mx, offs[i] + cnts[i]); sum += cnts[i]; }
      if (so.cnt > offs.length) { sum = sum / offs.length * so.cnt; }
      ctx.seg("image data (" + q.name + ")", "image", T.base + mn, Math.max(sum, 0), so.cnt + (E2[0x0111] ? " strips" : " tiles"), T.depth);
      if (q.name === "IFD0" && !ctx.raster) {
        const g = k => E2[k] ? E2[k].value : undefined;
        ctx.raster = { ifd: q.name, width: g(0x0100), height: g(0x0101), bitsPerSample: g(0x0102), compression: g(0x0103), photometric: g(0x0106), samplesPerPixel: g(0x0115) || 1,
          planar: g(0x011c) || 1, sampleFormat: g(0x0153) || 1, predictor: g(0x013d) || 1, rowsPerStrip: g(0x0116), tiled: !!E2[0x0144], tileWidth: g(0x0142), tileHeight: g(0x0143),
          offsets: offs.map(x => x + T.base), byteCounts: cnts, complete: so.cnt === offs.length, littleEndian: T.le };
      }
    }
  }
  return next;
}

const NEED_BYTES = new Set([0x02bc, 0x83bb, 0x8773, 0x8649, 0x927c, 0x9000, 0xa000, 0x0002, 0x9101, 0xa300, 0xa301, 0x9286, 0x001b, 0x001c, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f, 0x0000, 0xc634, 0xcd41]);
async function readEntry(ctx, T, q, gid, e, E2) {
  const src = ctx.src, { tag, type, cnt, total, voff, name, tt } = e, le = T.le;
  const isGPSt = q.table === "GPS", special = NEED_BYTES.has(tag) && !(tag === 0x0000 && !isGPSt) && !(tag === 0x0002 && q.table !== "EXIF");
  const binaryType = type === 7 || ((type === 1 || type === 6) && cnt > 64);
  const t = { name, id: hex(tag), value: null, display: undefined, type: tt[1], count: cnt, offset: voff };
  /* sub-directories */
  if (SUBDIR[tag] && q.table === "EXIF" && (type === 4 || type === 13 || type === 16 || type === 18)) {
    const bytes = e.bytes || await src.read(voff, total), v = decodeVals(bytes, type, 1, le)[0];
    t.value = v; t.display = String(v); ctx.add(gid, t); E2[tag] = { value: v, cnt, total, voff };
    const [nm, tb] = SUBDIR[tag];
    if (v) await readIFD(ctx, T, { off: v, name: nm, table: tb });
    return;
  }
  if (tag === 0x014a && q.table === "EXIF" && (type === 4 || type === 13 || type === 16 || type === 18)) {
    const bytes = e.bytes || await src.read(voff, Math.min(total, 64 * tt[0])), vs = decodeVals(bytes, type, Math.min(cnt, 64), le);
    t.value = cnt === 1 ? vs[0] : vs; ctx.add(gid, t); E2[tag] = { value: t.value, cnt, total, voff };
    for (let k = 0; k < vs.length; k++) if (vs[k]) await readIFD(ctx, T, { off: vs[k], name: "SubIFD" + (k ? k : ""), table: "EXIF" });
    return;
  }
  if (tag === 0x927c && q.table === "EXIF") { await readMakerNote(ctx, T, gid, t, voff, total); return; }
  /* large binary blocks are not read unless needed */
  if (binaryType && !special && total > 1024) {
    t.display = "(binary, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); E2[tag] = { value: null, cnt, total, voff };
    return;
  }
  let cap = total;
  if (type === 2 || type === 129 || binaryType || special) cap = Math.min(total, tag === 0x02bc || tag === 0x8773 || tag === 0x83bb || tag === 0x8649 || tag === 0xcd41 ? LIM.bin : LIM.str);
  else cap = Math.min(total, ((tag === 0x0111 || tag === 0x0117 || tag === 0x0144 || tag === 0x0145) ? LIM.offs : LIM.arr) * tt[0]);
  const bytes = e.bytes || await src.read(voff, cap);
  if (bytes.length < cap) ctx.warn("truncated", q.name + " " + name, voff);
  let v;
  if (type === 2) v = cstr(bytes);
  else if (type === 129) v = cstr(bytes);
  else if (special || type === 7) {
    switch (tag) {
      case 0x9000: case 0xa000: case 0x0002: v = latin1(bytes).replace(/\0+$/, ""); break;
      case 0x9101: v = Array.from(bytes.subarray(0, 4)); break;
      case 0xa300: case 0xa301: v = bytes[0]; break;
      case 0x9286: case 0x001b: case 0x001c: v = charsetText(bytes); break;
      case 0x9c9b: case 0x9c9c: case 0x9c9d: case 0x9c9e: case 0x9c9f: v = utf16(bytes, true); break;
      case 0x0000: v = Array.from(bytes.subarray(0, 4)); break;
      case 0x02bc: t.display = "(XMP packet, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); ctx.seg("XMP (tag 0x02bc)", "xmp", voff, total, "", T.depth + 1); await parseXMP(ctx, bytes, voff); return;
      case 0x83bb: t.display = "(IPTC, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); ctx.seg("IPTC (tag 0x83bb)", "iptc", voff, total, "", T.depth + 1); parseIPTC(ctx, bytes, voff); return;
      case 0x8773: t.display = "(ICC profile, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); ctx.seg("ICC profile (tag 0x8773)", "icc", voff, total, "", T.depth + 1); parseICC(ctx, bytes, voff); return;
      case 0xcd41: t.display = "(JUMBF, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); { const r = await c2paRead(ctx, bytes, p => voff + p, "TIFF tag 0xcd41 (" + q.name + ")", T.depth + 1); if (!r.stores) ctx.seg("JUMBF (tag 0xcd41)", "other", voff, total, r.label || "", T.depth + 1); } return;
      case 0x8649: t.display = "(Photoshop IRB, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); await parseIRB(ctx, bytes, voff); return;
      default:
        if (total > 64) { t.display = "(binary, " + total + " bytes)"; t.binary = { offset: voff, length: total }; ctx.add(gid, t); E2[tag] = { value: null, cnt, total, voff }; return; }
        v = Array.from(bytes);
    }
  } else {
    const arr = decodeVals(bytes, type, cnt, le);
    v = cnt === 1 ? arr[0] : arr;
    if (arr.length < cnt) t.note = "first " + arr.length + " of " + cnt + " values";
  }
  t.value = v;
  if (tag === 0x010f && q.table === "EXIF" && typeof v === "string" && !ctx.info.make) ctx.info.make = v;
  t.display = printConv(name, v, q.table);
  if (tag === 0x87b1 && typeof v === "string") t.display = v.replace(/\|/g, "|");
  ctx.add(gid, t);
  E2[tag] = { value: v, cnt, total, voff };
}
function printConv(name, v, table) {
  if (v == null) return "";
  if (PRINT[name]) { try { return PRINT[name](v); } catch (e) { return autoDisp(v); } }
  const en = E[name];
  if (en && table !== "MPF") {
    if (Array.isArray(v)) return v.map(x => en[x] != null ? en[x] : "Unknown (" + x + ")").join(", ");
    if (en[v] != null) return en[v];
    return "Unknown (" + autoDisp(v) + ")";
  }
  return autoDisp(v);
}

/* ---------------------------------------------------------------- MakerNotes: DJI decoded, other vendors detected */
async function readMakerNote(ctx, T, gid, t, voff, total) {
  const head = await ctx.src.read(voff, Math.min(total, 32)), s = latin1(head);
  const make = (ctx.info.make || "").toUpperCase();
  let vendor = null, name = "MakerNoteUnknown", decode = null;
  if (s.startsWith("[ae_dbg_info:")) { vendor = "DJI (debug info)"; name = "MakerNoteDJIInfo"; }
  else if (make.startsWith("DJI") && !/^(...@AMBA|DJI)/.test(s)) { vendor = "DJI"; name = "MakerNoteDJI"; decode = "DJI"; }
  else if (make.startsWith("DJI")) { vendor = "DJI"; name = "MakerNoteUnknown"; }
  else if (s.startsWith("Nikon\0")) { vendor = "Nikon"; name = "MakerNoteNikon"; }
  else if (s.startsWith("Apple iOS")) { vendor = "Apple"; name = "MakerNoteApple"; }
  else if (s.startsWith("SONY DSC ") || s.startsWith("SONY CAM ") || s.startsWith("SONY MOBILE")) { vendor = "Sony"; name = "MakerNoteSony"; }
  else if (s.startsWith("Panasonic\0")) { vendor = "Panasonic"; name = "MakerNotePanasonic"; }
  else if (s.startsWith("OLYMPUS\0")) { vendor = "Olympus"; name = "MakerNoteOlympus2"; }
  else if (s.startsWith("OM SYSTEM\0")) { vendor = "OM System"; name = "MakerNoteOlympus3"; }
  else if (s.startsWith("OLYMP\0")) { vendor = "Olympus"; name = "MakerNoteOlympus"; }
  else if (s.startsWith("FUJIFILM")) { vendor = "Fujifilm"; name = "MakerNoteFujiFilm"; }
  else if (s.startsWith("AOC\0") || s.startsWith("PENTAX ")) { vendor = "Pentax"; name = "MakerNotePentax"; }
  else if (make.startsWith("CANON")) { vendor = "Canon"; name = "MakerNoteCanon"; }
  else if (make.startsWith("SAMSUNG")) { vendor = "Samsung"; }
  else if (make.startsWith("FLIR")) { vendor = "FLIR"; name = "MakerNoteFLIR"; }
  else if (make.startsWith("HASSELBLAD")) { vendor = "Hasselblad"; name = "MakerNoteHasselblad"; }
  t.name = name; t.display = "(binary, " + total + " bytes" + (vendor ? "; " + vendor : "") + ")"; t.binary = { offset: voff, length: total };
  if (vendor) t.note = "vendor: " + vendor;
  ctx.add(gid, t);
  ctx.info.makerNote = { vendor: vendor || "unknown", length: total, decoded: !!decode };
  ctx.seg("MakerNote" + (vendor ? " (" + vendor + ")" : ""), "maker", voff, total, decode ? "decoded" : "not decoded", T.depth + 1);
  if (decode === "DJI") {
    try { await readIFD(ctx, T, { off: voff - T.base, name: "DJI", table: "DJI", group: "MakerNotes:DJI" }); }
    catch (e) { ctx.warn("makernote", "DJI MakerNote: " + e.message, voff); }
    const g = ctx.gmap.get("MakerNotes:DJI");
    if (g) for (const tg of g.tags) if (typeof tg.value === "number" && tg.type === "float") tg.display = num(tg.value, 7);
  }
}

/* ---------------------------------------------------------------- GeoTIFF keys */
function decodeGeoKeys(ctx, dir, dbl, asc) {
  if (!Array.isArray(dir) || dir.length < 4) { ctx.warn("geotiff", "GeoKeyDirectory too short"); return; }
  const g = "GeoTIFF", nk = Math.min(dir[3], Math.floor((dir.length - 4) / 4), 500);
  ctx.add(g, { name: "GeoTiffVersion", id: "1", value: dir[0] + "." + dir[1] + "." + dir[2], type: "int16u" });
  const dbls = dbl == null ? [] : [].concat(dbl), ascs = typeof asc === "string" ? asc : "";
  const keys = {};
  for (let k = 0; k < nk; k++) {
    const id = dir[4 + k * 4], loc = dir[5 + k * 4], cnt = dir[6 + k * 4], vo = dir[7 + k * 4];
    let v;
    if (loc === 0) v = vo;
    else if (loc === 34736) { const a = dbls.slice(vo, vo + cnt); v = cnt === 1 ? a[0] : a; }
    else if (loc === 34737) v = ascs.substr(vo, cnt).replace(/\|$/, "");
    else v = null;
    const name = GEOKEY[id] || ("Tag " + hex(id));
    let disp;
    if (E[name] && loc === 0) disp = E[name][v] || ("Unknown (" + v + ")");
    else if (/CSType|GeographicType|GeodeticDatum|VerticalDatum|Ellipsoid|PrimeMeridian$|^Projection$/.test(name) && loc === 0) disp = v === 32767 ? "User Defined" : "EPSG:" + v + (EPSG[v] ? " (" + EPSG[v] + ")" : "");
    else disp = autoDisp(v);
    const t = { name, id: String(id), value: v, display: disp, type: loc === 34736 ? "double" : loc === 34737 ? "string" : "int16u", count: cnt };
    if (GEOKEY11[id]) t.note = "GeoTIFF 1.1: " + GEOKEY11[id];
    ctx.add(g, t); keys[name] = v;
  }
  ctx.info.geoKeys = keys;
}

/* ---------------------------------------------------------------- XMP: XML parsing (DOMParser or built-in), RDF walk */
const NSP = { "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf", "adobe:ns:meta/": "x", "http://www.w3.org/XML/1998/namespace": "xml", "http://purl.org/dc/elements/1.1/": "dc",
  "http://ns.adobe.com/xap/1.0/": "xmp", "http://ns.adobe.com/xap/1.0/mm/": "xmpMM", "http://ns.adobe.com/xap/1.0/rights/": "xmpRights", "http://ns.adobe.com/tiff/1.0/": "tiff",
  "http://ns.adobe.com/exif/1.0/": "exif", "http://cipa.jp/exif/1.0/": "exifEX", "http://ns.adobe.com/exif/1.0/aux/": "aux", "http://ns.adobe.com/camera-raw-settings/1.0/": "crs",
  "http://ns.adobe.com/photoshop/1.0/": "photoshop", "http://ns.adobe.com/xmp/note/": "xmpNote", "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/": "Iptc4xmpCore",
  "http://iptc.org/std/Iptc4xmpExt/2008-02-29/": "Iptc4xmpExt", "http://ns.google.com/photos/1.0/panorama/": "GPano", "http://www.dji.com/drone-dji/1.0/": "drone-dji",
  "http://pix4d.com/camera/1.0/": "Camera", "http://pix4d.com/camera/1.0": "Camera", "http://micasense.com/MicaSense/1.0/": "MicaSense", "http://micasense.com/DLS/1.0/": "DLS",
  "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#": "stEvt", "http://ns.adobe.com/xap/1.0/sType/ResourceRef#": "stRef", "http://ns.adobe.com/pdf/1.3/": "pdf" };
const XMP_NAME = { "drone-dji:GpsLatitude": "GPSLatitude", "drone-dji:GpsLongitude": "GPSLongitude", "drone-dji:GpsLongtitude": "GPSLongtitude", "tiff:ImageLength": "ImageHeight",
  "exif:PixelXDimension": "ExifImageWidth", "exif:PixelYDimension": "ExifImageHeight", "exif:FocalLengthIn35mmFilm": "FocalLengthIn35mmFormat", "exif:ISOSpeedRatings": "ISO" };
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
function decodeEnt(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" :
    String.fromCodePoint(Math.min(0x10ffff, e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
}
/* Minimal, lenient XML parser -> {uri, local, prefix, attrs:[{uri,local,prefix,value}], children:[], text} */
function parseXMLBuiltin(s) {
  const root = { uri: "", local: "#doc", prefix: "", attrs: [], children: [], text: "", nsmap: { xml: "http://www.w3.org/XML/1998/namespace" } };
  const stack = [root]; let i = 0, guard = 0; const L = s.length;
  const top = () => stack[stack.length - 1];
  while (i < L && guard++ < 2000000) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { top().text += decodeEnt(s.slice(i)); break; }
    if (lt > i) top().text += decodeEnt(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); i = e < 0 ? L : e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt + 9); top().text += s.slice(lt + 9, e < 0 ? L : e); i = e < 0 ? L : e + 3; continue; }
    if (s[lt + 1] === "?") { const e = s.indexOf("?>", lt + 2); i = e < 0 ? L : e + 2; continue; }
    if (s[lt + 1] === "!") { const e = s.indexOf(">", lt + 2); i = e < 0 ? L : e + 1; continue; }
    if (s[lt + 1] === "/") {
      const e = s.indexOf(">", lt + 2); const qn = s.slice(lt + 2, e < 0 ? L : e).trim(); i = e < 0 ? L : e + 1;
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].qname === qn) { stack.length = k; break; }
      continue;
    }
    let j = lt + 1; while (j < L && !/[\s/>]/.test(s[j])) j++;
    const qn = s.slice(lt + 1, j), rawAttrs = []; let selfClose = false;
    while (j < L) {
      while (j < L && /\s/.test(s[j])) j++;
      if (s[j] === "/") { selfClose = true; j++; continue; }
      if (s[j] === ">") { j++; break; }
      let k = j; while (k < L && !/[\s=/>]/.test(s[k])) k++;
      const an = s.slice(j, k); j = k; while (j < L && /\s/.test(s[j])) j++;
      let av = "";
      if (s[j] === "=") { j++; while (j < L && /\s/.test(s[j])) j++; const qch = s[j]; if (qch === '"' || qch === "'") { const e = s.indexOf(qch, j + 1); av = s.slice(j + 1, e < 0 ? L : e); j = e < 0 ? L : e + 1; } else { let e = j; while (e < L && !/[\s>]/.test(s[e])) e++; av = s.slice(j, e); j = e; } }
      if (an) rawAttrs.push([an, decodeEnt(av)]);
      if (k === j && !an) j++;
    }
    const parent = top(), nsmap = Object.assign({}, parent.nsmap);
    for (const [an, av] of rawAttrs) { if (an === "xmlns") nsmap[""] = av; else if (an.startsWith("xmlns:")) nsmap[an.slice(6)] = av; }
    const sp = q => { const c = q.indexOf(":"); return c < 0 ? ["", q] : [q.slice(0, c), q.slice(c + 1)]; };
    const [pf, lc] = sp(qn);
    const el = { qname: qn, uri: nsmap[pf] || "", local: lc, prefix: pf, attrs: [], children: [], text: "", nsmap };
    for (const [an, av] of rawAttrs) { if (an === "xmlns" || an.startsWith("xmlns:")) continue; const [ap, al] = sp(an); el.attrs.push({ uri: ap ? (nsmap[ap] || "") : "", local: al, prefix: ap, value: av }); }
    parent.children.push(el);
    if (!selfClose) stack.push(el);
    i = j;
  }
  return root;
}
function domToTree(node) {
  const el = { uri: node.namespaceURI || "", local: node.localName || node.nodeName, prefix: node.prefix || "", attrs: [], children: [], text: "" };
  if (node.attributes) for (const a of Array.from(node.attributes)) { if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue; el.attrs.push({ uri: a.namespaceURI || "", local: a.localName, prefix: a.prefix || "", value: a.value }); }
  for (const c of Array.from(node.childNodes)) { if (c.nodeType === 1) el.children.push(domToTree(c)); else if (c.nodeType === 3 || c.nodeType === 4) el.text += c.nodeValue; }
  return el;
}
function parseXMLText(s, mode) {
  if (mode !== "builtin" && typeof G.DOMParser === "function") {
    try {
      const doc = new G.DOMParser().parseFromString(s, "application/xml");
      if (doc && doc.documentElement && !doc.getElementsByTagName("parsererror").length) return { root: { local: "#doc", children: [domToTree(doc.documentElement)], attrs: [], text: "" }, via: "DOMParser" };
    } catch (e) { /* fall back */ }
  }
  return { root: parseXMLBuiltin(s), via: "builtin" };
}
function findAll(el, uri, local, out) { out = out || []; for (const c of el.children) { if (c.uri === uri && c.local === local) out.push(c); else findAll(c, uri, local, out); } return out; }
function prefixFor(ctx, uri, docPrefix) { return NSP[uri] || docPrefix || "ns" + (Object.keys(ctx.info.xmpNS || {}).length + 1); }
function xmpValue(el) {
  /* -> {k:'s', v} | {k:'l', items:[...] , alt} | {k:'r', fields:[{el, val}] } */
  const res = el.attrs.find(a => a.uri === RDF && a.local === "resource");
  if (res) return { k: "s", v: res.value };
  const kids = el.children;
  const pt = el.attrs.find(a => a.uri === RDF && a.local === "parseType");
  if (kids.length === 1 && kids[0].uri === RDF && /^(Seq|Bag|Alt)$/.test(kids[0].local)) {
    const items = kids[0].children.filter(c => c.uri === RDF && c.local === "li").map(li => Object.assign(xmpValue(li), { lang: (li.attrs.find(a => a.local === "lang") || {}).value }));
    return { k: "l", items, alt: kids[0].local === "Alt" };
  }
  if ((pt && pt.value === "Resource") || (kids.length && !(kids.length === 1 && kids[0].uri === RDF && kids[0].local === "Description"))) {
    if (kids.length) return { k: "r", fields: kids.map(c => ({ el: c, val: xmpValue(c) })).concat(el.attrs.filter(a => a.uri !== RDF && a.uri !== "http://www.w3.org/XML/1998/namespace").map(a => ({ el: a, val: { k: "s", v: a.value } }))) };
  }
  if (kids.length === 1 && kids[0].uri === RDF && kids[0].local === "Description") {
    const d = kids[0];
    return { k: "r", fields: d.attrs.filter(a => a.uri !== RDF && a.uri !== "http://www.w3.org/XML/1998/namespace").map(a => ({ el: a, val: { k: "s", v: a.value } })).concat(d.children.map(c => ({ el: c, val: xmpValue(c) }))) };
  }
  const props = el.attrs.filter(a => a.uri !== RDF && a.uri !== "http://www.w3.org/XML/1998/namespace");
  if (props.length && !el.text.trim()) return { k: "r", fields: props.map(a => ({ el: a, val: { k: "s", v: a.value } })) };
  return { k: "s", v: el.text.trim() };
}
function flattenXMP(val, out, path) {
  if (val.k === "s") { out.push([path, val.v]); return; }
  if (val.k === "l") {
    if (val.alt) { const def = val.items.find(x => x.lang === "x-default") || val.items[0]; if (def) flattenXMP(def, out, path); for (const it of val.items) if (it !== def && it.lang && it.k === "s") out.push([path, it.v, "-" + it.lang]); return; }
    if (val.items.every(x => x.k === "s")) { out.push([path, val.items.map(x => x.v)]); return; }
    const sub = {}; const order = [];
    for (const it of val.items) { const o2 = []; flattenXMP(it, o2, path); for (const [p, v, sfx] of o2) { const key = p.map(x => x.uri + "\u0001" + x.local).join("/") + (sfx || ""); if (!sub[key]) { sub[key] = { p, sfx, vals: [] }; order.push(key); } sub[key].vals.push(v); } }
    for (const key of order) { const x = sub[key]; out.push([x.p, x.vals.length === 1 ? x.vals[0] : x.vals, x.sfx]); }
    return;
  }
  for (const f of val.fields) flattenXMP(f.val, out, path.concat([f.el]));
}
async function parseXMP(ctx, bytes, offset, label) {
  if (++ctx.xmpCount > 32) return;
  let s;
  if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c))) s = utf16(bytes.subarray(bytes[0] === 0xfe ? 2 : 0), false);
  else if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0))) s = utf16(bytes.subarray(bytes[0] === 0xff ? 2 : 0), true);
  else s = utf8loose(bytes);
  s = s.replace(/^﻿/, "");
  const a = s.search(/<x:xmpmeta|<x:xapmeta|<rdf:RDF/);
  if (a < 0) { ctx.warn("xmp-parse", "no rdf:RDF in XMP" + (label ? " (" + label + ")" : ""), offset); return; }
  let b = s.search(/<\/x:xmpmeta>|<\/x:xapmeta>/);
  if (b > 0) { const close = s.slice(b).match(/^<\/x:x[am]pmeta>/)[0]; s = s.slice(a, b + close.length); }
  else { const e = s.lastIndexOf("</rdf:RDF>"); s = e > 0 ? s.slice(a, e + 10) : s.slice(a); }
  let parsed;
  try { parsed = parseXMLText(s, ctx.opts.xml); } catch (e) { ctx.warn("xmp-parse", e.message, offset); return; }
  ctx.info.xmlParser = parsed.via;
  const rdfs = findAll(parsed.root, RDF, "RDF");
  if (!rdfs.length) { ctx.warn("xmp-parse", "rdf:RDF not found", offset); return; }
  ctx.info.xmpNS = ctx.info.xmpNS || {};
  let count = 0;
  for (const rdf of rdfs) for (const d of rdf.children.filter(c => c.uri === RDF && c.local === "Description")) {
    const items = [];
    for (const at of d.attrs) { if (at.uri === RDF || at.uri === "http://www.w3.org/XML/1998/namespace" || !at.uri) continue; items.push([[at], at.value, ""]); }
    for (const c of d.children) { const out = []; flattenXMP(xmpValue(c), out, [c]); for (const x of out) items.push(x); }
    for (const [segs, v, langSuffix] of items) {
      if (!Array.isArray(segs) || !segs.length || !segs[0].uri) continue;
      const head = segs[0], p0 = prefixFor(ctx, head.uri, head.prefix);
      ctx.info.xmpNS[p0] = head.uri;
      const qn = p0 + ":" + head.local;
      let nm = XMP_NAME[qn] || ucfirst(head.local);
      for (let k = 1; k < segs.length; k++) nm += ucfirst(segs[k].local);
      const id = segs.map(x => prefixFor(ctx, x.uri, x.prefix) + ":" + x.local).join("/");
      const gid = "XMP:" + p0;
      const g = ctx.group(gid, NSP[head.uri] ? undefined : head.uri);
      if (!NSP[head.uri]) g.ns = head.uri;
      ctx.add(gid, { name: nm + (langSuffix || ""), id, value: v, display: Array.isArray(v) ? v.join(", ") : String(v), type: Array.isArray(v) ? "list" : "string", count: Array.isArray(v) ? v.length : 1, offset });
      count++;
      if (qn === "xmpNote:HasExtendedXMP") ctx.info.extXMPGuid = String(v);
    }
  }
  ctx.info.xmpTags = (ctx.info.xmpTags || 0) + count;
}

/* ---------------------------------------------------------------- ICC profile */
const ICC_TAGS = { desc: "ProfileDescription", cprt: "ProfileCopyright", wtpt: "MediaWhitePoint", bkpt: "MediaBlackPoint", rXYZ: "RedMatrixColumn", gXYZ: "GreenMatrixColumn",
  bXYZ: "BlueMatrixColumn", rTRC: "RedTRC", gTRC: "GreenTRC", bTRC: "BlueTRC", kTRC: "GrayTRC", chad: "ChromaticAdaptation", chrm: "Chromaticity", lumi: "Luminance", meas: "Measurement",
  tech: "Technology", vued: "ViewingCondDesc", view: "ViewingConditions", dmnd: "DeviceMfgDesc", dmdd: "DeviceModelDesc", A2B0: "AToB0", A2B1: "AToB1", A2B2: "AToB2", B2A0: "BToA0",
  B2A1: "BToA1", B2A2: "BToA2", gamt: "Gamut", cicp: "ColorRepresentation", MS00: "WCSProfiles" };
function parseICC(ctx, b, offset) {
  const g = "ICC_Profile";
  if (b.length < 132) { ctx.warn("icc", "ICC profile too short (" + b.length + " bytes)", offset); return; }
  const dv = DV(b), size = dv.getUint32(0, false);
  const fc = o => latin1(b, o, 4), t = (name, id, v, disp, type) => ctx.add(g, { name, id, value: v, display: disp == null ? undefined : disp, type: type || "", offset: offset + (typeof id === "number" ? id : 0) });
  t("ProfileCMMType", 4, fc(4).replace(/\0/g, "").trim());
  const ver = b[8] + "." + (b[9] >> 4) + "." + (b[9] & 15); t("ProfileVersion", 8, ver);
  const cls = fc(12); t("ProfileClass", 12, cls, E.ProfileClass[cls] || cls);
  t("ColorSpaceData", 16, fc(16), fc(16).trim()); t("ProfileConnectionSpace", 20, fc(20), fc(20).trim());
  const yy = [0, 1, 2, 3, 4, 5].map(k => dv.getUint16(24 + 2 * k, false));
  t("ProfileDateTime", 24, yy[0] + ":" + String(yy[1]).padStart(2, "0") + ":" + String(yy[2]).padStart(2, "0") + " " + yy.slice(3).map(x => String(x).padStart(2, "0")).join(":"));
  t("ProfileFileSignature", 36, fc(36));
  const pp = fc(40); t("PrimaryPlatform", 40, pp, pp === "\0\0\0\0" ? "Unknown ()" : (E.PrimaryPlatform[pp] || pp));
  const fl = dv.getUint32(44, false); t("CMMFlags", 44, fl, ((fl & 1) ? "Embedded" : "Not Embedded") + ", " + ((fl & 2) ? "Not Independent" : "Independent"));
  t("DeviceManufacturer", 48, fc(48).replace(/\0/g, "")); t("DeviceModel", 52, fc(52).replace(/\0/g, ""));
  const at = dv.getUint32(60, false); t("DeviceAttributes", 56, at, [(at & 1) ? "Transparency" : "Reflective", (at & 2) ? "Matte" : "Glossy", (at & 4) ? "Negative" : "Positive", (at & 8) ? "B&W" : "Color"].join(", "));
  const ri = dv.getUint32(64, false) & 0xffff; t("RenderingIntent", 64, ri, E.RenderingIntent[ri] || "Unknown (" + ri + ")");
  const s15 = o => dv.getInt32(o, false) / 65536;
  t("ConnectionSpaceIlluminant", 68, [s15(68), s15(72), s15(76)].map(x => rnd(x, 5)), [s15(68), s15(72), s15(76)].map(x => num(rnd(x, 5))).join(" "));
  t("ProfileCreator", 80, fc(80).replace(/\0/g, ""));
  t("ProfileID", 84, hexstr(b.subarray(84, 100)), /^0+$/.test(hexstr(b.subarray(84, 100))) ? "0" : hexstr(b.subarray(84, 100)));
  const nt = Math.min(dv.getUint32(128, false), 200);
  for (let i = 0; i < nt; i++) {
    const p = 132 + i * 12; if (p + 12 > b.length) { ctx.warn("icc", "tag table truncated", offset + p); break; }
    const sig = fc(p), to = dv.getUint32(p + 4, false), ts = dv.getUint32(p + 8, false);
    const name = ICC_TAGS[sig] || ("Tag '" + sig + "'");
    if (to + ts > b.length || ts < 8) { ctx.add(g, { name, id: "'" + sig + "'", value: null, display: "(bad offset)", offset: offset + to }); continue; }
    const d = b.subarray(to, to + ts), typ = latin1(d, 0, 4);
    let v = null, disp;
    try {
      if (typ === "desc") { const n = DV(d).getUint32(8, false); v = cstr(d.subarray(12, 12 + n)); }
      else if (typ === "mluc") { const nr = DV(d).getUint32(8, false), rs = DV(d).getUint32(12, false); let best = null; for (let k = 0; k < nr && k < 64; k++) { const q = 16 + k * rs, lang = latin1(d, q, 2), len = DV(d).getUint32(q + 4, false), off = DV(d).getUint32(q + 8, false); const str = utf16(d.subarray(off, off + len), false); if (!best || lang === "en") best = str; if (lang === "en") break; } v = best; }
      else if (typ === "text") v = cstr(d.subarray(8));
      else if (typ === "XYZ ") { const a = []; for (let k = 8; k + 12 <= d.length; k += 12) a.push(...[0, 4, 8].map(o2 => rnd(DV(d).getInt32(k + o2, false) / 65536, 5))); v = a; }
      else if (typ === "curv") { const n = DV(d).getUint32(8, false); if (n === 0) disp = "(linear)"; else if (n === 1) { v = DV(d).getUint16(12, false) / 256; disp = "gamma " + num(rnd(v, 4)); } else disp = "(" + n + "-point curve, " + ts + " bytes)"; }
      else if (typ === "para") { const ft = DV(d).getUint16(8, false), np = [1, 3, 4, 5, 7][ft] || 0, a = []; for (let k = 0; k < np; k++) a.push(rnd(DV(d).getInt32(12 + 4 * k, false) / 65536, 5)); v = a; disp = "parametric type " + ft + ": " + a.join(" "); }
      else if (typ === "sf32") { const a = []; for (let k = 8; k + 4 <= d.length; k += 4) a.push(rnd(DV(d).getInt32(k, false) / 65536, 5)); v = a; }
      else if (typ === "sig ") v = latin1(d, 8, 4);
      else disp = "(binary, " + ts + " bytes, type '" + typ + "')";
    } catch (e) { disp = "(unreadable '" + typ + "')"; }
    ctx.add(g, { name, id: "'" + sig + "'", value: v, display: disp != null ? disp : autoDisp(v), type: typ.trim(), count: ts, offset: offset + to });
  }
  if (size !== b.length) ctx.warn("icc", "profile size " + size + " vs " + b.length + " bytes read", offset);
  ctx.info.icc = (ctx.gmap.get(g).tags.find(x => x.name === "ProfileDescription") || {}).value || "ICC";
}

/* ---------------------------------------------------------------- IPTC IIM and Photoshop IRB */
const IPTC1 = { 0: "EnvelopeRecordVersion", 5: "Destination", 20: "FileFormat", 22: "FileVersion", 30: "ServiceIdentifier", 40: "EnvelopeNumber", 50: "ProductID", 60: "EnvelopePriority",
  70: "DateSent", 80: "TimeSent", 90: "CodedCharacterSet", 100: "UniqueObjectName", 120: "ARMIdentifier", 122: "ARMVersion" };
const IPTC2 = { 0: "ApplicationRecordVersion", 3: "ObjectTypeReference", 4: "ObjectAttributeReference", 5: "ObjectName", 7: "EditStatus", 8: "EditorialUpdate", 10: "Urgency",
  12: "SubjectReference", 15: "Category", 20: "SupplementalCategories", 22: "FixtureIdentifier", 25: "Keywords", 26: "ContentLocationCode", 27: "ContentLocationName", 30: "ReleaseDate",
  35: "ReleaseTime", 37: "ExpirationDate", 38: "ExpirationTime", 40: "SpecialInstructions", 42: "ActionAdvised", 45: "ReferenceService", 47: "ReferenceDate", 50: "ReferenceNumber",
  55: "DateCreated", 60: "TimeCreated", 62: "DigitalCreationDate", 63: "DigitalCreationTime", 65: "OriginatingProgram", 70: "ProgramVersion", 75: "ObjectCycle", 80: "By-line",
  85: "By-lineTitle", 90: "City", 92: "Sub-location", 95: "Province-State", 100: "Country-PrimaryLocationCode", 101: "Country-PrimaryLocationName", 103: "OriginalTransmissionReference",
  105: "Headline", 110: "Credit", 115: "Source", 116: "CopyrightNotice", 118: "Contact", 120: "Caption-Abstract", 121: "LocalCaption", 122: "Writer-Editor", 125: "RasterizedCaption",
  130: "ImageType", 131: "ImageOrientation", 135: "LanguageIdentifier", 150: "AudioType", 151: "AudioSamplingRate", 152: "AudioSamplingResolution", 153: "AudioDuration",
  154: "AudioOutcue", 184: "JobID", 185: "MasterDocumentID", 186: "ShortDocumentID", 187: "UniqueDocumentID", 188: "OwnerID", 200: "ObjectPreviewFileFormat",
  201: "ObjectPreviewFileVersion", 202: "ObjectPreviewData", 221: "Prefs", 225: "ClassifyState", 228: "SimilarityIndex", 230: "DocumentNotes", 231: "DocumentHistory",
  232: "ExifCameraInfo", 255: "CatalogSets" };
function parseIPTC(ctx, b, offset) {
  let p = 0, n = 0; const acc = new Map();
  while (p + 5 <= b.length && n++ < 5000) {
    if (b[p] !== 0x1c) { if (p === 0) ctx.warn("iptc", "no 0x1C tag marker", offset); break; }
    const rec = b[p + 1], ds = b[p + 2]; let len = u16be(b, p + 3), hdr = 5;
    if (len & 0x8000) { const ln = len & 0x7fff; if (ln > 4 || p + 5 + ln > b.length) break; len = 0; for (let k = 0; k < ln; k++) len = len * 256 + b[p + 5 + k]; hdr += ln; }
    const d = b.subarray(p + hdr, Math.min(b.length, p + hdr + len));
    if (p + hdr + len > b.length) ctx.warn("truncated", "IPTC " + rec + ":" + ds, offset + p);
    const tbl = rec === 1 ? IPTC1 : rec === 2 ? IPTC2 : null;
    const name = (tbl && tbl[ds]) || ("Tag " + rec + ":" + String(ds).padStart(3, "0"));
    let v;
    if ((rec === 1 && ds === 0) || (rec === 2 && ds === 0)) v = d.length >= 2 ? u16be(d, 0) : d[0];
    else if (rec === 1 && ds === 90) v = latin1(d) === "\x1b%G" ? "UTF8" : hexstr(d);
    else if (rec === 2 && ds === 202) v = null;
    else v = utf8(d);
    if (typeof v === "string") { if (/^(DateCreated|DigitalCreationDate|ReleaseDate|ExpirationDate|ReferenceDate|DateSent)$/.test(name) && /^\d{8}$/.test(v)) v = v.slice(0, 4) + ":" + v.slice(4, 6) + ":" + v.slice(6); else if (/Time/.test(name) && /^\d{6}([+-]\d{4})?$/.test(v)) v = v.slice(0, 2) + ":" + v.slice(2, 4) + ":" + v.slice(4, 6) + (v.length > 6 ? v.slice(6, 9) + ":" + v.slice(9) : ""); }
    const key = rec + ":" + ds;
    if (acc.has(key)) { const t = acc.get(key); t.value = [].concat(t.value, v); t.display = t.value.join(", "); t.count = t.value.length; }
    else { const t = ctx.add("IPTC", v === null ? { name, id: key, value: null, display: "(binary, " + d.length + " bytes)", type: "undef", count: d.length, offset: offset + p, binary: { offset: offset + p + hdr, length: d.length } } : { name, id: key, value: v, type: "string", count: 1, offset: offset + p }); acc.set(key, t); }
    p += hdr + len;
  }
}
const IRB_T = { 0x03ed: "ResolutionInfo", 0x03ee: "AlphaChannelsNames", 0x0404: "IPTCData", 0x0406: "JPEG_Quality", 0x0409: "PhotoshopBGRThumbnail", 0x040a: "CopyrightFlag",
  0x040b: "URL", 0x040c: "PhotoshopThumbnail", 0x040d: "GlobalAngle", 0x040f: "ICC_Profile", 0x0419: "GlobalAltitude", 0x041a: "SliceInfo", 0x041b: "WorkflowURL", 0x041e: "URL_List",
  0x0421: "VersionInfo", 0x0422: "EXIFInfo", 0x0424: "XMP", 0x0425: "IPTCDigest", 0x0426: "PrintScaleInfo", 0x0428: "PixelInfo", 0x0435: "ChannelOptions", 0x0bb7: "ClippingPathName" };
async function parseIRB(ctx, b, offset) {
  let p = 0, n = 0;
  while (p + 12 <= b.length && n++ < 2000) {
    const sig = latin1(b, p, 4);
    if (sig !== "8BIM" && sig !== "PHUT" && sig !== "DCSR" && sig !== "AgHg" && sig !== "MeSa") { if (n === 1) ctx.warn("irb", "no 8BIM signature", offset + p); break; }
    const id = u16be(b, p + 4), nl = b[p + 6]; let q = p + 7 + nl; if ((nl + 1) & 1) q++;
    if (q + 4 > b.length) break;
    const size = u32be(b, q), d = b.subarray(q + 4, Math.min(b.length, q + 4 + size)), abs = offset + q + 4;
    const name = IRB_T[id] || ("Tag " + hex(id));
    try {
      if (id === 0x0404) { ctx.seg("IPTC (8BIM 0x0404)", "iptc", abs, size, "", 1); ctx.add("Photoshop", { name, id: hex(id), value: null, display: "(IPTC, " + size + " bytes)", type: "undef", count: size, offset: abs }); parseIPTC(ctx, d, abs); }
      else if (id === 0x0424) { ctx.add("Photoshop", { name, id: hex(id), value: null, display: "(XMP, " + size + " bytes)", type: "undef", count: size, offset: abs }); await parseXMP(ctx, d, abs, "Photoshop"); }
      else if (id === 0x040f) { ctx.add("Photoshop", { name, id: hex(id), value: null, display: "(ICC, " + size + " bytes)", type: "undef", count: size, offset: abs }); parseICC(ctx, d, abs); }
      else if (id === 0x040c || id === 0x0409) { ctx.bin("Photoshop", name, hex(id), abs, size); if (size > 28) ctx.previews.push({ kind: name, offset: abs + 28, length: size - 28, mime: "image/jpeg" }); }
      else if (id === 0x0425) ctx.add("Photoshop", { name, id: hex(id), value: hexstr(d), type: "undef", count: size, offset: abs });
      else if (id === 0x040a || id === 0x0419 || id === 0x040d) ctx.add("Photoshop", { name, id: hex(id), value: id === 0x040a ? (d[0] ? "True" : "False") : (d.length >= 4 ? u32be(d, 0) : null), type: "int32u", count: 1, offset: abs });
      else if (id === 0x040b || id === 0x041b) ctx.add("Photoshop", { name, id: hex(id), value: utf8(d), type: "string", offset: abs });
      else ctx.bin("Photoshop", name, hex(id), abs, size);
    } catch (e) { ctx.warn("irb", name + ": " + e.message, abs); }
    p = q + 4 + size + (size & 1);
  }
}

/* ---------------------------------------------------------------- JPEG */
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const STD_LUM = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
function jpegQuality(q) { /* inverse of the IJG libjpeg quality scaling of the ITU-T T.81 Annex K luminance table */
  if (!q || q.length < 64) return null;
  let sum = 0, n = 0; const ss = [];
  for (let i = 0; i < 64; i++) { const s = 100 * q[i] / STD_LUM[ZZ[i]]; if (q[i] > 1 && q[i] < 255) { sum += s; n++; ss.push(s); } }
  if (!n) return { quality: 100, scale: 0, spread: 0 };
  const S = sum / n; let quality = S <= 100 ? (200 - S) / 2 : 5000 / S; quality = Math.max(1, Math.min(100, quality));
  const sd = Math.sqrt(ss.reduce((a, x) => a + (x - S) * (x - S), 0) / ss.length) / S;
  return { quality: Math.round(quality), scale: S, spread: sd };
}
async function parseJPEG(ctx) {
  const src = ctx.src, iccChunks = [], seen = { app: {} };
  let pos = 2, firstSOS = -1, eoi = -1, guard = 0, mpf = null;
  ctx.seg("SOI", "header", 0, 2, "");
  ctx.info.dqt = {};
  while (pos + 2 <= src.size && guard++ < 20000) {
    const h = await src.read(pos, 4);
    if (h[0] !== 0xff) {
      ctx.warn("jpeg-sync", "expected marker", pos);
      const b = await src.read(pos, 65536); let k = b.indexOf(0xff); if (k < 0) break; pos += k; continue;
    }
    const m = h[1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd8) { pos += 2; continue; }
    if (m === 0xd9) { eoi = pos; ctx.seg("EOI", "header", pos, 2, ""); pos += 2; break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { pos += 2; continue; }
    if (h.length < 4) { ctx.warn("truncated", "JPEG marker " + hex(0xff00 | m), pos); break; }
    const len = (h[2] << 8) | h[3];
    if (len < 2) { ctx.warn("jpeg-sync", "bad segment length", pos); break; }
    const segStart = pos, dOff = pos + 4, dLen = len - 2;
    if (dOff + dLen > src.size) ctx.warn("truncated", "JPEG segment " + hex(0xff00 | m), pos);
    const d = await src.read(dOff, dLen);
    let label = mName(m), kind = "other", note = "";
    try { const r = await jpegSegment(ctx, m, d, dOff, iccChunks, seen); if (r) { label = r.label || label; kind = r.kind || kind; note = r.note || ""; if (r.mpf) mpf = r.mpf; } }
    catch (err) { ctx.warn("segment", label + ": " + (err && err.message), segStart); }
    ctx.seg(label, kind, segStart, len + 2, note);
    pos = segStart + 2 + len;
    if (m === 0xda) {
      if (firstSOS < 0) firstSOS = pos;
      if (src.whole) { const b = src.whole; let p = pos; const L = b.length - 1; while (p < L) { if (b[p] === 0xff) { const nx = b[p + 1]; if (nx !== 0 && nx !== 0xff && !(nx >= 0xd0 && nx <= 0xd7)) break; } p++; } pos = p; if (p >= L) break; }
      else {
        let p = pos, found = false; const CH = 1 << 20;
        for (let k = 0; k < 256 && p < src.size; k++) { const b = await src.read(p, CH + 1); let j = 0; for (; j + 1 < b.length; j++) { if (b[j] === 0xff) { const nx = b[j + 1]; if (nx !== 0 && nx !== 0xff && !(nx >= 0xd0 && nx <= 0xd7)) { found = true; break; } } } p += j; if (found || b.length <= 1) break; }
        if (!found) { ctx.warn("large-file", "entropy-coded data not fully scanned", pos); break; }
        pos = p;
      }
    }
  }
  if (firstSOS >= 0) ctx.seg("image data (entropy-coded)", "image", firstSOS, (eoi >= 0 ? eoi : src.size) - firstSOS, "", 0);
  if (eoi < 0) ctx.warn("no-eoi", "EOI marker not found (file truncated?)", src.size);
  /* ICC profile chunks */
  if (iccChunks.length) {
    iccChunks.sort((a, b) => a.seq - b.seq);
    const tot = iccChunks[0].count;
    if (iccChunks.length !== tot) ctx.warn("icc", "ICC chunks " + iccChunks.length + " of " + tot, iccChunks[0].offset);
    const len = iccChunks.reduce((a, c) => a + c.data.length, 0), buf = new Uint8Array(len); let p = 0;
    for (const c of iccChunks) { buf.set(c.data, p); p += c.data.length; }
    parseICC(ctx, buf, iccChunks[0].offset);
  }
  /* FLIR FFF in APP1 */
  if (ctx.flirChunks) { try { flirFFF(ctx); } catch (e) { ctx.warn("flir", "FFF: " + ((e && e.message) || e), null); } }
  /* JUMBF / C2PA in APP11 */
  if (ctx.jpJUMBF) { try { await jpegJUMBF(ctx); } catch (e) { ctx.warn("jumbf", "APP11: " + ((e && e.message) || e), null); } }
  /* Extended XMP */
  for (const [guid, x] of ctx.extXMP) {
    const got = x.parts.reduce((a, c) => a + c.data.length, 0);
    if (got < x.full) ctx.warn("ext-xmp", "Extended XMP " + guid + ": " + got + " of " + x.full + " bytes", x.parts[0].offset);
    const buf = new Uint8Array(x.full); for (const c of x.parts) if (c.off + c.data.length <= x.full) buf.set(c.data, c.off);
    if (ctx.info.extXMPGuid && ctx.info.extXMPGuid !== guid) ctx.warn("ext-xmp", "GUID does not match HasExtendedXMP", x.parts[0].offset);
    await parseXMP(ctx, buf.subarray(0, got >= x.full ? x.full : got), x.parts[0].offset, "ExtendedXMP");
  }
  /* MPF images and trailer */
  const end = eoi >= 0 ? eoi + 2 : src.size;
  if (mpf && mpf.images.length) {
    mpf.images.forEach((im, k) => {
      if (k === 0 || !im.start) return;
      const off = mpf.base + im.start;
      if (off + im.length <= src.size) {
        const big = im.type >= 0x10001 && im.type <= 0x10005;
        ctx.seg("MPF image " + (k + 1) + (big ? " (preview)" : ""), "preview", off, im.length, E.MPImageType[im.type] || hex(im.type, 5), off >= end ? 0 : 1);
        ctx.previews.push({ kind: k === 1 ? "PreviewImage" : "MPImage" + (k + 1), offset: off, length: im.length, mime: "image/jpeg" });
        if (k === 1) ctx.add("MPF", { name: "PreviewImage", id: "MPImage2", value: null, display: "(binary, " + im.length + " bytes)", type: "undef", count: im.length, offset: off, binary: { offset: off, length: im.length } });
      } else ctx.warn("bad-offset", "MPF image " + (k + 1), off);
    });
  }
  if (end < src.size) {
    const tl = src.size - end, head = await src.read(end, 16);
    // an MPF image may follow zero padding: WingtraHub rewrites APP1 of Sony JPEGs and pads, so that the MPF offsets of the preview stay valid
    const nextMP = mpf ? mpf.images.filter(im => im.start).map(im => mpf.base + im.start).filter(o => o > end && o - end <= 65536).sort((a, b) => a - b)[0] : null;
    let pad = 0; if (nextMP != null) { const z = await src.read(end, nextMP - end); if (z.length === nextMP - end && z.every(x => x === 0)) pad = nextMP - end; }
    // DJI M3T (2026): the declared length of MPF image 1 reaches past its EOI, and the next MPF image starts right after that length;
    // the bytes between are part of image 1 by the MPF list, not an unknown trailer
    const len1 = mpf && mpf.images[0] && !mpf.images[0].start ? mpf.images[0].length : 0;
    const inside = !pad && nextMP != null && len1 && end < len1 && nextMP >= len1 && nextMP - len1 <= 16 ? nextMP - end : 0;
    const inMPF = mpf && (pad > 0 || inside > 0 || mpf.images.some(im => im.start && mpf.base + im.start === end));
    if (pad) ctx.seg("zero padding before MPF image", "trailer", end, pad, pad + " zero bytes");
    if (inside) ctx.seg("data after EOI within MPF image 1", "trailer", end, inside, inside + " bytes, counted in the MPF length of image 1");
    let note = pad ? "MPF image after " + pad + " zero bytes" : inside ? "MPF image after " + inside + " bytes within the MPF length of image 1" : "";
    let jo = -1; for (let i = 0; i + 2 < head.length; i++) if (head[i] === 0xff && head[i + 1] === 0xd8 && head[i + 2] === 0xff) { jo = i; break; }
    if (pad || inside) { /* note set above */ }
    else if (head[0] === 0xff && head[1] === 0xd8) note = inMPF ? "MPF image" : "JPEG";
    else if (jo > 0) note = "JPEG at +" + jo;
    else if (latin1(head, 4, 4) === "ftyp") note = "MP4 video (EmbeddedVideo)";
    else note = hexstr(head, 8);
    ctx.info.trailer = { offset: end, length: tl, note };
    if (!inMPF) ctx.seg("trailer after EOI", "trailer", end, tl, note);
    if (!inMPF) ctx.warn("trailer", tl + " bytes after EOI (" + note + ")", end);
  }
}
function mName(m) {
  if (m >= 0xe0 && m <= 0xef) return "APP" + (m - 0xe0);
  return ({ 0xc4: "DHT", 0xcc: "DAC", 0xda: "SOS", 0xdb: "DQT", 0xdd: "DRI", 0xfe: "COM", 0xdc: "DNL", 0xde: "DHP", 0xdf: "EXP" })[m] || (m >= 0xc0 && m <= 0xcf ? "SOF" + (m - 0xc0) : "marker " + hex(m, 2));
}
async function jpegSegment(ctx, m, d, dOff, iccChunks, seen) {
  const s16 = latin1(d, 0, 40);
  const make = (ctx.info.make || "").toUpperCase(), dji = make.startsWith("DJI");
  if (m === 0xe0) {
    if (s16.startsWith("JFIF\0")) {
      const g = "JFIF"; ctx.add(g, { name: "JFIFVersion", id: "0", value: d[5] + "." + String(d[6]).padStart(2, "0"), type: "int8u", offset: dOff + 5 });
      ctx.add(g, { name: "ResolutionUnit", id: "2", value: d[7], display: JFIF_RES[d[7]] || ("Unknown (" + d[7] + ")"), type: "int8u", offset: dOff + 7 });
      ctx.add(g, { name: "XResolution", id: "3", value: u16be(d, 8), type: "int16u", offset: dOff + 8 }); ctx.add(g, { name: "YResolution", id: "5", value: u16be(d, 10), type: "int16u", offset: dOff + 10 });
      if (d[12] || d[13]) { ctx.add(g, { name: "ThumbnailWidth", id: "7", value: d[12], type: "int8u" }); ctx.add(g, { name: "ThumbnailHeight", id: "8", value: d[13], type: "int8u" }); }
      return { label: "APP0 JFIF", kind: "jfif" };
    }
    if (s16.startsWith("JFXX\0")) { if (d[5] === 0x10) { ctx.bin("JFIF", "ThumbnailImage", "0x0010", dOff + 6, d.length - 6); ctx.previews.push({ kind: "JFXX ThumbnailImage", offset: dOff + 6, length: d.length - 6, mime: "image/jpeg" }); } return { label: "APP0 JFXX", kind: "thumb" }; }
    return { label: "APP0 " + s16.slice(0, 4).replace(/\0.*/, ""), note: "not decoded" };
  }
  if (m === 0xe1) {
    if (s16.startsWith("Exif\0")) { await readTIFF(ctx, dOff + 6, { depth: 1, headerSeg: null }); ctx.info.hasExif = true; return { label: "APP1 Exif", kind: "exif", note: (ctx.info.byteOrder || "") }; }
    if (s16.startsWith("http://ns.adobe.com/xap/1.0/\0")) { const o = 29; await parseXMP(ctx, d.subarray(o), dOff + o, "APP1"); return { label: "APP1 XMP", kind: "xmp", note: (d.length - o) + " bytes" }; }
    if (s16.startsWith("http://ns.adobe.com/xmp/extension/\0")) {
      const o = 35, guid = latin1(d, o, 32), full = u32be(d, o + 32), off = u32be(d, o + 36);
      if (!ctx.extXMP.has(guid)) ctx.extXMP.set(guid, { full: Math.min(full, LIM.bin), parts: [] });
      ctx.extXMP.get(guid).parts.push({ off, data: d.subarray(o + 40), offset: dOff + o + 40 });
      return { label: "APP1 ExtendedXMP", kind: "xmp", note: "GUID " + guid.slice(0, 8) + "…, offset " + off };
    }
    if (s16.startsWith("FLIR\0") && d.length >= 8) {
      ctx.info.flir = (ctx.info.flir || 0) + 1;
      const k = d[6], tot = d[7] + 1; /* chunk number and count - 1 (ExifTool) */
      if (!ctx.flirChunks) ctx.flirChunks = { total: tot, parts: [] };
      if (ctx.flirChunks.total === tot && k < tot && !ctx.flirChunks.parts[k]) ctx.flirChunks.parts[k] = { data: d.subarray(8), offset: dOff + 8 };
      else ctx.warn("flir", "FLIR chunk " + (k + 1) + " of " + tot + " ignored (duplicate or inconsistent count)", dOff - 4);
      return { label: "APP1 FLIR", kind: "thermal", note: "FFF chunk " + (k + 1) + "/" + tot };
    }
    return { label: "APP1 " + s16.slice(0, 12).replace(/[\0-\x1f].*/, ""), note: "not decoded" };
  }
  if (m === 0xe2) {
    if (s16.startsWith("ICC_PROFILE\0")) { iccChunks.push({ seq: d[12], count: d[13], data: d.subarray(14), offset: dOff + 14 }); return { label: "APP2 ICC_PROFILE", kind: "icc", note: "chunk " + d[12] + "/" + d[13] }; }
    if (s16.startsWith("MPF\0")) {
      const base = dOff + 4;
      await readTIFF(ctx, base, { table: "MPF", group: "MPF", single: true, noOrder: true, name: "MPF0", depth: 1 });
      const mpf = { base, images: [] };
      const g = ctx.gmap.get("MPF"), ent = g && g.tags.find(t => t.name === "MPImageList");
      const le = latin1(d, 4, 2) === "II";
      // up to 64 bytes (4 images) the list is stored as a value array, not as a binary reference
      const nb = !ent ? null : ent.binary ? await ctx.src.read(ent.binary.offset, ent.binary.length) : Array.isArray(ent.value) ? Uint8Array.from(ent.value) : null;
      if (nb) {
        for (let k = 0; k * 16 + 16 <= nb.length && k < 64; k++) {
          const dv = DV(nb), attr = dv.getUint32(k * 16, le), size = dv.getUint32(k * 16 + 4, le), start = dv.getUint32(k * 16 + 8, le);
          const im = { flags: attr >>> 27 & 0x1f, format: attr >>> 24 & 7, type: attr & 0xffffff, length: size, start, dep1: dv.getUint16(k * 16 + 12, le), dep2: dv.getUint16(k * 16 + 14, le) };
          mpf.images.push(im);
          const gg = "MPF:MPImage" + (k + 1), fl = [];
          if (im.flags & 4) fl.push("Representative image"); if (im.flags & 8) fl.push("Dependent child image"); if (im.flags & 16) fl.push("Dependent parent image");
          ctx.add(gg, { name: "MPImageFlags", id: "0.1", value: im.flags, display: fl.join(", ") || "(none)", type: "int32u" });
          ctx.add(gg, { name: "MPImageFormat", id: "0.2", value: im.format, display: E.MPImageFormat[im.format] || ("Unknown (" + im.format + ")"), type: "int32u" });
          ctx.add(gg, { name: "MPImageType", id: "0.3", value: im.type, display: E.MPImageType[im.type] || ("Unknown (" + hex(im.type, 5) + ")"), type: "int32u" });
          ctx.add(gg, { name: "MPImageLength", id: "4", value: size, type: "int32u" });
          ctx.add(gg, { name: "MPImageStart", id: "8", value: start, type: "int32u" });
          ctx.add(gg, { name: "DependentImage1EntryNumber", id: "12", value: im.dep1, type: "int16u" });
          ctx.add(gg, { name: "DependentImage2EntryNumber", id: "14", value: im.dep2, type: "int16u" });
        }
      }
      return { label: "APP2 MPF", kind: "mpf", mpf, note: mpf.images.length + " images" };
    }
    if (s16.startsWith("FPXR")) return { label: "APP2 FPXR", note: "FlashPix (not decoded)" };
    return { label: "APP2", note: "not decoded" };
  }
  if (m === 0xed) {
    if (s16.startsWith("Photoshop 3.0\0")) { await parseIRB(ctx, d.subarray(14), dOff + 14); return { label: "APP13 Photoshop", kind: "iptc" }; }
    return { label: "APP13", note: "not decoded" };
  }
  if (m === 0xee && s16.startsWith("Adobe")) {
    const g = "APP14"; ctx.add(g, { name: "DCTEncodeVersion", id: "0", value: u16be(d, 5), type: "int16u" }); ctx.add(g, { name: "APP14Flags0", id: "1", value: u16be(d, 7), type: "int16u" });
    ctx.add(g, { name: "APP14Flags1", id: "2", value: u16be(d, 9), type: "int16u" }); ctx.add(g, { name: "ColorTransform", id: "3", value: d[11], display: E.ColorTransform[d[11]] || ("Unknown (" + d[11] + ")"), type: "int8u" });
    return { label: "APP14 Adobe" };
  }
  if (m >= 0xe3 && m <= 0xe7) {
    const n = m - 0xe0;
    seen.app[n] = (seen.app[n] || 0) + 1;
    if (n === 3 && dji) { ctx.info.djiThermal = Object.assign(ctx.info.djiThermal || {}, { app3: ((ctx.info.djiThermal || {}).app3 || 0) + d.length }); return { label: "APP3 ThermalData", kind: "thermal", note: "DJI raw thermal data (not decoded)" }; }
    if (n === 4 && dji) { const P = djiThermalParams(ctx, d, dOff); ctx.info.djiThermal = Object.assign(ctx.info.djiThermal || {}, { app4: d.length, params: P }); return { label: "APP4 " + (P.variant || "ThermalParams"), kind: "thermal", note: P.variant ? "DJI measurement parameters" + (P.prefix ? ", prefix \"" + P.prefix + "\"" : "") : "DJI, layout not recognised (not decoded)" }; }
    if (n === 5 && dji) { ctx.info.djiThermal = Object.assign(ctx.info.djiThermal || {}, { app5: d.length }); return { label: "APP5 ThermalCalibration", kind: "thermal", note: "DJI calibration (not decoded; used by the DJI Thermal SDK)" }; }
    if (n === 6 && s16.startsWith("DJI_DTAT")) return { label: "APP6 DJI_DTAT", kind: "thermal", note: "DJI (not decoded)" };
    if (n === 6 && s16.startsWith("GoPro")) return { label: "APP6 GoPro", note: "GoPro GPMF (not decoded)" };
    if (n === 7 && s16.startsWith("DJI-DBG")) { const k = djiDebugInfo(ctx, d, dOff); return { label: "APP7 DJI-DBG", note: "DJI debug info, " + k + " entries" }; }
    return { label: "APP" + n + " " + s16.slice(0, 8).replace(/[\0-\x1f].*/, ""), note: "not decoded" };
  }
  if (m === 0xeb && d.length >= 8 && d[0] === 0x4a && d[1] === 0x50) { /* JPEG-XT box (ISO/IEC 18477-3): CI "JP", En, Z, then box data */
    const en = u16be(d, 2), z = u32be(d, 4);
    if (!ctx.jpJUMBF) ctx.jpJUMBF = new Map();
    if (!ctx.jpJUMBF.has(en)) { if (ctx.jpJUMBF.size >= 64) return { label: "APP11 JPEG-XT", note: "box instance " + en + " ignored" }; ctx.jpJUMBF.set(en, []); }
    const arr = ctx.jpJUMBF.get(en); if (arr.length < 65536) arr.push({ z, data: d.subarray(8), offset: dOff + 8, seg: dOff - 4 });
    return { label: "APP11 JPEG-XT", kind: "c2pa", note: "box instance " + en + ", sequence " + z + (z === 1 && d.length >= 16 ? ", " + latin1(d, 12, 4).replace(/[^\x20-\x7e]/g, "?") : "") };
  }
  if (m >= 0xe8 && m <= 0xef) return { label: "APP" + (m - 0xe0) + " " + s16.slice(0, 8).replace(/[\0-\x1f].*/, ""), note: "not decoded" };
  if (m === 0xfe) { const c = utf8(d).replace(/\0+$/, ""); ctx.add("File", { name: "Comment", id: "COM", value: c, type: "string", offset: dOff }); return { label: "COM", kind: "other", note: c.slice(0, 40) }; }
  if (m === 0xdb) {
    let p = 0;
    while (p < d.length) { const pq = d[p] >> 4, tq = d[p] & 15, n = pq ? 128 : 64; if (p + 1 + n > d.length) break; const q = []; for (let k = 0; k < 64; k++) q.push(pq ? u16be(d, p + 1 + 2 * k) : d[p + 1 + k]); ctx.info.dqt[tq] = q; p += 1 + n; }
    return { label: "DQT", kind: "header" };
  }
  if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
    if (ctx.info.sof) return { label: mName(m), kind: "header" };
    const bits = d[0], hgt = u16be(d, 1), wid = u16be(d, 3), nc = d[5], comps = [];
    for (let k = 0; k < nc && 6 + k * 3 + 2 < d.length; k++) comps.push({ id: d[6 + k * 3], h: d[7 + k * 3] >> 4, v: d[7 + k * 3] & 15, tq: d[8 + k * 3] });
    ctx.info.sof = { process: m - 0xc0, bits, width: wid, height: hgt, comps };
    const g = "File";
    ctx.add(g, { name: "EncodingProcess", id: "SOF" + (m - 0xc0), value: m - 0xc0, display: E.EncodingProcess[m - 0xc0], type: "int8u", offset: dOff - 4 });
    ctx.add(g, { name: "BitsPerSample", id: "SOF.0", value: bits, type: "int8u", offset: dOff });
    ctx.add(g, { name: "ImageHeight", id: "SOF.1", value: hgt, type: "int16u", offset: dOff + 1 });
    ctx.add(g, { name: "ImageWidth", id: "SOF.3", value: wid, type: "int16u", offset: dOff + 3 });
    ctx.add(g, { name: "ColorComponents", id: "SOF.5", value: nc, type: "int8u", offset: dOff + 5 });
    if (nc === 3 && comps.length === 3) {
      const hs = comps[0].h / Math.max(1, comps[1].h), vs = comps[0].v / Math.max(1, comps[1].v), key = hs + " " + vs;
      const YC = { "1 1": "YCbCr4:4:4 (1 1)", "1 2": "YCbCr4:4:0 (1 2)", "1 4": "YCbCr4:4:1 (1 4)", "2 1": "YCbCr4:2:2 (2 1)", "2 2": "YCbCr4:2:0 (2 2)", "2 4": "YCbCr4:2:1 (2 4)", "4 1": "YCbCr4:1:1 (4 1)", "4 2": "YCbCr4:1:0 (4 2)" };
      ctx.add(g, { name: "YCbCrSubSampling", id: "SOF.comp", value: [hs, vs], display: YC[key] || key, type: "int8u" });
    }
    return { label: mName(m), kind: "header", note: wid + "x" + hgt };
  }
  return { label: mName(m), kind: "header" };
}

/* ---------------------------------------------------------------- thermal: DJI R-JPEG APP4 / APP7, FLIR FFF in APP1 */
/* DJI APP4 holds the measurement parameters set in the camera. Three layouts, told apart as ExifTool does (DJI.pm, ExifTool.pm):
   "ThermalParams" (ZH20T, magic aa551206, int16u values, scale not documented), "ThermalParams2" (M3T and others: floats, after an optional 32-byte prefix,
   recognised by 2c 01 20 00 at +32), "ThermalParams3" (magic aa553800 after a 32-byte prefix, int16u scaled by 10 or 100). */
function djiThermalParams(ctx, d, dOff) {
  const g = "APP4:DJI", dv = DV(d), L = d.length;
  const f32 = o => o + 4 <= L ? dv.getFloat32(o, true) : null, u16 = o => o + 2 <= L ? dv.getUint16(o, true) : null;
  const put = (name, o, value, display, type) => { if (value != null) ctx.add(g, { name, id: hex(o, 2), value, display: display == null ? undefined : display, type, offset: dOff + o }); };
  const at = (o, s) => s.every((x, k) => d[o + k] === x);
  const P = { variant: null, emissivity: null, distance: null, rh: null, reflected: null, ambient: null, prefix: null };
  const prefix = b => { if (b !== 32) return; const s = latin1(d, 4, 4); if (/^[a-z]{4}$/.test(s)) { P.prefix = s; ctx.add(g, { name: "ThermalParamsPrefix", id: "0x00", value: s, display: hexstr(d, 4) + ' "' + s + '"', type: "undef", count: 32, offset: dOff, note: "32-byte prefix before the parameters; meaning not documented" }); } };
  if (L >= 0x4e && at(0, [0xaa, 0x55, 0x12, 0x06])) {
    P.variant = "ThermalParams";
    for (const [o, n] of [[0x24, "K1"], [0x28, "K2"], [0x2c, "K3"], [0x30, "K4"], [0x34, "KF"], [0x38, "B1"], [0x3c, "B2"]]) put(n, o, f32(o), null, "float");
    for (const [o, n] of [[0x44, "ObjectDistance"], [0x46, "RelativeHumidity"], [0x48, "Emissivity"], [0x4a, "Reflection"], [0x4c, "AmbientTemperature"]]) put(n, o, u16(o), null, "int16u");
    P.raw = true; /* scale of these int16u values is not documented: shown, not used */
  } else if ((L >= 68 && at(64, [0x2c, 0x01, 0x20, 0x00])) || (L >= 36 && at(32, [0x2c, 0x01, 0x20, 0x00]))) {
    const b = L >= 68 && at(64, [0x2c, 0x01, 0x20, 0x00]) ? 32 : 0; P.variant = "ThermalParams2"; prefix(b);
    P.ambient = f32(b); P.distance = f32(b + 4); P.emissivity = f32(b + 8); const rh = f32(b + 12); P.rh = rh != null ? rh * 100 : null; P.reflected = f32(b + 16);
    put("AmbientTemperature", b, P.ambient, P.ambient != null ? P.ambient.toFixed(1) + " C" : null, "float");
    put("ObjectDistance", b + 4, P.distance, P.distance != null ? P.distance.toFixed(1) + " m" : null, "float");
    put("Emissivity", b + 8, P.emissivity, P.emissivity != null ? P.emissivity.toFixed(2) : null, "float");
    put("RelativeHumidity", b + 12, rh, rh != null ? num(rnd(rh * 100, 4)) + " %" : null, "float");
    put("ReflectedTemperature", b + 16, P.reflected, P.reflected != null ? P.reflected.toFixed(1) + " C" : null, "float");
    if (b + 0x65 + 16 <= L) { const s = cstr(d.subarray(b + 0x65, b + 0x65 + 16)); if (s) put("IDString", b + 0x65, s, s, "string"); }
  } else if (L >= 44 && at(32, [0xaa, 0x55, 0x38, 0x00])) {
    const b = 32; P.variant = "ThermalParams3"; prefix(b);
    P.rh = u16(b + 4); P.distance = u16(b + 6) / 10; P.emissivity = u16(b + 8) / 100; P.reflected = u16(b + 10) / 10;
    put("RelativeHumidity", b + 4, P.rh, P.rh + " %", "int16u"); put("ObjectDistance", b + 6, P.distance, num(P.distance) + " m", "int16u");
    put("Emissivity", b + 8, P.emissivity, P.emissivity.toFixed(2), "int16u"); put("ReflectedTemperature", b + 10, P.reflected, P.reflected.toFixed(1) + " C", "int16u");
  }
  for (const k of ["emissivity", "distance", "rh", "reflected", "ambient"]) if (P[k] != null && !isFinite(P[k])) P[k] = null;
  return P;
}
/* DJI APP7 "DJI-DBG\0" followed by [key:value] pairs (the M3T writes only sensor_id) */
function djiDebugInfo(ctx, d, dOff) {
  const s = latin1(d, 8), re = /\[([^:\]]{1,64}):([^\]]*)\]/g, NAMES = { sensor_id: "SensorID" }; let m, n = 0;
  while ((m = re.exec(s)) && n++ < 64) {
    const raw = m[2], v = raw.replace(/\0+$/, ""), printable = /^[\x20-\x7e]*$/.test(v);
    ctx.add("APP7:DJI", { name: NAMES[m[1]] || m[1].replace(/[^A-Za-z0-9]/g, "_"), id: m[1], value: printable ? v : null, display: printable ? v : "(binary, " + raw.length + " bytes)", type: "string", offset: dOff + 8 + m.index + m[1].length + 2 });
  }
  return n;
}
/* FLIR FFF: the APP1 "FLIR\0" chunks are joined in chunk order, then the FFF header, the record directory and the RawData and CameraInfo records are read
   (layout as in ExifTool FLIR.pm). Temperatures are not computed; the Planck constants and measurement parameters are the inputs for that. */
function flirFFF(ctx) {
  const F = ctx.flirChunks; if (!F || !F.parts.length) return;
  let have = 0; for (let i = 0; i < F.total; i++) if (F.parts[i]) have++;
  if (have !== F.total) { ctx.warn("flir", "FLIR chunks " + have + " of " + F.total + ": FFF not read", (F.parts.find(Boolean) || {}).offset); return; }
  const len = F.parts.reduce((a, p) => a + p.data.length, 0), b = new Uint8Array(len); let p0 = 0;
  for (const p of F.parts) { p.start = p0; b.set(p.data, p0); p0 += p.data.length; }
  const fileOff = o => { for (const p of F.parts) if (o >= p.start && o < p.start + p.data.length) return p.offset + (o - p.start); return null; };
  const g = "APP1:FLIR";
  if (len < 0x40 || !/^[AF]FF\0/.test(latin1(b, 0, 4))) { ctx.warn("flir", "FLIR data without FFF header", F.parts[0].offset); return; }
  const dv = DV(b); let le = false;
  const ver = dv.getUint32(0x14, false); if (!(ver >= 100 && ver < 200)) { le = true; const v2 = dv.getUint32(0x14, true); if (!(v2 >= 100 && v2 < 200)) { ctx.warn("flir", "unsupported FFF version", F.parts[0].offset); return; } }
  const creator = cstr(b.subarray(4, 20)); if (creator) ctx.add(g, { name: "CreatorSoftware", id: "4", value: creator, type: "string", offset: fileOff(4) });
  const dirOff = dv.getUint32(0x18, le), nRec = dv.getUint32(0x1c, le);
  if (nRec > 1024 || dirOff + nRec * 32 > len) { ctx.warn("flir", "FFF record directory out of range", fileOff(0x18)); return; }
  const out = { creator, records: [] };
  for (let i = 0; i < nRec; i++) {
    const e = dirOff + i * 32, type = dv.getUint16(e, le); if (!type) continue;
    const ro = dv.getUint32(e + 12, le), rl = dv.getUint32(e + 16, le); out.records.push(type);
    if (ro + rl > len) { ctx.warn("flir", "FFF record " + hex(type, 2) + " out of range", fileOff(e)); continue; }
    const r = b.subarray(ro, ro + rl), rv = DV(r);
    if (type === 0x01 && rl >= 32) { /* RawData */
      const rle = rv.getUint16(0, true) < 0x100, w = rv.getUint16(2, rle), h = rv.getUint16(4, rle), data = r.subarray(32);
      const kind = latin1(data, 0, 8) === "\x89PNG\r\n\x1a\n" ? "PNG" : data[0] === 0xff && data[1] === 0xd8 ? "JPG" : data.length === w * h * 2 ? (rle ? "TIFF" : "raw big-endian") : "DAT";
      ctx.add(g, { name: "RawThermalImageWidth", id: "RawData.1", value: w, type: "int16u", offset: fileOff(ro + 2) });
      ctx.add(g, { name: "RawThermalImageHeight", id: "RawData.2", value: h, type: "int16u", offset: fileOff(ro + 4) });
      ctx.add(g, { name: "RawThermalImageType", id: "RawData.16", value: kind, display: kind === "TIFF" ? "TIFF (16-bit raw, little-endian; ExifTool adds a TIFF header)" : kind, type: "undef" });
      ctx.add(g, { name: "RawThermalImage", id: "RawData.16.1", value: null, display: "(binary, " + data.length + " bytes)", type: "undef", count: data.length, offset: fileOff(ro + 32) });
      out.raw = { w, h, kind, bytes: data.length };
    } else if (type === 0x20 && rl >= 0x100) { /* CameraInfo */
      const cle = rv.getUint16(0, true) < 0x100, has = (o, n) => o + n <= rl;
      const fl = o => has(o, 4) ? rv.getFloat32(o, cle) : null, K = o => { const v = fl(o); return v == null ? null : v - 273.15; };
      const C = {}, put = (name, o, value, display, type) => { if (value == null || (typeof value === "number" && !isFinite(value))) return; C[name] = value; ctx.add(g, { name, id: "CameraInfo." + hex(o, 3), value, display: display == null ? undefined : display, type, offset: fileOff(ro + o) }); };
      const kel = (n, o) => { const v = K(o); put(n, o, v, v != null ? v.toFixed(1) + " C" : null, "float"); };
      put("Emissivity", 0x20, fl(0x20), fl(0x20) != null ? fl(0x20).toFixed(2) : null, "float");
      put("ObjectDistance", 0x24, fl(0x24), fl(0x24) != null ? fl(0x24).toFixed(2) + " m" : null, "float");
      kel("ReflectedApparentTemperature", 0x28); kel("AtmosphericTemperature", 0x2c); kel("IRWindowTemperature", 0x30);
      put("IRWindowTransmission", 0x34, fl(0x34), fl(0x34) != null ? fl(0x34).toFixed(2) : null, "float");
      { let rh = fl(0x3c); if (rh != null && rh > 2) rh /= 100; put("RelativeHumidity", 0x3c, rh, rh != null ? (rh * 100).toFixed(1) + " %" : null, "float"); }
      for (const [o, n] of [[0x58, "PlanckR1"], [0x5c, "PlanckB"], [0x60, "PlanckF"]]) put(n, o, fl(o), fl(o) != null ? num(fl(o), 8) : null, "float");
      for (const [o, n] of [[0x70, "AtmosphericTransAlpha1"], [0x74, "AtmosphericTransAlpha2"], [0x78, "AtmosphericTransBeta1"], [0x7c, "AtmosphericTransBeta2"], [0x80, "AtmosphericTransX"]]) put(n, o, fl(o), fl(o) != null ? fl(o).toFixed(6) : null, "float");
      kel("CameraTemperatureRangeMax", 0x90); kel("CameraTemperatureRangeMin", 0x94);
      for (const [o, n, k] of [[0xd4, "CameraModel", 32], [0xf4, "CameraPartNumber", 16], [0x104, "CameraSerialNumber", 16], [0x114, "CameraSoftware", 16], [0x170, "LensModel", 32]]) if (has(o, k)) { const s = cstr(r.subarray(o, o + k)); if (s) put(n, o, s, s, "string"); }
      if (has(0x1b4, 4) && fl(0x1b4)) put("FieldOfView", 0x1b4, fl(0x1b4), fl(0x1b4).toFixed(1) + " deg", "float");
      if (has(0x308, 4)) put("PlanckO", 0x308, rv.getInt32(0x308, cle), null, "int32s");
      if (has(0x30c, 4)) put("PlanckR2", 0x30c, fl(0x30c), num(fl(0x30c), 8), "float");
      if (has(0x33c, 2)) { put("RawValueMedian", 0x338, rv.getUint16(0x338, cle), null, "int16u"); put("RawValueRange", 0x33c, rv.getUint16(0x33c, cle), null, "int16u"); }
      if (has(0x464, 2)) put("FrameRate", 0x464, rv.getUint16(0x464, cle), null, "int16u");
      out.cam = C;
    }
  }
  ctx.info.flirFFF = out;
}

/* ---------------------------------------------------------------- TIFF LZW (TIFF 6.0 section 13, MSB-first codes, early change) */
function lzwDecode(d, max) {
  const out = new Uint8Array(max); let o = 0, bit = 0, w = 9, prev = -1; const nbits = d.length * 8;
  let tab = []; const reset = () => { tab = []; for (let i = 0; i < 256; i++) tab.push(Uint8Array.of(i)); tab.push(null, null); w = 9; };
  reset();
  while (bit + w <= nbits && o < max) {
    const b0 = bit >> 3, v = ((d[b0] << 16) | ((d[b0 + 1] || 0) << 8) | (d[b0 + 2] || 0)) >>> 0, code = (v >>> (24 - (bit & 7) - w)) & ((1 << w) - 1); bit += w;
    if (code === 256) { reset(); prev = -1; continue; } if (code === 257) break;
    let e;
    if (prev < 0) e = tab[code];
    else if (code < tab.length) { e = tab[code]; const p = tab[prev], n = new Uint8Array(p.length + 1); n.set(p); n[p.length] = e[0]; tab.push(n); }
    else { const p = tab[prev]; e = new Uint8Array(p.length + 1); e.set(p); e[p.length] = p[0]; tab.push(e); }
    if (!e) break;
    out.set(e.subarray(0, Math.min(e.length, max - o)), o); o += e.length; prev = code;
    if (tab.length + 1 >= (1 << w) && w < 12) w++;
  }
  return out.subarray(0, Math.min(o, max));
}
/* statistics of a single-band 16-bit integer or 32-bit float TIFF (thermal images converted to TIFF); strips only, at most 64 Mpx */
async function bandStats(ctx) {
  const R = ctx.raster; if (!R || R.tiled || R.samplesPerPixel !== 1 || !R.offsets || !R.offsets.length || !R.complete) return null;
  const bits = Array.isArray(R.bitsPerSample) ? R.bitsPerSample[0] : R.bitsPerSample, sf = R.sampleFormat;
  const kind = bits === 16 && sf !== 3 ? (sf === 2 ? "int16" : "uint16") : bits === 32 && sf === 3 ? "float32" : null;
  if (!kind || !(R.compression === 1 || R.compression === 5 || R.compression === 8 || R.compression === 32946) || !(R.predictor === 1 || (R.predictor === 2 && kind !== "float32"))) return null;
  const W = R.width, H = R.height, bpp = bits / 8; if (!W || !H || W * H > 64e6) return null;
  const buf = new Uint8Array(W * H * bpp); let o = 0;
  for (let k = 0; k < R.offsets.length && o < buf.length; k++) {
    let d = await ctx.src.read(R.offsets[k], R.byteCounts[k]);
    if (R.compression === 8 || R.compression === 32946) { d = await inflate(d); if (!d) return null; }
    else if (R.compression === 5) d = lzwDecode(d, Math.min(buf.length - o, (R.rowsPerStrip || H) * W * bpp));
    buf.set(d.subarray(0, Math.min(d.length, buf.length - o)), o); o += d.length;
  }
  if (o < buf.length) return null;
  const dv = new DataView(buf.buffer), le = R.littleEndian, n = W * H; let mn = Infinity, mx = -Infinity, sum = 0, nan = 0; const hist = new Array(16).fill(0);
  let prevRow = 0;
  for (let i = 0; i < n; i++) {
    let v = kind === "float32" ? dv.getFloat32(i * 4, le) : kind === "int16" ? dv.getInt16(i * 2, le) : dv.getUint16(i * 2, le);
    if (R.predictor === 2) { if (i % W) { v = (v + prevRow) & 0xffff; if (kind === "int16" && v > 32767) v -= 65536; dv.setUint16(i * 2, v & 0xffff, le); } prevRow = v & 0xffff; }
    if (!isFinite(v)) { nan++; continue; }
    if (v < mn) mn = v; if (v > mx) mx = v; sum += v; if (kind === "uint16") hist[v >> 12]++;
  }
  const st = { kind, width: W, height: H, min: mn, max: mx, mean: n - nan ? sum / (n - nan) : null, nan };
  if (kind === "uint16") { st.hist = hist; const f = a => a.reduce((x, y) => x + y, 0) / n; st.wrap = f(hist.slice(0, 2)) > 0.02 && f(hist.slice(14)) > 0.02 && f(hist.slice(5, 11)) < 0.005; }
  return st;
}
/* ---------------------------------------------------------------- zlib inflate via DecompressionStream */
async function inflate(b) {
  if (typeof G.DecompressionStream !== "function") return null;
  try {
    const ds = new G.DecompressionStream("deflate"), w = ds.writable.getWriter();
    w.write(b).catch(() => {}); w.close().catch(() => {});
    const r = ds.readable.getReader(), parts = []; let n = 0;
    for (;;) { const { value, done } = await r.read(); if (done) break; parts.push(value); n += value.length; if (n > LIM.bin) { try { r.cancel(); } catch (e) { /* ignore */ } break; } }
    const out = new Uint8Array(n); let p = 0; for (const x of parts) { out.set(x.subarray(0, Math.min(x.length, n - p)), p); p += x.length; if (p >= n) break; }
    return out;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- PNG */
const PNG_TXT = { Artist: "Artist", Author: "Author", Collection: "Collection", Comment: "Comment", Copyright: "Copyright", "Creation Time": "CreationTime", Description: "Description",
  Disclaimer: "Disclaimer", Document: "Document", Label: "Label", Make: "Make", Model: "Model", Software: "Software", Source: "Source", TimeStamp: "TimeStamp", Title: "Title", URL: "URL",
  Warning: "PNGWarning", "create-date": "CreateDate", "modify-date": "ModDate", parameters: "Parameters" };
async function pngText(ctx, kw, text, off, type) {
  if (kw === "XML:com.adobe.xmp") { ctx.add("PNG", { name: "XMP", id: type + ":" + kw, value: null, display: "(XMP, " + text.length + " chars)", type: "string", offset: off }); await parseXMP(ctx, new TextEncoder().encode(text), off, "PNG " + type); return "xmp"; }
  const m = /^Raw profile type (\w+)$/i.exec(kw);
  if (m) {
    const parts = text.trim().split(/\n/), hexs = parts.slice(2).join("").replace(/\s+/g, ""), bytes = new Uint8Array(Math.floor(hexs.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexs.substr(2 * i, 2), 16);
    const kind = m[1].toLowerCase();
    ctx.add("PNG", { name: ({ exif: "EXIF_Profile", app1: "APP1_Profile", xmp: "XMP_Profile", iptc: "IPTC_Profile", "8bim": "Photoshop_Profile", icc: "ICC_Profile", icm: "ICC_Profile" })[kind] || ("Tag " + kw), id: type + ":" + kw, value: null, display: "(" + bytes.length + " bytes, hex text)", type: "string", offset: off });
    if (kind === "exif" || kind === "app1") { const o = latin1(bytes, 0, 6) === "Exif\0\0" ? 6 : 0; await tiffFromBytes(ctx, bytes.subarray(o), off); }
    else if (kind === "xmp") await parseXMP(ctx, bytes, off, "PNG raw profile");
    else if (kind === "iptc") parseIPTC(ctx, bytes, off);
    else if (kind === "8bim") await parseIRB(ctx, bytes, off);
    else if (kind === "icc" || kind === "icm") parseICC(ctx, bytes, off);
    return kind === "xmp" ? "xmp" : kind === "icc" || kind === "icm" ? "icc" : "exif";
  }
  ctx.add("PNG", { name: PNG_TXT[kw] || ucfirst(kw.replace(/[^A-Za-z0-9]+(.)?/g, (a, c) => c ? c.toUpperCase() : "")) || "Tag", id: type + ":" + kw, value: text, type: "string", offset: off });
  return "text";
}
async function tiffFromBytes(ctx, bytes, absOff) {
  /* parse a TIFF structure that lives in decoded bytes (PNG zTXt/iTXt hex profiles): temporary memory source, offsets reported relative to the chunk */
  const saved = ctx.src; ctx.src = memSource(bytes);
  try { await readTIFF(ctx, 0, { depth: 1 }); } finally { ctx.src = saved; }
}
async function parsePNG(ctx) {
  const src = ctx.src; let pos = 8, n = 0, idat = null;
  ctx.seg("PNG signature", "header", 0, 8, "");
  while (pos + 8 <= src.size && n++ < LIM.boxes) {
    const h = await src.read(pos, 8), len = u32be(h, 0), type = latin1(h, 4, 4), dOff = pos + 8;
    if (!/^[A-Za-z]{4}$/.test(type)) { ctx.warn("png", "bad chunk type", pos); break; }
    if (dOff + len + 4 > src.size) ctx.warn("truncated", "PNG chunk " + type, pos);
    let kind = "other", note = "";
    const needs = type !== "IDAT" && type !== "fdAT" && len <= LIM.bin;
    const d = needs ? await src.read(dOff, len) : null;
    try {
      if (type === "IHDR") { const g = "PNG"; ctx.add(g, { name: "ImageWidth", id: "IHDR.0", value: u32be(d, 0), type: "int32u", offset: dOff }); ctx.add(g, { name: "ImageHeight", id: "IHDR.4", value: u32be(d, 4), type: "int32u", offset: dOff + 4 });
        ctx.add(g, { name: "BitDepth", id: "IHDR.8", value: d[8], type: "int8u" }); ctx.add(g, { name: "ColorType", id: "IHDR.9", value: d[9], display: E.ColorType[d[9]] || "Unknown (" + d[9] + ")", type: "int8u" });
        ctx.add(g, { name: "Compression", id: "IHDR.10", value: d[10], display: d[10] === 0 ? "Deflate/Inflate" : "Unknown (" + d[10] + ")", type: "int8u" }); ctx.add(g, { name: "Filter", id: "IHDR.11", value: d[11], display: d[11] === 0 ? "Adaptive" : "Unknown (" + d[11] + ")", type: "int8u" });
        ctx.add(g, { name: "Interlace", id: "IHDR.12", value: d[12], display: E.Interlace[d[12]] || "Unknown (" + d[12] + ")", type: "int8u" }); ctx.info.png = { width: u32be(d, 0), height: u32be(d, 4), bitDepth: d[8], colorType: d[9] }; kind = "header"; }
      else if (type === "IDAT") { if (idat && idat.end === pos) { idat.length += len + 12; idat.count++; idat.end = dOff + len + 4; } else { idat = { offset: pos, length: len + 12, count: 1, end: dOff + len + 4 }; ctx.seg("IDAT", "image", pos, 0, ""); idat.ref = ctx.structure[ctx.structure.length - 1]; } idat.ref.length = idat.length; idat.ref.note = idat.count + " chunks"; pos = dOff + len + 4; continue; }
      else if (type === "tEXt") { const z = d.indexOf(0); kind = await pngText(ctx, latin1(d, 0, z), latin1(d, z + 1), dOff, "tEXt") === "xmp" ? "xmp" : "text"; note = latin1(d, 0, Math.min(z, 30)); }
      else if (type === "zTXt") { const z = d.indexOf(0), kw = latin1(d, 0, z), inf = await inflate(d.subarray(z + 2)); if (inf) kind = await pngText(ctx, kw, latin1(inf), dOff, "zTXt"); else { ctx.add("PNG", { name: PNG_TXT[kw] || kw, id: "zTXt:" + kw, value: null, display: "(compressed, " + (len - z - 2) + " bytes)", offset: dOff }); ctx.warn("inflate", "zTXt " + kw, dOff); } note = kw; }
      else if (type === "iTXt") {
        const z = d.indexOf(0), kw = utf8(d.subarray(0, z)), cf = d[z + 1], z2 = d.indexOf(0, z + 3), z3 = d.indexOf(0, z2 + 1);
        let tb = d.subarray(z3 + 1); if (cf) { const inf = await inflate(tb); if (!inf) { ctx.warn("inflate", "iTXt " + kw, dOff); tb = null; } else tb = inf; }
        if (tb) { const r = await pngText(ctx, kw, utf8loose(tb), dOff, "iTXt"); kind = r === "xmp" ? "xmp" : "text"; } note = kw;
      }
      else if (type === "eXIf" || type === "zxIf") { const o = latin1(d, 0, 6) === "Exif\0\0" ? 6 : 0; await readTIFF(ctx, dOff + o, { depth: 1 }); kind = "exif"; }
      else if (type === "iCCP") { const z = d.indexOf(0), nm = latin1(d, 0, z); ctx.add("PNG", { name: "ProfileName", id: "iCCP-name", value: nm, type: "string", offset: dOff }); const inf = await inflate(d.subarray(z + 2)); if (inf) parseICC(ctx, inf, dOff); else ctx.warn("inflate", "iCCP", dOff); kind = "icc"; }
      else if (type === "pHYs") { ctx.add("PNG", { name: "PixelsPerUnitX", id: "pHYs.0", value: u32be(d, 0), type: "int32u", offset: dOff }); ctx.add("PNG", { name: "PixelsPerUnitY", id: "pHYs.4", value: u32be(d, 4), type: "int32u" }); ctx.add("PNG", { name: "PixelUnits", id: "pHYs.8", value: d[8], display: E.PixelUnits[d[8]] || "Unknown (" + d[8] + ")", type: "int8u" }); }
      else if (type === "tIME") ctx.add("PNG", { name: "ModifyDate", id: "tIME", value: u16be(d, 0) + ":" + [d[2], d[3]].map(x => String(x).padStart(2, "0")).join(":") + " " + [d[4], d[5], d[6]].map(x => String(x).padStart(2, "0")).join(":"), type: "int8u", offset: dOff });
      else if (type === "gAMA") ctx.add("PNG", { name: "Gamma", id: "gAMA", value: rnd(100000 / u32be(d, 0), 4), type: "int32u", offset: dOff });
      else if (type === "cHRM") { const a = []; for (let k = 0; k < 8; k++) a.push(u32be(d, 4 * k) / 100000); ctx.add("PNG", { name: "PrimaryChromaticities", id: "cHRM", value: a, type: "int32u", offset: dOff }); }
      else if (type === "sRGB") ctx.add("PNG", { name: "SRGBRendering", id: "sRGB", value: d[0], display: ["Perceptual", "Relative Colorimetric", "Saturation", "Absolute Colorimetric"][d[0]] || "Unknown (" + d[0] + ")", type: "int8u", offset: dOff });
      else if (type === "IEND") { ctx.seg("IEND", "header", pos, 12, ""); pos = dOff + len + 4; break; }
      else if (type === "caBX") { kind = "c2pa"; ctx.bin("PNG", "JUMBF", "caBX", dOff, len); if (d) { const r = await c2paRead(ctx, d, p => dOff + p, "PNG caBX chunk", 1); note = r.label === "c2pa" ? "C2PA manifest store" : "JUMBF"; } }
      else if (type === "acTL") ctx.add("PNG", { name: "AnimationControl", id: "acTL", value: [u32be(d, 0), u32be(d, 4)], display: u32be(d, 0) + " frames, " + u32be(d, 4) + " plays", type: "int32u", offset: dOff });
      else note = "not decoded";
    } catch (e) { ctx.warn("png", type + ": " + e.message, pos); }
    ctx.seg(type, kind, pos, len + 12, note);
    pos = dOff + len + 4;
  }
  if (pos < src.size) { ctx.seg("data after IEND", "trailer", pos, src.size - pos, ""); ctx.warn("trailer", (src.size - pos) + " bytes after IEND", pos); }
}

/* ---------------------------------------------------------------- WebP (RIFF) */
async function parseWebP(ctx) {
  const src = ctx.src, h = await src.read(0, 12), riffSize = DV(h).getUint32(4, true);
  ctx.seg("RIFF header", "header", 0, 12, "WEBP");
  if (riffSize + 8 > src.size) ctx.warn("truncated", "RIFF size " + riffSize, 4);
  let pos = 12, n = 0; const g = "RIFF";
  while (pos + 8 <= src.size && n++ < 10000) {
    const ch = await src.read(pos, 8), id = latin1(ch, 0, 4), len = DV(ch).getUint32(4, true), dOff = pos + 8;
    let kind = "other", note = "";
    const d = (id === "VP8 " || id === "VP8L" || id === "ALPH" || id === "ANMF") ? await src.read(dOff, Math.min(len, 32)) : await src.read(dOff, Math.min(len, LIM.bin));
    try {
      if (id === "VP8X") { const fl = d[0], w = 1 + (d[4] | d[5] << 8 | d[6] << 16), hh = 1 + (d[7] | d[8] << 8 | d[9] << 16), names = [[1, "Animation"], [2, "XMP"], [3, "EXIF"], [4, "Alpha"], [5, "ICC Profile"]].filter(x => fl & (1 << x[0])).map(x => x[1]);
        ctx.add(g, { name: "WebP_Flags", id: "VP8X.0", value: fl, display: names.join(", ") || "(none)", type: "int8u", offset: dOff }); ctx.add(g, { name: "ImageWidth", id: "VP8X.4", value: w, type: "int24u" }); ctx.add(g, { name: "ImageHeight", id: "VP8X.6", value: hh, type: "int24u" }); ctx.info.webp = { width: w, height: hh }; kind = "header"; }
      else if (id === "VP8 ") { if (d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) { const w = (d[6] | d[7] << 8) & 0x3fff, hh = (d[8] | d[9] << 8) & 0x3fff; ctx.add(g, { name: "VP8Version", id: "VP8.0", value: d[0] >> 1 & 7, display: ["0 (bicubic reconstruction, normal loop)", "1 (bilinear reconstruction, simple loop)", "2 (bilinear reconstruction, no loop)", "3 (no reconstruction, no loop)"][d[0] >> 1 & 7] || String(d[0] >> 1 & 7), type: "int8u" }); if (!ctx.info.webp) { ctx.add(g, { name: "ImageWidth", id: "VP8.6", value: w, type: "int16u" }); ctx.add(g, { name: "ImageHeight", id: "VP8.8", value: hh, type: "int16u" }); ctx.info.webp = { width: w, height: hh }; } } kind = "image"; note = "lossy"; }
      else if (id === "VP8L") { if (d[0] === 0x2f) { const b = d[1] | d[2] << 8 | d[3] << 16 | d[4] << 24, w = (b & 0x3fff) + 1, hh = ((b >>> 14) & 0x3fff) + 1; if (!ctx.info.webp) { ctx.add(g, { name: "ImageWidth", id: "VP8L.1", value: w, type: "int16u" }); ctx.add(g, { name: "ImageHeight", id: "VP8L.2", value: hh, type: "int16u" }); } ctx.add(g, { name: "AlphaIsUsed", id: "VP8L.4", value: (b >>> 28) & 1, display: E.AlphaIsUsed[(b >>> 28) & 1], type: "int8u" }); ctx.info.webp = ctx.info.webp || { width: w, height: hh }; } kind = "image"; note = "lossless"; }
      else if (id === "EXIF") { const o = latin1(d, 0, 6) === "Exif\0\0" ? 6 : 0; await readTIFF(ctx, dOff + o, { depth: 1 }); kind = "exif"; }
      else if (id === "XMP " || id === "XMP\0") { await parseXMP(ctx, d, dOff, "WebP"); kind = "xmp"; }
      else if (id === "ICCP") { parseICC(ctx, d, dOff); kind = "icc"; }
      else if (id === "ANIM") { ctx.add(g, { name: "BackgroundColor", id: "ANIM.0", value: DV(d).getUint32(0, true), display: d[2] + " " + d[1] + " " + d[0] + " " + d[3], type: "int8u" }); ctx.add(g, { name: "AnimationLoopCount", id: "ANIM.4", value: DV(d).getUint16(4, true), type: "int16u" }); }
      else if (id === "C2PA") { kind = "c2pa"; ctx.bin(g, "JUMBF", "C2PA", dOff, len); const r = await c2paRead(ctx, d, p => dOff + p, "WebP C2PA chunk", 1); note = r.label === "c2pa" ? "C2PA manifest store" : "JUMBF"; }
      else if (id === "ALPH" || id === "ANMF") kind = "image";
      else note = "not decoded";
    } catch (e) { ctx.warn("webp", id + ": " + e.message, pos); }
    ctx.seg(id.trim(), kind, pos, len + 8, note);
    pos = dOff + len + (len & 1);
  }
}

/* ---------------------------------------------------------------- ISO base media (HEIC/HEIF/AVIF, MP4/MOV, CR3) */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "dinf", "edts", "iprp", "ipco", "meco", "mvex", "tref", "sinf", "schi", "moof", "traf", "gmhd"]);
const T1904 = Date.UTC(1904, 0, 1);
function qtDate(sec) { if (!sec) return "0000:00:00 00:00:00"; const d = new Date(T1904 + sec * 1000); return isNaN(d) ? String(sec) : d.toISOString().replace("T", " ").replace(/-/g, ":").replace(/\.\d+Z$/, ""); }
const CR3_UUID = "85c0b687820f11e08111f4ce462b6a48", XMP_UUID = "be7acfcb97a942e89c71999491e3afac";
async function parseBMFF(ctx) {
  const src = ctx.src, st = { boxes: 0, track: 0, items: {}, iloc: {}, ipco: [], ipma: {}, primary: null, idat: null, handler: "", keys: [], dji: new Set() };
  await walkBoxes(ctx, 0, src.size, 0, st, "");
  /* HEIF item handling */
  const itemIds = Object.keys(st.items);
  if (itemIds.length) {
    const g = "QuickTime";
    if (st.primary != null) ctx.add(g, { name: "PrimaryItemReference", id: "pitm", value: st.primary, type: "int32u" });
    for (const id of itemIds) {
      const it = st.items[id], loc = st.iloc[id];
      if (!loc || !loc.extents.length) continue;
      const ext = loc.extents[0], base = loc.method === 1 ? (st.idat ? st.idat.offset : 0) : 0, off = base + loc.base + ext.offset, len = loc.extents.reduce((a, e) => a + e.length, 0);
      if (it.type === "Exif") {
        const b = await src.read(off, 8), skip = u32be(b, 0);
        ctx.seg("Exif item " + id, "exif", off, len, "", 1);
        try { await readTIFF(ctx, off + 4 + skip, { depth: 1 }); } catch (e) { ctx.warn("heif", "Exif item: " + e.message, off); }
      } else if (it.type === "mime" && /rdf\+xml|xmp/i.test(it.contentType || "")) {
        ctx.seg("XMP item " + id, "xmp", off, len, "", 1);
        await parseXMP(ctx, await src.read(off, Math.min(len, LIM.bin)), off, "HEIF item");
      } else if (String(id) === String(st.primary)) ctx.seg("primary image item " + id + " (" + it.type + ")", "image", off, len, loc.extents.length + " extents", 1);
    }
    const pid = st.primary, props = (st.ipma[pid] || []).map(i => st.ipco[i - 1]).filter(Boolean);
    const ispe = props.find(p => p.type === "ispe") || st.ipco.find(p => p && p.type === "ispe");
    if (ispe) { ctx.add(g, { name: "ImageWidth", id: "ispe.4", value: ispe.w, type: "int32u" }); ctx.add(g, { name: "ImageHeight", id: "ispe.8", value: ispe.h, type: "int32u" }); ctx.info.heif = { width: ispe.w, height: ispe.h }; }
    const irot = props.find(p => p.type === "irot"); if (irot) ctx.add(g, { name: "Rotation", id: "irot", value: irot.angle, display: irot.angle * 90 + "", type: "int8u" });
    const pixi = props.find(p => p.type === "pixi"); if (pixi) ctx.add(g, { name: "ImagePixelDepth", id: "pixi", value: pixi.bits, type: "int8u" });
  }
  if (st.dji.size) { ctx.info.djiVideo = Array.from(st.dji); ctx.warn("dji-telemetry", "DJI timed metadata (" + Array.from(st.dji).join(", ") + ") present, not decoded", null); }
}
async function walkBoxes(ctx, start, end, depth, st, path) {
  const src = ctx.src; let pos = start;
  while (pos + 8 <= end && st.boxes++ < LIM.boxes) {
    const h = await src.read(pos, 16); if (h.length < 8) break;
    let size = u32be(h, 0), type = latin1(h, 4, 4), hl = 8;
    if (size === 1) { if (h.length < 16) break; size = u32be(h, 8) * 4294967296 + u32be(h, 12); hl = 16; }
    else if (size === 0) size = end - pos;
    if (size < hl || pos + size > end + 8) { ctx.warn("bmff", "bad box size '" + type.replace(/[^\x20-\x7e]/g, "?") + "'", pos); if (size < hl) break; size = end - pos; }
    if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) { ctx.warn("bmff", "bad box type", pos); break; }
    const dOff = pos + hl, dLen = Math.min(size, end - pos) - hl, p2 = path + "/" + type;
    if (depth === 0 || depth === 1 && path === "/moov") ctx.seg(type, type === "mdat" ? "image" : type === "moov" || type === "meta" ? "exif" : "other", pos, size, "", depth);
    try { await bmffBox(ctx, type, dOff, dLen, depth, st, p2); } catch (e) { ctx.warn("bmff", type + ": " + e.message, pos); }
    pos += size;
  }
}
async function bmffBox(ctx, type, off, len, depth, st, path) {
  const src = ctx.src, g = "QuickTime";
  if (depth > 12) return;
  if (type === "ftyp") {
    const d = await src.read(off, Math.min(len, 256)), major = latin1(d, 0, 4), comp = [];
    for (let k = 8; k + 4 <= d.length; k += 4) comp.push(latin1(d, k, 4));
    ctx.add(g, { name: "MajorBrand", id: "ftyp.0", value: major, type: "string", offset: off }); ctx.add(g, { name: "MinorVersion", id: "ftyp.1", value: u32be(d, 4), type: "int32u" }); ctx.add(g, { name: "CompatibleBrands", id: "ftyp.2", value: comp, type: "string" });
    ctx.info.brands = [major].concat(comp); return;
  }
  if (CONTAINERS.has(type)) {
    if (type === "trak") { st.track++; st.curTrack = "QuickTime:Track" + st.track; }
    await walkBoxes(ctx, off, off + len, depth + 1, st, path); return;
  }
  if (type === "meta") {
    const b = await src.read(off, 8);
    const o2 = latin1(b, 4, 4) === "hdlr" ? off : off + 4;
    await walkBoxes(ctx, o2, off + len, depth + 1, st, path); return;
  }
  if (type === "uuid") {
    const u = hexstr(await src.read(off, 16));
    if (u === XMP_UUID) { ctx.seg("uuid XMP", "xmp", off - 8, len + 8, "", depth); await parseXMP(ctx, await src.read(off + 16, Math.min(len - 16, LIM.bin)), off + 16, "uuid"); }
    else if (u === CR3_UUID) await walkBoxes(ctx, off + 16, off + len, depth + 1, st, path);
    else if (u === C2PA_UUID) { /* C2PA uuid box: version/flags, purpose string, (manifest: 8-byte offset), JUMBF */
      const d = await src.read(off + 16, Math.min(Math.max(0, len - 16), LIM.bin));
      let z = 4; while (z < d.length && z < 68 && d[z]) z++;
      const purpose = latin1(d, 4, z - 4).replace(/[^\x20-\x7e]/g, "?"), p = z + 1 + (purpose === "manifest" ? 8 : 0);
      const sb = ctx.structure.slice().reverse().find(x => x.segment === "uuid" && x.offset < off && x.offset + x.length >= off + len);
      if (sb) { sb.segment = "uuid C2PA"; sb.kind = "c2pa"; sb.note = "purpose " + purpose; }
      ctx.add(g, { name: "JUMBF", id: "uuid-c2pa", value: null, display: "(C2PA, purpose " + purpose + ", " + Math.max(0, d.length - p) + " bytes)", type: "undef", count: Math.max(0, d.length - p), offset: off + 16 + p, binary: { offset: off + 16 + p, length: Math.max(0, d.length - p) } });
      if (purpose === "manifest" && p < d.length) await c2paRead(ctx, d.subarray(p), q => off + 16 + p + q, "ISO BMFF uuid box (purpose manifest)", depth + 1);
    }
    return;
  }
  if (/^CMT[1-4]$/.test(type)) {
    const map = { CMT1: ["IFD0", "EXIF:IFD0", "EXIF"], CMT2: ["ExifIFD", "EXIF:ExifIFD", "EXIF"], CMT3: ["MakerNotes", "MakerNotes:Canon", "EXIF"], CMT4: ["GPS", "EXIF:GPS", "GPS"] }[type];
    ctx.seg(type, type === "CMT3" ? "maker" : "exif", off - 8, len + 8, "Canon CR3 " + map[0], depth);
    if (type !== "CMT3") await readTIFF(ctx, off, { single: true, name: map[0], group: map[1], table: map[2], depth: depth });
    else ctx.bin(map[1], "MakerNoteCanon", "CMT3", off, len, { note: "not decoded" });
    return;
  }
  if (type === "mvhd" || type === "tkhd" || type === "mdhd") {
    const d = await src.read(off, Math.min(len, 120)), v = d[0], L = v === 1;
    const rd = o => L ? u32be(d, o) * 4294967296 + u32be(d, o + 4) : u32be(d, o);
    if (type === "mvhd") {
      const cr = rd(4), md = rd(L ? 12 : 8), ts = u32be(d, L ? 20 : 12), du = L ? u32be(d, 24) * 4294967296 + u32be(d, 28) : u32be(d, 16);
      ctx.add(g, { name: "MovieHeaderVersion", id: "mvhd.0", value: v, type: "int8u", offset: off }); ctx.add(g, { name: "CreateDate", id: "mvhd.1", value: qtDate(cr), type: "int32u" }); ctx.add(g, { name: "ModifyDate", id: "mvhd.2", value: qtDate(md), type: "int32u" });
      ctx.add(g, { name: "TimeScale", id: "mvhd.3", value: ts, type: "int32u" }); ctx.add(g, { name: "Duration", id: "mvhd.4", value: ts ? du / ts : du, display: ts ? num(rnd(du / ts, 3)) + " s" : String(du), type: "int32u" });
      ctx.info.qtCreate = cr ? T1904 + cr * 1000 : null;
    } else if (type === "tkhd") {
      const gg = st.curTrack || "QuickTime:Track1", cr = rd(4), md = rd(L ? 12 : 8), tid = u32be(d, L ? 20 : 12), du = L ? u32be(d, 28) * 4294967296 + u32be(d, 32) : u32be(d, 20);
      const wo = L ? 88 : 76; const w = u32be(d, wo) / 65536, hh = u32be(d, wo + 4) / 65536;
      ctx.add(gg, { name: "TrackHeaderVersion", id: "tkhd.0", value: v, type: "int8u", offset: off }); ctx.add(gg, { name: "TrackCreateDate", id: "tkhd.1", value: qtDate(cr), type: "int32u" });
      ctx.add(gg, { name: "TrackModifyDate", id: "tkhd.2", value: qtDate(md), type: "int32u" }); ctx.add(gg, { name: "TrackID", id: "tkhd.3", value: tid, type: "int32u" }); ctx.add(gg, { name: "TrackDuration", id: "tkhd.5", value: du, type: "int32u" });
      if (w || hh) { ctx.add(gg, { name: "ImageWidth", id: "tkhd.19", value: w, type: "fixed32u" }); ctx.add(gg, { name: "ImageHeight", id: "tkhd.20", value: hh, type: "fixed32u" }); if (!ctx.info.video) ctx.info.video = { width: w, height: hh }; }
    } else {
      const gg = st.curTrack || "QuickTime:Track1", ts = u32be(d, L ? 20 : 12), du = L ? u32be(d, 24) * 4294967296 + u32be(d, 28) : u32be(d, 16);
      ctx.add(gg, { name: "MediaTimeScale", id: "mdhd.3", value: ts, type: "int32u" }); ctx.add(gg, { name: "MediaDuration", id: "mdhd.4", value: ts ? du / ts : du, display: ts ? num(rnd(du / ts, 3)) + " s" : String(du), type: "int32u" });
    }
    return;
  }
  if (type === "hdlr") {
    const d = await src.read(off, Math.min(len, 128)), ht = latin1(d, 8, 4), nm = cstr(d.subarray(24)).replace(/^[\x00-\x1f]/, "");
    st.handler = ht;
    if (/djmd|dbgi/i.test(nm)) st.dji.add(nm);
    if (st.curTrack && /moov\/trak/.test(path)) ctx.add(st.curTrack, { name: "HandlerType", id: "hdlr.2", value: ht, display: ({ vide: "Video Track", soun: "Audio Track", meta: "NRT Metadata", text: "Text", sbtl: "Subtitle", tmcd: "Time Code", pict: "Picture" })[ht] || ht, type: "string" });
    if (nm && st.curTrack && /moov\/trak/.test(path)) ctx.add(st.curTrack, { name: "HandlerDescription", id: "hdlr.4", value: nm, type: "string" });
    return;
  }
  if (type === "stsd" && st.curTrack) { const d = await src.read(off, Math.min(len, 64)); const fmt = latin1(d, 12, 4); if (/djmd|dbgi/.test(fmt)) st.dji.add(fmt); if (fmt === "camm" || fmt === "gpmd") ctx.warn("telemetry", "timed metadata track '" + fmt + "' (not decoded)", off); return; }
  if (type === "\xa9xyz") { const d = await src.read(off, Math.min(len, 128)); const s = latin1(d.subarray(4)).replace(/\0.*$/, ""); ctx.add(g, { name: "GPSCoordinates", id: "\xa9xyz", value: s, type: "string", offset: off }); ctx.info.iso6709 = s; return; }
  if (type === "\xa9day" || type === "\xa9mak" || type === "\xa9mod") { const d = await src.read(off, Math.min(len, 256)); const s = utf8loose(d.subarray(4)).replace(/\0.*$/, ""); ctx.add(g, { name: ({ "\xa9day": "ContentCreateDate", "\xa9mak": "Make", "\xa9mod": "Model" })[type], id: type, value: s, type: "string", offset: off }); return; }
  if (type === "keys") { const d = await src.read(off, Math.min(len, 65536)); const n = u32be(d, 4); let p = 8; st.keys = []; for (let k = 0; k < n && p + 8 <= d.length; k++) { const ks = u32be(d, p); st.keys.push(latin1(d, p + 8, ks - 8)); p += ks; } return; }
  if (type === "ilst") {
    const d = await src.read(off, Math.min(len, 1 << 20)); let p = 0;
    while (p + 8 <= d.length) {
      const bs = u32be(d, p), idx = u32be(d, p + 4); if (bs < 8) break;
      const key = st.keys[idx - 1]; let q = p + 8, val = null;
      while (q + 16 <= p + bs) { const ds = u32be(d, q); if (latin1(d, q + 4, 4) === "data") { const tp = u32be(d, q + 8) & 0xffffff, vb = d.subarray(q + 16, q + ds); val = tp === 1 ? utf8loose(vb) : tp === 23 ? DV(vb).getFloat32(0, false) : tp === 21 || tp === 22 ? (vb.length === 1 ? vb[0] : vb.length === 2 ? u16be(vb, 0) : u32be(vb, 0)) : hexstr(vb, 32); break; } if (ds < 8) break; q += ds; }
      if (key) {
        const last = key.replace(/^com\.(apple\.quicktime|android)\./, ""), nm = ({ "location.ISO6709": "GPSCoordinates", make: "Make", model: "Model", software: "Software", creationdate: "CreationDate" })[last] || ucfirst(last.replace(/\.(.)/g, (a, c) => c.toUpperCase()));
        ctx.add("QuickTime:Keys", { name: nm, id: key, value: val, type: "string", offset: off + p });
        if (nm === "GPSCoordinates" && typeof val === "string") ctx.info.iso6709 = val;
        if (nm === "CreationDate") ctx.info.qtCreationDate = val;
      }
      p += bs;
    }
    return;
  }
  if (type === "pitm") { const d = await src.read(off, 8); st.primary = d[0] === 0 ? u16be(d, 4) : u32be(d, 4); return; }
  if (type === "iinf") {
    const d = await src.read(off, Math.min(len, 1 << 20)); const v = d[0]; let p = v === 0 ? 6 : 8;
    while (p + 8 <= d.length) {
      const bs = u32be(d, p), bt = latin1(d, p + 4, 4); if (bs < 8) break;
      if (bt === "infe") { const iv = d[p + 8]; if (iv >= 2) { const id = iv === 2 ? u16be(d, p + 12) : u32be(d, p + 12), q = p + 12 + (iv === 2 ? 2 : 4) + 2, it = latin1(d, q, 4); let z = d.indexOf(0, q + 4); const name = latin1(d, q + 4, z - q - 4); let ct = ""; if (it === "mime") { const z2 = d.indexOf(0, z + 1); ct = latin1(d, z + 1, (z2 < 0 ? p + bs : z2) - z - 1); } st.items[id] = { type: it, name, contentType: ct }; } }
      p += bs;
    }
    return;
  }
  if (type === "iloc") {
    const d = await src.read(off, Math.min(len, 1 << 20)), v = d[0], os = d[4] >> 4, ls = d[4] & 15, bs = d[5] >> 4, is = v >= 1 ? d[5] & 15 : 0;
    const rdn = (p, n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + d[p + k]; return x; };
    let p = 6, n; if (v < 2) { n = u16be(d, p); p += 2; } else { n = u32be(d, p); p += 4; }
    for (let k = 0; k < n && p < d.length; k++) {
      const id = v < 2 ? u16be(d, p) : u32be(d, p); p += v < 2 ? 2 : 4;
      let method = 0; if (v >= 1) { method = u16be(d, p) & 15; p += 2; }
      p += 2; const base = rdn(p, bs); p += bs; const ec = u16be(d, p); p += 2; const extents = [];
      for (let e = 0; e < ec && p < d.length; e++) { if (is) p += is; const eo = rdn(p, os); p += os; const el = rdn(p, ls); p += ls; extents.push({ offset: eo, length: el }); }
      st.iloc[id] = { method, base, extents };
    }
    return;
  }
  if (type === "idat") { st.idat = { offset: off, length: len }; return; }
  if (type === "ispe") { const d = await src.read(off, 12); st.ipco.push({ type, w: u32be(d, 4), h: u32be(d, 8) }); return; }
  if (type === "irot") { const d = await src.read(off, 1); st.ipco.push({ type, angle: d[0] & 3 }); return; }
  if (type === "pixi") { const d = await src.read(off, 8); st.ipco.push({ type, bits: Array.from(d.subarray(5, 5 + d[4])) }); return; }
  if (path.indexOf("/ipco/") >= 0) { st.ipco.push({ type }); return; }
  if (type === "ipma") {
    const d = await src.read(off, Math.min(len, 1 << 20)), v = d[0], fl = d[3]; let p = 4; const n = u32be(d, p); p += 4;
    for (let k = 0; k < n && p < d.length; k++) { const id = v < 1 ? u16be(d, p) : u32be(d, p); p += v < 1 ? 2 : 4; const c = d[p++], arr = []; for (let j = 0; j < c; j++) { const x = fl & 1 ? u16be(d, p) & 0x7fff : d[p] & 0x7f; p += fl & 1 ? 2 : 1; arr.push(x); } st.ipma[id] = arr; }
    return;
  }
  if (type === "djmd" || type === "dbgi") { st.dji.add(type); return; }
}

/* ---------------------------------------------------------------- CBOR (RFC 8949): small bounded decoder for C2PA claims, assertions and COSE */
class CTag { constructor(tag, value) { this.tag = tag; this.value = value; } }
class CSimple { constructor(v) { this.simple = v; } }
const CBOR_BREAK = { brk: true };
function cborDecode(b, lim) {
  lim = lim || {};
  const maxDepth = lim.depth || 32, maxItems = lim.items || 200000, end = b.length;
  let p = 0, n = 0;
  const fail = m => { throw new Error("CBOR " + m + " at byte " + p); };
  const need = k => { if (p + k > end) fail("truncated"); };
  function arg(ai) {
    if (ai < 24) return ai;
    if (ai === 24) { need(1); return b[p++]; }
    if (ai === 25) { need(2); const v = u16be(b, p); p += 2; return v; }
    if (ai === 26) { need(4); const v = u32be(b, p); p += 4; return v; }
    if (ai === 27) { need(8); const v = u32be(b, p) * 4294967296 + u32be(b, p + 4); p += 8; return v; }
    if (ai === 31) return -1;
    return fail("reserved additional information " + ai);
  }
  function half(h) { const e = h >> 10 & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return e === 0 ? s * m * Math.pow(2, -24) : e === 31 ? (m ? NaN : s * Infinity) : s * (1024 + m) * Math.pow(2, e - 25); }
  function key(k) { return typeof k === "string" ? k : typeof k === "number" ? String(k) : cText(k, 80); }
  function item(d) {
    if (d > maxDepth) fail("nesting deeper than " + maxDepth);
    if (++n > maxItems) fail("more than " + maxItems + " items");
    need(1);
    const ib = b[p++], mt = ib >> 5, ai = ib & 31;
    if (mt === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      if (ai === 25) { need(2); const v = half(u16be(b, p)); p += 2; return v; }
      if (ai === 26) { need(4); const v = DV(b).getFloat32(p); p += 4; return v; }
      if (ai === 27) { need(8); const v = DV(b).getFloat64(p); p += 8; return v; }
      if (ai === 31) return CBOR_BREAK;
      if (ai < 20) return new CSimple(ai);
      if (ai === 24) { need(1); return new CSimple(b[p++]); }
      return fail("reserved simple value");
    }
    const len = arg(ai);
    if (len < 0 && (mt < 2 || mt === 6)) fail("indefinite length not allowed");
    if (mt === 0) return len;
    if (mt === 1) return -1 - len;
    if (mt === 2 || mt === 3) {
      let bytes;
      if (len >= 0) { need(len); bytes = b.subarray(p, p + len); p += len; }
      else {
        const parts = []; let tot = 0;
        for (;;) {
          need(1); if (b[p] === 0xff) { p++; break; }
          const c = b[p++]; if (c >> 5 !== mt || (c & 31) === 31) fail("bad chunk in indefinite string");
          const l = arg(c & 31); need(l); parts.push(b.subarray(p, p + l)); p += l; tot += l;
          if (++n > maxItems) fail("too many string chunks");
        }
        bytes = new Uint8Array(tot); let q = 0; for (const x of parts) { bytes.set(x, q); q += x.length; }
      }
      return mt === 2 ? bytes : utf8loose(bytes);
    }
    if (mt === 4) {
      const a = [];
      if (len >= 0) { if (len > end - p) fail("array length " + len); for (let k = 0; k < len; k++) { const v = item(d + 1); if (v === CBOR_BREAK) fail("unexpected break"); a.push(v); } }
      else for (;;) { const v = item(d + 1); if (v === CBOR_BREAK) break; a.push(v); }
      return a;
    }
    if (mt === 5) {
      const o = Object.create(null);
      const one = () => { const k = item(d + 1); if (k === CBOR_BREAK) return false; const v = item(d + 1); if (v === CBOR_BREAK) fail("unexpected break"); o[key(k)] = v; return true; };
      if (len >= 0) { if (len > (end - p) / 2) fail("map length " + len); for (let k = 0; k < len; k++) if (!one()) fail("unexpected break"); }
      else while (one()) { /* until break */ }
      return o;
    }
    return new CTag(len, item(d + 1));
  }
  const value = item(0);
  if (value === CBOR_BREAK) fail("unexpected break");
  return { value, end: p };
}
const isMapObj = v => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof CTag) && !(v instanceof CSimple);
function cText(v, budget) { /* compact one-line rendering of decoded CBOR/JSON */
  const out = []; let left = budget || 400;
  const w = s => { if (left <= 0) return; if (s.length > left) { out.push(s.slice(0, left) + "…"); left = 0; } else { out.push(s); left -= s.length; } };
  function r(x, d) {
    if (left <= 0) return;
    if (x === undefined) w("undefined");
    else if (x === null) w("null");
    else if (typeof x === "string") w(x.length > 200 ? x.slice(0, 200) + "…" : x);
    else if (typeof x === "number") w(num(x, 15));
    else if (typeof x === "boolean") w(String(x));
    else if (x instanceof Uint8Array) w(x.length <= 16 ? "0x" + hexstr(x) : "0x" + hexstr(x, 8) + "… (" + x.length + " bytes)");
    else if (x instanceof CTag) { w("tag " + x.tag + "("); r(x.value, d + 1); w(")"); }
    else if (x instanceof CSimple) w("simple(" + x.simple + ")");
    else if (Array.isArray(x)) { w("["); x.slice(0, 16).forEach((y, i) => { if (i) w(", "); r(y, d + 1); }); if (x.length > 16) w(", … " + x.length + " items"); w("]"); }
    else if (typeof x === "object") { const ks = Object.keys(x); if (d) w("{"); ks.slice(0, 24).forEach((k, i) => { if (i) w(d ? ", " : "; "); w(k + ": "); r(x[k], d + 1); }); if (ks.length > 24) w(", … " + ks.length + " keys"); if (d) w("}"); }
    else w(String(x));
  }
  r(v, 0);
  return out.join("");
}
const cStr = v => typeof v === "string" ? v : v == null ? null : cText(v, 200);

/* ---------------------------------------------------------------- X.509 (DER): names and validity of a certificate only; nothing is verified */
function derTLV(b, p, end) {
  if (p + 2 > end) return null;
  const tag = b[p]; let len = b[p + 1], q = p + 2;
  if ((tag & 0x1f) === 0x1f) return null;
  if (len & 0x80) { const k = len & 0x7f; if (k < 1 || k > 4 || q + k > end) return null; len = 0; for (let i = 0; i < k; i++) len = len * 256 + b[q++]; }
  if (q + len > end) return null;
  return { tag, s: p, vs: q, ve: q + len };
}
function derKids(b, t) { const a = []; let p = t.vs; while (p < t.ve && a.length < 64) { const c = derTLV(b, p, t.ve); if (!c) break; a.push(c); p = c.ve; } return a; }
const DN_OID = { "550403": "CN", "55040a": "O", "55040b": "OU", "550406": "C", "550407": "L", "550408": "ST", "2a864886f70d010901": "E" };
function derStr(b, t) { const v = b.subarray(t.vs, t.ve); return t.tag === 0x1e ? utf16(v, false) : t.tag === 0x0c ? utf8loose(v) : latin1(v); }
function derName(b, t) {
  const o = {};
  for (const set of derKids(b, t)) for (const atv of derKids(b, set)) {
    const k = derKids(b, atv); if (k.length < 2 || k[0].tag !== 6) continue;
    const nm = DN_OID[hexstr(b.subarray(k[0].vs, k[0].ve))]; if (!nm) continue;
    const s = derStr(b, k[1]); o[nm] = o[nm] ? o[nm] + ", " + s : s;
  }
  return o;
}
function derTime(b, t) {
  const s = latin1(b.subarray(t.vs, t.ve));
  const m = t.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/.exec(s);
  if (!m) return s;
  let y = +m[1]; if (t.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return y + ":" + m[2] + ":" + m[3] + " " + m[4] + ":" + m[5] + ":" + (m[6] || "00") + "Z";
}
function x509(b) {
  if (!(b instanceof Uint8Array)) return null;
  const c = derTLV(b, 0, b.length); if (!c || c.tag !== 0x30) return null;
  const tbs = derKids(b, c)[0]; if (!tbs || tbs.tag !== 0x30) return null;
  let f = derKids(b, tbs); if (f[0] && f[0].tag === 0xa0) f = f.slice(1);
  if (f.length < 5 || f[2].tag !== 0x30 || f[4].tag !== 0x30) return null;
  const val = f[3].tag === 0x30 ? derKids(b, f[3]) : [];
  return { serial: hexstr(b.subarray(f[0].vs, Math.min(f[0].ve, f[0].vs + 32))), issuer: derName(b, f[2]), subject: derName(b, f[4]), notBefore: val[0] ? derTime(b, val[0]) : null, notAfter: val[1] ? derTime(b, val[1]) : null };
}

/* ---------------------------------------------------------------- JUMBF (ISO/IEC 19566-5) and C2PA manifest stores (C2PA Technical Specification) */
const JUMBF_TAIL = "00110010800000aa00389b71", C2PA_UUID = "d8fec3d61b0e483c92975828877ec481", EMBEDDED_FILE_UUID = "40cb0c32bb8a489da70b2ad6f47f4369";
const JUMBF_DESC = { c2pa: "C2PA manifest store", c2ma: "C2PA manifest", c2um: "C2PA update manifest", c2as: "C2PA assertion store", c2cl: "C2PA claim", c2cs: "C2PA claim signature",
  c2vc: "C2PA credential store", cbor: "CBOR", json: "JSON", uuid: "UUID", xml: "XML", jp2c: "JPEG 2000 codestream" };
const C2PA_ID = { ManifestLabel: "jumd.label", ManifestType: "jumd.type", ClaimLabel: "c2cl.label", ClaimVersion: "c2cl.label", ClaimGenerator: "claim_generator", ClaimGeneratorName: "claim_generator_info.name",
  ClaimGeneratorVersion: "claim_generator_info.version", ClaimGeneratorInfo: "claim_generator_info", SpecVersion: "specVersion", Title: "dc:title", Format: "dc:format", InstanceID: "instanceID", ClaimHashAlgorithm: "alg",
  AssertionCount: "c2pa.assertions", RedactedAssertions: "redacted_assertions", ActionsAction: "actions[].action", ActionsSoftwareAgent: "actions[].softwareAgent", ActionsDigitalSourceType: "actions[].digitalSourceType",
  ActionsWhen: "actions[].when", ActionsDescription: "actions[].description", IngredientTitle: "ingredient.dc:title", IngredientRelationship: "ingredient.relationship", IngredientFormat: "ingredient.dc:format",
  IngredientManifest: "ingredient.activeManifest", HashAssertions: "c2pa.hash.*", Thumbnail: "c2pa.thumbnail.*", OtherAssertions: "c2pa.assertions", Signature: "c2cs", SignatureAlgorithm: "COSE alg (1)",
  CertificateChainLength: "COSE x5chain (33)", SignerCommonName: "x5chain[0].subject.CN", SignerOrganization: "x5chain[0].subject.O", SignerOrganizationalUnit: "x5chain[0].subject.OU", SignerCountry: "x5chain[0].subject.C",
  IssuerCommonName: "x5chain[0].issuer.CN", IssuerOrganization: "x5chain[0].issuer.O", CertificateNotBefore: "x5chain[0].notBefore", CertificateNotAfter: "x5chain[0].notAfter", SignerCertificate: "x5chain[0]",
  SignatureTimeStamp: "COSE sigTst2/sigTst", CertificateStatus: "COSE rVals", ValidationStatus: "reader" };
const COSE_ALG = { "-7": "ES256", "-35": "ES384", "-36": "ES512", "-8": "EdDSA", "-37": "PS256", "-38": "PS384", "-39": "PS512" };
const IPTC_DST = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const DST_NAME = { digitalCapture: "Digital capture sampled from real life", computationalCapture: "Multi-frame computational capture sampled from real life", negativeFilm: "Digitised from a transparent negative",
  positiveFilm: "Digitised from a transparent positive", print: "Digitised from a non-transparent medium", minorHumanEdits: "Original media with minor human edits (retired term)", humanEdits: "Human-edited media",
  compositeWithTrainedAlgorithmicMedia: "Edited using Generative AI", algorithmicallyEnhanced: "Algorithmically-altered media", softwareImage: "Created by software (retired term)", digitalArt: "Digital art (retired term)",
  digitalCreation: "Digital creation", dataDrivenMedia: "Data-driven media", trainedAlgorithmicMedia: "Created using Generative AI", algorithmicMedia: "Pure algorithmic media", screenCapture: "Screen capture",
  virtualRecording: "Virtual event recording", composite: "Composite of elements", compositeCapture: "Composite of captured elements", compositeSynthetic: "Composite including generative AI elements" };
const DST_AI = new Set(["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia", "compositeSynthetic"]);
function dstTerm(u) { const s = typeof u === "string" ? u : ""; const m = /digitalsourcetype\/([A-Za-z]+)\/?$/.exec(s); return m ? m[1] : s && !/[/:]/.test(s) ? s : null; }
function jumbfBoxes(b, o, end, depth, st) {
  const out = [];
  while (o + 8 <= end) {
    if (++st.n > LIM.boxes) { st.warn("more than " + LIM.boxes + " JUMBF boxes", o); break; }
    let L = u32be(b, o), h = 8; const T = latin1(b, o + 4, 4);
    if (L === 1) { if (o + 16 > end) { st.warn("truncated XLBox", o); break; } L = u32be(b, o + 8) * 4294967296 + u32be(b, o + 12); h = 16; }
    else if (L === 0) L = end - o;
    if (!/^[\x20-\x7e]{4}$/.test(T)) { st.warn("bad JUMBF box type", o); break; }
    if (L < h || o + L > end) { st.warn("bad JUMBF box length '" + T + "'", o); if (L < h) break; L = end - o; }
    const box = { t: T, o, len: L, d: o + h, de: o + L };
    if (T === "jumb") {
      if (depth >= 24) st.warn("JUMBF nesting deeper than 24", o);
      else {
        const kids = jumbfBoxes(b, box.d, box.de, depth + 1, st);
        if (kids[0] && kids[0].t === "jumd") { box.desc = jumd(b, kids[0], st); box.content = kids.slice(1); }
        else { st.warn("JUMBF superbox without description box", o); box.desc = { t4: "", type: "", toggles: 0 }; box.content = kids; }
      }
    }
    out.push(box); o += L;
  }
  return out;
}
function jumd(b, bx, st) {
  const p0 = bx.d, e = bx.de, r = { type: "", t4: "", toggles: 0 };
  if (e - p0 < 17) { st.warn("short JUMBF description box", bx.o); return r; }
  r.type = hexstr(b.subarray(p0, p0 + 16));
  if (r.type.slice(8) === JUMBF_TAIL) r.t4 = latin1(b, p0, 4).replace(/[^\x20-\x7e]/g, "?");
  r.toggles = b[p0 + 16]; let p = p0 + 17;
  if (r.toggles & 2) { let z = p; while (z < e && b[z]) z++; r.label = utf8loose(b.subarray(p, Math.min(z, p + 1024))); p = z + 1; }
  if (r.toggles & 4) { if (p + 4 <= e) r.id = u32be(b, p); p += 4; }
  if (r.toggles & 8) { if (p + 32 <= e) r.sig = hexstr(b.subarray(p, p + 32)); p += 32; }
  if (r.toggles & 16 && p + 8 <= e) r.priv = { t: latin1(b, p + 4, 4).replace(/[^\x20-\x7e]/g, "?"), len: Math.min(u32be(b, p), e - p) };
  return r;
}
function jdata(b, box, st) { /* first content box of a superbox, decoded */
  const c = (box.content || []).find(x => x.t !== "jumd" && x.t !== "jumb") || null;
  if (!c) return { kind: (box.content || []).some(x => x.t === "jumb") ? "superbox" : "none", value: null, size: 0, off: box.o };
  const r = { kind: c.t, value: null, size: c.de - c.d, off: c.d };
  try {
    if (c.t === "cbor") r.value = cborDecode(b.subarray(c.d, c.de)).value;
    else if (c.t === "json") { if (r.size <= LIM.str) r.value = JSON.parse(utf8loose(b.subarray(c.d, c.de))); }
    else if (c.t === "bfdb") {
      const tg = b[c.d]; let z = c.d + 1; while (z < c.de && b[z]) z++;
      r.mime = latin1(b, c.d + 1, z - c.d - 1);
      if (tg & 1) { let z2 = z + 1; while (z2 < c.de && b[z2]) z2++; r.fileName = utf8loose(b.subarray(z + 1, z2)); }
      const bd = box.content.find(x => x.t === "bidb"); if (bd) { r.dataOff = bd.d; r.size = bd.de - bd.d; }
      r.value = { mime: r.mime, fileName: r.fileName };
    } else if (c.t === "uuid") r.value = { uuid: hexstr(b.subarray(c.d, Math.min(c.de, c.d + 16))), bytes: Math.max(0, r.size - 16) };
  } catch (e) { st.warn((box.desc && box.desc.label || c.t) + ": " + e.message, c.d); r.error = e.message; }
  return r;
}
function coseSign1(v, st) {
  const tagged = v instanceof CTag;
  const a = tagged ? (v.tag === 18 ? v.value : null) : v;
  if (!Array.isArray(a) || a.length !== 4) return { ok: false, note: tagged ? "CBOR tag " + v.tag + " (not COSE_Sign1)" : "not a COSE_Sign1 structure" };
  const r = { ok: true, tagged };
  let prot = {};
  if (a[0] instanceof Uint8Array && a[0].length) { try { prot = cborDecode(a[0]).value; } catch (e) { st.warn("COSE protected header: " + e.message, null); } }
  const unp = isMapObj(a[1]) ? a[1] : {};
  const hp = k => isMapObj(prot) && prot[k] !== undefined ? prot[k] : unp[k];
  r.alg = hp("1"); r.algName = r.alg == null ? null : COSE_ALG[String(r.alg)] || cStr(r.alg);
  let ch = hp("33"); if (ch === undefined) ch = hp("x5chain");
  const certs = ch instanceof Uint8Array ? [ch] : Array.isArray(ch) ? ch.filter(x => x instanceof Uint8Array) : [];
  r.nCerts = certs.length; r.certs = [];
  for (const c of certs.slice(0, 8)) { let x = null; try { x = x509(c); } catch (e) { x = null; } r.certs.push(x || { error: "certificate not parsed (" + c.length + " bytes)" }); }
  r.tst = unp.sigTst2 !== undefined ? "sigTst2" : unp.sigTst !== undefined ? "sigTst" : null;
  r.ocsp = unp.rVals !== undefined;
  r.detached = a[2] === null; r.sigLen = a[3] instanceof Uint8Array ? a[3].length : 0;
  return r;
}
function c2paManifest(b, m, st) {
  const M = { label: m.desc.label || "", t4: m.desc.t4, off: m.o, len: m.len, kind: m.desc.t4 === "c2um" ? "update" : "standard", assertions: [], actions: [], ingredients: [], hashes: [], thumbs: [], other: [], claim: null, sig: null, boxes: {} };
  for (const k of m.content || []) {
    if (!k.desc) continue;
    const t4 = k.desc.t4, lab = k.desc.label || "";
    if (t4 === "c2as" || lab === "c2pa.assertions") {
      M.boxes.assertions = k;
      for (const a of k.content || []) {
        if (!a.desc) continue;
        if (M.assertions.length >= 500) { st.warn("more than 500 assertions", a.o); break; }
        const dd = jdata(b, a, st), label = a.desc.label || "(no label)";
        M.assertions.push({ label, base: label.replace(/__\d+$/, ""), kind: dd.kind, value: dd.value, size: dd.size, off: dd.off, dataOff: dd.dataOff, mime: dd.mime, salt: !!a.desc.priv, box: a });
      }
    } else if (t4 === "c2cl" || /^c2pa\.claim/.test(lab)) { M.boxes.claim = k; M.claimLabel = lab; const dd = jdata(b, k, st); M.claim = dd.value; M.claimKind = dd.kind; }
    else if (t4 === "c2cs" || lab === "c2pa.signature") { M.boxes.sig = k; const dd = jdata(b, k, st); M.sigKind = dd.kind; M.sig = dd.kind === "cbor" && dd.value != null ? coseSign1(dd.value, st) : { ok: false, note: "signature box not decoded (" + dd.kind + ")" }; }
    else if (t4 === "c2vc") { M.boxes.vc = k; M.credentials = (k.content || []).filter(x => x.t === "jumb").length; }
  }
  /* assertions */
  for (const a of M.assertions) {
    const v = a.value, base = a.base;
    if (/^c2pa\.actions(\.v\d+)?$/.test(base) && isMapObj(v) && Array.isArray(v.actions)) {
      const agents = Array.isArray(v.softwareAgents) ? v.softwareAgents : [];
      for (const x of v.actions.slice(0, 200)) {
        if (!isMapObj(x)) continue;
        const pr = isMapObj(x.parameters) ? x.parameters : {};
        let ag = x.softwareAgent; if (ag === undefined && typeof x.softwareAgentIndex === "number") ag = agents[x.softwareAgentIndex];
        const agent = typeof ag === "string" ? ag : isMapObj(ag) ? [cStr(ag.name), cStr(ag.version)].filter(Boolean).join(" ") || cText(ag, 120) : null;
        const dst = cStr(x.digitalSourceType !== undefined ? x.digitalSourceType : pr.digitalSourceType);
        M.actions.push({ action: cStr(x.action) || "(none)", agent, dst, term: dstTerm(dst), when: cStr(x.when), description: cStr(x.description !== undefined ? x.description : pr.description), reason: cStr(x.reason), assertion: a.label });
      }
    } else if (/^c2pa\.ingredient(\.v\d+)?$/.test(base) && isMapObj(v)) {
      const am = isMapObj(v.activeManifest) ? v.activeManifest : isMapObj(v.c2pa_manifest) ? v.c2pa_manifest : null;
      M.ingredients.push({ title: cStr(v["dc:title"]), format: cStr(v["dc:format"]), relationship: cStr(v.relationship), instanceID: cStr(v.instanceID), documentID: cStr(v.documentID), manifest: am ? cStr(am.url) : null, assertion: a.label });
    } else if (/^c2pa\.hash\./.test(base)) M.hashes.push(base + (isMapObj(v) && v.alg ? " (" + cStr(v.alg) + ")" : ""));
    else if (/^c2pa\.thumbnail\./.test(base)) M.thumbs.push({ label: a.label, mime: a.mime || null, size: a.size, dataOff: a.dataOff });
    else M.other.push(a.label);
  }
  /* claim */
  const c = M.claim;
  if (isMapObj(c)) {
    M.claimVersion = /\.v(\d+)$/.test(M.claimLabel || "") ? +/\.v(\d+)$/.exec(M.claimLabel)[1] : 1;
    M.generator = cStr(c.claim_generator);
    const gi = c.claim_generator_info, arr = Array.isArray(gi) ? gi : isMapObj(gi) ? [gi] : [];
    M.genInfo = arr.filter(isMapObj).slice(0, 8).map(g => ({ name: cStr(g.name), version: cStr(g.version), extra: Object.keys(g).filter(k => k !== "name" && k !== "version" && k !== "icon" && k !== "specVersion").map(k => k + ": " + cText(g[k], 80)).join("; ") }));
    M.title = cStr(c["dc:title"]); M.format = cStr(c["dc:format"]); M.instanceID = cStr(c.instanceID); M.alg = cStr(c.alg); M.specVersion = cStr(c.specVersion !== undefined ? c.specVersion : (arr.find(g => isMapObj(g) && g.specVersion !== undefined) || {}).specVersion);
    const cnt = k => Array.isArray(c[k]) ? c[k].length : 0;
    M.refs = cnt("assertions") + cnt("created_assertions") + cnt("gathered_assertions"); M.redacted = cnt("redacted_assertions");
    M.sigRef = cStr(c.signature);
  }
  return M;
}
async function c2paRead(ctx, b, fo, where, depth) {
  /* b: complete JUMBF bytes; fo(p): file offset of byte p of b; where: container description; depth: structure depth for sub-entries */
  const st = { n: 0, warn: (t, o) => ctx.warn("jumbf", t, o == null ? null : fo(o)) };
  const top = jumbfBoxes(b, 0, b.length, 0, st);
  const res = { stores: 0, manifests: 0, label: "" };
  /* generic JUMBF tree */
  const stores = top.filter(x => x.t === "jumb" && x.desc && (x.desc.t4 === "c2pa" || x.desc.label === "c2pa"));
  if (stores.length) ctx.group("C2PA");
  let nj = 0;
  const walk = (boxes, d) => {
    for (const x of boxes) {
      if (x.t !== "jumb" || !x.desc) continue;
      if (++nj > 400) { if (nj === 401) st.warn("more than 400 JUMBF superboxes listed", x.o); return; }
      const lab = x.desc.label, ty = x.desc.t4 || (x.desc.type === EMBEDDED_FILE_UUID ? "embedded-file UUID" : x.desc.type ? x.desc.type.slice(0, 8) + "…" : "?"), cont = (x.content || []).filter(y => y.t !== "jumb").map(y => y.t);
      ctx.add("JUMBF", { name: "JUMDLabel", id: "jumd@" + hex(fo(x.o), 8), value: lab == null ? null : lab, display: lab == null ? "(no label)" : lab, type: "string", offset: fo(x.o),
        note: "type " + ty + (JUMBF_DESC[x.desc.t4] ? " (" + JUMBF_DESC[x.desc.t4] + ")" : "") + ", " + x.len + " bytes" + (cont.length ? ", content " + cont.join("+") : "") + (x.desc.priv ? ", private box " + x.desc.priv.t : "") + (d ? ", level " + (d + 1) : "") });
      if (x.content) walk(x.content, d + 1);
    }
  };
  walk(top, 0);
  if (!stores.length) { res.label = top[0] && top[0].desc ? (top[0].desc.label || top[0].desc.t4) : ""; return res; }
  for (const [si, store] of stores.entries()) {
    const mans = (store.content || []).filter(x => x.t === "jumb" && x.desc && (/^c2(ma|um)$/.test(x.desc.t4) || (x.content || []).some(y => y.desc && (y.desc.t4 === "c2cl" || /^c2pa\.claim/.test(y.desc.label || "")))));
    res.stores++; res.manifests += mans.length; res.label = "c2pa";
    if (si > 0) { st.warn("more than one C2PA manifest store; only the first is interpreted", store.o); continue; }
    const M = mans.map(m => c2paManifest(b, m, st)), act = M.length - 1;
    ctx.seg("C2PA manifest store", "c2pa", fo(store.o), fo(store.o + store.len - 1) + 1 - fo(store.o), M.length + " manifest" + (M.length === 1 ? "" : "s"), depth);
    M.forEach((m, i) => {
      const so = fo(m.off), se = fo(m.off + m.len - 1) + 1;
      ctx.seg("C2PA manifest" + (i === act ? " (active)" : ""), "c2pa", so, se - so, m.label, depth + 1);
      for (const [k, nm] of [["assertions", "assertion store"], ["claim", "claim"], ["sig", "claim signature"], ["vc", "credential store"]]) {
        const bx = m.boxes[k]; if (!bx || i !== act) continue;
        const o1 = fo(bx.o), o2 = fo(bx.o + bx.len - 1) + 1;
        ctx.seg("C2PA " + nm, "c2pa", o1, o2 - o1, k === "assertions" ? m.assertions.length + " assertion" + (m.assertions.length === 1 ? "" : "s") : k === "claim" ? m.claimLabel || "" : k === "sig" ? (m.sig && m.sig.ok ? "COSE_Sign1" + (m.sig.algName ? " " + m.sig.algName : "") : "") : "", depth + 2);
      }
    });
    /* tags */
    const SG = "C2PA";
    ctx.add(SG, { name: "ManifestStoreLocation", id: "store.where", value: where, type: "string", offset: fo(store.o) });
    ctx.add(SG, { name: "ManifestStoreSize", id: "store.size", value: store.len, type: "int32u" });
    ctx.add(SG, { name: "ManifestCount", id: "store.count", value: M.length, type: "int32u" });
    if (M.length) ctx.add(SG, { name: "ActiveManifest", id: "store.active", value: M[act].label, type: "string", note: "the last manifest in the store" });
    M.forEach((m, i) => {
      const g = i === act ? SG : "C2PA:Manifest" + (i + 1), A = (name, value, display, extra) => ctx.add(g, Object.assign({ name, id: C2PA_ID[name] || name, value, display, type: "string" }, extra || {}));
      if (i !== act) A("ManifestLabel", m.label);
      A("ManifestType", m.kind, m.kind + " manifest (" + (m.t4 || "?") + ")");
      if (m.claimLabel) A("ClaimLabel", m.claimLabel);
      if (m.claimVersion) A("ClaimVersion", m.claimVersion, String(m.claimVersion));
      if (m.generator) A("ClaimGenerator", m.generator);
      if (m.genInfo && m.genInfo.length) {
        A("ClaimGeneratorName", m.genInfo.map(x => x.name || "").join("; "));
        if (m.genInfo.some(x => x.version)) A("ClaimGeneratorVersion", m.genInfo.map(x => x.version || "").join("; "));
        if (m.genInfo.some(x => x.extra)) A("ClaimGeneratorInfo", m.genInfo.map(x => x.extra).filter(Boolean).join(" | "));
      }
      if (m.specVersion) A("SpecVersion", m.specVersion);
      if (m.title) A("Title", m.title);
      if (m.format) A("Format", m.format);
      if (m.instanceID) A("InstanceID", m.instanceID);
      if (m.alg) A("ClaimHashAlgorithm", m.alg);
      A("AssertionCount", m.assertions.length, String(m.assertions.length), { type: "int32u" });
      if (m.redacted) A("RedactedAssertions", m.redacted, String(m.redacted), { type: "int32u" });
      if (m.actions.length) {
        A("ActionsAction", m.actions.map(x => x.action), m.actions.map(x => x.action).join(", "));
        if (m.actions.some(x => x.agent)) A("ActionsSoftwareAgent", m.actions.map(x => x.agent || ""), m.actions.map(x => x.agent || "-").join("; "));
        const ds = m.actions.filter(x => x.dst);
        if (ds.length) A("ActionsDigitalSourceType", ds.map(x => x.dst), ds.map(x => x.term ? x.term + " (" + (DST_NAME[x.term] || "term not in the IPTC vocabulary") + ")" : x.dst).join("; "), { note: "IPTC Digital Source Type vocabulary, " + IPTC_DST });
        if (m.actions.some(x => x.when)) A("ActionsWhen", m.actions.map(x => x.when || ""), m.actions.map(x => x.when || "-").join("; "));
        if (m.actions.some(x => x.description)) A("ActionsDescription", m.actions.map(x => x.description || ""), m.actions.map(x => x.description || "-").join("; "));
      }
      if (m.ingredients.length) {
        if (m.ingredients.some(x => x.title)) A("IngredientTitle", m.ingredients.map(x => x.title || ""), m.ingredients.map(x => x.title || "-").join("; "));
        A("IngredientRelationship", m.ingredients.map(x => x.relationship || ""), m.ingredients.map(x => x.relationship || "-").join("; "));
        if (m.ingredients.some(x => x.format)) A("IngredientFormat", m.ingredients.map(x => x.format || ""), m.ingredients.map(x => x.format || "-").join("; "));
        if (m.ingredients.some(x => x.manifest)) A("IngredientManifest", m.ingredients.map(x => x.manifest || ""), m.ingredients.map(x => x.manifest || "-").join("; "));
      }
      if (m.hashes.length) A("HashAssertions", m.hashes, m.hashes.join(", "), { note: "hashes are not recomputed by this reader" });
      for (const th of m.thumbs) {
        if (th.dataOff != null && fo(th.dataOff + th.size - 1) + 1 - fo(th.dataOff) === th.size) ctx.bin(g, "Thumbnail", th.label, fo(th.dataOff), th.size, { note: th.mime || "" });
        else A("Thumbnail", th.label, th.label + " (" + th.size + " bytes)");
      }
      if (m.other.length) A("OtherAssertions", m.other, m.other.join(", "));
      const s = m.sig;
      if (!m.boxes.sig) A("Signature", "none", "none (no claim signature box)");
      else if (!s || !s.ok) A("Signature", "unreadable", "present but not decoded" + (s && s.note ? ": " + s.note : ""));
      else {
        A("Signature", "COSE_Sign1", "present (COSE_Sign1" + (s.algName ? ", " + s.algName : "") + ", " + s.sigLen + "-byte signature)");
        if (s.algName) A("SignatureAlgorithm", s.algName, s.algName + (s.alg != null ? " (COSE " + s.alg + ")" : ""));
        A("CertificateChainLength", s.nCerts, String(s.nCerts), { type: "int32u" });
        const c0 = s.certs[0];
        if (c0 && !c0.error) {
          const sub = c0.subject || {}, iss = c0.issuer || {};
          if (sub.CN) A("SignerCommonName", sub.CN); if (sub.O) A("SignerOrganization", sub.O); if (sub.OU) A("SignerOrganizationalUnit", sub.OU); if (sub.C) A("SignerCountry", sub.C);
          if (iss.CN) A("IssuerCommonName", iss.CN); if (iss.O) A("IssuerOrganization", iss.O);
          if (c0.notBefore) A("CertificateNotBefore", c0.notBefore); if (c0.notAfter) A("CertificateNotAfter", c0.notAfter);
        } else if (c0) A("SignerCertificate", c0.error);
        A("SignatureTimeStamp", s.tst || "none", s.tst ? "present (" + s.tst + "), not verified" : "none");
        if (s.ocsp) A("CertificateStatus", "rVals", "OCSP response stored (rVals), not checked");
      }
      A("ValidationStatus", "not validated", "not validated: this reader does not check the signature, the certificate chain or the content hashes");
      /* every assertion, decoded */
      for (const a of m.assertions) {
        const disp = a.kind === "cbor" || a.kind === "json" ? (a.value === null || a.value === undefined ? "(not decoded)" : cText(a.value, 600)) : a.kind === "bfdb" ? (a.mime || "embedded file") + ", " + a.size + " bytes" : "(" + a.kind + ", " + a.size + " bytes)";
        ctx.add("C2PA:Assertions" + (i === act ? "" : (i + 1)), { name: a.label, id: a.label, value: a.kind === "cbor" || a.kind === "json" ? null : a.size, display: disp, type: a.kind, offset: fo(a.off), note: a.kind.toUpperCase() + ", " + a.size + " bytes" + (a.salt ? ", salted" : "") });
      }
    });
    ctx.info.c2pa = { where, offset: fo(store.o), size: store.len, count: M.length, active: act,
      manifests: M.map((m, i) => ({ label: m.label, kind: m.kind, active: i === act, claimVersion: m.claimVersion || null, generator: m.generator || null, genInfo: m.genInfo || [], title: m.title || null, format: m.format || null,
        instanceID: m.instanceID || null, ai: m.actions.some(x => DST_AI.has(x.term)), actions: m.actions, ingredients: m.ingredients, hashes: m.hashes, thumbs: m.thumbs.length, assertions: m.assertions.map(a => a.label), other: m.other,
        signature: !m.boxes.sig ? null : m.sig && m.sig.ok ? { alg: m.sig.algName, nCerts: m.sig.nCerts, signer: m.sig.certs[0] && m.sig.certs[0].subject || null, issuer: m.sig.certs[0] && m.sig.certs[0].issuer || null,
          notBefore: m.sig.certs[0] && m.sig.certs[0].notBefore || null, notAfter: m.sig.certs[0] && m.sig.certs[0].notAfter || null, tst: m.sig.tst } : { unreadable: true } })) };
  }
  return res;
}
async function jpegJUMBF(ctx) { /* reassemble APP11 JPEG-XT boxes: per box instance En, in sequence Z; continuation segments repeat LBox/TBox (ISO/IEC 18477-3) */
  for (const [en, parts] of ctx.jpJUMBF) {
    parts.sort((a, b) => a.z - b.z);
    const first = parts[0], f = first.data;
    if (first.z !== 1) ctx.warn("jumbf", "APP11 box " + en + ": first segment has sequence " + first.z, first.offset);
    for (let k = 1; k < parts.length; k++) if (parts[k].z === parts[k - 1].z) ctx.warn("jumbf", "APP11 box " + en + ": duplicate sequence " + parts[k].z, parts[k].offset); else if (parts[k].z !== parts[k - 1].z + 1) ctx.warn("jumbf", "APP11 box " + en + ": missing sequence " + (parts[k - 1].z + 1), parts[k].offset);
    if (f.length < 8) continue;
    const hl = u32be(f, 0) === 1 ? 16 : 8, pieces = []; let tot = 0;
    for (const [k, p] of parts.entries()) {
      if (k && p.z === parts[k - 1].z) continue;
      const skip = k ? Math.min(hl, p.data.length) : 0, d = p.data.subarray(skip);
      if (tot + d.length > LIM.bin) { ctx.warn("jumbf", "APP11 box " + en + " larger than " + LIM.bin + " bytes", p.offset); break; }
      pieces.push({ at: tot, file: p.offset + skip, d }); tot += d.length;
    }
    const buf = new Uint8Array(tot); for (const pc of pieces) buf.set(pc.d, pc.at);
    let declared = u32be(f, 0); if (declared === 1 && f.length >= 16) declared = u32be(f, 8) * 4294967296 + u32be(f, 12);
    if (declared > tot) ctx.warn("jumbf", "APP11 box " + en + ": " + tot + " of " + declared + " bytes present", first.offset);
    const fo = p => { let lo = 0, hi = pieces.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pieces[mid].at <= p) lo = mid; else hi = mid - 1; } const pc = pieces[lo]; return pc ? pc.file + Math.min(p - pc.at, pc.d.length) : p; };
    const r = await c2paRead(ctx, buf.subarray(0, Math.min(tot, declared > 0 ? declared : tot)), fo, "JPEG APP11 (JUMBF box " + en + ", " + pieces.length + " segment" + (pieces.length === 1 ? "" : "s") + ")", 1);
    const segs = new Set(parts.map(p => p.seg));
    for (const s of ctx.structure) if (s.depth === 0 && segs.has(s.offset) && /^APP11/.test(s.segment)) { s.segment = r.label === "c2pa" ? "APP11 C2PA (JUMBF)" : "APP11 JUMBF" + (r.label ? " " + r.label.slice(0, 40) : ""); if (r.label !== "c2pa") s.kind = "other"; }
  }
}

/* ---------------------------------------------------------------- file type detection */
function detectType(h, ext) {
  const s = latin1(h, 0, 16);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "JPEG";
  if (h[0] === 0x89 && s.slice(1, 4) === "PNG") return "PNG";
  if (s.startsWith("II*\0") && s.slice(8, 10) === "CR") return "CR2";
  if (s.startsWith("IIRO") || s.startsWith("IIRS") || s.startsWith("MMOR")) return "ORF";
  if (s.startsWith("IIU\0")) return "RW2";
  if (s.startsWith("II*\0") || s.startsWith("MM\0*")) return "TIFF";
  if (s.startsWith("II+\0") || s.startsWith("MM\0+")) return "BigTIFF";
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP") return "WEBP";
  if (s.startsWith("RIFF")) return "RIFF";
  if (s.slice(4, 8) === "ftyp") {
    const b = s.slice(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs)$/.test(b)) return "HEIC";
    if (/^(avif|avis)$/.test(b)) return "AVIF";
    if (b === "crx ") return "CR3";
    if (b === "mif1" || b === "msf1") return "HEIF";
    if (b === "qt  ") return "MOV";
    return "MP4";
  }
  if (/^....(moov|mdat|wide|free|skip|pnot)/.test(s)) return "MOV";
  if (s.startsWith("FUJIFILMCCD-RAW")) return "RAF";
  if (s.startsWith("GIF87a") || s.startsWith("GIF89a")) return "GIF";
  if (s.startsWith("%PDF")) return "PDF";
  if (/^(﻿)?\s*<(\?xpacket|x:xmpmeta|\?xml|rdf:RDF)/.test(utf8loose(h.subarray(0, 64)))) return "XMP";
  return "unknown";
}
const MIME = { JPEG: "image/jpeg", PNG: "image/png", TIFF: "image/tiff", BigTIFF: "image/tiff", WEBP: "image/webp", HEIC: "image/heic", HEIF: "image/heif", AVIF: "image/avif",
  MP4: "video/mp4", MOV: "video/quicktime", CR2: "image/x-canon-cr2", CR3: "image/x-canon-cr3", DNG: "image/x-adobe-dng", NEF: "image/x-nikon-nef", ARW: "image/x-sony-arw",
  ORF: "image/x-olympus-orf", RW2: "image/x-panasonic-rw2", RAF: "image/x-fujifilm-raf", GIF: "image/gif", PDF: "application/pdf", XMP: "application/rdf+xml" };

/* ---------------------------------------------------------------- main entry */
async function parse(input, fileName, opts) {
  opts = opts || {};
  const name = String(fileName || (input && input.name) || "file");
  let src;
  try {
    if (input instanceof ArrayBuffer) src = memSource(new Uint8Array(input));
    else if (ArrayBuffer.isView(input)) src = memSource(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    else if (input && typeof input.slice === "function" && typeof input.size === "number") src = input.size <= (opts.maxWhole || LIM.whole) ? memSource(new Uint8Array(await input.arrayBuffer())) : blobSource(input);
    else throw new Error("unsupported input");
  } catch (e) { return { file: { name, size: 0, type: "unknown", mime: "", ext: "" }, groups: [], warnings: [{ code: "input", text: e.message, offset: null }], structure: [], previews: [], raster: null, summary: {} }; }
  const ctx = new Ctx(src, name, opts);
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || ["", ""])[1].toLowerCase();
  const head = await src.read(0, 64);
  let type = detectType(head, ext);
  if (!src.whole) ctx.warn("large-file", "file larger than " + Math.round((opts.maxWhole || LIM.whole) / 1048576) + " MB: only the needed byte ranges were read", null);
  try {
    if (type === "JPEG") await parseJPEG(ctx);
    else if (type === "PNG") await parsePNG(ctx);
    else if (type === "WEBP") await parseWebP(ctx);
    else if (/^(TIFF|BigTIFF|CR2|ORF|RW2)$/.test(type)) await readTIFF(ctx, 0, { headerSeg: "TIFF header", fileLevel: true });
    else if (/^(HEIC|HEIF|AVIF|MP4|MOV|CR3)$/.test(type)) await parseBMFF(ctx);
    else if (type === "XMP") { ctx.seg("XMP sidecar", "xmp", 0, src.size, ""); await parseXMP(ctx, await src.read(0, Math.min(src.size, LIM.bin)), 0, "sidecar"); }
    else if (type === "RAF") {
      const h = await src.read(0, 100), jo = u32be(h, 84), jl = u32be(h, 88);
      ctx.seg("RAF header", "header", 0, 100, "");
      if (jo && jl && jo + jl <= src.size) { ctx.seg("embedded JPEG", "preview", jo, jl, "", 0); ctx.previews.push({ kind: "PreviewImage", offset: jo, length: jl, mime: "image/jpeg" }); const sub = await src.read(jo, 4); if (sub[0] === 0xff && sub[1] === 0xd8) { const b = await src.read(jo, jl); const save = ctx.src; ctx.src = memSource(b); try { await parseJPEG(ctx); } finally { ctx.src = save; } ctx.warn("raf", "EXIF read from the embedded JPEG preview; offsets are relative to it", jo); } }
    }
    else ctx.warn("unknown-format", "format not recognised" + (ext ? " (." + ext + ")" : ""), 0);
  } catch (e) { ctx.warn("parse", (e && e.message) || String(e), null); }
  ctx.structure.sort((a, b) => a.offset - b.offset || a.depth - b.depth || b.length - a.length);
  /* refine type */
  const t0 = ctx.gmap.get("EXIF:IFD0");
  const has = n => t0 && t0.tags.some(t => t.name === n);
  if ((type === "TIFF" || type === "BigTIFF") && has("DNGVersion")) type = "DNG";
  else if (type === "TIFF" && ({ nef: "NEF", nrw: "NEF", arw: "ARW", srf: "ARW", sr2: "ARW", pef: "PEF", srw: "SRW", "3fr": "3FR", iiq: "IIQ", erf: "ERF", kdc: "KDC", mos: "MOS" })[ext]) type = ({ nef: "NEF", nrw: "NEF", arw: "ARW", srf: "ARW", sr2: "ARW", pef: "PEF", srw: "SRW", "3fr": "3FR", iiq: "IIQ", erf: "ERF", kdc: "KDC", mos: "MOS" })[ext];
  const result = { file: { name, size: src.size, type, mime: MIME[type] || "", ext, byteOrder: ctx.info.byteOrder || null }, groups: ctx.groups, warnings: ctx.warnings, structure: ctx.structure,
    previews: ctx.previews, raster: ctx.raster, info: ctx.info, summary: {} };
  /* File group first */
  const fg = { id: "File", tags: [] };
  const ft = (n, v, d) => fg.tags.push({ name: n, id: n, value: v, display: d == null ? autoDisp(v) : d, type: "", count: 1, offset: null });
  ft("FileName", name); ft("FileSize", src.size, fmtBytes(src.size)); ft("FileType", type); if (ext) ft("FileTypeExtension", ext); if (MIME[type]) ft("MIMEType", MIME[type]);
  if (ctx.info.byteOrder) ft("ExifByteOrder", ctx.info.byteOrder, ctx.info.byteOrder === "II" ? "Little-endian (Intel, II)" : "Big-endian (Motorola, MM)");
  const oldFile = ctx.gmap.get("File");
  if (oldFile) { fg.tags.push(...oldFile.tags); result.groups.splice(result.groups.indexOf(oldFile), 1); }
  result.groups.unshift(fg);
  if (ext && type !== "unknown") { const extType = ({ jpg: "JPEG", jpeg: "JPEG", jpe: "JPEG", tif: "TIFF", tiff: "TIFF", png: "PNG", webp: "WEBP", heic: "HEIC", heif: "HEIF", avif: "AVIF", mp4: "MP4", mov: "MOV", dng: "DNG", cr2: "CR2", cr3: "CR3" })[ext]; if (extType && extType !== type && !(extType === "TIFF" && /DNG|BigTIFF|NEF|ARW/.test(type)) && !(extType === "HEIC" && type === "HEIF") && !(extType === "MP4" && type === "MOV") && !(extType === "MOV" && type === "MP4")) result.warnings.push({ code: "ext-mismatch", text: "extension ." + ext + " but content is " + type, offset: 0 }); }
  if (/^(TIFF|BigTIFF)$/.test(type)) { try { const st = await bandStats(ctx); if (st) ctx.info.band = st; } catch (e) { /* pixel statistics are optional */ } }
  try { derive(result, opts, ctx.pendingComposite); } catch (e) { result.warnings.push({ code: "derive", text: e.message, offset: null }); }
  return result;
}
function fmtBytes(n) { return n < 1024 ? n + " bytes" : n < 1048576 ? num(rnd(n / 1024, 1)) + " kB" : n < 1073741824 ? num(rnd(n / 1048576, 1)) + " MB" : num(rnd(n / 1073741824, 2)) + " GB"; }

/* ---------------------------------------------------------------- tag lookup over a result */
function index(result) {
  const ix = new Map();
  for (const g of result.groups) for (const t of g.tags) {
    const k = t.name; if (!ix.has(k)) ix.set(k, []); ix.get(k).push({ g: g.id, t });
  }
  return ix;
}
function pick(ix, name, groupRe) { const a = ix.get(name); if (!a) return null; for (const x of a) if (!groupRe || groupRe.test(x.g)) return x; return null; }

/* ---------------------------------------------------------------- NOAA solar position (Meeus-based NOAA spreadsheet algorithm, gml.noaa.gov/grad/solcalc) */
function solarPosition(date, lat, lon) {
  const rad = Math.PI / 180, ms = date instanceof Date ? date.getTime() : date;
  const jd = ms / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
  const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T), e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
  const omega = 125.04 - 1934.136 * T, lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60, eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) / rad;
  const y = Math.pow(Math.tan(eps * rad / 2), 2);
  const eot = 4 / rad * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const d = new Date(ms), minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  let tst = ((minutes + eot + 4 * lon) % 1440 + 1440) % 1440, ha = tst / 4 - 180; if (ha < -180) ha += 360;
  const cz = Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad);
  const zen = Math.acos(Math.max(-1, Math.min(1, cz))) / rad, el0 = 90 - zen;
  let refr = 0; const te = Math.tan(el0 * rad);
  if (el0 > 85) refr = 0; else if (el0 > 5) refr = 58.1 / te - 0.07 / Math.pow(te, 3) + 0.000086 / Math.pow(te, 5); else if (el0 > -0.575) refr = 1735 + el0 * (-518.2 + el0 * (103.4 + el0 * (-12.79 + el0 * 0.711))); else refr = -20.772 / te;
  const el = el0 + refr / 3600;
  const ca = (Math.sin(lat * rad) * Math.cos(zen * rad) - Math.sin(decl * rad)) / (Math.cos(lat * rad) * Math.sin(zen * rad));
  const a = Math.acos(Math.max(-1, Math.min(1, ca))) / rad;
  const az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  return { elevation: el, azimuth: az, zenith: 90 - el, declination: decl, equationOfTime: eot };
}

/* ---------------------------------------------------------------- composite and derived values */
const LEAP = [[Date.UTC(2017, 0, 1), 18], [Date.UTC(2015, 6, 1), 17], [Date.UTC(2012, 6, 1), 16], [Date.UTC(2009, 0, 1), 15], [Date.UTC(2006, 0, 1), 14], [Date.UTC(1999, 0, 1), 13]];
function gpsUtcOffset(ms) { for (const [t, n] of LEAP) if (ms >= t) return n; return 13; } /* GPS - UTC in seconds */
function parseDT(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})[:\-](\d\d)[:\-](\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?)?\s*(Z|[+\-]\d\d:?\d\d)?/.exec(s.trim());
  if (!m || +m[1] < 1900) return null;
  let tz = null; if (m[8]) { if (m[8] === "Z") tz = 0; else { const t = m[8].replace(":", ""); tz = (t[0] === "-" ? -1 : 1) * (+t.slice(1, 3) * 60 + +t.slice(3, 5)); } }
  return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) + (m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0), tz, hasTime: !!m[4] };
}
function tzStr(min) { const s = min < 0 ? "-" : "+", a = Math.abs(min); return s + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0"); }
function iso(ms, tzMin) { const d = new Date(ms + (tzMin || 0) * 60000).toISOString(); return tzMin == null || tzMin === 0 ? d : d.replace("Z", tzStr(tzMin)); }
function parseISO6709(s) { const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(s || ""); return m ? { lat: +m[1], lon: +m[2], alt: m[3] != null ? +m[3] : null } : null; }
function xmpGPS(s) { /* XMP exif:GPSLatitude "DDD,MM.mmk" or "DDD,MM,SSk" */
  if (typeof s !== "string") return NaN; const m = /^(\d+),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/.exec(s.trim()); if (!m) return parseFloat(s);
  const v = +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0); return /[SW]/.test(m[4]) ? -v : v;
}
function derive(result, opts, pending) {
  opts = opts || {};
  /* drop previous derived/composite groups when re-deriving */
  result.groups = result.groups.filter(g => g.id !== "Composite" && g.id !== "Derived");
  const ix = index(result), V = (n, re) => { const x = pick(ix, n, re); return x ? x.t.value : undefined; }, ID = (n, re) => { const x = pick(ix, n, re); return x ? x.g + ":" + n : null; };
  const comp = { id: "Composite", tags: [] }, der = { id: "Derived", tags: [] };
  const C = (name, value, display, from, note) => comp.tags.push({ name, id: name, value, display: display == null ? autoDisp(value) : display, type: "", count: 1, offset: null, from: from.filter(Boolean), note });
  const D = (name, value, display, from, note) => der.tags.push({ name, id: name, value, display: display == null ? autoDisp(value) : display, type: "", count: 1, offset: null, from: (from || []).filter(Boolean), note: note || "" });
  const S = { file: result.file.name, type: result.file.type };
  const EX = /^EXIF:/, GPS = /^EXIF:GPS$/, DJI = /^XMP:drone-dji$/, CAM = /^XMP:Camera$/, DLS = /^XMP:DLS$/, MS = /^XMP:MicaSense$/, MN = /^MakerNotes:DJI$/, SF = /^XMP:sensefly$/;
  const make = V("Make", EX) || V("Make", /^XMP:tiff$/) || V("Make", /^QuickTime/) || ""; S.make = String(make).trim();
  S.model = String(V("Model", EX) || V("Model", /^XMP:tiff$/) || V("Model", /^QuickTime/) || "").trim();
  S.serial = V("SerialNumber", EX) || V("CameraSerialNumber", EX) || V("SerialNumber", /^XMP/) || null; S.serialSrc = ID("SerialNumber", EX) || ID("CameraSerialNumber", EX) || ID("SerialNumber", /^XMP/);
  S.software = V("Software", EX) || V("Software", /^QuickTime/) || null;
  S.droneModel = V("DroneModel", DJI) || null;
  S.owner = V("OwnerName", EX) || V("Artist", EX) || V("By-line", /IPTC/) || V("Creator", /^XMP:dc$/) || null;
  /* image size */
  const W = V("ImageWidth", /^File$/) || V("ImageWidth", /^EXIF:IFD0$/) || V("ImageWidth", /^PNG$/) || V("ImageWidth", /^RIFF$/) || V("ImageWidth", /^QuickTime/) || V("ExifImageWidth", EX);
  const H = V("ImageHeight", /^File$/) || V("ImageHeight", /^EXIF:IFD0$/) || V("ImageHeight", /^PNG$/) || V("ImageHeight", /^RIFF$/) || V("ImageHeight", /^QuickTime/) || V("ExifImageHeight", EX);
  if (isNum(W) && isNum(H)) { C("ImageSize", W + "x" + H, null, [ID("ImageWidth", /^File$/) || ID("ImageWidth", /^(EXIF:IFD0|PNG|RIFF|QuickTime)/), ID("ImageHeight", /^File$/) || ID("ImageHeight", /^(EXIF:IFD0|PNG|RIFF|QuickTime)/)]); C("Megapixels", Number((W * H / 1e6).toPrecision(3)), num(W * H / 1e6, 3), ["Composite:ImageSize"]); }
  S.width = W; S.height = H;
  const EW = V("ExifImageWidth", EX) || V("ExifImageWidth", /^XMP:exif$/), EH = V("ExifImageHeight", EX) || V("ExifImageHeight", /^XMP:exif$/);
  S.sensorPxW = toNum(EW) || W; S.sensorPxH = toNum(EH) || H;
  const bps = V("BitsPerSample", /^(EXIF:IFD0|File)$/) || V("BitDepth", /^PNG$/); S.bitDepth = Array.isArray(bps) ? bps[0] : bps; S.channels = V("SamplesPerPixel", /^EXIF:IFD0$/) || V("ColorComponents", /^File$/) || null;
  /* exposure */
  const t = V("ExposureTime", EX), N = V("FNumber", EX), ssv = V("ShutterSpeedValue", EX), av = V("ApertureValue", EX);
  const isoV = V("ISO", EX) || V("ISOSpeed", EX) || V("RecommendedExposureIndex", EX) || V("StandardOutputSensitivity", EX);
  const A = isNum(N) && N > 0 ? N : isNum(av) ? Math.pow(2, av / 2) : null, Sh = isNum(t) && t > 0 ? t : isNum(ssv) ? Math.pow(2, -ssv) : null;
  if (A) C("Aperture", rnd(A, 2), A.toFixed(1), [ID("FNumber", EX) || ID("ApertureValue", EX)]);
  if (Sh) C("ShutterSpeed", Sh, expTime(Sh), [ID("ExposureTime", EX) || ID("ShutterSpeedValue", EX)]);
  const isoN = toNum(isoV);
  if (A && Sh && isoN > 0) { const lv = 2 * Math.log2(A) - Math.log2(Sh) - Math.log2(isoN / 100); C("LightValue", rnd(lv, 1), lv.toFixed(1), ["Composite:Aperture", "Composite:ShutterSpeed", ID("ISO", EX) || ID("ISOSpeed", EX)]); S.lv = lv; }
  S.exposureTime = Sh; S.fnumber = A; S.iso = isNum(isoN) ? isoN : null; S.exposureProgram = V("ExposureProgram", EX); S.exposureMode = V("ExposureMode", EX); S.exposureBias = V("ExposureCompensation", EX);
  const djiExp = toNum(V("ExposureTime", DJI)); if (isNum(djiExp)) { S.exposureTimeDJI = djiExp / 1e6; }
  /* focal length, crop factor, pixel pitch */
  const f = toNum(V("FocalLength", EX)), f35 = toNum(V("FocalLengthIn35mmFormat", EX)); S.focal = isNum(f) ? f : null; S.focal35 = isNum(f35) && f35 > 0 ? f35 : null;
  let pitch = null, pitchSrc = null, pitchNote = "";
  const fpx = toNum(V("FocalPlaneXResolution", EX)), fpu = V("FocalPlaneResolutionUnit", EX), unitMM = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 }[fpu];
  const cfpx = toNum(V("CalibratedFocalLength", DJI));
  if (isNum(fpx) && fpx > 0 && unitMM) { pitch = unitMM / fpx * 1000; pitchSrc = [ID("FocalPlaneXResolution", EX), ID("FocalPlaneResolutionUnit", EX)]; pitchNote = "pitch = unit / FocalPlaneXResolution"; }
  else if (isNum(cfpx) && cfpx > 0 && isNum(f) && f > 0) { pitch = f / cfpx * 1000; pitchSrc = [ID("FocalLength", EX), "XMP:drone-dji:CalibratedFocalLength"]; pitchNote = "pitch = FocalLength [mm] / CalibratedFocalLength [px]"; }
  else if (S.focal35 && isNum(f) && f > 0 && isNum(S.sensorPxW) && S.sensorPxW >= 100) { const crop = S.focal35 / f; pitch = 36 / crop / S.sensorPxW * 1000; pitchSrc = [ID("FocalLength", EX), ID("FocalLengthIn35mmFormat", EX), ID("ExifImageWidth", EX) || "Composite:ImageSize"]; pitchNote = "sensor width = 36 mm / (FocalLengthIn35mmFormat / FocalLength); estimate"; }
  if (S.focal35 && isNum(f) && f > 0) { const sc = S.focal35 / f; C("ScaleFactor35efl", rnd(sc, 3), sc.toFixed(1), [ID("FocalLength", EX), ID("FocalLengthIn35mmFormat", EX)]); C("FocalLength35efl", rnd(S.focal35, 1), f.toFixed(1) + " mm (35 mm equivalent: " + S.focal35.toFixed(1) + " mm)", [ID("FocalLength", EX), "Composite:ScaleFactor35efl"]); S.crop = sc; }
  else if (isNum(f) && f > 0 && pitch && isNum(S.sensorPxW) && isNum(S.sensorPxH)) { const diag = Math.hypot(S.sensorPxW, S.sensorPxH) * pitch / 1000, sc = 43.2666 / diag; C("ScaleFactor35efl", rnd(sc, 3), sc.toFixed(1), pitchSrc.concat([ID("ExifImageWidth", EX)])); C("FocalLength35efl", rnd(f * sc, 1), f.toFixed(1) + " mm (35 mm equivalent: " + (f * sc).toFixed(1) + " mm)", [ID("FocalLength", EX), "Composite:ScaleFactor35efl"]); S.crop = sc; }
  if (pitch) {
    S.pixelPitch = pitch; S.pixelPitchSrc = pitchSrc; S.pixelPitchNote = pitchNote;
    D("PixelPitch", rnd(pitch, 4), num(rnd(pitch, 3)) + " um", pitchSrc, pitchNote);
    if (isNum(S.sensorPxW) && isNum(S.sensorPxH)) {
      S.sensorW = S.sensorPxW * pitch / 1000; S.sensorH = S.sensorPxH * pitch / 1000;
      D("SensorSize", [rnd(S.sensorW, 3), rnd(S.sensorH, 3)], num(rnd(S.sensorW, 2)) + " x " + num(rnd(S.sensorH, 2)) + " mm", ["Derived:PixelPitch", ID("ExifImageWidth", EX) || "Composite:ImageSize"], "sensor = pixel pitch x image size in pixels");
      if (S.focal) { S.hfov = 2 * Math.atan(S.sensorW / 2 / S.focal) * 180 / Math.PI; S.vfov = 2 * Math.atan(S.sensorH / 2 / S.focal) * 180 / Math.PI; D("FieldOfView", [rnd(S.hfov, 2), rnd(S.vfov, 2)], num(rnd(S.hfov, 1)) + " x " + num(rnd(S.vfov, 1)) + " deg", ["Derived:SensorSize", ID("FocalLength", EX)], "FOV = 2 atan(sensor / 2f)"); }
    }
  }
  /* GPS position */
  let lat = null, lon = null, posSrc = null;
  const glat = V("GPSLatitude", GPS), glon = V("GPSLongitude", GPS), glr = V("GPSLatitudeRef", GPS), glor = V("GPSLongitudeRef", GPS);
  if (Array.isArray(glat) && Array.isArray(glon) && glat.length >= 3 && glon.length >= 3) {
    lat = (glat[0] + glat[1] / 60 + glat[2] / 3600) * (glr === "S" ? -1 : 1); lon = (glon[0] + glon[1] / 60 + glon[2] / 3600) * (glor === "W" ? -1 : 1);
    if (isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0)) {
      posSrc = "EXIF:GPS";
      C("GPSLatitude", rnd(lat, 8), dmsDeg(lat) + " " + (lat < 0 ? "S" : "N"), ["EXIF:GPS:GPSLatitude", "EXIF:GPS:GPSLatitudeRef"]);
      C("GPSLongitude", rnd(lon, 8), dmsDeg(lon) + " " + (lon < 0 ? "W" : "E"), ["EXIF:GPS:GPSLongitude", "EXIF:GPS:GPSLongitudeRef"]);
    } else { lat = lon = null; }
  }
  if (lat == null) {
    const dlat = toNum(V("GPSLatitude", DJI)), dlon = toNum(V("GPSLongitude", DJI) != null ? V("GPSLongitude", DJI) : V("GPSLongtitude", DJI));
    if (isNum(dlat) && isNum(dlon) && !(dlat === 0 && dlon === 0)) { lat = dlat; lon = dlon; posSrc = "XMP:drone-dji"; }
    else { const xl = xmpGPS(V("GPSLatitude", /^XMP:exif$/)), xo = xmpGPS(V("GPSLongitude", /^XMP:exif$/)); if (isNum(xl) && isNum(xo)) { lat = xl; lon = xo; posSrc = "XMP:exif"; C("GPSLatitude", rnd(lat, 8), dmsDeg(lat) + " " + (lat < 0 ? "S" : "N"), ["XMP:exif:GPSLatitude"]); C("GPSLongitude", rnd(lon, 8), dmsDeg(lon) + " " + (lon < 0 ? "W" : "E"), ["XMP:exif:GPSLongitude"]); }
      else { const q = parseISO6709(result.info && result.info.iso6709); if (q) { lat = q.lat; lon = q.lon; posSrc = "QuickTime:GPSCoordinates"; C("GPSLatitude", rnd(lat, 8), dmsDeg(lat) + " " + (lat < 0 ? "S" : "N"), ["QuickTime:GPSCoordinates"]); C("GPSLongitude", rnd(lon, 8), dmsDeg(lon) + " " + (lon < 0 ? "W" : "E"), ["QuickTime:GPSCoordinates"]); } }
    }
  }
  if (lat != null && posSrc !== "XMP:drone-dji") C("GPSPosition", [rnd(lat, 8), rnd(lon, 8)], dmsDeg(lat) + " " + (lat < 0 ? "S" : "N") + ", " + dmsDeg(lon) + " " + (lon < 0 ? "W" : "E"), ["Composite:GPSLatitude", "Composite:GPSLongitude"]);
  S.lat = lat; S.lon = lon; S.posSrc = posSrc;
  const galt = toNum(V("GPSAltitude", GPS)), gref = V("GPSAltitudeRef", GPS);
  if (isNum(galt)) { const a = (gref === 1 || gref === 3) ? -galt : galt; S.altGPS = a; S.altGPSRef = gref; C("GPSAltitude", rnd(a, 3), num(rnd(Math.abs(a), 3)) + " m " + (a < 0 ? "Below" : "Above") + " Sea Level", ["EXIF:GPS:GPSAltitude", "EXIF:GPS:GPSAltitudeRef"], gref >= 2 ? "Exif 3.0: GPSAltitudeRef 2/3 = sea-level reference; 0/1 = ellipsoidal height" : "Exif 2.x: above sea level; Exif 3.0 redefines 0/1 as ellipsoidal height"); }
  S.altAbs = toNum(V("AbsoluteAltitude", DJI)); if (!isNum(S.altAbs)) S.altAbs = null;
  S.altRel = toNum(V("RelativeAltitude", DJI)); if (!isNum(S.altRel)) S.altRel = null;
  S.altitudeType = V("AltitudeType", DJI) || null;
  S.vertCS = V("VertCS", CAM) || null; S.horizCS = V("HorizCS", CAM) || null;
  S.mapDatum = V("GPSMapDatum", GPS) || null;
  /* attitude, speed */
  const n2 = (n, re) => { const v = toNum(V(n, re)); return isNum(v) ? v : null; };
  S.flight = { roll: n2("FlightRollDegree", DJI), pitch: n2("FlightPitchDegree", DJI), yaw: n2("FlightYawDegree", DJI), src: "XMP:drone-dji" };
  if (S.flight.roll == null && n2("Roll", MN) != null) S.flight = { roll: n2("Roll", MN), pitch: n2("Pitch", MN), yaw: n2("Yaw", MN), src: "MakerNotes:DJI" };
  if (S.flight.roll == null && n2("Roll", CAM) != null) S.flight = { roll: n2("Roll", CAM), pitch: n2("Pitch", CAM), yaw: n2("Yaw", CAM), src: "XMP:Camera" };
  if (S.flight.roll == null && n2("Roll", SF) != null) S.flight = { roll: n2("Roll", SF), pitch: n2("Pitch", SF), yaw: n2("Yaw", SF), src: "XMP:sensefly" };
  S.gimbal = { roll: n2("GimbalRollDegree", DJI), pitch: n2("GimbalPitchDegree", DJI), yaw: n2("GimbalYawDegree", DJI), src: "XMP:drone-dji" };
  if (S.gimbal.pitch == null && n2("CameraPitch", MN) != null) S.gimbal = { roll: n2("CameraRoll", MN), pitch: n2("CameraPitch", MN), yaw: n2("CameraYaw", MN), src: "MakerNotes:DJI" };
  S.speed = { x: n2("FlightXSpeed", DJI), y: n2("FlightYSpeed", DJI), z: n2("FlightZSpeed", DJI), src: "XMP:drone-dji" };
  if (S.speed.x == null && n2("SpeedX", MN) != null) S.speed = { x: n2("SpeedX", MN), y: n2("SpeedY", MN), z: n2("SpeedZ", MN), src: "MakerNotes:DJI" };
  if (S.speed.x != null) { S.groundSpeed = Math.hypot(S.speed.x, S.speed.y || 0); D("GroundSpeed", rnd(S.groundSpeed, 2), num(rnd(S.groundSpeed, 2)) + " m/s", S.speed.src === "MakerNotes:DJI" ? ["MakerNotes:DJI:SpeedX", "MakerNotes:DJI:SpeedY"] : [S.speed.src + ":FlightXSpeed", S.speed.src + ":FlightYSpeed"], "sqrt(X^2 + Y^2)"); }
  /* RTK / GNSS quality */
  const rf = V("RtkFlag", DJI), gs = V("GpsStatus", DJI);
  S.rtk = { flag: rf != null ? toNum(rf) : null, gpsStatus: gs || null, sx: n2("RtkStdLon", DJI), sy: n2("RtkStdLat", DJI), sz: n2("RtkStdHgt", DJI), diffAge: n2("RtkDiffAge", DJI), state: null, src: rf != null ? "XMP:drone-dji:RtkFlag" : null };
  if (S.rtk.flag != null && isNum(S.rtk.flag)) { const fl = S.rtk.flag; S.rtk.state = fl === 50 ? "fixed" : fl === 48 || fl === 49 ? "int" : fl >= 32 && fl <= 34 ? "float" : fl === 16 ? "single" : fl === 0 ? (lat != null && S.rtk.sx == null ? "single" : "none") : "other"; if (fl === 0 && S.rtk.state === "single") S.rtk.noRtk = true; }
  else if (gs) S.rtk.state = /rtk/i.test(gs) ? "rtk" : /normal/i.test(gs) ? "single" : /invalid/i.test(gs) ? "none" : null;
  if (S.rtk.sx == null && n2("GPSXYAccuracy", CAM) != null) { S.rtk.sx = S.rtk.sy = n2("GPSXYAccuracy", CAM); S.rtk.sz = n2("GPSZAccuracy", CAM); S.rtk.sigmaSrc = "XMP:Camera"; } else if (S.rtk.sx == null && n2("GPSXYAccuracy", SF) != null) { S.rtk.sx = S.rtk.sy = n2("GPSXYAccuracy", SF); S.rtk.sz = n2("GPSZAccuracy", SF); S.rtk.sigmaSrc = "XMP:sensefly"; } else if (S.rtk.sx != null) S.rtk.sigmaSrc = "XMP:drone-dji";
  if (S.rtk.state) D("GNSSSolution", S.rtk.state, S.rtk.state + (S.rtk.flag != null ? " (RtkFlag " + S.rtk.flag + ")" : ""), [S.rtk.src, gs ? "XMP:drone-dji:GpsStatus" : null, S.rtk.noRtk ? "Composite:GPSLatitude" : null], "DJI: 0 none, 16 single point, 32-34 float, 48-49 lower-grade integer, 50 fixed (narrow-lane integer)" + (S.rtk.noRtk ? "; RtkFlag 0 with a valid position = drone without RTK, standalone GNSS" : ""));
  const hpe = n2("GPSHPositioningError", GPS); if (hpe != null) S.rtk.hpe = hpe;
  /* time */
  const dto = V("DateTimeOriginal", EX), sso = V("SubSecTimeOriginal", EX), oto = V("OffsetTimeOriginal", EX) || V("OffsetTime", EX);
  const dtc = V("CreateDate", EX), ssc = V("SubSecTimeDigitized", EX), otc = V("OffsetTimeDigitized", EX), dtm = V("ModifyDate", /^EXIF:IFD0$/), ssm = V("SubSecTime", EX), otm = V("OffsetTime", EX);
  const sub = (d, ss, o) => d + (ss != null && String(ss).trim() !== "" ? "." + String(ss).trim() : "") + (o ? String(o).trim() : "");
  if (dto && (sso != null || oto)) C("SubSecDateTimeOriginal", sub(dto, sso, oto), null, [ID("DateTimeOriginal", EX), ID("SubSecTimeOriginal", EX), ID("OffsetTimeOriginal", EX)]);
  if (dtc && (ssc != null || otc)) C("SubSecCreateDate", sub(dtc, ssc, otc), null, [ID("CreateDate", EX), ID("SubSecTimeDigitized", EX), ID("OffsetTimeDigitized", EX)]);
  if (dtm && (ssm != null || otm)) C("SubSecModifyDate", sub(dtm, ssm, otm), null, [ID("ModifyDate", EX), ID("SubSecTime", EX), ID("OffsetTime", EX)]);
  const gds = V("GPSDateStamp", GPS), gts = V("GPSTimeStamp", GPS);
  let gpsMs = null;
  if (gds && Array.isArray(gts) && gts.length >= 3) { const p = parseDT(String(gds).replace(/:/g, "-") + "T00:00:00"); if (p) { gpsMs = p.ms + Math.round((gts[0] * 3600 + gts[1] * 60 + gts[2]) * 1000); C("GPSDateTime", iso(gpsMs).replace(/-/g, ":").replace("T", " ").replace(/\.000Z$/, "Z"), null, ["EXIF:GPS:GPSDateStamp", "EXIF:GPS:GPSTimeStamp"]); } }
  const local = parseDT(dto ? sub(dto, sso, null) : null) || parseDT(V("DateTimeOriginal", /^XMP:exif$/)) || parseDT(V("CreateDate", /^XMP:xmp$/)) || parseDT(V("DateCreated", /^XMP:photoshop$/));
  let utcMs = null, utcSrc = null, tz = null, tzSrc = null;
  const djiUtc = parseDT(V("UTCAtExposure", DJI));
  if (djiUtc) { const ls = gpsUtcOffset(djiUtc.ms); utcMs = djiUtc.ms - (djiUtc.tz || 0) * 60000 - ls * 1000; utcSrc = "XMP:drone-dji:UTCAtExposure - " + ls + " s"; S.djiGpsTime = true; }
  if (utcMs == null && local && oto) { const o = parseDT("2000:01:01 00:00:00" + String(oto).trim()); if (o && o.tz != null) { tz = o.tz; tzSrc = ID("OffsetTimeOriginal", EX) || ID("OffsetTime", EX); utcMs = local.ms - tz * 60000; utcSrc = "DateTimeOriginal + " + (tzSrc || "OffsetTimeOriginal"); } }
  if (utcMs == null && local && local.tz != null) { tz = local.tz; utcMs = local.ms - tz * 60000; utcSrc = "XMP date with time zone"; tzSrc = "XMP"; }
  const djiMake = /^(dji|hasselblad)$/i.test(S.make);
  if (utcMs == null && gpsMs != null) { if (djiMake) { const ls = gpsUtcOffset(gpsMs); utcMs = gpsMs - ls * 1000; utcSrc = "GPSDateStamp + GPSTimeStamp - " + ls + " s (DJI writes GPS time)"; } else { utcMs = gpsMs; utcSrc = "GPSDateStamp + GPSTimeStamp"; } }
  if (utcMs == null && local && /micasense/i.test(S.make)) { utcMs = local.ms; utcSrc = "DateTimeOriginal (MicaSense writes UTC)"; tz = 0; tzSrc = "MicaSense convention"; }
  if (utcMs == null && local && /^(sensefly|parrot)$/i.test(S.make)) { utcMs = local.ms; utcSrc = "DateTimeOriginal (" + S.make + " writes UTC)"; tz = 0; tzSrc = S.make + " convention (checked against GPS time and the eMotion flight log)"; }
  if (utcMs == null && result.info && result.info.qtCreate) { utcMs = result.info.qtCreate; utcSrc = "QuickTime:CreateDate (UTC)"; }
  const refMs = utcMs != null && utcSrc && !/^DateTimeOriginal/.test(utcSrc) ? utcMs : null;
  if (tz == null && local && refMs != null) { const dmin = Math.round((local.ms - refMs) / 60000 / 15) * 15; if (Math.abs(dmin) <= 14 * 60 && Math.abs(local.ms - refMs - dmin * 60000) < 300000) { tz = dmin; tzSrc = "DateTimeOriginal - UTC (" + (djiUtc ? "UTCAtExposure" : "GPS time") + ")"; } }
  // a reference in whole seconds (GPSTimeStamp rewritten without a fraction, e.g. by WingtraHub) is compared in whole seconds, so a sub-second part of DateTimeOriginal does not show up as an offset
  if (local && refMs != null && tz != null) { const whole = refMs % 1000 === 0, lms = whole ? Math.floor(local.ms / 1000) * 1000 : local.ms, off = (lms - refMs - tz * 60000) / 1000; S.clockOffset = off; D("CameraClockOffset", rnd(off, 1), (off >= 0 ? "+" : "") + num(rnd(off, 1)) + " s", [ID("DateTimeOriginal", EX), utcSrc], "DateTimeOriginal - time zone - UTC; whole seconds when either time has no fraction (DateTimeOriginal without SubSecTimeOriginal, GPSTimeStamp without decimals)"); }
  S.localTime = local ? iso(local.ms).replace(/Z$/, "") : null; S.utc = utcMs != null ? iso(utcMs) : null; S.utcMs = utcMs; S.utcSrc = utcSrc; S.tz = tz; S.tzSrc = tzSrc;
  if (utcMs != null) D("DateTimeUTC", S.utc, S.utc, [utcSrc], tzSrc ? "time zone: " + tzStr(tz || 0) + " (" + tzSrc + ")" : "");
  else if (local) D("DateTimeUTC", null, "(unknown: local time without time zone)", [ID("DateTimeOriginal", EX)], "no OffsetTimeOriginal, no GPS time, no UTC tag");
  if (tz != null && tzSrc) D("TimeZone", tzStr(tz), tzStr(tz), [tzSrc]);
  if (local) { const ld = new Date(local.ms), yr = ld.getUTCFullYear(), reset = ld.getUTCMonth() === 0 && ld.getUTCDate() === 1 && ld.getUTCHours() < 6, gpsOff = gpsMs != null && Math.abs(local.ms - gpsMs) > 86400000;
    // cameras write DateTimeOriginal and CreateDate from one clock; a difference of more than a day means one was rewritten after capture
    // (WingtraHub 2.20 rewrites DateTimeOriginal of Sony a6100 photos and keeps CreateDate from an unset camera clock, 2019-01-01)
    const cd = parseDT(dtc), rew = cd && Math.abs(local.ms - cd.ms) > 86400000;
    if (!(reset || yr < 2005 || gpsOff) && rew) { S.clockSuspect = "rewritten"; D("ClockCheck", S.clockSuspect, "DateTimeOriginal differs from CreateDate (" + dtc + ") by more than one day: one of them was rewritten after capture", [ID("DateTimeOriginal", EX), ID("CreateDate", EX)], "take the time from the flight log"); result.warnings.push({ code: "clock", text: "DateTimeOriginal " + S.localTime + " and CreateDate " + dtc + " differ by more than one day", offset: null }); }
    else if (reset || yr < 2005 || gpsOff) { S.clockSuspect = reset ? "reset" : yr < 2005 ? "old" : "gps-mismatch"; D("ClockCheck", S.clockSuspect, reset ? "camera clock probably not set (1 January, early morning)" : yr < 2005 ? "camera clock probably not set (year " + yr + ")" : "DateTimeOriginal differs from GPS time by more than one day", [ID("DateTimeOriginal", EX), gpsMs != null ? "Composite:GPSDateTime" : null], "take the time from the flight log"); result.warnings.push({ code: "clock", text: "camera clock suspect: DateTimeOriginal " + S.localTime, offset: null }); } }
  /* sun position */
  if (utcMs != null && lat != null) { const sp = solarPosition(utcMs, lat, lon); S.sun = sp; D("SunElevation", rnd(sp.elevation, 2), num(rnd(sp.elevation, 1)) + " deg", ["Derived:DateTimeUTC", "Composite:GPSLatitude"], "NOAA solar position algorithm, with refraction"); D("SunAzimuth", rnd(sp.azimuth, 2), num(rnd(sp.azimuth, 1)) + " deg", ["Derived:DateTimeUTC", "Composite:GPSLongitude"], "clockwise from north"); }
  /* GSD */
  const hUser = isNum(opts.height) ? opts.height : null, Hh = hUser != null ? hUser : S.altRel;
  S.gsdHeight = Hh; S.gsdHeightSrc = hUser != null ? "user" : S.altRel != null ? "XMP:drone-dji:RelativeAltitude" : null;
  if (pitch && S.focal && isNum(Hh) && Hh > 0) {
    S.gsd = pitch * 1e-6 * Hh / (S.focal * 1e-3); /* m/px */
    D("GSD", rnd(S.gsd * 100, 3), num(rnd(S.gsd * 100, 2)) + " cm/px at " + num(rnd(Hh, 1)) + " m", ["Derived:PixelPitch", ID("FocalLength", EX), hUser != null ? "user height" : "XMP:drone-dji:RelativeAltitude"], "GSD = pixel pitch x H / f; flat terrain at the take-off level assumed");
    if (isNum(S.sensorPxW) && isNum(S.sensorPxH)) { S.footprint = [S.gsd * S.sensorPxW, S.gsd * S.sensorPxH]; D("Footprint", [rnd(S.footprint[0], 1), rnd(S.footprint[1], 1)], num(rnd(S.footprint[0], 1)) + " x " + num(rnd(S.footprint[1], 1)) + " m", ["Derived:GSD", ID("ExifImageWidth", EX) || "Composite:ImageSize"], "nadir view assumed"); }
  }
  /* bands, irradiance, gain */
  const bn = V("BandName", DJI) || V("BandName", CAM); const bf = V("BandFreq", DJI); const cw = toNum(V("CentralWavelength", CAM)), fw = toNum(V("WavelengthFWHM", CAM));
  S.band = bn ? { name: String(bn), src: V("BandName", DJI) ? "XMP:drone-dji:BandName" : "XMP:Camera:BandName", wl: null, fwhm: null, wlSrc: null } : null;
  if (S.band) { if (isNum(cw)) { S.band.wl = cw; S.band.wlSrc = "XMP:Camera:CentralWavelength"; } else if (bf) { const m = /(\d+(?:\.\d+)?)\s*\(\+\/-\s*(\d+(?:\.\d+)?)\)/.exec(String(bf)); if (m) { S.band.wl = +m[1]; S.band.halfWidth = +m[2]; S.band.wlSrc = "XMP:drone-dji:BandFreq"; } else { const w2 = toNum(bf); if (isNum(w2)) { S.band.wl = w2; S.band.wlSrc = "XMP:drone-dji:BandFreq"; } } } if (isNum(fw)) S.band.fwhm = fw;
    D("Band", S.band.name, S.band.name + (S.band.wl ? " " + S.band.wl + " nm" : "") + (S.band.fwhm ? " (FWHM " + S.band.fwhm + " nm)" : S.band.halfWidth ? " (+/-" + S.band.halfWidth + " nm)" : ""), [S.band.src, S.band.wlSrc]); }
  const ird = toNum(V("Irradiance", DJI)), cirr = toNum(V("Irradiance", CAM)), hirr = toNum(V("HorizontalIrradiance", DLS)), sirr = toNum(V("SpectralIrradiance", DLS));
  if (isNum(cirr) && isNum(hirr)) S.irradiance = { value: cirr, raw: cirr, unit: "uW/cm2/nm", src: "XMP:Camera:Irradiance", note: "DLS2 (XMP:DLS:HorizontalIrradiance present): Camera:Irradiance is already in uW/cm2/nm (= W/m2/nm x 100)" };
  else if (isNum(cirr)) S.irradiance = { value: cirr * 100, raw: cirr, unit: "uW/cm2/nm", src: "XMP:Camera:Irradiance", note: "DLS1: Camera:Irradiance in W/m2/nm x 100" };
  else if (isNum(hirr)) S.irradiance = { value: hirr, raw: hirr, unit: "uW/cm2/nm", src: "XMP:DLS:HorizontalIrradiance", note: "DLS2 raw x 0.01 = W/m2/nm = x100 uW/cm2/nm" };
  else if (isNum(ird)) S.irradiance = { value: ird, raw: ird, unit: null, src: "XMP:drone-dji:Irradiance", note: "unit not stated by DJI" };
  if (S.irradiance) D("Irradiance", rnd(S.irradiance.value, 4), num(rnd(S.irradiance.value, 4)) + (S.irradiance.unit ? " " + S.irradiance.unit : " (unit not stated)"), [S.irradiance.src], S.irradiance.note);
  if (isNum(sirr) && !S.irradiance) S.irradiance = { value: sirr, raw: sirr, unit: "uW/cm2/nm", src: "XMP:DLS:SpectralIrradiance" };
  const irl = V("IrradianceList", CAM);
  if (typeof irl === "string" && irl.trim()) { const sq = sequoiaIrradiance(irl.trim()); if (sq) { S.sunshine = sq; D("SunshineSamples", sq.n, sq.n + " samples, " + num(rnd(sq.span, 2)) + " s; CH0 mean " + num(rnd(sq.ch0, 1)) + ", gain " + sq.gains.join("/") + ", integration " + sq.times.join("/") + " ms", ["XMP:Camera:IrradianceList"], "Parrot Sequoia sunshine sensor, 28-byte records: timestamp us, CH0, CH1, gain index, integration ms, yaw, pitch, roll");
    if (!S.irradiance) S.irradiance = { value: rnd(sq.rel, 6), raw: sq.rel, unit: null, src: "XMP:Camera:IrradianceList", note: "relative: mean CH0 / (gain index x integration time [ms]); not calibrated" }; } }
  const cpic = toNum(V("CalibrationPicture", CAM)); if (cpic === 1) { S.panel = { src: "XMP:Camera:CalibrationPicture" }; D("CalibrationImage", true, "yes (camera flags this image as a calibration picture)", ["XMP:Camera:CalibrationPicture"]); }
  const stc = toNum(V("SensorTemperature", CAM)); S.sensorTemp = isNum(stc) && stc < 6553 ? stc : null; if (isNum(stc) && stc >= 6553) { S.sensorTempInvalid = true; D("SensorTemperatureCheck", "invalid", num(stc) + " = no measurement (0xFFFF / 10)", ["XMP:Camera:SensorTemperature"]); }
  if (!S.band && /^mapir$/i.test(S.make)) { const fm = /_(RGN|OCN|NGB|NIR|RE|RGB)$/i.exec(S.model); const MB = { RGN: ["Red,Green,NIR", "660/550/850"], OCN: ["Orange,Cyan,NIR", "615/490/808"], NGB: ["NIR,Green,Blue", "850/550/475"], NIR: ["NIR", 850], RE: ["Red edge", 725] };
    if (fm && MB[fm[1].toUpperCase()]) { const b = MB[fm[1].toUpperCase()]; S.band = { name: b[0], src: "EXIF:IFD0:Model (MAPIR filter suffix)", wl: typeof b[1] === "number" ? b[1] : null, fwhm: null, wlSrc: typeof b[1] === "number" ? "MAPIR filter table" : null }; D("Band", b[0], b[0] + " " + b[1] + " nm", ["EXIF:IFD0:Model"], "MAPIR Survey3: band from the filter code in the model name (vendor filter table)"); } }
  const sg = toNum(V("SensorGain", DJI)); const isoMS = toNum(V("ISOSpeed", EX));
  if (isNum(sg)) S.sensorGain = { value: sg, src: "XMP:drone-dji:SensorGain" };
  else if (/micasense/i.test(S.make) && isNum(isoMS)) S.sensorGain = { value: isoMS / 100, src: "EXIF:ExifIFD:ISOSpeed / 100", derived: true };
  const sga = toNum(V("SensorGainAdjustment", DJI)); if (isNum(sga)) S.sensorGainAdj = sga;
  S.blackLevel = V("BlackLevel", DJI) != null ? toNum(V("BlackLevel", DJI)) : V("BlackLevel", EX) != null ? V("BlackLevel", EX) : null;
  S.dewarp = V("DewarpData", DJI) || null; S.vignetting = V("VignettingData", DJI) || V("VignettingPolynomial", CAM) || null;
  S.calibratedFocalPx = isNum(cfpx) ? cfpx : null; S.opticalCenter = [n2("CalibratedOpticalCenterX", DJI), n2("CalibratedOpticalCenterY", DJI)];
  S.dlsAttitude = n2("IrradianceRoll", CAM) != null ? { roll: n2("IrradianceRoll", CAM), pitch: n2("IrradiancePitch", CAM), yaw: n2("IrradianceYaw", CAM), src: "XMP:Camera", unit: "deg" } : n2("Roll", DLS) != null ? { roll: n2("Roll", DLS) * 180 / Math.PI, pitch: n2("Pitch", DLS) * 180 / Math.PI, yaw: n2("Yaw", DLS) * 180 / Math.PI, src: "XMP:DLS (rad -> deg)", unit: "deg" } : null;
  S.radiometricCal = V("RadiometricCalibration", MS) || null;
  /* sensor type */
  const info = result.info || {};
  S.thermal = null;
  const r6 = x => x == null ? null : rnd(x, 6), r2 = x => x == null ? null : rnd(x, 2); /* float32 Kelvin - 273.15 carries noise below 0.01 K */
  if (info.djiThermal) {
    const P = info.djiThermal.params, a3 = info.djiThermal.app3;
    S.thermal = { kind: "DJI R-JPEG", parts: info.djiThermal, encoding: "radiometric JPEG (DJI R-JPEG): 16-bit raw values in APP3" + (a3 && S.width && S.height && a3 === S.width * S.height * 2 ? " (" + S.width + " x " + S.height + ")" : "") + ", converted to temperature only by the DJI Thermal SDK", encodingSrc: "JPEG APP3 ThermalData, APP4 " + ((P && P.variant) || "ThermalParams") };
    if (P && P.variant && !P.raw) S.thermal.params = { emissivity: r6(P.emissivity), object_distance_m: r6(P.distance), relative_humidity_pct: P.rh == null ? null : rnd(P.rh, 3), reflected_temperature_c: r2(P.reflected), ambient_temperature_c: r2(P.ambient), src: "APP4:DJI (" + P.variant + ")" };
    const sid = V("SensorID", /^APP7:DJI$/); if (sid) S.thermal.sensorId = sid;
  } else if (info.flirFFF && info.flirFFF.cam) {
    const C = info.flirFFF.cam, R = info.flirFFF.raw;
    S.thermal = { kind: "FLIR radiometric JPEG", parts: { flir: info.flir }, encoding: "radiometric JPEG (FLIR FFF in APP1): " + (R ? (R.kind === "TIFF" ? "16-bit raw" : R.kind) + " thermal image " + R.w + " x " + R.h : "raw thermal image") + ", converted to temperature with the Planck constants of the record", encodingSrc: "APP1:FLIR RawData, CameraInfo",
      params: { emissivity: r6(C.Emissivity), object_distance_m: r6(C.ObjectDistance), relative_humidity_pct: C.RelativeHumidity != null ? rnd(C.RelativeHumidity * 100, 3) : null, reflected_temperature_c: r2(C.ReflectedApparentTemperature), atmospheric_temperature_c: r2(C.AtmosphericTemperature), ir_window_temperature_c: r2(C.IRWindowTemperature), ir_window_transmission: r6(C.IRWindowTransmission), src: "APP1:FLIR CameraInfo" } };
    if (C.PlanckR1 != null && C.PlanckB != null) S.thermal.planck = { R1: +num(C.PlanckR1, 8), B: +num(C.PlanckB, 8), F: +num(C.PlanckF, 8), O: C.PlanckO, R2: +num(C.PlanckR2, 8), src: "APP1:FLIR CameraInfo" };
    if (C.CameraTemperatureRangeMin != null) S.thermal.range = [rnd(C.CameraTemperatureRangeMin, 2), rnd(C.CameraTemperatureRangeMax, 2)];
    if (C.PlanckB) D("PeakSpectralSensitivity", rnd(14387.6515 / C.PlanckB, 3), (14387.6515 / C.PlanckB).toFixed(1) + " um", ["APP1:FLIR:PlanckB"], "14387.6515 / PlanckB (ExifTool composite)");
  } else if (info.flir) S.thermal = { kind: "FLIR radiometric JPEG", parts: { flir: info.flir } };
  /* temperature TIFF written by ThermoTIFF (J. Rous): Software "ThermoTIFF x", float32 degC, conversion parameters in ImageDescription */
  const sw0 = String(V("Software", /^EXIF:IFD0$/) || ""), desc0 = String(V("ImageDescription", /^EXIF:IFD0$/) || ""), gdm = String(V("GDALMetadata", /^EXIF:IFD0$/) || "");
  if (!S.thermal && /^(TIFF|BigTIFF)$/.test(result.file.type) && (/^ThermoTIFF\b/.test(sw0) || / by ThermoTIFF \S+ using DJI Thermal SDK/.test(desc0))) {
    const m = /Converted from (.+?) by ThermoTIFF (\S+) using DJI Thermal SDK API (\S+?)\.\s/.exec(desc0) || [], pv = k => { const x = new RegExp("(?:^|[;.]\\s*)" + k + "=([-+]?[\\d.]+(?:[eE][-+]?\\d+)?)").exec(desc0); return x ? +x[1] : null; };
    S.thermal = { kind: "ThermoTIFF", encoding: "TIFF float32, degrees Celsius" + (/UNITTYPE[^>]*>\s*degC/.test(gdm) ? " (GDAL_METADATA UNITTYPE degC)" : "") + ", converted from a DJI R-JPEG by ThermoTIFF" + (m[2] ? " " + m[2] : "") + " with the DJI Thermal SDK" + (m[3] ? " (API " + m[3] + ")" : ""), encodingSrc: "EXIF:IFD0:ImageDescription, Software, GDALMetadata",
      thermotiff: { version: m[2] || (/^ThermoTIFF\s+(\S+)/.exec(sw0) || [])[1] || null, sdk_api: m[3] || null, source: m[1] || null,
        params: { emissivity: pv("emissivity"), object_distance_m: pv("distance"), relative_humidity_pct: pv("humidity"), reflected_temperature_c: pv("reflection"), ambient_temperature_c: pv("ambient") } } };
    S.thermal.params = null; /* the TIFF holds the parameters used in the conversion, not those set at capture */
    D("TemperatureTIFF", "ThermoTIFF", "degrees Celsius, float32; ThermoTIFF " + (S.thermal.thermotiff.version || "?") + ", DJI Thermal SDK API " + (S.thermal.thermotiff.sdk_api || "?"), ["EXIF:IFD0:Software", "EXIF:IFD0:ImageDescription"]);
  }
  /* thermal TIFFs from converters that do not name themselves (checked: DJI Image Processor 1.7.5 by Miro Rava, float32 LZW; ThermoConverter 1.8 by VantageUAV,
     uint16 Deflate). Both copy Software (camera firmware) and ImageDescription (palette name) from the R-JPEG, and store no measurement parameters. */
  const band = info.band, dSrc = String(V("ImageSource", DJI) || "");
  if (!S.thermal && band && /^(TIFF|BigTIFF)$/.test(result.file.type) && /^DJI/i.test(S.make) && (/infrared/i.test(dSrc) || /^(WhiteHot|BlackHot|Arctic|Ironbow\d?|Fulgurite|Hotiron|HotIron|Medical|Rainbow\d?|Tint|GreenHot|RedHot|Lava|Rain)$/i.test(desc0.trim()) || /_T(_tiff)?\.tiff?$/i.test(result.file.name))) {
    const r2_ = x => x == null ? "?" : num(rnd(x, 2)), rng = r2_(band.min) + " … " + r2_(band.max) + (band.mean != null ? " (mean " + r2_(band.mean) + ")" : "");
    const cel = band.kind === "float32" && band.min > -100 && band.max < 2000, copied = /^\d+(\.\d+){2,}$/.test(String(sw0).trim()) ? " Software (" + sw0 + ") and ImageDescription are copied from the camera." : "";
    if (band.kind === "float32") {
      S.thermal = { kind: "temperature TIFF (converter not named)", encoding: "TIFF float32, one band, values " + rng + (cel ? ", in the range of degrees Celsius" : ", unit not stated") + "; converted from a DJI R-JPEG by a program that does not name itself." + copied + " The measurement parameters used are not stored.", encodingSrc: "EXIF:IFD0 BitsPerSample, SampleFormat; pixel values", params: null, checks: [], band };
      D("TemperatureTIFF", "float32", "float32, " + rng + (cel ? " (degrees Celsius, probably)" : "") + "; converter and its parameters not stated", ["EXIF:IFD0:SampleFormat", "pixel values"]);
    } else {
      S.thermal = { kind: "thermal TIFF, 16-bit (scale not stated)", encoding: "TIFF " + band.kind + ", one band, values " + rng + "; the scale from values to temperature is not stored." + copied + " ThermoConverter (VantageUAV) writes (T − minimum temperature) × factor, both set in the app; with its −50 °C and 1000 per °C the values wrap above 15.535 °C.", encodingSrc: "EXIF:IFD0 BitsPerSample; pixel values", params: null, checks: [], band };
      D("ThermalTIFF16", band.kind, band.kind + ", " + rng + "; scale to temperature not stated" + (band.wrap ? "; values probably wrapped (overflow)" : ""), ["EXIF:IFD0:BitsPerSample", "pixel values"]);
      if (band.wrap) result.warnings.push({ code: "thermal-wrap", text: "16-bit thermal values sit at both ends of the range with the middle empty: the converter probably overflowed (values above the top of its scale start again from 0); these are not usable as temperatures", offset: null });
    }
    const lost = ["UTCAtExposure", "ImageSource", "AltitudeType", "RtkFlag", "LRFStatus"].filter(k => V(k, DJI) == null);
    if (lost.length && (V("GpsLatitude", DJI) != null || V("GPSLatitude", DJI) != null)) D("ConversionLostXMP", lost.length, "XMP drone-dji without " + lost.join(", ") + " (dropped by the converter)", ["XMP:drone-dji"]);
  }
  if (band && !S.thermal && band.kind) D("BandStatistics", band.kind, band.kind + ", min " + num(rnd(band.min, 3)) + ", max " + num(rnd(band.max, 3)) + (band.mean != null ? ", mean " + num(rnd(band.mean, 3)) : ""), ["pixel values"]);
  else if (band && S.thermal && S.thermal.kind === "ThermoTIFF") { S.thermal.band = band; D("TemperatureRange", [band.min, band.max], num(rnd(band.min, 2)) + " … " + num(rnd(band.max, 2)) + " °C" + (band.mean != null ? " (mean " + num(rnd(band.mean, 2)) + ")" : ""), ["pixel values"]); }
  /* EXIF tags written into the GPS IFD (ThermoConverter): CreateDate, FocalLength, BodySerialNumber and others with IDs outside the GPS table */
  { const g = result.groups.find(x => x.id === "EXIF:GPS"), odd = g ? g.tags.filter(t => /^Tag 0x([89a-f][0-9a-f]{3})$/i.test(t.name)) : [];
    if (odd.length) result.warnings.push({ code: "gps-ifd", text: "EXIF tags in the GPS IFD (" + odd.map(t => t.name.replace("Tag ", "")).join(", ") + "): the writing program put Exif tags there; readers that expect GPS tags ignore them", offset: null }); }
  if (S.thermal && S.thermal.kind !== "ThermoTIFF" && !S.thermal.band) D("RadiometricJPEG", S.thermal.kind, S.thermal.kind + (S.thermal.params ? " (measurement parameters read; temperatures not computed)" : " (temperatures not computed; use the vendor SDK)"), ["JPEG APP segments"]);
  /* laser rangefinder (DJI XMP): status Normal with distance 0 = no measurement */
  const lrfS = V("LRFStatus", DJI), lrfD = toNum(V("LRFTargetDistance", DJI));
  if (lrfS != null || isNum(lrfD)) {
    S.lrf = { status: lrfS != null ? String(lrfS) : null, distance: isNum(lrfD) ? lrfD : null, lat: n2("LRFTargetLat", DJI), lon: n2("LRFTargetLon", DJI), alt: n2("LRFTargetAlt", DJI), absAlt: n2("LRFTargetAbsAlt", DJI) };
    S.lrf.measured = /^normal$/i.test(S.lrf.status || "") && S.lrf.distance > 0;
    D("LaserRangefinder", S.lrf.measured ? rnd(S.lrf.distance, 3) : null, S.lrf.measured ? num(rnd(S.lrf.distance, 3)) + " m" : "not measured (status " + (S.lrf.status || "?") + ", distance " + (S.lrf.distance != null ? num(S.lrf.distance) : "?") + ")", ["XMP:drone-dji:LRFStatus", "XMP:drone-dji:LRFTargetDistance"], "a zero distance or a status other than Normal means no measurement");
  }
  /* measurement parameters: limits and agreement with the flight */
  const TP = S.thermal && (S.thermal.params || (S.thermal.thermotiff && S.thermal.thermotiff.params));
  if (TP) {
    const chk = [], e = TP.emissivity, dd = TP.object_distance_m, rh = TP.relative_humidity_pct, dji = /^DJI|ThermoTIFF/.test(S.thermal.kind);
    if (e != null && !(e > 0 && e <= 1)) chk.push(["emissivity", "outside 0-1"]);
    else if (e === 1) chk.push(["emissivity", "1.00: blackbody (brightness) temperature, no emissivity correction"]);
    if (dd != null && dji && (dd < 1 || dd > 25)) chk.push(["object_distance_m", "outside 1-25 m (DJI Thermal SDK; ThermoTIFF does not trust the correction above 25 m)"]);
    if (rh != null && !(rh >= 0 && rh <= 100)) chk.push(["relative_humidity_pct", "outside 0-100 %"]);
    const hRef = S.lrf && S.lrf.measured ? S.lrf.distance : S.altRel != null && S.altRel > 0 ? S.altRel : null;
    if (dd != null && hRef != null && S.thermal.kind !== "ThermoTIFF") { const want = dji ? Math.min(hRef, 25) : hRef; if (Math.abs(dd - want) > Math.max(2, 0.2 * want)) chk.push(["object_distance_m", num(dd) + " m set in the camera; " + (S.lrf && S.lrf.measured ? "laser rangefinder " : "height above take-off ") + num(rnd(hRef, 1)) + " m" + (dji && hRef > 25 ? " (SDK limit 25 m)" : "")]); }
    S.thermal.checks = chk;
    D("ThermalParamsCheck", chk.length ? chk.length : 0, chk.length ? chk.map(c => c[0] + ": " + c[1]).join("; ") : "within limits", [TP === S.thermal.params ? S.thermal.params.src : "EXIF:IFD0:ImageDescription"], "emissivity 0-1, DJI distance 1-25 m, humidity 0-100 %, distance compared with the laser rangefinder or the height above take-off");
  }
  S.sensorType = S.thermal ? "thermal_LWIR" : S.band ? "multispectral" : (S.channels === 3 || result.file.type === "JPEG" || result.file.type === "HEIC") ? "RGB" : null;
  /* JPEG quality */
  if (info.dqt && info.dqt[0]) { const q = jpegQuality(info.dqt[0]); if (q) { S.jpegQuality = q; D("JPEGQualityEstimate", q.quality, String(q.quality) + (q.spread > 0.15 ? " (non-IJG table, rough)" : ""), ["DQT table 0"], "IJG scaling of the T.81 Annex K luminance table: S = mean(100 Q/Qstd); q = (200 - S)/2 for S <= 100, else 5000/S"); } }
  /* GeoTIFF */
  const gk = info.geoKeys;
  const ps = V("PixelScale", /^EXIF:IFD0$/), tp = V("ModelTiePoint", /^EXIF:IFD0$/), mt = V("ModelTransform", /^EXIF:IFD0$/);
  if (gk || ps || mt) {
    const epsg = gk ? (gk.ProjectedCSType && gk.ProjectedCSType !== 32767 ? gk.ProjectedCSType : gk.GeographicType && gk.GeographicType !== 32767 ? gk.GeographicType : null) : null;
    S.geo = { epsg, epsgName: epsg ? EPSG[epsg] || null : null, vertical: gk && gk.VerticalCSType ? gk.VerticalCSType : null, model: gk ? gk.GTModelType : null, raster: gk ? gk.GTRasterType : null };
    if (epsg) D("CRS", "EPSG:" + epsg, "EPSG:" + epsg + (EPSG[epsg] ? " (" + EPSG[epsg] + ")" : ""), [gk.ProjectedCSType ? "GeoTIFF:ProjectedCSType" : "GeoTIFF:GeographicType"]);
    let sx = null, sy = null, x0 = null, y0 = null;
    if (Array.isArray(ps) && ps.length >= 2) { sx = ps[0]; sy = ps[1]; }
    if (Array.isArray(tp) && tp.length >= 6 && sx != null) { x0 = tp[3] - tp[0] * sx; y0 = tp[4] + tp[1] * sy; }
    if (Array.isArray(mt) && mt.length >= 16) { sx = mt[0]; sy = -mt[5]; x0 = mt[3]; y0 = mt[7]; if (mt[1] || mt[4]) S.geo.rotated = true; }
    if (sx != null) { S.geo.pixelSize = [sx, sy]; D("PixelSize", [sx, sy], num(sx, 6) + " x " + num(sy, 6) + (gk && gk.GTModelType === 2 ? " deg" : gk && gk.ProjLinearUnits === 9001 ? " m" : " (CRS units)"), [ps ? "EXIF:IFD0:PixelScale" : "EXIF:IFD0:ModelTransform"]); }
    if (x0 != null) {
      S.geo.ul = [x0, y0]; D("UpperLeft", [x0, y0], num(x0, 12) + ", " + num(y0, 12), [tp ? "EXIF:IFD0:ModelTiePoint" : "EXIF:IFD0:ModelTransform", "EXIF:IFD0:PixelScale"], gk && gk.GTRasterType === 2 ? "PixelIsPoint: tie point at pixel centre" : "corner of the upper-left pixel");
      if (isNum(W) && isNum(H) && sx != null) { S.geo.extent = [x0, y0 - H * sy, x0 + W * sx, y0]; D("Extent", S.geo.extent.map(x => rnd(x, 6)), S.geo.extent.map(x => num(x, 12)).join(", "), ["Derived:UpperLeft", "Derived:PixelSize", "Composite:ImageSize"], "xmin, ymin, xmax, ymax"); }
    }
    const nd = V("GDALNoData", /^EXIF:IFD0$/); if (nd != null) S.geo.nodata = nd;
  }
  /* add pending composites (thumbnail) */
  for (const p of (pending || [])) comp.tags.push(p);
  S.makerNote = info.makerNote || null; S.hasXMP = result.groups.some(g => /^XMP:/.test(g.id)); S.hasICC = result.groups.some(g => g.id === "ICC_Profile"); S.hasIPTC = result.groups.some(g => g.id === "IPTC");
  S.previews = (result.previews || []).length;
  S.c2pa = info.c2pa || null;
  if (comp.tags.length) result.groups.push(comp);
  if (der.tags.length) result.groups.push(der);
  result.summary = S;
  return S;
}

/* ---------------------------------------------------------------- OpenSkyLab image_log.csv row (metadata standard v0.2) */
const IMAGE_LOG_COLUMNS = ["image_id", "sensor_id", "file_name", "timestamp_utc", "lat_deg", "lon_deg", "alt_ellipsoid_m", "alt_rel_m", "roll_deg", "pitch_deg", "yaw_deg", "gimbal_roll_deg",
  "gimbal_pitch_deg", "gimbal_yaw_deg", "rtk_flag", "sigma_x_m", "sigma_y_m", "sigma_z_m", "speed_x_ms", "speed_y_ms", "speed_z_ms", "exposure_s", "sensor_gain", "band_id",
  "band_wavelength_nm", "irradiance_dls", "fpa_temp_c", "shutter_flag", "aux"];
function sequoiaIrradiance(b64) {
  let bin; try { bin = typeof atob === "function" ? atob(b64.replace(/\s+/g, "")) : Buffer.from(b64, "base64").toString("latin1"); } catch (e) { return null; }
  if (!bin || bin.length < 28 || bin.length % 28) return null;
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dv = DV(u), rec = [];
  for (let o = 0; o + 28 <= u.length; o += 28) rec.push({ t: dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296, ch0: dv.getUint16(o + 8, true), ch1: dv.getUint16(o + 10, true), gain: dv.getUint16(o + 12, true), ms: dv.getUint16(o + 14, true) });
  const ok = rec.filter(r => r.gain > 0 && r.ms > 0); if (!ok.length) return null;
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { n: rec.length, span: (rec[rec.length - 1].t - rec[0].t) / 1e6, ch0: mean(ok.map(r => r.ch0)), ch1: mean(ok.map(r => r.ch1)), rel: mean(ok.map(r => r.ch0 / (r.gain * r.ms))), gains: [...new Set(ok.map(r => r.gain))], times: [...new Set(ok.map(r => r.ms))] };
}
function imageLog(result) {
  const S = result.summary || {}, out = [];
  const R = (col, value, status, src, note) => out.push({ column: col, value: value == null || value === "" || (typeof value === "number" && !isFinite(value)) ? "" : (typeof value === "number" ? String(rnd(value, 9)) : String(value)), status: (value == null || value === "") && status !== "missing" ? "missing" : status, source: src || "", note: note || "" });
  R("image_id", "", "missing", "", "manual"); R("sensor_id", "", "missing", "", "manual");
  R("file_name", S.file, "file", "File:FileName");
  R("timestamp_utc", S.utc ? S.utc.replace(/(\.\d{3})?Z$/, m => m.length > 1 ? m : "Z") : "", S.utc ? "derived" : "missing", S.utcSrc || "EXIF:DateTimeOriginal", S.clockSuspect ? "clock-suspect" : S.utc ? "" : (S.localTime ? "no-tz" : ""));
  R("lat_deg", S.lat != null ? rnd(S.lat, 8) : "", "file", S.posSrc === "EXIF:GPS" ? "Composite:GPSLatitude (EXIF:GPS)" : S.posSrc || ""); R("lon_deg", S.lon != null ? rnd(S.lon, 8) : "", "file", S.posSrc === "EXIF:GPS" ? "Composite:GPSLongitude (EXIF:GPS)" : S.posSrc || "");
  if (S.altAbs != null) R("alt_ellipsoid_m", S.altAbs, "file", "XMP:drone-dji:AbsoluteAltitude", "check-datum");
  else if (S.altGPS != null) R("alt_ellipsoid_m", S.altGPS, "file", "Composite:GPSAltitude", S.altGPSRef >= 2 ? "sea-level" : /^sensefly$/i.test(S.make) ? "ellipsoid-sensefly" : "gps-alt");
  else R("alt_ellipsoid_m", "", "missing", "", "");
  R("alt_rel_m", S.altRel, "file", "XMP:drone-dji:RelativeAltitude", "rel-takeoff");
  const fl = S.flight || {}, gb = S.gimbal || {}, sp = S.speed || {}, rk = S.rtk || {};
  R("roll_deg", fl.roll, "file", fl.roll != null ? fl.src + (fl.src === "XMP:drone-dji" ? ":FlightRollDegree" : ":Roll") : ""); R("pitch_deg", fl.pitch, "file", fl.pitch != null ? fl.src + (fl.src === "XMP:drone-dji" ? ":FlightPitchDegree" : ":Pitch") : ""); R("yaw_deg", fl.yaw, "file", fl.yaw != null ? fl.src + (fl.src === "XMP:drone-dji" ? ":FlightYawDegree" : ":Yaw") : "");
  R("gimbal_roll_deg", gb.roll, "file", gb.roll != null ? gb.src + (gb.src === "XMP:drone-dji" ? ":GimbalRollDegree" : ":CameraRoll") : ""); R("gimbal_pitch_deg", gb.pitch, "file", gb.pitch != null ? gb.src + (gb.src === "XMP:drone-dji" ? ":GimbalPitchDegree" : ":CameraPitch") : ""); R("gimbal_yaw_deg", gb.yaw, "file", gb.yaw != null ? gb.src + (gb.src === "XMP:drone-dji" ? ":GimbalYawDegree" : ":CameraYaw") : "");
  const st = rk.state, rv = st === "fixed" || st === "int" || st === "float" || st === "single" ? st : "";
  R("rtk_flag", rv, rv ? "derived" : "missing", rk.src || (rk.gpsStatus ? "XMP:drone-dji:GpsStatus" : ""), rv ? "" : (st === "rtk" ? "rtk-unknown" : "log"));
  R("sigma_x_m", rk.sx, "file", rk.sx != null ? (rk.sigmaSrc === "XMP:Camera" ? "XMP:Camera:GPSXYAccuracy" : "XMP:drone-dji:RtkStdLon") : "", "sigma-axes"); R("sigma_y_m", rk.sy, "file", rk.sy != null ? (rk.sigmaSrc === "XMP:Camera" ? "XMP:Camera:GPSXYAccuracy" : "XMP:drone-dji:RtkStdLat") : "", "sigma-axes"); R("sigma_z_m", rk.sz, "file", rk.sz != null ? (rk.sigmaSrc === "XMP:Camera" ? "XMP:Camera:GPSZAccuracy" : "XMP:drone-dji:RtkStdHgt") : "", "");
  /* axes: x = east, y = north (as in the template example: speed_x 5.0 at yaw 92.8 deg); DJI X points north, Y east */
  R("speed_x_ms", sp.y, "file", sp.y != null ? sp.src + (sp.src === "XMP:drone-dji" ? ":FlightYSpeed" : ":SpeedY") : "", "speed-axes"); R("speed_y_ms", sp.x, "file", sp.x != null ? sp.src + (sp.src === "XMP:drone-dji" ? ":FlightXSpeed" : ":SpeedX") : "", "speed-axes"); R("speed_z_ms", sp.z, "file", sp.z != null ? sp.src + (sp.src === "XMP:drone-dji" ? ":FlightZSpeed" : ":SpeedZ") : "", "speed-z");
  if (S.exposureTimeDJI != null) R("exposure_s", S.exposureTimeDJI, "derived", "XMP:drone-dji:ExposureTime / 1e6");
  else R("exposure_s", S.exposureTime, "file", S.exposureTime != null ? "EXIF:ExifIFD:ExposureTime" : "");
  if (S.sensorGain) R("sensor_gain", S.sensorGain.value, S.sensorGain.derived ? "derived" : "file", S.sensorGain.src); else R("sensor_gain", "", "missing", "", S.band ? "" : "na");
  R("band_id", S.band ? S.band.name : "", "file", S.band ? S.band.src : "", S.band ? "" : "na");
  R("band_wavelength_nm", S.band && S.band.wl != null ? S.band.wl : "", S.band && S.band.wlSrc === "XMP:drone-dji:BandFreq" ? "derived" : "file", S.band ? S.band.wlSrc || "" : "", S.band ? "" : "na");
  if (S.irradiance) R("irradiance_dls", S.irradiance.value, S.irradiance.unit && S.irradiance.raw !== S.irradiance.value ? "derived" : "file", S.irradiance.src, S.irradiance.unit ? "" : "unit-unknown");
  else R("irradiance_dls", "", "missing", "", S.band ? "" : "na");
  if (S.thermal && S.sensorTemp != null) R("fpa_temp_c", S.sensorTemp, "file", "XMP:Camera:SensorTemperature");
  else R("fpa_temp_c", "", "missing", "", S.thermal ? (S.sensorTempInvalid ? "invalid" : /^DJI|^ThermoTIFF/.test(S.thermal.kind) ? "not-written" : "sdk") : "na"); R("shutter_flag", "", "missing", "", S.thermal ? "sdk" : "na");
  const aux = [[S.make, S.model].filter(Boolean).join(" "), S.software].filter(Boolean).join("; ");
  R("aux", aux, "file", "EXIF:IFD0:Make, Model, Software");
  return out;
}

/* ---------------------------------------------------------------- exports */
function g0(id) { const p = id.split(":")[0]; return p === "GeoTIFF" ? "GeoTiff" : p; }
function toExiftoolJSON(results, o) {
  o = o || {}; const arr = [].concat(results).map(r => {
    const obj = { SourceFile: r.file.name };
    for (const g of r.groups) for (const t of g.tags) {
      if (g.id === "Derived" && !o.derived) continue;
      const k = (o.g1 ? g.id.replace(/^XMP:/, "XMP-").replace(/^EXIF:/, "").replace(/^MakerNotes:/, "").replace(/^APP\d+:/, "") : g0(g.id)) + ":" + t.name;
      if (k in obj) continue;
      let v = o.raw ? t.value : t.display;
      if (t.binary) v = "(Binary data " + t.binary.length + " bytes)";
      else if (v === null || v === undefined) v = t.display;
      obj[k] = v;
    }
    return obj;
  });
  return JSON.stringify(arr, null, 2);
}
function csvCell(v) { const s = v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v); return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCSV(result) {
  const rows = [["group", "name", "id", "value", "display", "type", "count", "offset"]];
  for (const g of result.groups) for (const t of g.tags) rows.push([g.id, t.name, t.id, t.binary ? "" : (t.value == null ? "" : t.value), t.display, t.type, t.count, t.offset == null ? "" : t.offset]);
  return rows.map(r => r.map(csvCell).join(",")).join("\r\n");
}

const OSLMeta = { version: VERSION, parse, derive: (r, o) => derive(r, o, (r.groups.find(g => g.id === "Composite") || { tags: [] }).tags.filter(t => t.name === "ThumbnailImage")), imageLog, toExiftoolJSON, toCSV, solarPosition, jpegQuality,
  IMAGE_LOG_COLUMNS, csvCell, parseXMLBuiltin, cborDecode, _x509: x509, _tables: { EXIF: EXIF_T, GPS: GPS_T, DJI: DJI_T, MPF: MPF_T, GEOKEY, IPTC1, IPTC2, ICC_TAGS, E } };
G.OSLMeta = OSLMeta;
if (typeof module !== "undefined" && module.exports) module.exports = OSLMeta;
})(typeof globalThis !== "undefined" ? globalThis : this);
/*OSL-META-READER-END*/

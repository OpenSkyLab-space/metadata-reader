# Third-party notices

The reader is an independent implementation in JavaScript (MIT, `LICENSE`). It contains no code from the projects below.
What it takes from them is listed here: names, enumerations, file layouts and algorithms needed to read their files,
plus the embedded fonts and the specification table, which are included under their own licences.

## Included under their own licences

| What | Where in the reader | Licence |
|---|---|---|
| Atkinson Hyperlegible, Familjen Grotesk, JetBrains Mono (fonts) | embedded in the built pages | SIL Open Font License 1.1 (`LICENSES/`) |
| OpenSkyLab drone data metadata specification v0.3 (field table) | `src/metadata-reader_osl.js` | CC BY 4.0 (`LICENSES/CC-BY-4.0.txt`) |

## Names, vocabularies and data with attribution terms

| Source | What the reader takes | Licence or terms | Attribution |
|---|---|---|---|
| [EPSG Geodetic Parameter Dataset](https://epsg.org/) | names of 24 EPSG codes (coordinate reference systems, datums, ellipsoids, vertical systems) shown next to GeoTIFF keys (`EPSG` in `src/metadata-reader_lib.js`) | [EPSG terms of use](https://epsg.org/terms-of-use.html) | EPSG Geodetic Parameter Dataset, © IOGP (International Association of Oil & Gas Producers). The names are shown as published; the selection of codes is the reader's own. |
| [IPTC NewsCodes, Digital Source Type](https://cv.iptc.org/newscodes/digitalsourcetype/) | labels of the digital source type terms used in C2PA assertions | CC BY 4.0 | IPTC Digital Source Type vocabulary, © IPTC, CC BY 4.0. |
| [Open-Meteo](https://open-meteo.com/) | weather values fetched only on the user's request | CC BY 4.0 | shown next to the values: "Data: Open-Meteo.com (CC BY 4.0)". |
| [NOAA Global Monitoring Laboratory, Solar Calculator](https://gml.noaa.gov/grad/solcalc/) | the solar position algorithm (based on J. Meeus, *Astronomical Algorithms*) | US government information, public domain unless annotated otherwise ([NOAA GML disclaimer](https://gml.noaa.gov/about/disclaimer.html)) | NOAA Global Monitoring Laboratory, Boulder, Colorado, USA. Not endorsed by NOAA. |

## File formats and names taken from documentation and open-source projects

No code from these projects is included. Formats, functionality and short identifiers are reimplemented from their documentation and source.

| Source | What the reader takes | Licence of the source |
|---|---|---|
| [ExifTool](https://exiftool.org/) by Phil Harvey | tag names and value labels for EXIF, GPS, MPF and DJI tags, the "Composite" style of derived values, the layouts of DJI APP4 thermal parameters (`DJI.pm`) and FLIR FFF records (`FLIR.pm`), the JSON export shape of `exiftool -j -G` | Artistic License or GNU GPL version 1 or later |
| [ArduPilot](https://ardupilot.org/) | DataFlash log format, flight mode names of Copter, Plane and Rover (`mode.h`), ERR subsystem names (`AP_Logger.h`), vibration limits from the documentation | GNU GPL version 3 |
| [PX4 Autopilot](https://px4.io/) | ULog format, `vehicle_status.nav_state` names, custom mode numbering in the MAVLink heartbeat (`px4_custom_mode.h`) | BSD 3-Clause |
| [MAVLink](https://mavlink.io/en/) | message and field names, packet layout of `.tlog` telemetry logs | MIT (message definitions and generated libraries) |
| [dji-log-parser](https://github.com/lvauvillier/dji-log-parser) | layout of DJI FlightRecord files and of their unencrypted summary | MIT |
| [libjpeg-turbo](https://libjpeg-turbo.org/) (`jcparam.c`) | the IJG quality scaling formula, inverted to estimate JPEG quality | IJG License and Modified BSD License |
| [MicaSense imageprocessing](https://github.com/micasense/imageprocessing) | interpretation of MicaSense tags (`metadata.py`) | MIT |

The standards the reader implements (Exif, TIFF, DNG, XMP, GeoTIFF, ICC, IPTC IIM and Photo Metadata, HEIF, PNG, JPEG, JUMBF, C2PA, CBOR and COSE)
and the vendor documents it follows (DJI, Pix4D, MicaSense) are listed under "Sources" at the bottom of the reader page.
Vendor formats without public documentation (senseFly, Wingtra, Pix4D, Jeti, DJI DAT) are read from the structure of data files; no program was decompiled.

## Not included

The DJI Thermal SDK, any DJI App Key and the code of ThermoTIFF are not part of the reader. The reader does not convert thermal images to temperatures
and does not decrypt DJI FlightRecord v13+ logs.

## Test data

The sample images and logs in this repository are synthetic. Real logs and images used for testing during development are not distributed with the reader.

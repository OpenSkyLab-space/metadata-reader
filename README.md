# OpenSkyLab metadata reader

Reads the metadata of drone images, multispectral bands, GeoTIFF orthomosaics and videos, and the flight and GNSS logs that belong to them, in the browser.
It joins images with logs, checks the result against the [OpenSkyLab metadata specification](https://openskylab.space/metadata.html) field by field, with the source of every value,
and exports `metadata.json`, `image_log.csv`, `provenance.json`, camera positions for Metashape, PIX4Dmatic and OpenDroneMap, GeoJSON for QGIS and a flight report.

**Reader 1.4.0** · parser OSLMeta 1.0.0 · flight logs OSLFlight 0.3.0 · checks against specification v0.3 · [use it online](https://openskylab.space/reader) · DOI: *added after the first release*

## Use

- Online: [openskylab.space/reader](https://openskylab.space/reader).
- Offline: download [`dist/metadata-reader_tool.html`](dist/metadata-reader_tool.html) and open it in a browser. It is one file and needs no server or network.
- `dist/metadata-reader.html` is the teaching version, with synthetic samples and eight tasks (Czech and English).

**Privacy.** Files are read only in the browser's memory; nothing is uploaded. The one exception is the optional weather button: only after you confirm, it sends the approximate position of the flight (rounded to 0.01°) and its date to Open-Meteo. A Content-Security-Policy in the page lets the browser block every other request.

## What is here

| Folder | Content |
|---|---|
| [`src/`](src) | sources: the parser (`metadata-reader_lib.js`, works in the browser and in Node.js), the flight log module (`metadata-reader_flight.js`), user interface, texts (CZ/EN), page template, embedded fonts, synthetic samples, build script |
| [`dist/`](dist) | the two built pages (generated, do not edit) |
| [`test/`](test) | tests on synthetic files and logs, fuzz tests |
| [`tools/`](tools) | version check |
| [`docs/`](docs) | draft of `provenance.json` (for specification 0.4), which the reader writes |

Build: `node src/metadata-reader_build.js dist en`. Tests: `node test/samples_test.js --out /tmp/s`, `node test/field_regressions_test.js`, `node test/flight_test.js`, `node test/metadata-reader_fuzz.js /tmp/s/*`.

The specification table `src/metadata-reader_osl.js` is generated from the files of the specification with `node src/metadata-reader_gen.js <spec folder> > src/metadata-reader_osl.js`.

## How to cite

Cite the version you used; `CITATION.cff` gives the details (GitHub shows them under "Cite this repository"). Each release is archived on Zenodo with its own DOI.

## Licence

- Code: MIT (`LICENSE`), © 2026 Jan Komárek.
- The specification table (`src/metadata-reader_osl.js`) is taken from the OpenSkyLab metadata specification v0.3, licensed CC BY 4.0 (`LICENSES/CC-BY-4.0.txt`).
- Embedded fonts: Atkinson Hyperlegible, Familjen Grotesk and JetBrains Mono, SIL OFL 1.1 (`LICENSES/`).
- Weather values fetched on request come from [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).

## Acknowledgements and notes

- Tag names and value labels follow the tag documentation of [ExifTool](https://exiftool.org/) by Phil Harvey. The reader is an independent implementation in JavaScript.
- DJI FlightRecord layouts follow the open-source [dji-log-parser](https://github.com/lvauvillier/dji-log-parser); encrypted logs (v13+) are read only as far as their unencrypted summary.
- The sample images and logs in the repository are synthetic; their values are illustrative.
- Use of AI: the code was developed with the assistance of Claude (Anthropic), used to draft code and text. The author is responsible for the content.

Author and copyright holder: Jan Komárek ([ORCID 0000-0002-3505-6755](https://orcid.org/0000-0002-3505-6755)). Contact: [openskylab.space](https://openskylab.space/)

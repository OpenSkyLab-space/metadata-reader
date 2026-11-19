# Provenance in OpenSkyLab metadata: draft for specification 0.4

Status: draft, not part of the released specification 0.3. Schema: [`openskylab_provenance_schema_v0.4-draft.json`](openskylab_provenance_schema_v0.4-draft.json).

## Why

Metadata say *what* a dataset is. Provenance says *where each value and each product came from, and how*.
It covers the whole chain, not only processing:

1. **Acquisition**: the flight, the sensor, the logs it wrote.
2. **Metadata collection**: which value was read from which tag of which file, which was derived by a rule, which came from a flight log, which was typed by hand.
3. **Processing**: software, versions, settings, GCPs, intermediate products.
4. **Use and publication**: what was released, under which identifier.

The metadata stay the core of the specification. Provenance is a thin layer next to them and never repeats their values.

## Files

| File | Holds |
|---|---|
| `metadata.json` | The metadata, as in 0.3, plus one new top-level field `provenance`: the relative path or URL of the provenance record. |
| `provenance.json` | The provenance record (this draft). One per dataset. |

Keeping provenance in its own file keeps `metadata.json` readable and lets the provenance grow (one activity per processing step) without touching the metadata.

## Format

An own, small JSON format, mapped to W3C PROV-O so that it can be converted to PROV-O / PROV-JSON when needed. Plain PROV-JSON was not chosen: it is generic, verbose and hard to read or fill by hand.

| provenance.json | PROV-O |
|---|---|
| `inputs[]`, `describes[]` | `prov:Entity` |
| `collections[]` | `prov:Collection` (`prov:hadMember`) |
| `activities[]` | `prov:Activity` |
| `agents[]` (`software`, `person`, `organisation`) | `prov:SoftwareAgent`, `prov:Person`, `prov:Organization` |
| `activities[].used` | `prov:used` |
| `activities[].generated` | `prov:wasGeneratedBy` (inverse) |
| `activities[].agent` | `prov:wasAssociatedWith` |
| `activities[].recorded_in` | `prov:wasDerivedFrom` of the activity record (the input that documents the activity, e.g. a processing project) |
| `activities[].started_utc`, `ended_utc` | `prov:startedAtTime`, `prov:endedAtTime` |
| `fields[].from` | `prov:wasDerivedFrom` (from the value to the input) |
| `fields[].by` | `prov:wasAttributedTo` |
| `inputs[].sha256` | identity of the entity (not a PROV term; same role as `file:checksum` in STAC) |

Related: ISO 19115 `lineage` (`LI_Source`, `LI_ProcessStep`), the STAC processing extension (`processing:lineage`, `processing:software`), C2PA for single images.

## What is required at which level

| Level | Required |
|---|---|
| **Core** | `metadata.json → provenance`; in `provenance.json`: `inputs[]` with SHA-256 of every input file, `agents[]` with the version of every software agent, at least one activity linking inputs to the files it generated (`used`, `generated`). `products[].derived_from` and `products[].checksum` (already Core in 0.3) refer to ids and hashes in this record. |
| **Quantitative** | additionally `fields[]`: the origin of each value in `metadata.json` (`image`, `derived`, `flight_log`, `manual`, `processing_log`, `calibration`, `field_record`, `external_service`: a value fetched from a web service at the user's request, such as a weather archive, with the service and the request in `source`); one `processing` activity per processing step with its `parameters`, linked to `processing[].workflow_id`. |
| **Full** | additionally manual changes with `by` and `replaces`, and the publication activity. |

A file that cannot be hashed (for example over the browser limit) is listed with `sha256: null` and a `note`.

## What the reader writes

The OpenSkyLab metadata reader exports `provenance.json` next to `metadata.json`:

- every loaded image and log with size, SHA-256 (computed in the browser) and time of reading;
- the reader as a software agent with the versions of its parser, flight-log module and specification table;
- one `metadata_extraction` activity that used all inputs and generated `metadata.json` and `image_log.csv` (with their SHA-256, so the record proves which export it belongs to);
- `fields[]` for every value it filled: origin, source tag or log, the input it came from, the rule note for derived values, and for values from a log the image's own value with `same` / `differ` (default tolerances of the reader: 1 m position and height, 0.5 s time), or `not_comparable` with the difference when the two values may refer to different references (a height whose datum the image does not state);
- `image_log_columns`: per column of `image_log.csv`, how many rows come from the image, the log or are empty.
- `matching[]` when logs are loaded: per image the match status (`unique`, `ambiguous`, `conflict`, `unmatched`), the method (file name, DJI index, MicaSense CaptureId or time), the log record, the time offset and distance, how many records fitted, the alternatives and the records rejected with the reason. Two records that fit about equally are not resolved by guessing: the image stays unmatched with status `ambiguous`.

When a processing project is loaded (Pix4Dmapper `.p4d`; Agisoft Metashape `doc.xml`, `chunk.zip` or `.psz`), the reader also writes:

- the project as an input with role `processing_project`;
- the processing software as an agent, with the version the project records (for Metashape the version that last saved the project);
- one `processing` activity per step recorded in the project, with its settings as `parameters`, `workflow_id`, `recorded_in` (the project), `used` (the loaded images whose file names the project lists) and `generated` (the products in `metadata.json` that the step made, where the project tells);
- `processing[]` and `products[]` in `metadata.json`, and `fields[]` with origin `processing_log` for them.

A project keeps settings, not a log of the run: it does not say when a step ran, and Pix4D stores only which steps are switched on. Times, versions of single steps and accuracy figures from the quality report are added by hand.
Manual entries are added later by the user or by a processing tool, as further activities.

## Example (shortened, synthetic)

```json
{
  "provenance_version": "0.4-draft",
  "generated_utc": "2026-11-09T08:34:45Z",
  "describes": [{ "file": "metadata.json", "sha256": "d400…7896", "schema_version": "0.4" }],
  "agents": [
    { "id": "software:reader", "type": "software", "name": "OpenSkyLab metadata reader", "version": "1.4.0" },
    { "id": "software:metashape", "type": "software", "name": "Agisoft Metashape Professional", "version": "2.1.3" },
    { "id": "person:1", "type": "person", "name": "A. Operator", "orcid": "https://orcid.org/0000-0000-0000-0000" }
  ],
  "activities": [
    { "id": "activity:read", "type": "metadata_extraction", "agent": "software:reader", "used": ["images", "log:1"], "generated": ["metadata.json", "image_log.csv"] },
    { "id": "activity:align", "type": "processing", "order": 1, "name": "Align photos", "agent": ["software:metashape", "person:1"], "workflow_id": "wf-1",
      "used": ["images", "gcp:1"], "generated": ["product:sparse"], "parameters": { "accuracy": "high", "generic_preselection": true } }
  ],
  "inputs": [
    { "id": "image:1", "role": "image", "file": "IMG_0001.JPG", "sha256": "a66c…e091" },
    { "id": "log:1", "role": "flight_log", "kind": "dji-mrk", "file": "flight.MRK", "sha256": "c10b…4467" },
    { "id": "gcp:1", "role": "gcp", "file": "gcp.csv", "sha256": "…" }
  ],
  "collections": [{ "id": "images", "members": 312 }],
  "fields": [
    { "path": "missions[0].gnss_mode", "origin": "flight_log", "source": "flight.MRK", "from": ["log:1"],
      "check": { "image_value": "RTK", "image_source": "XMP:drone-dji:RtkFlag", "agreement": "same" } },
    { "path": "sensors[0].sensor_model", "origin": "image", "source": "EXIF:IFD0:Make, Model", "from": ["image:1"] },
    { "path": "dataset.licence", "origin": "manual", "by": "person:1", "from": [] }
  ]
}
```

## Changes to the field list for 0.4 (proposal)

| Field | Level | Change |
|---|---|---|
| `provenance` (top level of `metadata.json`) | C | new: path or URL of `provenance.json` |
| `products[].derived_from` | C | unchanged level; its ids are ids of `inputs[]` or `products` in `provenance.json` |
| `products[].checksum` | C | unchanged; equals the SHA-256 of the product in `provenance.json` |
| `processing[].workflow_id`, `processing[].steps` | Q | unchanged level; each step corresponds to one `processing` activity |

## Open points

- Processing provenance: Pix4Dmapper and Metashape projects are read (see above). OpenDroneMap, PIX4Dmatic and the quality reports (PDF) are still to be examined; the PDF reports are kept as hashed inputs only.
- Whether `provenance.json` should also be accepted inline (`metadata.json → provenance` as an object) for single-file datasets.
- A converter to PROV-O (Turtle / JSON-LD) for repositories that want RDF.

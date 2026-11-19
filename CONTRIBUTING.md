# Contributing

Reports and sample files are welcome, especially from people who fly drones and publish the data.

- **A tag read wrongly, a file that fails, a log that is not recognised:** open an issue with "Reader bug". If you can, attach an original, unedited file; it is used only for testing. Tell us if it must not be published.
- **A camera or log format not yet tested:** use "New camera".
- **Pull requests:** small and focused, one topic each. The CI must pass. Do not edit generated files by hand: `dist/` comes from `src/metadata-reader_build.js`, `src/metadata-reader_osl.js` from `src/metadata-reader_gen.js`.
- Fields of the specification itself are discussed in the specification's repository, not here.

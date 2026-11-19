# Releasing

1. On a branch: update `versions.json` and `READER.version` in `src/metadata-reader_ui.js` (and `VERSION` in the parser or the flight module if they changed);
   rename `[Unreleased]` in `CHANGELOG.md` to the version with the date; set `version` and `date-released` in `CITATION.cff`.
2. Rebuild: `node src/metadata-reader_build.js dist en`.
3. `python tools/check_versions.py` and the tests pass; open a pull request; the CI passes; merge.
4. On GitHub: Releases → Draft a new release → tag `vX.Y.Z` (the reader version) on `main`, notes = the changelog section. The CI checks the tag against `versions.json`.
5. Zenodo archives the release and mints its DOI (switch the GitHub–Zenodo link on once for the repository first). Put the concept DOI into `README.md` and `CITATION.cff` after the first release.
6. Website: deploy `dist/metadata-reader_tool.html` from the tag and update the version and DOI shown on the reader page.

"""Check that every version number in the repository agrees with versions.json (run by the CI and before a release).
usage: python tools/check_versions.py [--tag vX.Y.Z]"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda *p: open(os.path.join(ROOT, *p), encoding='utf-8').read()
V = json.loads(rd('versions.json'))
reader, parser, flight, spec = V['reader'], V['parser'], V['flight_logs'], V['specification']
problems = []
def need(ok, msg):
    if not ok:
        problems.append(msg)

semver = re.compile(r'^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$')
for k in ('reader', 'parser', 'flight_logs'):
    need(semver.match(V[k]), f'versions.json: {k} "{V[k]}" is not MAJOR.MINOR.PATCH')
need(re.match(r'^\d+\.\d+$', spec), f'versions.json: specification "{spec}" is not MAJOR.MINOR')
need(f'const VERSION = "{parser}";' in rd('src', 'metadata-reader_lib.js'), 'metadata-reader_lib.js: VERSION differs from parser')
need(f'const VERSION = "{flight}";' in rd('src', 'metadata-reader_flight.js'), 'metadata-reader_flight.js: VERSION differs from flight_logs')
need(re.search(r'const READER = \{[^}]*version: "' + re.escape(reader) + '"', rd('src', 'metadata-reader_ui.js')), 'metadata-reader_ui.js: READER.version differs from reader')
need(rd('src', 'metadata-reader_osl.js').startswith(f'/* OpenSkyLab metadata specification v{spec},'), 'metadata-reader_osl.js was generated for another specification version')
cff = rd('CITATION.cff')
need(re.search(rf'^version: "?{re.escape(reader)}"?\s*$', cff, re.M), 'CITATION.cff: version differs from reader')
ch = rd('CHANGELOG.md'); top = re.search(r'^## \[([^\]]+)\]', ch, re.M)
need(top and top.group(1) in (reader, 'Unreleased'), 'CHANGELOG.md: the newest section is neither the reader version nor [Unreleased]')
need(f'## [{reader}]' in ch, f'CHANGELOG.md: no section for {reader}')
if '--tag' in sys.argv:
    tag = sys.argv[sys.argv.index('--tag') + 1]
    need(tag == 'v' + reader, f'tag {tag} differs from versions.json reader v{reader}')

print('\n'.join(problems) if problems else f'versions consistent: reader {reader}, parser {parser}, flight logs {flight}, specification {spec}')
sys.exit(1 if problems else 0)

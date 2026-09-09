// Diagnostic harness: parses every activity file in a Strava export folder
// using the same libraries as the app worker, and reports why files fail.
// Usage: node scripts/diagnose.mjs "C:\path\to\export_folder"

import fs from 'node:fs';
import path from 'node:path';
import * as fflate from 'fflate';
import { gpx, tcx } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';
import FitParser from 'fit-file-parser';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/diagnose.mjs <exportFolder>');
  process.exit(1);
}

const activitiesDir = path.join(root, 'activities');
if (!fs.existsSync(activitiesDir)) {
  console.error('No activities/ folder in', root);
  process.exit(1);
}

function sanitizeXml(text) {
  const prolog = text.toLowerCase().indexOf('<?xml');
  let t = prolog >= 0 ? text.slice(prolog) : text;
  if (prolog < 0) {
    const lt = t.indexOf('<');
    if (lt > 0) t = t.slice(lt);
  }
  return t.replace(/^[\u0000-\u001F\u007F\uFEFF]+/, '');
}

function coordsFromGeo(geo) {
  const out = [];
  if (!geo || !Array.isArray(geo.features)) return out;
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString' || g.type === 'MultiPoint') out.push(...g.coordinates);
    else if (g.type === 'MultiLineString' || g.type === 'Polygon') for (const l of g.coordinates) out.push(...l);
    else if (g.type === 'Point') out.push(g.coordinates);
  }
  return out.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
}

function parseXmlFile(buf, kind) {
  const text = sanitizeXml(fflate.strFromU8(buf));
  const errors = [];
  const dom = new DOMParser({
    onError: (level, msg) => { if (level !== 'warning') errors.push(msg); },
  }).parseFromString(text, 'text/xml');
  const geo = kind === 'gpx' ? gpx(dom) : tcx(dom);
  return { coords: coordsFromGeo(geo), errors };
}

let dumpedFit = false;

function parseFitFile(buf) {
  return new Promise(resolve => {
    const p = new FitParser({ force: true, mode: 'both', elapsedRecordField: true });
    p.parse(buf.slice().buffer, (err, data) => {
      if (err) return resolve({ coords: [], error: String(err) });
      if (process.env.DUMP_FIT && !dumpedFit) {
        dumpedFit = true;
        fs.writeFileSync('fit_dump.json', JSON.stringify(data, null, 2).slice(0, 200000));
        console.log('FIT top-level keys:', Object.keys(data));
      }
      const coords = [];
      const seen = new Set();
      const walk = node => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) return node.forEach(walk);
        if (Number.isFinite(node.position_lat) && Number.isFinite(node.position_long)) {
          coords.push([node.position_long, node.position_lat]);
        }
        for (const k of ['activity', 'sessions', 'laps', 'records', 'lengths', 'events', 'sets']) {
          if (node[k]) walk(node[k]);
        }
      };
      walk(data);
      resolve({ coords, error: null });
    });
  });
}

function gunzipAll(buf) {
  let d = buf;
  let n = 0;
  while (d.length > 2 && d[0] === 0x1f && d[1] === 0x8b && n < 5) {
    d = fflate.gunzipSync(d);
    n++;
  }
  return d;
}

const files = fs.readdirSync(activitiesDir);
const stats = { total: 0, ok: 0, noTrack: 0, unsupported: 0, error: 0 };
const failures = [];

for (const name of files) {
  const full = path.join(activitiesDir, name);
  if (!fs.statSync(full).isFile()) continue;
  stats.total++;
  let buf = new Uint8Array(fs.readFileSync(full));
  try {
    buf = gunzipAll(buf);
  } catch (e) {
    stats.error++;
    failures.push({ name, reason: 'gunzip: ' + e.message });
    continue;
  }
  const base = name.replace(/\.gz$/i, '').toLowerCase();
  const ext = (base.match(/\.(gpx|tcx|fit)$/) || [])[1];
  try {
    let coords = [];
    let extra = '';
    if (ext === 'gpx' || ext === 'tcx') {
      const r = parseXmlFile(buf, ext);
      coords = r.coords;
      if (r.errors.length) extra = ` xmlErrors=${r.errors.length}`;
    } else if (ext === 'fit') {
      const r = await parseFitFile(buf);
      coords = r.coords;
      if (r.error) extra = ' fitError=' + r.error;
    } else {
      stats.unsupported++;
      failures.push({ name, reason: 'unsupported ext' });
      continue;
    }
    if (coords.length > 0) stats.ok++;
    else {
      stats.noTrack++;
      failures.push({ name, reason: 'no track points' + extra + ` bytes=${buf.length}` });
    }
  } catch (e) {
    stats.error++;
    failures.push({ name, reason: 'parse: ' + e.message });
  }
}

const lines = [];
lines.push('=== SUMMARY ===');
lines.push(JSON.stringify(stats));
const byReason = {};
for (const f of failures) {
  const k = f.reason.replace(/bytes=\d+/, '').trim();
  byReason[k] = (byReason[k] || 0) + 1;
}
lines.push('=== FAILURES BY REASON ===');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) lines.push(`${v}\t${k}`);
lines.push('=== FAILURES (all) ===');
for (const f of failures) lines.push(`${f.name} -> ${f.reason}`);
fs.writeFileSync('diag_report.txt', lines.join('\n'));
console.log('report written', stats);

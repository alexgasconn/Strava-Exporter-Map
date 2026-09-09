import * as fflate from 'fflate';
import { gpx, tcx } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';
import FitParser from 'fit-file-parser';
import type { StravaActivity, Peak } from './types';

// Web worker context
const ctx: Worker = self as any;

// Peaks and settings used for fast completed-peak computation inside worker
let workerPeaks: Peak[] = [];
let proximityMeters = 50;
let peakGrid: Map<string, Peak[]> | null = null;
let cellSizeDeg = 0.01; // fallback
const parsedActivities: StravaActivity[] = [];
// Map of activity id -> metadata (name, date) parsed from activities.csv inside an export
type ActivityMeta = { name?: string; date?: string };
type TrackParseResult = { path: [number, number][], type?: string, timestamps?: string[], name?: string, date?: string };

// activities.csv dates are human-readable ("Jan 4, 2025, 8:51:22 AM"); the UI filters on ISO.
function toIsoDate(raw?: string): string {
  if (!raw) return '';
  const t = Date.parse(raw);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}


ctx.onmessage = async (event: MessageEvent) => {
  const { type, buffer, peaks, proximity } = event.data;

  if (type === 'SET_PEAKS') {
    if (Array.isArray(peaks)) {
      workerPeaks = peaks;
      buildGridIndex();
    }
    return;
  }

  if (type === 'SET_PROXIMITY') {
    if (typeof proximity === 'number' && proximity > 0) {
      proximityMeters = proximity;
      buildGridIndex();
      // recompute completions from all parsed activities with new radius
      const allCompleted = computeCompletedFromActivities(parsedActivities);
      ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(allCompleted) });
      const conquests = computeConquestsFromActivities(parsedActivities);
      ctx.postMessage({ type: 'PEAK_CONQUESTS', conquests: Object.fromEntries(conquests) });
    }
    return;
  }

  if (type === 'PARSE_ZIP') {
    try {
      ctx.postMessage({ type: 'PROGRESS', message: 'Loading zip file in memory...', percent: 10 });

      if (!buffer || buffer.byteLength === 0) {
        throw new Error("Uploaded file is empty or could not be read.");
      }

      const zipData = new Uint8Array(buffer);

      ctx.postMessage({ type: 'PROGRESS', message: 'Extracting activities...', percent: 15 });

      // Use unzipSync because we are already in a worker, blocking is fine and avoids async weirdness
      // Extract all entries first so we can log which files were filtered out.
      const unzippedAll = fflate.unzipSync(zipData);
      const allNames = Object.keys(unzippedAll);
      // Try to parse activities.csv (if present) to enrich logging with activity name/date
      const activitiesMeta: Map<string, ActivityMeta> = new Map();
      try {
        const csvKey = allNames.find(k => k.toLowerCase().endsWith('activities.csv'));
        if (csvKey) {
          const csvText = fflate.strFromU8(unzippedAll[csvKey]);
          const parsed = parseActivitiesCsv(csvText);
          for (const [id, meta] of Object.entries(parsed)) activitiesMeta.set(id, meta as ActivityMeta);
          ctx.postMessage({ type: 'DEBUG', message: `Parsed activities.csv entries: ${activitiesMeta.size}` });
        }
      } catch (e) {
        console.warn('Failed to parse activities.csv', e);
      }
      const matched: string[] = [];
      const skipped: { name: string, reason: string }[] = [];

      // Accept files under activities/ with extensions: .gpx, .tcx, .fit and optional .gz suffix
      const acceptRe = /(^|\/)activities\/.*\.(gpx|tcx|fit)(?:\.gz)?$/i;
      for (const rawName of allNames) {
        const raw = rawName.replaceAll('\\\\', '/').replaceAll('\\', '/');
        const name = raw.toLowerCase();
        if (name.endsWith('/')) {
          skipped.push({ name: rawName, reason: 'directory' });
          continue;
        }
        if (!acceptRe.test(name)) {
          skipped.push({ name: rawName, reason: 'not activities/*.gpx|.tcx|.fit(.gz)?' });
          continue;
        }
        matched.push(rawName);
      }

      // Log summary of what's inside the zip and what's being processed
      console.log('ZIP entries:', allNames.length, 'matched activities:', matched.length, 'skipped:', skipped.length);
      ctx.postMessage({ type: 'PROGRESS', message: `ZIP contains ${allNames.length} entries; processing ${matched.length} activity files...`, percent: 15 });
      if (skipped.length > 0) {
        // send a short sample of skipped filenames to help debugging
        const sample = skipped.slice(0, 20).map(s => `${s.name} (${s.reason})`);
        ctx.postMessage({ type: 'DEBUG', message: `Skipped ${skipped.length} entries: ${sample.join(', ')}${skipped.length > 20 ? ', ...' : ''}` });
        // also send the full list so UI can present it to the user for debugging
        ctx.postMessage({ type: 'SKIPPED_ENTRIES', entries: skipped.map(s => ({ name: s.name, reason: s.reason })) });
      }

      // Work with the matched subset
      const files = matched;
      // map file data from unzippedAll
      const unzipped: Record<string, Uint8Array> = {};
      for (const n of files) unzipped[n] = unzippedAll[n];
      if (files.length === 0) {
        ctx.postMessage({ type: 'ERROR', message: 'No activity files (gpx, tcx, fit) found in the zip.' });
        return;
      }

      let parsedCount = 0;
      const totalRows = files.length;
      const stats = { total: totalRows, ok: 0, noTrack: 0, gunzipFailed: 0, unsupported: 0, errored: 0 };

      ctx.postMessage({ type: 'PROGRESS', message: `Parsing ${totalRows} activities...`, percent: 20 });

      const batchSize = 150;
      let batch: any[] = [];
      for (let i = 0; i < totalRows; i++) {
        const filename = files[i];
        let fileData = unzipped[filename];
        // debug: announce file being attempted
        console.log(`Attempting to read: ${filename} (${i + 1}/${totalRows})`);

        // Determine if compressed and underlying extension
        try {
          // Normalize to Uint8Array if needed
          if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
          if (!(fileData instanceof Uint8Array)) fileData = new Uint8Array(fileData as any || []);

          // If filename ends with .gz or the data begins with gzip magic bytes, gunzip repeatedly
          const nameLower = filename.toLowerCase();
          const looksGz = nameLower.endsWith('.gz') || (fileData && fileData.length >= 2 && fileData[0] === 0x1f && fileData[1] === 0x8b);
          if (looksGz) {
            try {
              // Support nested gzip layers: keep gunzipping while it looks like gzip
              let attempts = 0;
              while (fileData && fileData.length >= 2 && fileData[0] === 0x1f && fileData[1] === 0x8b && attempts < 5) {
                fileData = fflate.gunzipSync(fileData);
                if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
                attempts++;
              }
            } catch (e) {
              console.error('Failed to gunzip', filename, e);
              stats.gunzipFailed++;
              ctx.postMessage({ type: 'FILE_STATUS', filename, ok: false, message: `❌ Failed to gunzip: ${String(e)}` });
              continue; // skip this file
            }
          }

          const stripped = filename.replace(/\.gz$/i, '').toLowerCase();
          const extMatch = stripped.match(/\.(gpx|tcx|fit)$/i);
          const ext = extMatch ? extMatch[1].toLowerCase() : null;

          let path: [number, number][] = [];
          let timestamps: string[] | undefined = undefined;
          let activityType = 'Other';
          let embeddedName: string | undefined;
          let embeddedDate: string | undefined;

          if (ext === 'gpx') {
            // ensure Uint8Array
            if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
            const res = parseGpx(fileData, filename);
            path = res.path;
            timestamps = (res as any).timestamps;
            if ((res as any).type) activityType = (res as any).type;
            embeddedName = (res as any).name;
            embeddedDate = (res as any).date;
          } else if (ext === 'tcx') {
            if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
            const res = parseTcx(fileData, filename);
            path = res.path;
            timestamps = (res as any).timestamps;
            if ((res as any).type) activityType = (res as any).type;
            embeddedName = (res as any).name;
            embeddedDate = (res as any).date;
          } else if (ext === 'fit') {
            if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
            const res = await parseFit(fileData);
            path = res.path;
            if ((res as any).type) activityType = (res as any).type;
            // parseFit will also populate timestamps if available
            timestamps = (res as any).timestamps;
            embeddedName = (res as any).name;
            embeddedDate = (res as any).date;
          } else {
            stats.unsupported++;
            ctx.postMessage({ type: 'FILE_STATUS', filename, ok: false, message: `❌ Unsupported extension for ${filename}` });
            continue;
          }

          const meta = activitiesMeta.get((filename.match(/(\d{5,})/) || [])[1] || '');

          if (path && path.length > 0) {
            // normalize into StravaActivity-like object
            const distance = computePathDistance(path);
            const date = (timestamps && timestamps.length > 0) ? timestamps[0] : toIsoDate(embeddedDate || meta?.date);
            const activity: StravaActivity = {
              id: filename,
              name: meta?.name || embeddedName || filename.split(/[\\/]/).pop() || 'Unknown Activity',
              type: activityType,
              date,
              distance,
              path,
              timestamps
            };
            parsedActivities.push(activity);
            batch.push(activity);
            stats.ok++;
            ctx.postMessage({ type: 'FILE_STATUS', filename, ok: true, message: `✅ Parsed (${path.length} pts, ${Math.round(distance)} m)` });
          } else {
            stats.noTrack++;
            const label = meta ? ` — ${meta.date || 'sin fecha'} — ${meta.name || 'sin título'}` : '';
            console.warn(`❌ Sin ruta GPS: ${filename}${label}`);
            ctx.postMessage({ type: 'FILE_STATUS', filename, ok: false, message: `❌ Sin ruta GPS${label}` });
          }
        } catch (e) {
          console.error('Failed to process', filename, e);
          stats.errored++;
          ctx.postMessage({ type: 'FILE_STATUS', filename, ok: false, message: `❌ Error: ${String(e)}` });
        }

        parsedCount++;
        // flush batch periodically
        if (batch.length >= batchSize) {
          ctx.postMessage({ type: 'ACTIVITY_BATCH', activities: batch });
          // also compute completed peaks from this batch incrementally
          if (workerPeaks && workerPeaks.length > 0) {
            const completed = computeCompletedFromActivities(batch);
            ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(completed) });
          }
          batch = [];
        }

        if (parsedCount % 50 === 0) {
          ctx.postMessage({ type: 'PROGRESS', message: `Parsing tracks... ${parsedCount}/${totalRows}`, percent: 20 + Math.floor((parsedCount / totalRows) * 80) });
        }
      }
      // send remaining
      if (batch.length > 0) {
        ctx.postMessage({ type: 'ACTIVITY_BATCH', activities: batch });
        if (workerPeaks && workerPeaks.length > 0) {
          const completed = computeCompletedFromActivities(batch);
          ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(completed) });
        }
      }

      // final full recompute from everything parsed so far (in case proximity/peaks were set after some batches)
      if (workerPeaks && workerPeaks.length > 0) {
        const allCompleted = computeCompletedFromActivities(parsedActivities);
        ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(allCompleted) });
        const conquests = computeConquestsFromActivities(parsedActivities);
        ctx.postMessage({ type: 'PEAK_CONQUESTS', conquests: Object.fromEntries(conquests) });
      }

      console.log('Parse summary', stats);
      ctx.postMessage({ type: 'SUMMARY', stats });
      ctx.postMessage({ type: 'DONE' });

    } catch (error: any) {
      console.error(error);
      ctx.postMessage({ type: 'ERROR', message: `Error processing zip: ${error.message}` });
    }
  }

  if (type === 'PARSE_FILES') {
    try {
      const files = event.data.files;
      if (!files || !Array.isArray(files) || files.length === 0) {
        ctx.postMessage({ type: 'ERROR', message: 'No files provided for parsing.' });
        return;
      }

      ctx.postMessage({ type: 'PROGRESS', message: `Parsing ${files.length} provided files...`, percent: 10 });

      const batchSize = 150;
      let batch: any[] = [];

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const filename = (f.name || `file_${i}`).toString();
        let fileData = f.data;

        // if Uint8Array-like wrapper
        if (fileData && (fileData instanceof ArrayBuffer)) fileData = new Uint8Array(fileData);

        // Normalize to Uint8Array
        if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
        if (!(fileData instanceof Uint8Array)) fileData = new Uint8Array(fileData as any || []);

        // If it's gzipped (by filename or by magic bytes), gunzip repeatedly to handle nested gz
        try {
          const nameLower = filename.toLowerCase();
          const looksGz = nameLower.endsWith('.gz') || (fileData && fileData.length >= 2 && fileData[0] === 0x1f && fileData[1] === 0x8b);
          if (looksGz) {
            let attempts = 0;
            while (fileData && fileData.length >= 2 && fileData[0] === 0x1f && fileData[1] === 0x8b && attempts < 5) {
              fileData = fflate.gunzipSync(fileData);
              if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
              attempts++;
            }
          }
        } catch (e) {
          console.warn('Failed to gunzip', filename, e);
        }

        const baseName = filename.replace(/\.gz$/i, '').toLowerCase();
        let path: [number, number][] = [];
        let activityType = 'Other';
        let activityName: string | undefined;
        let activityDate: string | undefined;

        try {
          if (baseName.endsWith('.gpx')) {
            const res = parseGpx(fileData, filename);
            path = res.path;
            if (res.type) activityType = res.type;
            activityName = res.name;
            activityDate = res.date;
          } else if (baseName.endsWith('.tcx')) {
            const res = parseTcx(fileData, filename);
            path = res.path;
            if (res.type) activityType = res.type;
            activityName = res.name;
            activityDate = res.date;
          } else if (baseName.endsWith('.fit')) {
            if (fileData instanceof ArrayBuffer) fileData = new Uint8Array(fileData as ArrayBuffer);
            const res = await parseFit(fileData);
            path = res.path;
            if (res.type) activityType = res.type;
            activityName = res.name;
            activityDate = res.date;
          }
        } catch (e) {
          console.error('Failed to parse', filename, e);
          ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
        }

        if (path && path.length > 0) {
          const activity: StravaActivity = {
            id: filename,
            name: activityName || filename.split(/[\\/\\\\]/).pop() || 'Unknown Activity',
            type: activityType,
            date: activityDate ? toIsoDate(activityDate) : '',
            distance: 0,
            path
          };
          parsedActivities.push(activity);
          batch.push(activity);
        }

        if (batch.length >= batchSize) {
          ctx.postMessage({ type: 'ACTIVITY_BATCH', activities: batch });
          if (workerPeaks && workerPeaks.length > 0) {
            const completed = computeCompletedFromActivities(batch);
            ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(completed) });
          }
          batch = [];
        }
      }

      if (batch.length > 0) {
        ctx.postMessage({ type: 'ACTIVITY_BATCH', activities: batch });
        if (workerPeaks && workerPeaks.length > 0) {
          const completed = computeCompletedFromActivities(batch);
          ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(completed) });
        }
      }

      if (workerPeaks && workerPeaks.length > 0) {
        const allCompleted = computeCompletedFromActivities(parsedActivities);
        ctx.postMessage({ type: 'COMPLETED_UPDATE', completedIds: Array.from(allCompleted) });
        const conquests = computeConquestsFromActivities(parsedActivities);
        ctx.postMessage({ type: 'PEAK_CONQUESTS', conquests: Object.fromEntries(conquests) });
      }

      ctx.postMessage({ type: 'DONE' });
    } catch (err: any) {
      console.error(err);
      ctx.postMessage({ type: 'ERROR', message: `Error parsing files: ${err?.message || String(err)}` });
    }
    return;
  }
};

function parseGpx(data: Uint8Array, filename?: string): TrackParseResult {
  const textRaw = fflate.strFromU8(data);
  // sanitize: try to locate the XML prolog '<?xml' and slice everything before it;
  // fallback to first '<' if not found. Also trim leading control/BOM characters.
  const prologIndex = textRaw.toLowerCase().indexOf('<?xml');
  let text = textRaw;
  if (prologIndex >= 0) {
    text = textRaw.slice(prologIndex);
  } else {
    const firstLT = textRaw.indexOf('<');
    if (firstLT > 0) text = textRaw.slice(firstLT);
  }
  // remove leading BOM or non-printable chars
  text = text.replace(/^[\u0000-\u001F\u007F\uFEFF]+/, '');
  try {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    const geo = gpx(dom);
    const res = extractPathAndTypeFromGeoJSON(geo);
    const nameNode = dom.getElementsByTagName('name')[0];
    const timeNode = dom.getElementsByTagName('time')[0];
    const name = nameNode?.textContent?.trim() || undefined;
    const date = timeNode?.textContent?.trim() || undefined;
    if (!res.path || res.path.length === 0) {
      const msg = `No GPX track found in ${filename || 'uploaded file'}`;
      console.error(msg);
      ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: msg });
    }
    return { ...res, name, date };
  } catch (e) {
    console.error('GPX parse error', filename, e);
    ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
    return { path: [] };
  }
}

function parseActivitiesCsv(text: string): Record<string, ActivityMeta> {
  const out: Record<string, ActivityMeta> = {};
  if (!text) return out;

  // Full CSV tokenizer: activity names may contain commas and embedded newlines.
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { row.push(cur); cur = ''; }
    else if (ch === '\n' && !inQuotes) { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r' && !inQuotes) { /* ignore */ }
    else cur += ch;
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  if (rows.length < 2) return out;

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const find = (re: RegExp) => headers.findIndex(h => re.test(h));
  const idIdx = find(/^(activity[ _]?id|id)$/);
  const nameIdx = find(/^(activity[ _]?name|nombre de la actividad|name|title)$/);
  const dateIdx = find(/^(activity[ _]?date|fecha de la actividad|start[ _]?date(_local)?|date)$/);

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const id = (idIdx >= 0 ? cols[idIdx] : cols[0] || '').trim();
    if (!id) continue;
    out[id] = {
      name: nameIdx >= 0 ? (cols[nameIdx] || '').trim() : undefined,
      date: dateIdx >= 0 ? (cols[dateIdx] || '').trim() : undefined,
    };
  }
  return out;
}

function parseTcx(data: Uint8Array, filename?: string): TrackParseResult {
  const textRaw = fflate.strFromU8(data);
  // sanitize: try to locate the XML prolog '<?xml' and slice everything before it;
  // fallback to first '<' if not found. Also trim leading control/BOM characters.
  const prologIndex = textRaw.toLowerCase().indexOf('<?xml');
  let text = textRaw;
  if (prologIndex >= 0) {
    text = textRaw.slice(prologIndex);
  } else {
    const firstLT = textRaw.indexOf('<');
    if (firstLT > 0) text = textRaw.slice(firstLT);
  }
  // remove leading BOM or non-printable chars
  text = text.replace(/^[\u0000-\u001F\u007F\uFEFF]+/, '');
  try {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    const geo = tcx(dom);
    const res = extractPathAndTypeFromGeoJSON(geo);
    const activityNode = dom.getElementsByTagName('Activity')[0];
    const idNode = activityNode?.getElementsByTagName('Id')[0];
    const sport = activityNode?.getAttribute('Sport') || undefined;
    const name = activityNode?.getElementsByTagName('Name')[0]?.textContent?.trim() || sport;
    const date = idNode?.textContent?.trim() || undefined;
    if (!res.path || res.path.length === 0) {
      const msg = `No TCX track found in ${filename || 'uploaded file'}`;
      console.error(msg);
      ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: msg });
    }
    return { ...res, name, date };
  } catch (e) {
    console.error('TCX parse error', filename, e);
    ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
    return { path: [] };
  }
}

function extractPathAndTypeFromGeoJSON(geo: any): { path: [number, number][], type?: string, timestamps?: string[] } {
  let path: [number, number][] = [];
  let type: string | undefined = undefined;
  const timestamps: string[] = [];

  if (geo && geo.type === 'FeatureCollection' && Array.isArray(geo.features)) {
    for (const feature of geo.features) {
      // Try to extract activity type from properties if present
      if (feature.properties && feature.properties.type) {
        const t = String(feature.properties.type).toLowerCase();
        if (t.includes('ride') || t.includes('bik') || t.includes('cycl')) type = 'Ride';
        else if (t.includes('run')) type = 'Run';
        else if (t.includes('swim')) type = 'Swim';
        else if (t.includes('walk') || t.includes('hike')) type = 'Walk';
      }

      // Try to extract coordTimes array if present
      const coordTimes = feature.properties && feature.properties.coordTimes && Array.isArray(feature.properties.coordTimes) ? feature.properties.coordTimes : null;

      const geom = feature.geometry;
      if (!geom) continue;

      const pushCoords = (coords: any[]) => {
        for (let idx = 0; idx < coords.length; idx++) {
          const c = coords[idx];
          if (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
            path.push([c[0], c[1]] as [number, number]);
            if (coordTimes && coordTimes[idx]) timestamps.push(String(coordTimes[idx]));
          }
        }
      };

      if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
        pushCoords(geom.coordinates);
      } else if ((geom.type === 'MultiLineString' || geom.type === 'Polygon') && Array.isArray(geom.coordinates)) {
        for (const line of geom.coordinates) if (Array.isArray(line)) pushCoords(line);
      } else if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates)) {
        pushCoords(geom.coordinates);
      } else if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
        pushCoords([geom.coordinates]);
      } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
        for (const g of geom.geometries) {
          if (!g || !Array.isArray(g.coordinates)) continue;
          if (g.type === 'LineString' || g.type === 'MultiPoint') pushCoords(g.coordinates);
          else if (g.type === 'MultiLineString' || g.type === 'Polygon') {
            for (const line of g.coordinates) if (Array.isArray(line)) pushCoords(line);
          } else if (g.type === 'Point') pushCoords([g.coordinates]);
        }
      }
    }
  }
  return { path: normalizePath(path), type, timestamps: timestamps.length > 0 ? timestamps : undefined };
}

// Drops out-of-range points; if the whole track looks transposed, swaps lon/lat.
function normalizePath(path: [number, number][]): [number, number][] {
  if (path.length === 0) return path;
  const inRange = (lon: number, lat: number) =>
    Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90 &&
    !(lon === 0 && lat === 0);

  const valid = path.filter(p => inRange(p[0], p[1]));
  if (valid.length > 0) return valid;

  const swapped = path
    .map(p => [p[1], p[0]] as [number, number])
    .filter(p => inRange(p[0], p[1]));
  return swapped;
}

function parseFit(data: Uint8Array): Promise<TrackParseResult> {
  return new Promise((resolve, reject) => {
    const fitParser = new FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'km',
      temperatureUnit: 'celcius',
      elapsedRecordField: true,
      // 'both' exposes the flat record list as well as the session/lap tree,
      // so GPS points are found regardless of how the device structured the file.
      mode: 'both',
    });

    // Normalize to Uint8Array and give fitParser an isolated ArrayBuffer.
    let u8: Uint8Array;
    if (data instanceof ArrayBuffer) u8 = new Uint8Array(data as ArrayBuffer);
    else if (data instanceof Uint8Array) u8 = data as Uint8Array;
    else u8 = new Uint8Array(data as any || []);
    // Some parsers crash if they read off a view of a larger buffer — slice to isolate.
    const isolatedBuffer = u8.slice().buffer;

    fitParser.parse(isolatedBuffer, (error: Error | null, fitData: any) => {
      if (error) {
        reject(error);
        return;
      }

      const path: [number, number][] = [];
      const timestamps: string[] = [];
      let type: string | undefined = undefined;
      let name: string | undefined = undefined;
      let activityDate: string | undefined = undefined;

      const sportOf = (s: any) => {
        const v = String(s || '').toLowerCase();
        if (v.includes('cycl') || v.includes('bik')) return 'Ride';
        if (v.includes('run')) return 'Run';
        if (v.includes('swim')) return 'Swim';
        if (v.includes('walk') || v.includes('hike')) return 'Walk';
        return undefined;
      };

      const seen = new Set<any>();
      const collect = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
          for (const item of node) collect(item);
          return;
        }
        for (const key of ['activity_name', 'activityName', 'workout_name', 'workoutName', 'name', 'title']) {
          if (!name && typeof node[key] === 'string' && node[key].trim()) name = node[key].trim();
        }
        for (const key of ['start_time', 'startTime', 'timestamp']) {
          if (!activityDate && node[key]) {
            const parsed = new Date(node[key]);
            if (!Number.isNaN(parsed.getTime())) activityDate = parsed.toISOString();
          }
        }
        if (!type && node.sport) type = sportOf(node.sport);
        const lat = node.position_lat;
        const lon = node.position_long;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          path.push([lon, lat]);
          if (node.timestamp) timestamps.push(new Date(node.timestamp).toISOString());
        }
        for (const key of ['activity', 'sessions', 'laps', 'records', 'lengths', 'events', 'sets']) {
          if (node[key]) collect(node[key]);
        }
      };

      collect(fitData?.activity);
      if (path.length === 0) collect(fitData?.records);
      if (path.length === 0) collect(fitData?.sessions);
      if (!type) type = sportOf(fitData?.sessions?.[0]?.sport ?? fitData?.sports?.[0]?.sport);

      const res: TrackParseResult = { path: normalizePath(path), type, name, date: activityDate };
      if (timestamps.length > 0) res.timestamps = timestamps;
      resolve(res);
    });
  });
}

// ------------------ Completed-peak computation helpers ------------------
function buildGridIndex() {
  if (!workerPeaks || workerPeaks.length === 0) { peakGrid = null; return; }
  // approximate degrees per meter for latitude
  cellSizeDeg = Math.max(0.0001, proximityMeters / 110000); // ~111km per degree
  const grid = new Map<string, Peak[]>();
  for (const p of workerPeaks) {
    const lon = Number(p.longitude);
    const lat = Number(p.latitude);
    if (Number.isNaN(lon) || Number.isNaN(lat)) continue;
    const gx = Math.floor(lon / cellSizeDeg);
    const gy = Math.floor(lat / cellSizeDeg);
    const key = gx + ':' + gy;
    const arr = grid.get(key) || [];
    arr.push(p);
    grid.set(key, arr);
  }
  peakGrid = grid;
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number) {
  const toRad = (v: number) => v * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computePathDistance(path: [number, number][]) {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += haversine(Number(path[i - 1][0]), Number(path[i - 1][1]), Number(path[i][0]), Number(path[i][1]));
  }
  return d;
}

// tracks which activity first reached each peak, for display in the map popup
function computeConquestsFromActivities(activities: StravaActivity[]) {
  const conquests = new Map<string, { activityId: string; name: string; date: string }>();
  if (!peakGrid || workerPeaks.length === 0) return conquests;

  for (const act of activities) {
    if (!act.path || act.path.length === 0) continue;
    const sampleEvery = Math.max(1, Math.floor(act.path.length / 500));
    for (let i = 0; i < act.path.length; i += sampleEvery) {
      const pt = act.path[i];
      const lon = Number(pt[0]);
      const lat = Number(pt[1]);
      if (Number.isNaN(lon) || Number.isNaN(lat)) continue;
      const gx = Math.floor(lon / cellSizeDeg);
      const gy = Math.floor(lat / cellSizeDeg);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = (gx + dx) + ':' + (gy + dy);
          const bucket = peakGrid.get(key);
          if (!bucket) continue;
          for (const peak of bucket) {
            const d = haversine(lon, lat, Number(peak.longitude), Number(peak.latitude));
            if (d <= proximityMeters) {
              const existing = conquests.get(peak.id);
              if (!existing || (act.date && (!existing.date || act.date < existing.date))) {
                conquests.set(peak.id, { activityId: act.id, name: act.name, date: act.date });
              }
            }
          }
        }
      }
    }
  }

  return conquests;
}

function computeCompletedFromActivities(activities: StravaActivity[]) {
  const completed = new Set<string>();
  if (!peakGrid || workerPeaks.length === 0) return completed;

  for (const act of activities) {
    if (!act.path || act.path.length === 0) continue;
    // sample long paths to reduce checks
    const sampleEvery = Math.max(1, Math.floor(act.path.length / 500));
    for (let i = 0; i < act.path.length; i += sampleEvery) {
      const pt = act.path[i];
      const lon = Number(pt[0]);
      const lat = Number(pt[1]);
      if (Number.isNaN(lon) || Number.isNaN(lat)) continue;
      const gx = Math.floor(lon / cellSizeDeg);
      const gy = Math.floor(lat / cellSizeDeg);
      // check neighboring cells
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = (gx + dx) + ':' + (gy + dy);
          const bucket = peakGrid.get(key);
          if (!bucket) continue;
          for (const peak of bucket) {
            if (completed.has(peak.id)) continue;
            const d = haversine(lon, lat, Number(peak.longitude), Number(peak.latitude));
            if (d <= proximityMeters) {
              completed.add(peak.id);
            }
          }
        }
      }
    }
  }

  return completed;
}

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
      const matched: string[] = [];
      const skipped: { name: string, reason: string }[] = [];

      for (const rawName of allNames) {
        const raw = rawName.replaceAll('\\\\', '/').replaceAll('\\', '/');
        const name = raw.toLowerCase();
        if (name.endsWith('/')) {
          skipped.push({ name: rawName, reason: 'directory' });
          continue;
        }
        const inActivities = /(^|\/)activities\//.test(name);
        const isExt = (name.endsWith('.gpx') || name.endsWith('.tcx') || name.endsWith('.fit') || name.endsWith('.gz'));
        if (!inActivities) {
          skipped.push({ name: rawName, reason: 'not in activities/ folder' });
          continue;
        }
        if (!isExt) {
          skipped.push({ name: rawName, reason: 'unsupported extension' });
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

      ctx.postMessage({ type: 'PROGRESS', message: `Parsing ${totalRows} activities...`, percent: 20 });

      const batchSize = 150;
      let batch: any[] = [];
      for (let i = 0; i < totalRows; i++) {
        const filename = files[i];
        let fileData = unzipped[filename];
        // debug: announce file being attempted
        console.log(`Attempting to read: ${filename} (${i + 1}/${totalRows})`);
        ctx.postMessage({ type: 'DEBUG', message: `Reading ${filename} (${i + 1}/${totalRows})` });

        // If it's gzipped (like .fit.gz, .gpx.gz)
        if (filename.toLowerCase().endsWith('.gz')) {
          try {
            fileData = fflate.gunzipSync(fileData);
          } catch (e) {
            // skip if decompression fails
            console.warn("Failed to gunzip", filename, e);
            ctx.postMessage({ type: 'DEBUG', message: `Failed to gunzip ${filename}: ${String(e)}` });
          }
        }

        const baseName = filename.replace(/\.gz$/i, '').toLowerCase();
        let path: [number, number][] = [];
        let activityType = 'Other';

        try {
          if (baseName.endsWith('.gpx')) {
            const res = parseGpx(fileData, filename);
            path = res.path;
            if (res.type) activityType = res.type;
          } else if (baseName.endsWith('.tcx')) {
            const res = parseTcx(fileData, filename);
            path = res.path;
            if (res.type) activityType = res.type;
          } else if (baseName.endsWith('.fit')) {
            const res = await parseFit(fileData);
            path = res.path;
            if (res.type) activityType = res.type;
          }
        } catch (e) {
          console.error('Failed to parse', filename, e);
          ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
        }

        if (path && path.length > 0) {
          const activity: StravaActivity = {
            id: filename,
            name: filename.split(/[\\/]/).pop() || 'Unknown Activity',
            type: activityType,
            date: '',
            distance: 0,
            path
          };
          // keep parsed activities in worker to allow recompute on proximity change
          parsedActivities.push(activity);
          batch.push(activity);
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
      }

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

        // If it's gzipped (like .fit.gz, .gpx.gz)
        if (filename.toLowerCase().endsWith('.gz')) {
          try {
            fileData = fflate.gunzipSync(fileData);
          } catch (e) {
            console.warn('Failed to gunzip', filename);
          }
        }

        const baseName = filename.replace(/\.gz$/i, '').toLowerCase();
        let path: [number, number][] = [];
        let activityType = 'Other';

        try {
          if (baseName.endsWith('.gpx')) {
            const res = parseGpx(fileData, filename);
            path = res.path;
            if (res.type) activityType = res.type;
          } else if (baseName.endsWith('.tcx')) {
            const res = parseTcx(fileData, filename);
            path = res.path;
            if (res.type) activityType = res.type;
          } else if (baseName.endsWith('.fit')) {
            const res = await parseFit(fileData);
            path = res.path;
            if (res.type) activityType = res.type;
          }
        } catch (e) {
          console.error('Failed to parse', filename, e);
          ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
        }

        if (path && path.length > 0) {
          const activity: StravaActivity = {
            id: filename,
            name: filename.split(/[\\/\\\\]/).pop() || 'Unknown Activity',
            type: activityType,
            date: '',
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
      }

      ctx.postMessage({ type: 'DONE' });
    } catch (err: any) {
      console.error(err);
      ctx.postMessage({ type: 'ERROR', message: `Error parsing files: ${err?.message || String(err)}` });
    }
    return;
  }
};

function parseGpx(data: Uint8Array, filename?: string): { path: [number, number][], type?: string } {
  const textRaw = fflate.strFromU8(data);
  // sanitize: find first '<' in case of leading garbage (BOM, padding, multipart headers)
  const firstLT = textRaw.indexOf('<');
  const text = firstLT > 0 ? textRaw.slice(firstLT) : textRaw;
  try {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    const geo = gpx(dom);
    const res = extractPathAndTypeFromGeoJSON(geo);
    if (!res.path || res.path.length === 0) {
      const msg = `No GPX track found in ${filename || 'uploaded file'}`;
      console.error(msg);
      ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: msg });
    }
    return res;
  } catch (e) {
    console.error('GPX parse error', filename, e);
    ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
    return { path: [] };
  }
}

function parseTcx(data: Uint8Array, filename?: string): { path: [number, number][], type?: string } {
  const textRaw = fflate.strFromU8(data);
  const firstLT = textRaw.indexOf('<');
  const text = firstLT > 0 ? textRaw.slice(firstLT) : textRaw;
  try {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    const geo = tcx(dom);
    const res = extractPathAndTypeFromGeoJSON(geo);
    if (!res.path || res.path.length === 0) {
      const msg = `No TCX track found in ${filename || 'uploaded file'}`;
      console.error(msg);
      ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: msg });
    }
    return res;
  } catch (e) {
    console.error('TCX parse error', filename, e);
    ctx.postMessage({ type: 'PARSE_ERROR', filename, reason: String(e) });
    return { path: [] };
  }
}

function extractPathAndTypeFromGeoJSON(geo: any): { path: [number, number][], type?: string } {
  let path: [number, number][] = [];
  let type: string | undefined = undefined;

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

      if (feature.geometry && feature.geometry.type === 'LineString' && Array.isArray(feature.geometry.coordinates)) {
        const coords = feature.geometry.coordinates;
        path = path.concat(
          coords
            .filter((c: any) => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number' && !isNaN(c[0]) && !isNaN(c[1]))
            .map((c: any) => [c[0], c[1]] as [number, number])
        );
      } else if (feature.geometry && feature.geometry.type === 'MultiLineString' && Array.isArray(feature.geometry.coordinates)) {
        for (const line of feature.geometry.coordinates) {
          if (Array.isArray(line)) {
            path = path.concat(
              line
                .filter((c: any) => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number' && !isNaN(c[0]) && !isNaN(c[1]))
                .map((c: any) => [c[0], c[1]] as [number, number])
            );
          }
        }
      }
    }
  }
  return { path, type };
}

function parseFit(data: Uint8Array): Promise<{ path: [number, number][], type?: string }> {
  return new Promise((resolve, reject) => {
    const fitParser = new FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'km',
      temperatureUnit: 'celcius',
      elapsedRecordField: true,
      mode: 'cascade',
    });

    // Ensure we give fitParser an isolated Node-like buffer or ArrayBuffer
    // Some parsers crash if they read off a view of a larger buffer.
    const isolatedBuffer = data.slice().buffer;

    fitParser.parse(isolatedBuffer, (error: Error | null, fitData: any) => {
      if (error) {
        reject(error);
        return;
      }

      const path: [number, number][] = [];
      let type: string | undefined = undefined;

      if (fitData && fitData.activity && Array.isArray(fitData.activity.sessions)) {
        for (const session of fitData.activity.sessions) {
          // Try to extract activity sport
          if (!type && session.sport) {
            const s = String(session.sport).toLowerCase();
            if (s.includes('cycl') || s.includes('bik')) type = 'Ride';
            else if (s.includes('run')) type = 'Run';
            else if (s.includes('swim')) type = 'Swim';
            else if (s.includes('walk') || s.includes('hike')) type = 'Walk';
          }

          if (Array.isArray(session.laps)) {
            for (const lap of session.laps) {
              if (Array.isArray(lap.records)) {
                for (const record of lap.records) {
                  if (typeof record.position_lat === 'number' && typeof record.position_long === 'number' &&
                    !isNaN(record.position_lat) && !isNaN(record.position_long)) {
                    path.push([record.position_long, record.position_lat]);
                  }
                }
              }
            }
          }
        }
      }

      if (path.length === 0 && fitData && Array.isArray(fitData.records)) {
        for (const record of fitData.records) {
          if (typeof record.position_lat === 'number' && typeof record.position_long === 'number' &&
            !isNaN(record.position_lat) && !isNaN(record.position_long)) {
            path.push([record.position_long, record.position_lat]);
          }
        }
      }

      resolve({ path, type });
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

import * as fflate from 'fflate';
import { gpx, tcx } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';
import FitParser from 'fit-file-parser';
import type { StravaActivity } from './types';

// Web worker context
const ctx: Worker = self as any;

ctx.onmessage = async (event: MessageEvent) => {
  const { type, buffer } = event.data;
  
  if (type === 'PARSE_ZIP') {
    try {
      ctx.postMessage({ type: 'PROGRESS', message: 'Loading zip file in memory...', percent: 10 });
      
      if (!buffer || buffer.byteLength === 0) {
        throw new Error("Uploaded file is empty or could not be read.");
      }

      const zipData = new Uint8Array(buffer);
      
      ctx.postMessage({ type: 'PROGRESS', message: 'Extracting activities...', percent: 15 });
      
      // Use unzipSync because we are already in a worker, blocking is fine and avoids async weirdness
      const unzipped = fflate.unzipSync(zipData, {
        filter: (file) => {
          if (!file || !file.name) return false;
          const name = file.name.toLowerCase();
          return name.includes('activities/') && 
                 (name.endsWith('.gpx') || name.endsWith('.tcx') || name.endsWith('.fit') || name.endsWith('.gz'));
        }
      });

      const files = Object.keys(unzipped);
      if (files.length === 0) {
        ctx.postMessage({ type: 'ERROR', message: 'No activity files (gpx, tcx, fit) found in the zip.' });
        return;
      }

      let parsedCount = 0;
      const totalRows = files.length;
      
      ctx.postMessage({ type: 'PROGRESS', message: `Parsing ${totalRows} activities...`, percent: 20 });
      
      const batchSize = 20;
      let batch: any[] = [];
      for (let i = 0; i < totalRows; i++) {
        const filename = files[i];
        let fileData = unzipped[filename];
        
        // If it's gzipped (like .fit.gz, .gpx.gz)
        if (filename.toLowerCase().endsWith('.gz')) {
          try {
            fileData = fflate.gunzipSync(fileData);
          } catch(e) {
            // skip if decompression fails
            console.warn("Failed to gunzip", filename);
          }
        }
        
        const baseName = filename.replace(/\.gz$/i, '').toLowerCase();
        let path: [number, number][] = [];
        let activityType = 'Other';
        
        try {
          if (baseName.endsWith('.gpx')) {
            const res = parseGpx(fileData);
            path = res.path;
            if (res.type) activityType = res.type;
          } else if (baseName.endsWith('.tcx')) {
            const res = parseTcx(fileData);
            path = res.path;
            if (res.type) activityType = res.type;
          } else if (baseName.endsWith('.fit')) {
            const res = await parseFit(fileData);
            path = res.path;
            if (res.type) activityType = res.type;
          }
        } catch(e) {
           // silently ignore parsing errors for individual files to continue
           console.warn("Failed to parse", filename, e);
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
          batch.push(activity);
        }

        parsedCount++;
        // flush batch periodically
        if (batch.length >= batchSize) {
          ctx.postMessage({ type: 'ACTIVITY_BATCH', activities: batch });
          batch = [];
        }

        if (parsedCount % 10 === 0) {
          ctx.postMessage({ type: 'PROGRESS', message: `Parsing tracks... ${parsedCount}/${totalRows}`, percent: 20 + Math.floor((parsedCount / totalRows) * 80) });
        }
      }
      // send remaining
      if (batch.length > 0) ctx.postMessage({ type: 'ACTIVITY_BATCH', activities: batch });
      
      ctx.postMessage({ type: 'DONE' });
      
    } catch (error: any) {
      console.error(error);
      ctx.postMessage({ type: 'ERROR', message: `Error processing zip: ${error.message}` });
    }
  }
};

function parseGpx(data: Uint8Array): { path: [number, number][], type?: string } {
  const text = fflate.strFromU8(data);
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  const geo = gpx(dom);
  return extractPathAndTypeFromGeoJSON(geo);
}

function parseTcx(data: Uint8Array): { path: [number, number][], type?: string } {
  const text = fflate.strFromU8(data);
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  const geo = tcx(dom);
  return extractPathAndTypeFromGeoJSON(geo);
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

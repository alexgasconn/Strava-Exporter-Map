import { useState, useEffect, useRef } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { WebMercatorViewport } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, TextLayer, BitmapLayer, IconLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { StravaActivity, ViewMode, Peak } from '../types';
import { getActivityColor } from '../types';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapViewProps {
  activities: StravaActivity[];
  viewMode: ViewMode;
  // peaks overlay
  peaks?: Peak[];
  showPeaks?: boolean;
  completedPeakIds?: Set<string>;
  completedPeaks?: Peak[];
  mapStyleUrl?: string;
  colorByGroups?: boolean;
  selectedPeak?: any | null;
  peakConquests?: Record<string, { activityId: string; name: string; date: string }>;
  onSelectPeak?: (p: any) => void;
}

const INITIAL_VIEW_STATE = {
  longitude: -3.7038, // Madrid
  latitude: 40.4168,
  zoom: 5,
  pitch: 0,
  bearing: 0
};

export default function MapView({ activities, viewMode, peaks, showPeaks = true, completedPeakIds, completedPeaks = [], mapStyleUrl, colorByGroups = false, selectedPeak = null, peakConquests, onSelectPeak }: MapViewProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  // popup holds the geographic peak; its screen position is reprojected each render
  const [popup, setPopup] = useState<null | { peak: any }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setDimensions({ width: el.clientWidth || 800, height: el.clientHeight || 600 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // CARTO raster tiles (user-provided key)
  const CARTO_RASTER_KEY = 'cb1_2hl3_1_c4dfd0f0c288bbb5cd981bed';
  const CARTO_RASTER_URL = `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_RASTER_KEY}`;

  useEffect(() => {
    // Auto-center when first activities are loaded
    if (activities.length > 0 && viewState === INITIAL_VIEW_STATE) {
      for (const act of activities) {
        if (act.path && act.path.length > 0 && Array.isArray(act.path[0]) && act.path[0].length >= 2) {
          setViewState({
            ...INITIAL_VIEW_STATE,
            longitude: act.path[0][0],
            latitude: act.path[0][1],
            zoom: 10
          });
          break;
        }
        // dynamic pin size based on current zoom so pins are visible without zooming
        const pinSize = (d: any) => {
          const z = (viewState && (viewState as any).zoom) || INITIAL_VIEW_STATE.zoom;
          const base = d.completed ? 26 : 22;
          return Math.max(12, Math.round(base + (z - 5) * 2.2));
        };
      }
    }
  }, [activities, viewState]);

  // show popup when selectedPeak prop changes (from Sidebar click)
  useEffect(() => {
    if (typeof (selectedPeak) !== 'undefined' && selectedPeak) {
      // selectedPeak may be either the internal singleItems object (has .position)
      // or a raw Peak from the JSON (lat/lon stored as strings). Handle both.
      let lon: number | null = null;
      let lat: number | null = null;
      let popupPeak: any = selectedPeak;
      if ((selectedPeak as any).position && Array.isArray((selectedPeak as any).position)) {
        lon = Number((selectedPeak as any).position[0]);
        lat = Number((selectedPeak as any).position[1]);
        popupPeak = selectedPeak;
      } else if ((selectedPeak as any).longitude !== undefined && (selectedPeak as any).latitude !== undefined) {
        const parsedLon = Number((selectedPeak as any).longitude);
        const parsedLat = Number((selectedPeak as any).latitude);
        if (!Number.isNaN(parsedLon) && !Number.isNaN(parsedLat)) {
          lon = parsedLon;
          lat = parsedLat;
          popupPeak = {
            id: selectedPeak.id,
            name: selectedPeak.name,
            height: selectedPeak.height,
            essencial: !!selectedPeak.essencial,
            image: selectedPeak.image,
            url: selectedPeak.url,
            completed: completedPeakIds ? completedPeakIds.has(selectedPeak.id) : false,
            position: [lon, lat]
          };
        }
      }

      if (lon !== null && lat !== null) {
        setViewState(v => ({ ...v, longitude: lon as number, latitude: lat as number, zoom: Math.max((v as any).zoom, 13) }));
        const conquest = peakConquests?.[popupPeak.id];
        setPopup({ peak: conquest ? { ...popupPeak, conquest } : popupPeak });
      }
    }
  }, [selectedPeak]);

  const visibleActivities = activities; // show all activity types

  // helper: distance between lat/lon in meters
  function haversineMeters([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]) {
    const toRad = (v: number) => v * Math.PI / 180;
    const R = 6371000; // meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // compute which activities end near any completed peak
  const conqueredActivityIds = new Set<string>();
  if (completedPeaks && completedPeaks.length > 0) {
    for (const act of visibleActivities) {
      if (!act.path || act.path.length === 0) continue;
      const last = act.path[act.path.length - 1];
      for (const p of completedPeaks) {
        const dist = haversineMeters([Number(last[0]), Number(last[1])], [Number(p.longitude), Number(p.latitude)]);
        if (dist <= 200) { // within 200m
          conqueredActivityIds.add(act.id);
          break;
        }
      }
    }
  }

  const layers = [];

  // Add CARTO raster tiles as the bottom-most layer so basemap is visible
  layers.push(
    new TileLayer({
      id: 'carto-raster-tiles',
      data: CARTO_RASTER_URL,
      tileSize: 256,
      minZoom: 0,
      maxZoom: 19,
      renderSubLayers: props => {
        const {
          bbox: { west, south, east, north } = props.tile.bbox as any
        } = props.tile;
        // Avoid passing the tile `data` through as the layer `data` prop —
        // Deck.gl may treat it as a container and call `count()` on it.
        // Instead, pass a null `data` and provide the tile image via `image`.
        return new BitmapLayer({ ...props, data: null } as any, {
          id: `${props.id}-bitmap`,
          image: props.data,
          bounds: [west, south, east, north]
        });
      }
    })
  );

  if (viewMode === 'polylines') {
    layers.push(
      new PathLayer({
        id: 'path-layer',
        data: visibleActivities,
        pickable: true,
        widthScale: 1,
        widthMinPixels: 2,
        getPath: d => d.path,
        getColor: d => conqueredActivityIds.has(d.id) ? [34, 197, 94] : (colorByGroups ? getActivityColor(d.type) : [249, 115, 22]),
        getWidth: d => 2
      })
    );
  }

  if (viewMode === 'endpoints') {
    // Generate start and end points
    const pointsData = visibleActivities.flatMap(a => {
      const pts = [];
      if (a.path.length > 0) {
        pts.push({ position: a.path[0], color: [0, 255, 0], type: 'Start' });
        pts.push({ position: a.path[a.path.length - 1], color: [255, 0, 0], type: 'End' });
      }
      return pts;
    });

    layers.push(
      new ScatterplotLayer({
        id: 'endpoints-layer',
        data: pointsData,
        pickable: true,
        opacity: 0.8,
        stroked: true,
        filled: true,
        radiusScale: 6,
        radiusMinPixels: 4,
        radiusMaxPixels: 100,
        lineWidthMinPixels: 1,
        getPosition: d => d.position,
        getFillColor: d => d.color,
        getLineColor: d => [255, 255, 255]
      })
    );
  }

  if (viewMode === 'heatmap') {
    // Flatten all points for heatmap
    const heatData = visibleActivities.flatMap(a => a.path.map(p => ({ position: p })));

    // Heatmap tuned per user request: factor=1.133, rad=8, blur=14
    // Deck.gl HeatmapLayer doesn't expose a direct 'blur' prop; we map:
    // - factor -> weight multiplier
    // - rad -> radiusPixels
    // - blur -> approximate via threshold (higher blur -> higher threshold for visualization)
    const HEAT_FACTOR = 1.133;
    const HEAT_RAD = 8;
    const HEAT_BLUR = 14; // mapped to threshold below

    layers.push(
      new HeatmapLayer({
        id: 'heatmap-layer',
        data: heatData,
        pickable: false,
        getPosition: d => d.position,
        getWeight: d => 1 * HEAT_FACTOR,
        radiusPixels: HEAT_RAD,
        intensity: 1,
        threshold: Math.min(0.95, Math.max(0.01, HEAT_BLUR / 100))
      })
    );
  }

  if (showPeaks && peaks && peaks.length > 0) {
    // Simple grid-based clustering depending on zoom
    const zoom = (viewState && (viewState as any).zoom) || INITIAL_VIEW_STATE.zoom;
    const sizeDeg = Math.max(0.02, 0.8 / Math.pow(2, zoom));

    const cells: Record<string, { count: number; lonSum: number; latSum: number; items: any[] }> = {};
    for (const p of peaks) {
      const lon = Number(p.longitude);
      const lat = Number(p.latitude);
      const key = `${Math.round(lon / sizeDeg)}_${Math.round(lat / sizeDeg)}`;
      if (!cells[key]) cells[key] = { count: 0, lonSum: 0, latSum: 0, items: [] };
      cells[key].count += 1;
      cells[key].lonSum += lon;
      cells[key].latSum += lat;
      cells[key].items.push({
        id: p.id,
        name: p.name,
        position: [lon, lat],
        height: p.height,
        essencial: !!p.essencial,
        image: p.image,
        url: p.url,
        completed: completedPeakIds ? completedPeakIds.has(p.id) : false
      });
    }

    const clusters = Object.values(cells).map(c => {
      if (c.count === 1) return { ...c.items[0], cluster: false };
      const lon = c.lonSum / c.count;
      const lat = c.latSum / c.count;
      return { cluster: true, count: c.count, position: [lon, lat], items: c.items };
    });

    const clusterItems = clusters.filter(c => c.cluster);
    const singleItems = clusters.filter(c => !c.cluster);

    if (clusterItems.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: 'peaks-clusters',
          data: clusterItems,
          pickable: true,
          getPosition: d => d.position,
          getRadius: d => 200 * Math.min(4, Math.log2(d.count + 1)),
          radiusUnits: 'meters',
          getFillColor: d => [240, 80, 40],
          getLineColor: [255, 255, 255],
          opacity: 0.8
        })
      );

      layers.push(
        new TextLayer({
          id: 'cluster-counts',
          data: clusterItems,
          getPosition: d => d.position,
          getText: d => String(d.count),
          getSize: 24,
          getColor: [255, 255, 255],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center'
        })
      );
    }

    if (singleItems.length > 0) {
      // subtle halo under each pin for visibility — use pixel units so it's visible without zooming
      const zoom = (viewState && (viewState as any).zoom) || INITIAL_VIEW_STATE.zoom;
      // much smaller halo so map remains uncluttered; pixel units so visible without zooming
      const haloRadiusPx = Math.max(6, Math.round(zoom * 1.6));
      layers.push(
        new ScatterplotLayer({
          id: 'peaks-halo',
          data: singleItems,
          pickable: false,
          getPosition: d => d.position,
          getRadius: d => haloRadiusPx,
          radiusUnits: 'pixels',
          getFillColor: d => d.completed ? [34, 197, 94, 120] : [0, 0, 0, 90],
          opacity: 0.7
        })
      );

      // emoji pins as simple colored icons: green = completed, red = not completed
      // dynamic pin size based on current zoom so pins are visible without zooming
      const pinSize = (d: any) => {
        const z = (viewState && (viewState as any).zoom) || INITIAL_VIEW_STATE.zoom;
        // compact pin base to look like location pins; keep small but scale slightly with zoom
        const base = d.completed ? 26 : 22;
        return Math.max(12, Math.round(base + (z - 5) * 2.2));
      };

      // Build an icon atlas of map pins (colored pin with inner white circle) and render via IconLayer.
      // Create atlas synchronously using canvas so we don't depend on external assets.
      const buildIconAtlas = () => {
        const icons = [
          { id: 'pin-completed', color: [34, 197, 94] },
          { id: 'pin-default', color: [244, 63, 94] }
        ];
        const iconSize = 64;
        const canvas = document.createElement('canvas');
        canvas.width = iconSize * icons.length;
        canvas.height = iconSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const mapping: Record<string, any> = {};
        icons.forEach((it, i) => {
          const ox = i * iconSize;
          const cx = ox + iconSize / 2;
          const cy = iconSize * 0.36;
          const r = iconSize * 0.28;
          // pin head (circle)
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${it.color.join(',')})`;
          ctx.fill();
          // pin tail (triangle)
          ctx.beginPath();
          ctx.moveTo(cx - r * 0.6, cy + r * 0.2);
          ctx.lineTo(cx + r * 0.6, cy + r * 0.2);
          ctx.lineTo(cx, cy + r * 1.45);
          ctx.closePath();
          ctx.fillStyle = `rgb(${it.color.join(',')})`;
          ctx.fill();
          // inner white circle
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          mapping[it.id] = { x: ox, y: 0, width: iconSize, height: iconSize, anchorY: iconSize };
        });

        const dataUrl = canvas.toDataURL();
        return { atlas: dataUrl, mapping };
      };

      const atlas = buildIconAtlas();
      if (atlas) {
        layers.push(
          new IconLayer({
            id: 'peaks-icons',
            data: singleItems,
            pickable: true,
            iconAtlas: atlas.atlas,
            iconMapping: atlas.mapping,
            getIcon: (d: any) => d.completed ? 'pin-completed' : 'pin-default',
            sizeScale: 1,
            sizeUnits: 'pixels',
            sizeMinPixels: 22,
            sizeMaxPixels: 56,
            getSize: (d: any) => {
              const z = (viewState && (viewState as any).zoom) || INITIAL_VIEW_STATE.zoom;
              const base = d.completed ? 34 : 30;
              return Math.max(22, Math.round(base + (z - 6) * 2));
            },
            getPosition: (d: any) => d.position
          })
        );
      }
    }
  }

  // Calculate center if we have data (first activity's first point)
  // Or better, let DeckGL handle view state if we use a controller, 
  // but to auto-center we'd need to compute bounding box. 
  // For simplicity we just start at default and let user pan.

  // Reproject the popup peak to screen coordinates every render so it stays
  // anchored to its geographic location while panning/zooming.
  let popupScreen: [number, number] | null = null;
  if (popup && popup.peak && Array.isArray(popup.peak.position)) {
    try {
      const vp = new WebMercatorViewport({ ...(viewState as any), width: dimensions.width, height: dimensions.height });
      const p = vp.project([Number(popup.peak.position[0]), Number(popup.peak.position[1])]);
      popupScreen = [p[0], p[1]];
    } catch (e) { /* ignore projection errors */ }
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <DeckGL
        viewState={viewState as any}
        onViewStateChange={({ viewState }) => setViewState(viewState as typeof INITIAL_VIEW_STATE)}
        controller={true}
        layers={layers}
        onClick={(info) => {
          if (!info) { setPopup(null); return; }

          // Determine the picked object robustly. Some renderers return minimal objects,
          // so fallback to layer data using info.index when needed.
          let obj: any = info.object as any;
          if ((!obj || Object.keys(obj).length === 0) && info.layer && typeof info.index === 'number') {
            try {
              const data = (info.layer as any).props?.data;
              if (Array.isArray(data) && data[info.index]) obj = data[info.index];
            } catch (e) { /* ignore */ }
          }

          if (!obj) { setPopup(null); return; }

          if (obj.cluster) {
            // zoom into cluster
            setViewState({ ...viewState, longitude: obj.position[0], latitude: obj.position[1], zoom: Math.min(((viewState as any).zoom || 5) + 2, 16) });
            setPopup(null);
            return;
          }

          if (obj.items && obj.items.length) {
            // defensive: cluster-like
            setViewState({ ...viewState, longitude: obj.position[0], latitude: obj.position[1], zoom: Math.min(((viewState as any).zoom || 5) + 2, 16) });
            setPopup(null);
            return;
          }

          // Single peak/object clicked.
          const conquest = peakConquests?.[obj.id];
          setPopup({ peak: conquest ? { ...obj, conquest } : obj });
          if (onSelectPeak) onSelectPeak(obj);
        }}
        getTooltip={({ object }) => object && ('name' in object ? `${object.name}\n${object.distance} km` : object.type)}
      >
        <Map
          mapStyle={mapStyleUrl || 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'}
        />
      </DeckGL>
      {popup && popup.peak && popupScreen && (
        <div
          style={{
            position: 'absolute',
            left: popupScreen[0],
            top: popupScreen[1],
            transform: 'translate(-50%, calc(-100% - 14px))',
            zIndex: 1000,
            pointerEvents: 'auto'
          }}
        >
          <div style={{ minWidth: 220, maxWidth: 260, background: 'rgba(15,18,24,0.97)', color: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.55)', border: '1px solid rgba(148,163,184,0.2)' }}>
            {popup.peak.image && <img src={popup.peak.image} alt={popup.peak.name} style={{ width: '100%', height: 120, objectFit: 'cover' }} />}
            <div style={{ padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.2 }}>{popup.peak.name}</div>
                <button
                  onClick={() => setPopup(null)}
                  style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
                  aria-label="Cerrar"
                >×</button>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {popup.peak.height && <span style={{ fontSize: 12, background: 'rgba(51,65,85,0.6)', padding: '2px 8px', borderRadius: 999 }}>{popup.peak.height} m</span>}
                {popup.peak.essencial && <span style={{ fontSize: 12, background: 'rgba(234,179,8,0.2)', color: '#fbbf24', padding: '2px 8px', borderRadius: 999 }}>Essencial</span>}
                <span style={{ fontSize: 12, background: popup.peak.completed ? 'rgba(34,197,94,0.2)' : 'rgba(148,163,184,0.15)', color: popup.peak.completed ? '#4ade80' : '#cbd5e1', padding: '2px 8px', borderRadius: 999 }}>
                  {popup.peak.completed ? 'Completado' : 'Pendiente'}
                </span>
              </div>
              {popup.peak.conquest && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(148,163,184,0.15)' }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Conquerit amb</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{popup.peak.conquest.name || 'Actividad'}</div>
                  {popup.peak.conquest.date && (
                    <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 1 }}>
                      {new Date(popup.peak.conquest.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </div>
                  )}
                </div>
              )}
              {popup.peak.url && <a href={popup.peak.url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 10, color: '#fbbf24', fontSize: 13, fontWeight: 600 }}>Ver en FEEC →</a>}
            </div>
          </div>
          {/* pointer */}
          <div style={{ position: 'absolute', left: '50%', bottom: -8, transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: '8px solid rgba(15,18,24,0.97)' }} />
        </div>
      )}
    </div>
  );
}

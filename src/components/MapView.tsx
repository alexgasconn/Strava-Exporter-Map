import { useState, useEffect } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer, TextLayer, BitmapLayer } from '@deck.gl/layers';
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
}

const INITIAL_VIEW_STATE = {
  longitude: -3.7038, // Madrid
  latitude: 40.4168,
  zoom: 5,
  pitch: 0,
  bearing: 0
};

export default function MapView({ activities, viewMode, peaks, showPeaks = true, completedPeakIds, completedPeaks = [], mapStyleUrl, colorByGroups = false }: MapViewProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [popup, setPopup] = useState<null | { x: number; y: number; peak: any }>(null);

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
      }
    }
  }, [activities, viewState]);

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
          bbox: { west, south, east, north }
        } = props.tile;
        return new BitmapLayer(props, {
          id: `${props.id}-bitmap`,
          data: null,
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

    layers.push(
      new HeatmapLayer({
        id: 'heatmap-layer',
        data: heatData,
        pickable: false,
        getPosition: d => d.position,
        getWeight: d => 1,
        radiusPixels: 15,
        intensity: 1,
        threshold: 0.05
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
      // subtle halo circle under each pin for visibility
      layers.push(
        new ScatterplotLayer({
          id: 'peaks-halo',
          data: singleItems,
          pickable: false,
          getPosition: d => d.position,
          getRadius: d => 60,
          radiusUnits: 'meters',
          getFillColor: d => d.completed ? [34, 197, 94, 60] : [0, 0, 0, 40],
          opacity: 0.6
        })
      );

      // emoji pins as icons (works without external assets), colored by status
      layers.push(
        new TextLayer({
          id: 'peaks-icons',
          data: singleItems,
          pickable: true,
          billboard: true,
          getPosition: d => d.position,
          getText: d => '📍',
          getSize: d => d.completed ? 48 : 40,
          getColor: d => d.completed ? [34, 197, 94] : (d.essencial ? [250, 204, 21] : [59, 130, 246]),
          getAngle: 0,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center'
        })
      );

      // optional small label under the pin
      layers.push(
        new TextLayer({
          id: 'peaks-labels',
          data: singleItems,
          pickable: false,
          billboard: false,
          getPosition: d => [d.position[0], d.position[1], 0],
          getText: d => d.name,
          getSize: 12,
          getColor: [230, 230, 230],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'top',
          sizeUnits: 'pixels',
          characterSet: 'auto',
          getPixelOffset: d => [12, -18]
        })
      );
    }
  }

  // Calculate center if we have data (first activity's first point)
  // Or better, let DeckGL handle view state if we use a controller, 
  // but to auto-center we'd need to compute bounding box. 
  // For simplicity we just start at default and let user pan.

  return (
    <div className="w-full h-full relative">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        controller={true}
        layers={layers}
        onClick={(info) => {
          if (!info || !info.object) { setPopup(null); return; }
          const obj = info.object as any;
          if (obj.cluster) {
            // zoom into cluster
            setViewState({ ...viewState, longitude: obj.position[0], latitude: obj.position[1], zoom: Math.min(((viewState as any).zoom || 5) + 2, 16) });
            setPopup(null);
          } else if (obj.items && obj.items.length) {
            // defensive: cluster-like
            setViewState({ ...viewState, longitude: obj.position[0], latitude: obj.position[1], zoom: Math.min(((viewState as any).zoom || 5) + 2, 16) });
            setPopup(null);
          } else {
            // single peak clicked
            setPopup({ x: info.x, y: info.y, peak: obj });
          }
        }}
        getTooltip={({ object }) => object && ('name' in object ? `${object.name}\n${object.distance} km` : object.type)}
      >
        <Map
          mapStyle={mapStyleUrl || 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'}
        />
        {popup && popup.peak && (
          <div style={{ position: 'absolute', left: popup.x, top: popup.y, transform: 'translate(-50%, -110%)', zIndex: 1000 }}>
            <div style={{ minWidth: 220, background: 'rgba(10,12,16,0.95)', color: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 6px 18px rgba(0,0,0,0.6)' }}>
              {popup.peak.image && <img src={popup.peak.image} alt={popup.peak.name} style={{ width: '100%', height: 120, objectFit: 'cover' }} />}
              <div style={{ padding: 8 }}>
                <div style={{ fontWeight: 700 }}>{popup.peak.name}</div>
                {popup.peak.height && <div style={{ fontSize: 12, color: '#cbd5e1' }}>{popup.peak.height} m</div>}
                {popup.peak.url && <a href={popup.peak.url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 6, color: '#fbbf24', fontSize: 13 }}>Ver en FEEC</a>}
              </div>
            </div>
          </div>
        )}
      </DeckGL>
    </div>
  );
}

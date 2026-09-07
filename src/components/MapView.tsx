import { useState, useEffect } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { StravaActivity, ViewMode } from '../types';
import { getActivityColor } from '../types';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapViewProps {
  activities: StravaActivity[];
  viewMode: ViewMode;
  filteredTypes: Set<string>;
}

const INITIAL_VIEW_STATE = {
  longitude: -3.7038, // Madrid
  latitude: 40.4168,
  zoom: 5,
  pitch: 0,
  bearing: 0
};

export default function MapView({ activities, viewMode, filteredTypes }: MapViewProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

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
  
  const visibleActivities = activities.filter(a => filteredTypes.has(a.type) || (filteredTypes.has('Other') && !['Ride', 'Run', 'Walk', 'Hike', 'Swim', 'VirtualRide', 'VirtualRun', 'EBikeRide'].includes(a.type)));
  
  const layers = [];

  if (viewMode === 'polylines') {
    layers.push(
      new PathLayer({
        id: 'path-layer',
        data: visibleActivities,
        pickable: true,
        widthScale: 1,
        widthMinPixels: 2,
        getPath: d => d.path,
        getColor: d => getActivityColor(d.type),
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

  // Calculate center if we have data (first activity's first point)
  // Or better, let DeckGL handle view state if we use a controller, 
  // but to auto-center we'd need to compute bounding box. 
  // For simplicity we just start at default and let user pan.

  return (
    <div className="absolute inset-0 w-full h-full">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        controller={true}
        layers={layers}
        getTooltip={({object}) => object && ('name' in object ? `${object.name}\n${object.distance} km` : object.type)}
      >
        <Map
          mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
        />
      </DeckGL>
    </div>
  );
}

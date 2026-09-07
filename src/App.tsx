/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import type { StravaActivity, ViewMode, Peak } from './types';
import peaksData from '../muntanyesRepte100CimsFEEC.json';
import Worker from './worker?worker';

export default function App() {
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('polylines');

  // no activity-type filtering: show all activities

  // Peaks (muntanyes)
  const [allPeaks] = useState<Peak[]>(() => (peaksData as Peak[] || []));
  const [showPeaks, setShowPeaks] = useState(false);
  const [onlyEssential, setOnlyEssential] = useState(false);
  const [peakSearch, setPeakSearch] = useState('');
  const [completionFilter, setCompletionFilter] = useState<'all' | 'done' | 'todo'>('all');
  const [visiblePeakIds, setVisiblePeakIds] = useState<Set<string>>(new Set());
  // computed set of completed peaks (automatic, from activities)
  const [completedPeakIds, setCompletedPeakIds] = useState<Set<string>>(new Set());
  const [proximityMeters, setProximityMeters] = useState<number>(50);

  // Map style selection (default OpenStreetMap)
  const MAP_STYLES: Record<string, string> = {
    OpenStreetMap: 'https://demotiles.maplibre.org/style.json',
    CartoDark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    CartoPositron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
  };
  const [mapStyleKey, setMapStyleKey] = useState<keyof typeof MAP_STYLES>('CartoPositron');
  const [colorByGroups, setColorByGroups] = useState<boolean>(false);

  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker();

    workerRef.current.onmessage = (e) => {
      const { type, message, percent, activity } = e.data;

      if (type === 'PROGRESS') {
        setProgressMsg(message);
        setProgress(percent);
      } else if (type === 'ACTIVITY_PARSED') {
        setActivities(prev => [...prev, activity]);
      } else if (type === 'DONE') {
        setLoading(false);
        setProgress(100);
        setProgressMsg('Complete');
      } else if (type === 'ERROR') {
        setLoading(false);
        setProgressMsg('Error: ' + message);
        console.error(message);
      }
    };

    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // initialize visiblePeakIds only when user chooses to show peaks
  useEffect(() => {
    if (showPeaks && allPeaks.length > 0 && visiblePeakIds.size === 0) {
      setVisiblePeakIds(new Set(allPeaks.map(p => p.id)));
    }
  }, [showPeaks, allPeaks]);

  // compute completed peaks automatically based on activities and proximity
  useEffect(() => {
    if (!activities || activities.length === 0 || !allPeaks || allPeaks.length === 0) {
      setCompletedPeakIds(new Set());
      return;
    }

    const toRad = (v: number) => v * Math.PI / 180;
    const haversine = (lon1: number, lat1: number, lon2: number, lat2: number) => {
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    const completed = new Set<string>();

    for (const peak of allPeaks) {
      const plon = Number(peak.longitude);
      const plat = Number(peak.latitude);
      if (Number.isNaN(plon) || Number.isNaN(plat)) continue;

      let found = false;
      for (const act of activities) {
        if (!act.path || act.path.length === 0) continue;
        for (const pt of act.path) {
          const lon = Number(pt[0]);
          const lat = Number(pt[1]);
          if (Number.isNaN(lon) || Number.isNaN(lat)) continue;
          const d = haversine(lon, lat, plon, plat);
          if (d <= proximityMeters) { found = true; break; }
        }
        if (found) break;
      }
      if (found) completed.add(peak.id);
    }

    setCompletedPeakIds(completed);
  }, [activities, allPeaks, proximityMeters]);

  const handleFileUpload = async (file: File) => {
    setLoading(true);
    setProgress(0);
    setProgressMsg('Initializing...');
    setActivities([]); // Clear previous

    try {
      const buffer = await file.arrayBuffer();
      workerRef.current?.postMessage({ type: 'PARSE_ZIP', buffer });
    } catch (e) {
      setLoading(false);
      setProgressMsg('Error reading file.');
    }
  };



  // compute peaks to show based on filters
  const peaksToShow = allPeaks.filter(p => {
    if (!visiblePeakIds.has(p.id)) return false;
    if (onlyEssential && !p.essencial) return false;
    if (peakSearch && !p.name.toLowerCase().includes(peakSearch.toLowerCase())) return false;
    if (completionFilter === 'done' && !completedPeakIds.has(p.id)) return false;
    if (completionFilter === 'todo' && completedPeakIds.has(p.id)) return false;
    return true;
  });

  const completedPeaks = allPeaks.filter(p => completedPeakIds.has(p.id));

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans">
      <MapView
        activities={activities}
        viewMode={viewMode}
        peaks={peaksToShow}
        showPeaks={showPeaks}
        completedPeakIds={completedPeakIds}
        completedPeaks={completedPeaks}
        mapStyleUrl={MAP_STYLES[mapStyleKey]}
        colorByGroups={colorByGroups}
      />
      <Sidebar
        onFileUpload={handleFileUpload}
        activities={activities}
        loading={loading}
        progress={progress}
        progressMsg={progressMsg}
        viewMode={viewMode}
        setViewMode={setViewMode}

        peaks={peaksToShow}
        showPeaks={showPeaks}
        setShowPeaks={setShowPeaks}
        onlyEssential={onlyEssential}
        setOnlyEssential={setOnlyEssential}
        peakSearch={peakSearch}
        setPeakSearch={setPeakSearch}
        completionFilter={completionFilter}
        setCompletionFilter={setCompletionFilter}
        visiblePeakIds={visiblePeakIds}
        setVisiblePeakIds={setVisiblePeakIds}
        completedPeakIds={completedPeakIds}
        proximityMeters={proximityMeters}
        setProximityMeters={setProximityMeters}
        colorByGroups={colorByGroups}
        setColorByGroups={setColorByGroups}
        mapStyleKey={mapStyleKey}
        setMapStyleKey={setMapStyleKey}
      />
    </div>
  );
}

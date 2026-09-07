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
  
  // Default all visible
  const [filteredTypes, setFilteredTypes] = useState<Set<string>>(
    new Set(['Ride', 'VirtualRide', 'EBikeRide', 'Run', 'Walk', 'Hike', 'VirtualRun', 'Swim', 'Other'])
  );

  // Peaks (muntanyes)
  const [allPeaks] = useState<Peak[]>(() => (peaksData as Peak[] || []));
  const [showPeaks, setShowPeaks] = useState(true);
  const [onlyEssential, setOnlyEssential] = useState(false);
  const [peakSearch, setPeakSearch] = useState('');
  const [completionFilter, setCompletionFilter] = useState<'all'|'done'|'todo'>('all');
  const [visiblePeakIds, setVisiblePeakIds] = useState<Set<string>>(new Set());
  const [completedPeakIds, setCompletedPeakIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('completedPeaks');
      return raw ? new Set(JSON.parse(raw)) : new Set<string>();
    } catch (e) {
      return new Set<string>();
    }
  });

  // Map style selection (default OpenStreetMap)
  const MAP_STYLES: Record<string, string> = {
    OpenStreetMap: 'https://demotiles.maplibre.org/style.json',
    CartoDark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    CartoPositron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
  };
  const [mapStyleKey, setMapStyleKey] = useState<keyof typeof MAP_STYLES>('OpenStreetMap');

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

  // initialize visiblePeakIds to include all peaks on first render
  useEffect(() => {
    if (allPeaks.length > 0 && visiblePeakIds.size === 0) {
      setVisiblePeakIds(new Set(allPeaks.map(p => p.id)));
    }
  }, [allPeaks]);

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

  const togglePeakCompleted = (id: string) => {
    const next = new Set(completedPeakIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCompletedPeakIds(next);
    try { localStorage.setItem('completedPeaks', JSON.stringify(Array.from(next))); } catch (e) {}
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

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans">
      <MapView 
        activities={activities} 
        viewMode={viewMode} 
        filteredTypes={filteredTypes}
        peaks={peaksToShow}
        showPeaks={showPeaks}
        completedPeakIds={completedPeakIds}
        mapStyleUrl={MAP_STYLES[mapStyleKey]}
      />
      <Sidebar 
        onFileUpload={handleFileUpload}
        activities={activities}
        loading={loading}
        progress={progress}
        progressMsg={progressMsg}
        viewMode={viewMode}
        setViewMode={setViewMode}
        filteredTypes={filteredTypes}
        setFilteredTypes={setFilteredTypes}
        peaks={allPeaks}
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
        togglePeakCompleted={togglePeakCompleted}
        mapStyleKey={mapStyleKey}
        setMapStyleKey={setMapStyleKey}
      />
    </div>
  );
}

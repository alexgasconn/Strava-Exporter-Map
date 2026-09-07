/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import type { StravaActivity, ViewMode } from './types';
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

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans">
      <MapView 
        activities={activities} 
        viewMode={viewMode} 
        filteredTypes={filteredTypes}
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
      />
    </div>
  );
}

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
  const [proximityMeters, setProximityMeters] = useState<number>(250);
  const [selectedPeak, setSelectedPeak] = useState<null | any>(null);
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  // do not store skipped files / parse errors / summary in UI state — log to console only
  // state variables removed per user preference

  // Map style: keep the default built into MapView (no user selection)
  const [colorByGroups, setColorByGroups] = useState<boolean>(false);

  const workerRef = useRef<Worker | null>(null);
  // Buffering to avoid many state updates while worker sends batches
  const activitiesBufferRef = useRef<StravaActivity[]>([]);
  const flushScheduledRef = useRef<boolean>(false);
  // debounce completed updates
  const pendingCompletedRef = useRef<string[] | null>(null);
  const completedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    workerRef.current = new Worker();

    workerRef.current.onmessage = (e) => {
      const { type, message, percent, activities: batch, completedIds, entries, filename, reason, stats } = e.data;

      if (type === 'PROGRESS') {
        setProgressMsg(message);
        setProgress(percent);
      } else if (type === 'DEBUG') {
        console.debug(message);
      } else if (type === 'SKIPPED_ENTRIES') {
        if (Array.isArray(entries)) console.debug('Skipped entries:', entries);
      } else if (type === 'PARSE_ERROR') {
        // only log parse errors to console per user request
        console.error('Worker parse error', filename, reason);
      } else if (type === 'ACTIVITY_BATCH') {
        if (Array.isArray(batch) && batch.length > 0) {
          // push into buffer and schedule a single flush to React state
          activitiesBufferRef.current.push(...batch);
          if (!flushScheduledRef.current) {
            flushScheduledRef.current = true;
            const flush = () => {
              const toFlush = activitiesBufferRef.current.splice(0);
              setActivities(prev => prev.concat(toFlush));
              flushScheduledRef.current = false;
            };
            if (typeof (window as any).requestIdleCallback === 'function') {
              (window as any).requestIdleCallback(flush, { timeout: 200 });
            } else {
              // fallback to rAF to keep UI responsive
              window.requestAnimationFrame(() => setTimeout(flush, 50));
            }
          }
        }
      } else if (type === 'COMPLETED_UPDATE') {
        if (Array.isArray(completedIds)) {
          // debounce applying completed IDs to avoid frequent re-renders
          pendingCompletedRef.current = completedIds;
          if (completedTimerRef.current) {
            window.clearTimeout(completedTimerRef.current);
            completedTimerRef.current = null;
          }
          completedTimerRef.current = window.setTimeout(() => {
            if (pendingCompletedRef.current) {
              setCompletedPeakIds(new Set(pendingCompletedRef.current));
              pendingCompletedRef.current = null;
            }
            completedTimerRef.current = null;
          }, 200);
        }
      } else if (type === 'SUMMARY') {
        console.log('Import summary', stats);
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

    // send initial peaks and proximity when worker is ready
    if (workerRef.current && allPeaks && allPeaks.length > 0) {
      workerRef.current.postMessage({ type: 'SET_PEAKS', peaks: allPeaks });
      workerRef.current.postMessage({ type: 'SET_PROXIMITY', proximity: proximityMeters });
    }

    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Listen for multiple-file selection events dispatched by Sidebar
  useEffect(() => {
    const handler = (e: any) => {
      const files = e.detail as FileList;
      if (files && files.length > 0) handleFilesUpload(files);
    };
    window.addEventListener('app-files-selected', handler as EventListener);
    return () => window.removeEventListener('app-files-selected', handler as EventListener);
  }, []);

  // initialize visiblePeakIds only when user chooses to show peaks
  useEffect(() => {
    if (showPeaks && allPeaks.length > 0 && visiblePeakIds.size === 0) {
      setVisiblePeakIds(new Set(allPeaks.map(p => p.id)));
    }
  }, [showPeaks, allPeaks]);

  // Proximity changes are handled by worker; notify it so it recomputes there
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'SET_PROXIMITY', proximity: proximityMeters });
    }
  }, [proximityMeters]);

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

  const handleFilesUpload = async (files: FileList | File[]) => {
    setLoading(true);
    setProgress(0);
    setProgressMsg('Initializing file parsing...');
    setActivities([]);

    try {
      const arr = Array.from(files as FileList);
      const toSend: { name: string; data: Uint8Array }[] = [];
      const transfer: ArrayBuffer[] = [];
      for (const f of arr) {
        const buf = await f.arrayBuffer();
        const u8 = new Uint8Array(buf);
        toSend.push({ name: f.name, data: u8 });
        transfer.push(u8.buffer);
      }
      // post files to worker; transfer underlying ArrayBuffers
      workerRef.current?.postMessage({ type: 'PARSE_FILES', files: toSend }, transfer);
    } catch (err) {
      setLoading(false);
      setProgressMsg('Error reading files.');
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
    <div className="flex h-screen bg-slate-950 font-sans">
      <div className="border-r border-slate-800/60" style={{ width: '30%' }}>
        <Sidebar
          onFileUpload={handleFileUpload}
          activities={activities}
          loading={loading}
          progress={progress}
          progressMsg={progressMsg}
          viewMode={viewMode}
          setViewMode={setViewMode}

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
          proximityMeters={proximityMeters}
          setProximityMeters={setProximityMeters}
          dateFrom={dateFrom}
          dateTo={dateTo}
          setDateFrom={setDateFrom}
          setDateTo={setDateTo}
          colorByGroups={colorByGroups}
          setColorByGroups={setColorByGroups}

          onSelectPeak={(p: any) => setSelectedPeak(p)}
        />
      </div>
      <div className="flex-1 relative">
        <MapView
          activities={activities.filter(a => {
            if ((!dateFrom && !dateTo) || !a.date) return true;
            const aDate = a.date.split('T')[0];
            if (dateFrom && aDate < dateFrom) return false;
            if (dateTo && aDate > dateTo) return false;
            return true;
          })}
          viewMode={viewMode}
          peaks={showPeaks ? peaksToShow : []}
          showPeaks={showPeaks}
          completedPeakIds={completedPeakIds}
          completedPeaks={completedPeaks}
          colorByGroups={colorByGroups}
          selectedPeak={selectedPeak}
          onSelectPeak={(p: any) => setSelectedPeak(p)}
        />
      </div>
    </div>
  );
}

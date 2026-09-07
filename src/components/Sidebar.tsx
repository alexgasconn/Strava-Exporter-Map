import { useState, useRef } from 'react';
import { Upload, Map as MapIcon, Target, Flame, Activity, Search } from 'lucide-react';
import type { ViewMode, StravaActivity, Peak } from '../types';
import { ACTIVITY_COLORS } from '../types';

interface SidebarProps {
  onFileUpload: (file: File) => void;
  activities: StravaActivity[];
  loading: boolean;
  progress: number;
  progressMsg: string;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  filteredTypes: Set<string>;
  setFilteredTypes: (types: Set<string>) => void;
  // peaks props
  peaks: Peak[];
  showPeaks: boolean;
  setShowPeaks: (v: boolean) => void;
  onlyEssential: boolean;
  setOnlyEssential: (v: boolean) => void;
  peakSearch: string;
  setPeakSearch: (s: string) => void;
  completionFilter: 'all'|'done'|'todo';
  setCompletionFilter: (f: 'all'|'done'|'todo') => void;
  visiblePeakIds: Set<string>;
  setVisiblePeakIds: (s: Set<string>) => void;
  completedPeakIds: Set<string>;
  togglePeakCompleted: (id: string) => void;
  mapStyleKey: string;
  setMapStyleKey: (k: string) => void;
}

const CATEGORIES = [
  { id: 'Ride', label: 'Bike', colors: ['Ride', 'VirtualRide', 'EBikeRide'] },
  { id: 'Run', label: 'Foot', colors: ['Run', 'Walk', 'Hike', 'VirtualRun'] },
  { id: 'Swim', label: 'Swim', colors: ['Swim'] },
  { id: 'Other', label: 'Other', colors: ['Other'] }
];

export default function Sidebar({
  onFileUpload, activities, loading, progress, progressMsg, viewMode, setViewMode, filteredTypes, setFilteredTypes
  , peaks, showPeaks, setShowPeaks, onlyEssential, setOnlyEssential, peakSearch, setPeakSearch, completionFilter, setCompletionFilter, visiblePeakIds, setVisiblePeakIds, completedPeakIds, togglePeakCompleted, mapStyleKey, setMapStyleKey
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileUpload(file);
    }
    // reset
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const toggleCategory = (catId: string, keys: string[]) => {
    const next = new Set(filteredTypes);
    // Check if category is active (at least one key is in set)
    const isActive = keys.some(k => next.has(k));
    
    if (isActive) {
      keys.forEach(k => next.delete(k));
    } else {
      keys.forEach(k => next.add(k));
    }
    
    // For 'Other' we just track 'Other' but MapView handles filtering out known ones
    if (catId === 'Other') {
      if (next.has('Other')) next.delete('Other');
      else next.add('Other');
    }
    
    setFilteredTypes(next);
  };

  return (
    <div className="absolute top-4 left-4 z-10 w-80 max-h-[calc(100vh-2rem)] overflow-y-auto bg-slate-900/90 backdrop-blur-md text-slate-100 rounded-2xl shadow-2xl border border-slate-700/50 p-6 flex flex-col gap-6">
      
      <div className="flex items-center gap-3">
        <Activity className="w-8 h-8 text-orange-500" />
        <h1 className="text-xl font-bold tracking-tight">Strava Explorer</h1>
      </div>

      <div className="flex flex-col gap-2">
        <button 
          onClick={handleUploadClick}
          disabled={loading}
          className="w-full bg-orange-600 hover:bg-orange-500 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Upload className="w-5 h-5" />
          {loading ? 'Parsing...' : 'Upload Strava Export (.zip)'}
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          accept=".zip" 
          onChange={handleFileChange} 
          className="hidden" 
        />
        
        {loading && (
          <div className="mt-2 text-sm text-slate-400">
            <div className="flex justify-between mb-1">
              <span>{progressMsg}</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div className="bg-orange-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        )}
        
        {!loading && activities.length > 0 && (
          <div className="mt-2 text-sm text-slate-300 flex items-center justify-between bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
            <span>Activities Loaded:</span>
            <span className="font-bold text-orange-400">{activities.length}</span>
          </div>
        )}
      </div>

      {activities.length > 0 && (
        <>
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">View Mode</h2>
            <div className="grid grid-cols-3 gap-2">
              <button 
                onClick={() => setViewMode('polylines')}
                className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${viewMode === 'polylines' ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
              >
                <MapIcon className="w-5 h-5" />
                <span className="text-xs font-medium">Lines</span>
              </button>
              <button 
                onClick={() => setViewMode('heatmap')}
                className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${viewMode === 'heatmap' ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
              >
                <Flame className="w-5 h-5" />
                <span className="text-xs font-medium">Heat</span>
              </button>
              <button 
                onClick={() => setViewMode('endpoints')}
                className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${viewMode === 'endpoints' ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
              >
                <Target className="w-5 h-5" />
                <span className="text-xs font-medium">Ends</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Basemap</h2>
            <div className="flex gap-2">
              <button onClick={() => setMapStyleKey('OpenStreetMap')} className={`p-2 rounded-md ${mapStyleKey === 'OpenStreetMap' ? 'bg-orange-500 text-black' : 'bg-slate-800/40'}`}>OSM</button>
              <button onClick={() => setMapStyleKey('CartoPositron')} className={`p-2 rounded-md ${mapStyleKey === 'CartoPositron' ? 'bg-orange-500 text-black' : 'bg-slate-800/40'}`}>Light</button>
              <button onClick={() => setMapStyleKey('CartoDark')} className={`p-2 rounded-md ${mapStyleKey === 'CartoDark' ? 'bg-orange-500 text-black' : 'bg-slate-800/40'}`}>Dark</button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Filters</h2>
            <div className="flex flex-col gap-2">
              {CATEGORIES.map(cat => {
                const isActive = cat.id === 'Other' ? filteredTypes.has('Other') : cat.colors.some(k => filteredTypes.has(k));
                
                // Get display color for category
                const typeKey = cat.colors[0];
                const colorArr = ACTIVITY_COLORS[typeKey] || ACTIVITY_COLORS.Other;
                const rgb = `rgb(${colorArr[0]}, ${colorArr[1]}, ${colorArr[2]})`;
                
                return (
                  <button 
                    key={cat.id}
                    onClick={() => toggleCategory(cat.id, cat.colors)}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-all ${isActive ? 'bg-slate-800 border-slate-600' : 'bg-slate-800/30 border-transparent opacity-50 hover:opacity-80'}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-4 h-4 rounded-full shadow-sm" style={{ backgroundColor: rgb }}></div>
                      <span className="text-sm font-medium">{cat.label}</span>
                    </div>
                    <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${isActive ? 'border-orange-500 bg-orange-500' : 'border-slate-500'}`}>
                      {isActive && <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Peaks</h2>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showPeaks} onChange={e => setShowPeaks(e.target.checked)} />
                <span className="text-sm ml-1">Mostrar picos</span>
              </label>
              <label className="flex items-center gap-2 ml-4">
                <input type="checkbox" checked={onlyEssential} onChange={e => setOnlyEssential(e.target.checked)} />
                <span className="text-sm ml-1">Solo esenciales</span>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <Search className="w-4 h-4" />
              <input value={peakSearch} onChange={e => setPeakSearch(e.target.value)} placeholder="Buscar pico" className="w-full bg-slate-800/20 p-2 rounded-md text-sm" />
            </div>

            <div className="flex gap-2">
              <button onClick={() => setCompletionFilter('all')} className={`p-2 rounded-md ${completionFilter === 'all' ? 'bg-orange-500' : 'bg-slate-800/30'}`}>Todos</button>
              <button onClick={() => setCompletionFilter('done')} className={`p-2 rounded-md ${completionFilter === 'done' ? 'bg-orange-500' : 'bg-slate-800/30'}`}>Completados</button>
              <button onClick={() => setCompletionFilter('todo')} className={`p-2 rounded-md ${completionFilter === 'todo' ? 'bg-orange-500' : 'bg-slate-800/30'}`}>Pendientes</button>
            </div>

            <div className="max-h-40 overflow-y-auto mt-2">
              {peaks.slice(0, 200).map(p => {
                const visible = visiblePeakIds.has(p.id);
                const done = completedPeakIds.has(p.id);
                return (
                  <div key={p.id} className="flex items-center justify-between p-2 rounded hover:bg-slate-800/40">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={visible} onChange={() => {
                        const next = new Set(visiblePeakIds);
                        if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                        setVisiblePeakIds(next);
                      }} />
                      <div>
                        <div className="text-sm font-medium">{p.name}</div>
                        <div className="text-xs text-slate-400">{p.height} m</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => togglePeakCompleted(p.id)} className={`px-2 py-1 text-xs rounded ${done ? 'bg-green-600' : 'bg-slate-800/30'}`}>{done ? 'Hecho' : 'Marcar'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      
    </div>
  );
}

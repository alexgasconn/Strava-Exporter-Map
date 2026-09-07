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
  // peaks props
  peaks: Peak[];
  showPeaks: boolean;
  setShowPeaks: (v: boolean) => void;
  onlyEssential: boolean;
  setOnlyEssential: (v: boolean) => void;
  peakSearch: string;
  setPeakSearch: (s: string) => void;
  completionFilter: 'all' | 'done' | 'todo';
  setCompletionFilter: (f: 'all' | 'done' | 'todo') => void;
  visiblePeakIds: Set<string>;
  setVisiblePeakIds: (s: Set<string>) => void;
  completedPeakIds: Set<string>;
  proximityMeters: number;
  setProximityMeters: (n: number) => void;
  mapStyleKey: string;
  setMapStyleKey: (k: string) => void;
  colorByGroups: boolean;
  setColorByGroups: (v: boolean) => void;
  onSelectPeak?: (p: any) => void;
}


export default function Sidebar({
  onFileUpload, activities, loading, progress, progressMsg, viewMode, setViewMode,
  peaks, showPeaks, setShowPeaks, onlyEssential, setOnlyEssential, peakSearch, setPeakSearch, completionFilter, setCompletionFilter, visiblePeakIds, setVisiblePeakIds, completedPeakIds, proximityMeters, setProximityMeters, mapStyleKey, setMapStyleKey, colorByGroups, setColorByGroups, onSelectPeak
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortBy, setSortBy] = useState<'name' | 'height' | 'comarca' | 'essencial' | 'status'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [comarcaFilter, setComarcaFilter] = useState<string>('all');

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

  // no activity-type filters; show all activities

  // compute unique comarcas for filter dropdown
  const comarcaOptions = Array.from(new Set(peaks.map(p => (p.comarca || '').trim()).filter(s => s))).sort();

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const filteredPeaks = peaks.filter(p => {
    if (onlyEssential && !p.essencial) return false;
    if (peakSearch && !p.name.toLowerCase().includes(peakSearch.toLowerCase())) return false;
    if (completionFilter === 'done' && !completedPeakIds.has(p.id)) return false;
    if (completionFilter === 'todo' && completedPeakIds.has(p.id)) return false;
    if (comarcaFilter !== 'all') {
      const c = (p.comarca || '').toLowerCase();
      if (c !== comarcaFilter.toLowerCase()) return false;
    }
    return true;
  });

  const sortedPeaks = filteredPeaks.sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'name') return dir * a.name.localeCompare(b.name);
    if (sortBy === 'height') return dir * (Number(a.height || 0) - Number(b.height || 0));
    if (sortBy === 'comarca') return dir * ((a.comarca || '').localeCompare(b.comarca || ''));
    if (sortBy === 'essencial') return dir * ((a.essencial ? 1 : 0) - (b.essencial ? 1 : 0));
    if (sortBy === 'status') return dir * ((completedPeakIds.has(a.id) ? 1 : 0) - (completedPeakIds.has(b.id) ? 1 : 0));
    return 0;
  });

  return (
    <div className="h-full w-full max-h-screen overflow-y-auto bg-slate-900/95 text-slate-100 border-r border-slate-800/50 p-6 flex flex-col gap-6">

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

      {/* Top: View/Map Configuration */}
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

        <div className="mt-2 flex items-center gap-2">
          <button onClick={() => setColorByGroups(!colorByGroups)} className={`px-3 py-1 rounded-md ${colorByGroups ? 'bg-orange-500 text-black' : 'bg-slate-800/30'}`}>
            {colorByGroups ? '4 Colores: ON' : '4 Colores: OFF'}
          </button>
          {colorByGroups && (
            <div className="flex items-center gap-2 ml-2 text-xs">
              <div className="flex items-center gap-1">
                <span className="w-3 h-3 rounded" style={{ backgroundColor: `rgb(${ACTIVITY_COLORS.Ride.join(',')})` }}></span>
                <span>Ride</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-3 h-3 rounded" style={{ backgroundColor: `rgb(${ACTIVITY_COLORS.Run.join(',')})` }}></span>
                <span>Run</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-3 h-3 rounded" style={{ backgroundColor: `rgb(${ACTIVITY_COLORS.Swim.join(',')})` }}></span>
                <span>Swim</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-3 h-3 rounded" style={{ backgroundColor: `rgb(${ACTIVITY_COLORS.Other.join(',')})` }}></span>
                <span>Other</span>
              </div>
            </div>
          )}
        </div>
      </div>


      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Peaks DB</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showPeaks} onChange={e => setShowPeaks(e.target.checked)} />
            <span className="text-sm ml-1">Mostrar picos en mapa</span>
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

        <div className="flex gap-2 items-center">
          <div className="flex gap-1">
            <button onClick={() => setCompletionFilter('all')} className={`p-2 rounded-md ${completionFilter === 'all' ? 'bg-orange-500' : 'bg-slate-800/30'}`}>Todos</button>
            <button onClick={() => setCompletionFilter('done')} className={`p-2 rounded-md ${completionFilter === 'done' ? 'bg-orange-500' : 'bg-slate-800/30'}`}>Completados</button>
            <button onClick={() => setCompletionFilter('todo')} className={`p-2 rounded-md ${completionFilter === 'todo' ? 'bg-orange-500' : 'bg-slate-800/30'}`}>Pendientes</button>
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <label>Comarca:</label>
            <select value={comarcaFilter} onChange={e => setComarcaFilter(e.target.value)} className="bg-slate-800/30 p-1 rounded">
              <option value="all">Todas</option>
              {comarcaOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm">Umbral de proximidad: <span className="font-medium">{proximityMeters} m</span></label>
          <input type="range" min={20} max={500} step={5} value={proximityMeters} onChange={e => setProximityMeters(Number(e.target.value))} />
        </div>

        <div className="max-h-[38vh] overflow-y-auto mt-2">
          <table className="w-full text-sm">
            <thead className="text-slate-400 text-xs">
              <tr>
                <th className="text-left">&nbsp;</th>
                <th onClick={() => toggleSort('name')} className="cursor-pointer">Pico {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => toggleSort('height')} className="cursor-pointer">Alt {sortBy === 'height' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => toggleSort('comarca')} className="cursor-pointer">Comarca {sortBy === 'comarca' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => toggleSort('essencial')} className="cursor-pointer">Ess {sortBy === 'essencial' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => toggleSort('status')} className="cursor-pointer">Estado {sortBy === 'status' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              </tr>
            </thead>
            <tbody>
              {sortedPeaks.map(p => {
                const visible = visiblePeakIds.has(p.id);
                const done = completedPeakIds.has(p.id);
                return (
                  <tr key={p.id} className="hover:bg-slate-800/30">
                    <td className="py-1">
                      <input type="checkbox" checked={visible} onChange={() => {
                        const next = new Set(visiblePeakIds);
                        if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                        setVisiblePeakIds(next);
                      }} />
                    </td>
                    <td className="py-1"><button onClick={() => onSelectPeak?.(p)} className="text-left w-full text-sm hover:underline">{p.name}</button></td>
                    <td className="text-xs text-slate-400">{p.height}</td>
                    <td className="text-xs">{p.comarca || '—'}</td>
                    <td className="text-xs">{p.essencial ? 'Sí' : '—'}</td>
                    <td className="text-xs font-medium text-right">{done ? <span className="text-emerald-400">Completado</span> : <span className="text-slate-400">Pendiente</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

import { useState, useRef } from 'react';
import { Upload, Activity, Mountain, CheckCircle2, Search, MapPin } from 'lucide-react';
import type { StravaActivity, Peak } from '../types';

const CHALLENGE_GOAL = 100;

interface SidebarProps {
  onFileUpload: (file: File) => void;
  activities: StravaActivity[];
  loading: boolean;
  progress: number;
  progressMsg: string;
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
  completedPeakIds: Set<string>;
  proximityMeters: number;
  setProximityMeters: (n: number) => void;
  dateFrom: string;
  dateTo: string;
  setDateFrom: (s: string) => void;
  setDateTo: (s: string) => void;
  onSelectPeak?: (p: any) => void;
}


export default function Sidebar({
  onFileUpload, activities, loading, progress, progressMsg,
  peaks, showPeaks, setShowPeaks, onlyEssential, setOnlyEssential, peakSearch, setPeakSearch, completionFilter, setCompletionFilter, completedPeakIds, proximityMeters, setProximityMeters, dateFrom, dateTo, setDateFrom, setDateTo, onSelectPeak
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const multiFileInputRef = useRef<HTMLInputElement>(null);
  const [sortBy, setSortBy] = useState<'name' | 'height' | 'comarca' | 'essencial' | 'status'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [comarcaFilter, setComarcaFilter] = useState<string>('all');

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleMultiClick = () => {
    multiFileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length === 1) {
      const file = files[0];
      onFileUpload(file);
    } else if (files && files.length > 1) {
      // dispatch a global event so App can handle multiple files if it listens
      const evt = new CustomEvent('app-files-selected', { detail: files });
      window.dispatchEvent(evt);
    }
    // reset
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // no activity-type filters; show all activities

  // compute unique comarcas for filter dropdown (split comma-separated region values)
  const comarcaOptions = Array.from(new Set(
    peaks.flatMap(p => (p.region || '').split(',').map(s => s.trim()).filter(Boolean))
  )).sort();

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
      const regions = (p.region || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (!regions.includes(comarcaFilter.toLowerCase())) return false;
    }
    return true;
  });

  const sortedPeaks = filteredPeaks.sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'name') return dir * a.name.localeCompare(b.name);
    if (sortBy === 'height') return dir * (Number(a.height || 0) - Number(b.height || 0));
    if (sortBy === 'comarca') return dir * ((a.region || '').localeCompare(b.region || ''));
    if (sortBy === 'essencial') return dir * ((a.essencial ? 1 : 0) - (b.essencial ? 1 : 0));
    if (sortBy === 'status') return dir * ((completedPeakIds.has(a.id) ? 1 : 0) - (completedPeakIds.has(b.id) ? 1 : 0));
    return 0;
  });

  const totalPeaks = peaks.length;
  const donePeaks = peaks.filter(p => completedPeakIds.has(p.id)).length;
  const goalPct = Math.round((Math.min(donePeaks, CHALLENGE_GOAL) / CHALLENGE_GOAL) * 100);

  return (
    <div className="h-full w-full max-h-screen overflow-y-auto bg-slate-900/95 text-slate-100 border-r border-slate-800/50 p-5 flex flex-col gap-5">

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-lg shadow-orange-500/20">
          <Activity className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold tracking-tight leading-none">Strava Explorer</h1>
          <p className="text-xs text-slate-400 mt-0.5">Repte 100 Cims · FEEC</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={handleUploadClick}
          disabled={loading}
          className="w-full bg-orange-600 hover:bg-orange-500 text-white font-medium py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Upload className="w-4 h-4" />
          {loading ? 'Parsing…' : 'Importar export (.zip)'}
        </button>
        <button
          onClick={handleMultiClick}
          disabled={loading}
          className="w-full bg-slate-800/60 hover:bg-slate-800 text-slate-200 text-sm font-medium py-2 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cargar archivos (.gpx/.fit)
        </button>
        <input
          type="file"
          ref={fileInputRef}
          accept=".zip"
          onChange={handleFileChange}
          className="hidden"
        />

        <input
          ref={multiFileInputRef}
          type="file"
          multiple
          accept=".gpx,.tcx,.fit,.gz"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
              const evt = new CustomEvent('app-files-selected', { detail: files });
              window.dispatchEvent(evt);
            }
            if (e.currentTarget) e.currentTarget.value = '';
          }}
          className="hidden"
        />

        {loading && (
          <div className="mt-1 text-sm text-slate-400">
            <div className="flex justify-between mb-1">
              <span className="truncate pr-2">{progressMsg}</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div className="bg-orange-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        )}
      </div>

      {/* Stats overview */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-slate-400 text-xs">
            <Activity className="w-3.5 h-3.5" /> Actividades
          </div>
          <div className="text-2xl font-bold text-orange-400 leading-none">{activities.length}</div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-slate-400 text-xs">
            <Mountain className="w-3.5 h-3.5" /> Cims fets
          </div>
          <div className="text-2xl font-bold text-emerald-400 leading-none">{donePeaks}<span className="text-sm text-slate-500 font-medium">/{totalPeaks}</span></div>
        </div>
      </div>
      <div className="-mt-2">
        <div className="flex justify-between text-xs text-slate-400 mb-1">
          <span>Objectiu Repte 100 Cims</span>
          <span className="font-medium text-slate-200">{Math.min(donePeaks, CHALLENGE_GOAL)}/{CHALLENGE_GOAL}</span>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
          <div className="bg-gradient-to-r from-emerald-500 to-emerald-400 h-2 rounded-full transition-all duration-500" style={{ width: `${goalPct}%` }}></div>
        </div>
      </div>


      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Mountain className="w-3.5 h-3.5" /> Cims ({sortedPeaks.length})
          </h2>
        </div>

        {/* Toggles */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setShowPeaks(!showPeaks)}
            className={`flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-lg border transition-all ${showPeaks ? 'bg-orange-500/20 border-orange-500 text-orange-300' : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
          >
            <MapPin className="w-3.5 h-3.5" /> {showPeaks ? 'Visibles' : 'Ocultos'}
          </button>
          <button
            onClick={() => setOnlyEssential(!onlyEssential)}
            className={`flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-lg border transition-all ${onlyEssential ? 'bg-amber-500/20 border-amber-500 text-amber-300' : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'}`}
          >
            ★ Solo esenciales
          </button>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 bg-slate-800/50 border border-slate-700/50 rounded-lg px-3">
          <Search className="w-4 h-4 text-slate-500 shrink-0" />
          <input value={peakSearch} onChange={e => setPeakSearch(e.target.value)} placeholder="Buscar cim…" className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-slate-500" />
        </div>

        {/* Completion filter chips */}
        <div className="grid grid-cols-3 gap-1.5 bg-slate-800/40 p-1 rounded-lg">
          {([['all', 'Todos'], ['done', 'Fets'], ['todo', 'Pendientes']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setCompletionFilter(key)}
              className={`text-xs font-medium py-1.5 rounded-md transition-all ${completionFilter === key ? 'bg-orange-500 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Comarca + date filters */}
        <div className="flex items-center gap-2">
          <select value={comarcaFilter} onChange={e => setComarcaFilter(e.target.value)} className="flex-1 bg-slate-800/50 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm outline-none">
            <option value="all">Todas las comarcas</option>
            {comarcaOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="flex-1 bg-slate-800/50 border border-slate-700/50 rounded-lg px-2 py-1.5 outline-none" />
          <span className="text-slate-500">→</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="flex-1 bg-slate-800/50 border border-slate-700/50 rounded-lg px-2 py-1.5 outline-none" />
          {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-slate-400 hover:text-slate-200">✕</button>}
        </div>

        {/* Proximity slider */}
        <div className="flex flex-col gap-1.5">
          <label className="flex justify-between text-xs text-slate-400">
            <span>Umbral de proximidad</span>
            <span className="font-medium text-slate-200">{proximityMeters} m</span>
          </label>
          <input type="range" min={20} max={500} step={5} value={proximityMeters} onChange={e => setProximityMeters(Number(e.target.value))} className="w-full accent-orange-500" />
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 text-xs text-slate-400">
          <span>Ordenar:</span>
          {([['name', 'Nombre'], ['height', 'Altura'], ['status', 'Estado']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={`px-1.5 py-0.5 rounded ${sortBy === key ? 'text-orange-300' : 'hover:text-slate-200'}`}
            >
              {label}{sortBy === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
            </button>
          ))}
        </div>

        {/* Peak list */}
        <div className="flex flex-col gap-1 -mx-1">
          {sortedPeaks.length === 0 && (
            <div className="text-center text-sm text-slate-500 py-6">No hay cims que coincidan.</div>
          )}
          {sortedPeaks.map(p => {
            const done = completedPeakIds.has(p.id);
            return (
              <div
                key={p.id}
                className={`group flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors cursor-pointer ${done ? 'hover:bg-emerald-500/10' : 'hover:bg-slate-800/60'}`}
                onClick={() => onSelectPeak?.(p)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate group-hover:text-orange-300">{p.name}</span>
                    {p.essencial && <span className="text-amber-400 text-xs shrink-0">★</span>}
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    {p.height ? `${p.height} m` : ''}{p.height && p.region ? ' · ' : ''}{p.region || ''}
                  </div>
                </div>
                {done
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  : <span className="w-4 h-4 rounded-full border border-slate-600 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

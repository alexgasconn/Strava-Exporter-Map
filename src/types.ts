export interface StravaActivity {
  id: string;
  name: string;
  type: string;
  date: string;
  distance: number;
  path: [number, number][]; // [longitude, latitude][]
}

export type ViewMode = 'polylines' | 'heatmap' | 'endpoints';

export const ACTIVITY_COLORS: Record<string, [number, number, number]> = {
  Ride: [59, 130, 246], // Blue
  VirtualRide: [59, 130, 246],
  EBikeRide: [59, 130, 246],
  Run: [249, 115, 22], // Orange
  Walk: [249, 115, 22],
  Hike: [249, 115, 22],
  VirtualRun: [249, 115, 22],
  Swim: [6, 182, 212], // Cyan
  Other: [156, 163, 175], // Gray
};

export function getActivityColor(type: string): [number, number, number] {
  return ACTIVITY_COLORS[type] || ACTIVITY_COLORS.Other;
}

// Fit parser types workaround
declare module 'fit-file-parser' {
  export default class FitParser {
    constructor(options: any);
    parse(buffer: ArrayBuffer | Uint8Array, callback: (error: Error | null, data: any) => void): void;
  }
}

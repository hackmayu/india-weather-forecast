// Data access for the UI. Two interchangeable back ends with identical signatures and results:
//   * network mode (default): the FastAPI service under /api  (Render, local development)
//   * static mode (VITE_STATIC_DATA=1, e.g. Vercel): prebuilt files under /data, computed in the browser
//     by staticData.ts using the same rules (parity is tested against golden outputs of the real API).
import * as staticData from "./staticData";
import { ApiError } from "./types";
import type { Kind, MapResp, PointResp, ProbMapResp, ProbMeta, ProbPointResp, RunMeta, RunSummary, Status, VariableId } from "./types";

export * from "./types";

export const STATIC_MODE = import.meta.env.VITE_STATIC_DATA === "1";

// Identical GETs that are in flight at the same moment (e.g. a prefetch and the real request) share one network call.
const inflight = new Map<string, Promise<unknown>>();
function get<T>(path: string): Promise<T> {
  const hit = inflight.get(path) as Promise<T> | undefined;
  if (hit) return hit;
  const p = getOnce<T>(path).finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

async function getOnce<T>(path: string): Promise<T> {
  let r: Response;
  try { r = await fetch(path); } catch { throw new ApiError(0, "Cannot reach the forecast service."); }
  if (!r.ok) {
    let detail = `Request failed (${r.status}).`;
    try {
      const j = await r.json();
      if (typeof j.detail === "string") detail = j.detail;
      else if (Array.isArray(j.detail) && j.detail[0]?.msg) detail = String(j.detail[0].msg);
    } catch { /* keep default */ }
    throw new ApiError(r.status, detail);
  }
  return r.json() as Promise<T>;
}

export const fetchStatus = (): Promise<Status> =>
  STATIC_MODE ? staticData.fetchStatus() : get<Status>("/api/status").then((s) => ({ ...s, mode: "backend" as const }));
export const fetchRun = (): Promise<RunMeta> => (STATIC_MODE ? staticData.fetchRun() : get<RunMeta>("/api/runs/latest"));
export const fetchRuns = (): Promise<{ runs: RunSummary[] }> => (STATIC_MODE ? staticData.fetchRuns() : get("/api/runs"));
export const fetchMap = (runId: string, step: number, variable: VariableId, kind: Kind, hours = 24, scope: "india" | "world" = "india"): Promise<MapResp> =>
  STATIC_MODE ? staticData.fetchMap(runId, step, variable, kind, hours, scope)
    : get<MapResp>(`/api/runs/${runId}/map?step=${step}&variable=${variable}&kind=${kind}${kind === "window" ? `&hours=${hours}` : ""}${scope === "world" ? "&scope=world" : ""}`);
/** `light` = rain series only. The static engine then skips downloading temperature/cloud/wind files (the run
 *  comparison needs only rain); the network API always returns everything. */
export const fetchPoint = (runId: string, lat: number, lon: number, opts?: { light?: boolean }): Promise<PointResp> =>
  STATIC_MODE ? staticData.fetchPoint(runId, lat, lon, opts) : get<PointResp>(`/api/runs/${runId}/point?lat=${lat}&lon=${lon}`);

export const fetchProbMeta = (): Promise<ProbMeta> => (STATIC_MODE ? staticData.fetchProbMeta() : get<ProbMeta>("/api/probability/latest"));
export const fetchProbMap = (runId: string, windowEnd: number, threshold: number): Promise<ProbMapResp> =>
  STATIC_MODE ? staticData.fetchProbMap(runId, windowEnd, threshold)
    : get<ProbMapResp>(`/api/probability/${runId}/map?window_end=${windowEnd}&threshold=${threshold}`);
export const fetchProbPoint = (runId: string, lat: number, lon: number): Promise<ProbPointResp> =>
  STATIC_MODE ? staticData.fetchProbPoint(runId, lat, lon) : get<ProbPointResp>(`/api/probability/${runId}/point?lat=${lat}&lon=${lon}`);

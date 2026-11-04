import { useEffect, useRef, useState } from "react";
import { CITIES } from "./cities";

export type Place = { name: string; state: string; lat: number; lon: number; pop: number };

let cache: Promise<Place[]> | null = null;
/** Loads the offline gazetteer (GeoNames, towns >= 1000 people) once, on first use. Falls back to the built-in big cities. */
export function loadPlaces(): Promise<Place[]> {
  cache ??= fetch(`${import.meta.env.BASE_URL}places.json`)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<[string, string, number, number, number][]>; })
    .then((rows) => rows.map(([name, state, lat, lon, pop]) => ({ name, state, lat, lon, pop })))
    .catch(() => { cache = null; return CITIES.map((c) => ({ name: c.name, state: "", lat: c.lat, lon: c.lon, pop: 1 })); });
  return cache;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Prefix matches first (biggest place first), then substring matches; places are already sorted by population. "pune, maha" also matches the state. */
export function searchPlaces(places: Place[], query: string, limit = 8): Place[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const [qn, qs] = q.split(",").map((s) => s.trim());
  const starts: Place[] = [], inside: Place[] = [];
  for (const p of places) {
    const n = norm(p.name);
    if (qs && !norm(p.state).startsWith(qs)) continue;
    if (n.startsWith(qn)) starts.push(p);
    else if (!qs && qn.length >= 3 && n.includes(qn)) inside.push(p);
    if (starts.length >= limit && inside.length >= limit) break;
  }
  return [...starts, ...inside].slice(0, limit);
}

export default function PlaceSearch({ onPick }: { onPick: (p: Place) => void }) {
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const typed = q.trim().length >= 2;
  const results = places ? (typed ? searchPlaces(places, q) : places.slice(0, 8)) : [];   // places are sorted by population: the first ones are the biggest cities
  const states = places ? [...new Set(places.map((p) => p.state).filter(Boolean))].sort() : [];
  const [state, setState] = useState("");
  const inState = places && state ? places.filter((p) => p.state === state).slice(0, 60) : [];

  useEffect(() => {   // fetch the place list shortly after the page settles so the state menu is filled when first opened
    const id = window.setTimeout(() => void loadPlaces().then(setPlaces), 2500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const pick = (p: Place) => { setQ(p.state ? `${p.name}, ${p.state}` : p.name); setOpen(false); onPick(p); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && open && results[active]) { e.preventDefault(); pick(results[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="placesearch" ref={box}>
      <label>Search any town or city in India
        <input role="combobox" aria-expanded={open && results.length > 0} aria-controls="place-listbox" aria-autocomplete="list"
          value={q} placeholder="e.g. Pune, or a small town" autoComplete="off"
          onFocus={() => { setOpen(true); void loadPlaces().then(setPlaces); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onKeyDown={onKey} />
      </label>
      {open && (
        <ul id="place-listbox" role="listbox" className="placelist">
          {!places && <li className="muted">Loading places…</li>}
          {places && !typed && <li className="muted hdr">Biggest cities (type to find any of {places.length.toLocaleString()} towns)</li>}
          {places && typed && results.length === 0 && <li className="muted">No match. Try the spelling, or pick on the map.</li>}
          {results.map((p, i) => (
            <li key={`${p.name}-${p.lat}-${p.lon}`} role="option" aria-selected={i === active}
              className={i === active ? "on" : ""} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <strong>{p.name}</strong> <span className="muted">{p.state}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="bystate">
        <label>Or browse by state
          <select value={state} onFocus={() => void loadPlaces().then(setPlaces)} onChange={(e) => setState(e.target.value)}>
            <option value="">Choose a state…</option>
            {states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {state && (
          <label>Town in {state}
            <select value="" onChange={(e) => { const pl = inState[Number(e.target.value)]; if (pl) pick(pl); }}>
              <option value="">Choose a town…</option>
              {inState.map((p, i) => <option key={`${p.name}-${p.lat}`} value={i}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

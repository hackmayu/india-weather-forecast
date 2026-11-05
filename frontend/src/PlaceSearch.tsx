import { useEffect, useRef, useState } from "react";
import { CITIES } from "./cities";

/** `state` holds the Indian state, or the country for world places (`world: true`). */
export type Place = { name: string; state: string; lat: number; lon: number; pop: number; world?: boolean };

let cache: Promise<Place[]> | null = null;
async function loadRows(file: string): Promise<[string, string, number, number, number][]> {
  const r = await fetch(`${import.meta.env.BASE_URL}${file}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
/** Loads the offline gazetteers once: India (GeoNames, towns >= 1000 people) and the 6,000 largest other cities of the world.
 *  Falls back to the built-in big cities if the files cannot be fetched. */
export function loadPlaces(): Promise<Place[]> {
  cache ??= Promise.all([loadRows("places.json"), loadRows("worldplaces.json").catch(() => [])])
    .then(([india, other]) => [
      ...india.map(([name, state, lat, lon, pop]): Place => ({ name, state, lat, lon, pop })),
      ...other.map(([name, state, lat, lon, pop]): Place => ({ name, state, lat, lon, pop, world: true })),
    ].sort((a, b) => b.pop - a.pop))
    .catch(() => { cache = null; return CITIES.map((c) => ({ name: c.name, state: "", lat: c.lat, lon: c.lon, pop: 1 })); });
  return cache;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Old / common spellings people still type. Only the part before a comma is replaced (state filter is kept). */
const ALIASES: Record<string, string> = {
  bangalore: "bengaluru", bombay: "mumbai", calcutta: "kolkata", madras: "chennai", poona: "pune", trivandrum: "thiruvananthapuram", cochin: "kochi",
  benares: "varanasi", banaras: "varanasi", allahabad: "prayagraj", gurgaon: "gurugram", baroda: "vadodara", vizag: "visakhapatnam", panjim: "panaji",
  pondicherry: "puducherry", simla: "shimla", nasik: "nashik", mysore: "mysuru", mangalore: "mangaluru", belgaum: "belagavi", gauhati: "guwahati",
  cawnpore: "kanpur", baranasi: "varanasi", vijaywada: "vijayawada", jullundur: "jalandhar", ooty: "udhagamandalam", orissa: "odisha",
};
const alias = (q: string) => { const [a, ...rest] = q.split(","); const w = a.trim(); const hit = ALIASES[w] ?? (w.length >= 4 ? ALIASES[Object.keys(ALIASES).find((k) => k.startsWith(w)) ?? ""] : undefined);
  return [hit ?? w, ...rest].join(","); };

/** Edit distance, giving up above `max` (typo tolerance without a heavy library). */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * Ranked suggestions as you type: 1) name starts with the text, 2) a word in the name starts with it ("nagar" finds "Ahmednagar"? no, "Sri Nagar" yes),
 * 3) the text appears inside the name, 4) close spellings (one typo, e.g. "bangalor", "mumbay"). Within a tier the bigger place comes first
 * (the list is sorted by population). "pune, maha" also filters by state.
 */
export function searchPlaces(places: Place[], query: string, limit = 8): Place[] {
  const q = alias(norm(query));
  if (q.length < 2) return [];
  const [qn, qs] = q.split(",").map((s) => s.trim());
  const tiers: Place[][] = [[], [], [], []];
  for (const p of places) {
    if (qs && !norm(p.state).startsWith(qs)) continue;
    const n = norm(p.name);
    if (n.startsWith(qn)) tiers[0].push(p);
    else if (n.split(/[\s-]+/).some((w) => w.startsWith(qn))) tiers[1].push(p);
    else if (qn.length >= 3 && n.includes(qn)) tiers[2].push(p);
    else if (qn.length >= 4 && (within(qn, n.slice(0, qn.length), 1) || within(qn, n.slice(0, qn.length + 1), 1))) tiers[3].push(p);
  }
  return tiers.flat().slice(0, limit);
}

/** Splits a name so the part the user typed can be shown in bold. */
export function highlight(name: string, query: string): [string, string, string] {
  const q = norm(query.split(",")[0]);
  if (!q) return ["", "", name];
  const i = norm(name).indexOf(q);           // norm() keeps the length for these scripts (NFD marks are stripped one-for-one)
  return i < 0 || norm(name).length !== name.length ? ["", "", name] : [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
}

const RECENT_KEY = "recentPlaces";
const readRecent = (): Place[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as Place[]; } catch { return []; } };
const saveRecent = (p: Place) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([p, ...readRecent().filter((r) => r.name !== p.name || r.state !== p.state)].slice(0, 5))); } catch { /* storage may be blocked */ }
};

function Name({ name, q }: { name: string; q: string }) {
  const [a, m, z] = highlight(name, q);
  return <strong>{a}<mark>{m}</mark>{z}</strong>;
}

export default function PlaceSearch({ onPick }: { onPick: (p: Place) => void }) {
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const typed = q.trim().length >= 2;
  const [recent, setRecent] = useState<Place[]>(readRecent);
  const list = useRef<HTMLUListElement>(null);
  const results = places ? (typed ? searchPlaces(places, q, 10) : [...recent, ...places.filter((p) => !p.world && !recent.some((r) => r.name === p.name && r.state === p.state)).slice(0, 8 - Math.min(recent.length, 3))].slice(0, 8)) : [];   // places are sorted by population: the first ones are the biggest cities
  const states = places ? [...new Set(places.filter((p) => !p.world).map((p) => p.state).filter(Boolean))].sort() : [];
  const [state, setState] = useState("");
  const inState = places && state ? places.filter((p) => !p.world && p.state === state).slice(0, 60) : [];

  useEffect(() => {   // fetch the place list shortly after the page settles so the state menu is filled when first opened
    const id = window.setTimeout(() => void loadPlaces().then(setPlaces), 2500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, q]);

  const pick = (p: Place) => { saveRecent(p); setRecent(readRecent()); setQ(p.state ? `${p.name}, ${p.state}` : p.name); setOpen(false); onPick(p); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && open && results[active]) { e.preventDefault(); pick(results[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="placesearch" ref={box}>
      <label>Search any place
        <input role="combobox" aria-expanded={open && results.length > 0} aria-controls="place-listbox" aria-autocomplete="list"
          value={q} placeholder="Pune, a small town, or Paris" autoComplete="off"
          onFocus={() => { setOpen(true); void loadPlaces().then(setPlaces); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onKeyDown={onKey} />
      </label>
      {open && (
        <ul id="place-listbox" role="listbox" className="placelist" ref={list}>
          {!places && <li className="muted">Loading places…</li>}
          {places && !typed && <li className="muted hdr">{recent.length ? "Recent and biggest cities" : "Biggest cities"} (type to find any of {places.length.toLocaleString()} places)</li>}
          {places && typed && results.length === 0 && <li className="muted">No match. Try the spelling, or pick on the map.</li>}
          {results.map((p, i) => (
            <li key={`${p.name}-${p.lat}-${p.lon}`} role="option" aria-selected={i === active}
              className={i === active ? "on" : ""} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <Name name={p.name} q={typed ? q : ""} /> <span className="muted">{p.state}</span>
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

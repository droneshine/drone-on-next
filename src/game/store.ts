// Local persistence. Custom drones (with embedded GLB) live in IndexedDB,
// small things in localStorage. Everything degrades to memory when storage is blocked.

import { DroneSpec, validateSpec } from '../sim/spec';

// DRONE ON Next keeps its own saves; the live game (prefix droneon.) is only ever read, as a one time import
export const NS = 'droneon2.';
const LEGACY_NS = 'droneon.';
const DB = 'droneon2', LEGACY_DB = 'droneon', STORE = 'drones';
let dbp: Promise<IDBDatabase | null> | null = null;

function openDb(name: string, create: boolean): Promise<IDBDatabase | null> {
  return new Promise(res => {
    try {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { if (create) r.result.createObjectStore(STORE, { keyPath: 'id' }); else { r.transaction?.abort(); } };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = (async () => {
    const d = await openDb(DB, true);
    if (!d) return null;
    // first start: copy the drones built in the live game, the live game keeps its own copy untouched
    if (!localStorage.getItem(NS + 'importedDrones')) {
      try {
        localStorage.setItem(NS + 'importedDrones', '1');
        const old = await openDb(LEGACY_DB, false);
        if (old && old.objectStoreNames.contains(STORE)) {
          const list = await new Promise<unknown[]>(r => { const q = old.transaction(STORE, 'readonly').objectStore(STORE).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); });
          await new Promise<void>(r => { const tx = d.transaction(STORE, 'readwrite'); for (const x of list) tx.objectStore(STORE).put(x); tx.oncomplete = () => r(); tx.onerror = () => r(); });
        }
        old?.close();
      } catch { /* nothing to import */ }
    }
    return d;
  })();
  return dbp;
}

const memDrones = new Map<string, DroneSpec>();

export async function listCustomDrones(): Promise<DroneSpec[]> {
  const d = await db();
  if (!d) return [...memDrones.values()];
  return new Promise(res => {
    const tx = d.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).getAll();
    q.onsuccess = () => {
      const raw = q.result as { id?: unknown }[];
      const out = raw.map(r => {
        const v = validateSpec(r);
        // drones saved before ids were checked (a featured id, odd characters): move them to their clean id once,
        // so Delete and Save always find the same record
        if (typeof r?.id === 'string' && r.id !== v.id) { void saveCustomDrone(v).then(() => deleteCustomDrone(r.id as string)); }
        return v;
      });
      res(out);
    };
    q.onerror = () => res([]);
  });
}

export async function saveCustomDrone(s: DroneSpec) {
  memDrones.set(s.id, s);
  const d = await db();
  if (!d) return;
  await new Promise<void>(res => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(s);
    tx.oncomplete = () => res(); tx.onerror = () => res();
  });
}

export async function deleteCustomDrone(id: string) {
  memDrones.delete(id);
  const d = await db();
  if (!d) return;
  await new Promise<void>(res => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res(); tx.onerror = () => res();
  });
}

const mem = new Map<string, string>();
/** Read a stored value. Anything of the wrong shape falls back, so a stale or corrupt entry can never lock a player out. */
export function getLS<T>(key: string, fallback: T): T {
  let v: unknown = undefined;
  try {
    // own save first, the live game's save as a read only starting point
    const s = localStorage.getItem(NS + key) ?? localStorage.getItem(LEGACY_NS + key);
    if (s != null) v = JSON.parse(s);
  } catch { v = undefined; }
  if (v === undefined) { const m = mem.get(key); if (m) { try { v = JSON.parse(m); } catch { v = undefined; } } }
  if (v === undefined || v === null) return fallback;
  const shape = (x: unknown) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);
  if (fallback !== null && fallback !== undefined && shape(v) !== shape(fallback)) return fallback;
  return v as T;
}
export function setLS(key: string, v: unknown) {
  const s = JSON.stringify(v);
  mem.set(key, s);
  try { localStorage.setItem(NS + key, s); } catch { /* blocked */ }
}

export interface Progress { stars: Record<string, number>; best: Record<string, number>; flights: number; airtime: number; distance: number; }
export function progress(): Progress {
  const p = getLS<Partial<Progress>>('progress', {});
  const rec = (o: unknown) => {
    const out: Record<string, number> = {};
    if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && isFinite(v)) out[k] = v;
    return out;
  };
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return { stars: rec(p.stars), best: rec(p.best), flights: n(p.flights), airtime: n(p.airtime), distance: n(p.distance) };
}
export function saveProgress(p: Progress) { setLS('progress', p); }

// ------------------------------------------------------------- share codes
export async function encodeShare(obj: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  let bytes = json;
  if ('CompressionStream' in window) {
    const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(cs).arrayBuffer());
  }
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodeShare<T>(code: string): Promise<T | null> {
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    let out = bytes;
    try {
      if ('DecompressionStream' in window) {
        const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        out = new Uint8Array(await new Response(ds).arrayBuffer());
      }
    } catch { out = bytes; }
    return JSON.parse(new TextDecoder().decode(out));
  } catch { return null; }
}

export function downloadFile(name: string, data: string | Blob, type = 'application/json') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function readFileAs(file: File, as: 'text' | 'dataURL'): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result)); r.onerror = rej;
    if (as === 'text') r.readAsText(file); else r.readAsDataURL(file);
  });
}

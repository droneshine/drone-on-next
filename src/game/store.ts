// Local persistence. Custom drones (with embedded GLB) live in IndexedDB,
// small things in localStorage. Everything degrades to memory when storage is blocked.

import { DroneSpec, validateSpec } from '../sim/spec';

const DB = 'droneon', STORE = 'drones';
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise(res => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}

const memDrones = new Map<string, DroneSpec>();

export async function listCustomDrones(): Promise<DroneSpec[]> {
  const d = await db();
  if (!d) return [...memDrones.values()];
  return new Promise(res => {
    const tx = d.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).getAll();
    q.onsuccess = () => res((q.result as unknown[]).map(validateSpec));
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
export function getLS<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem('droneon.' + key); if (v != null) return JSON.parse(v); } catch { /* blocked */ }
  const m = mem.get(key); return m ? JSON.parse(m) : fallback;
}
export function setLS(key: string, v: unknown) {
  const s = JSON.stringify(v);
  mem.set(key, s);
  try { localStorage.setItem('droneon.' + key, s); } catch { /* blocked */ }
}

export interface Progress { stars: Record<string, number>; best: Record<string, number>; flights: number; airtime: number; distance: number; }
export function progress(): Progress { return getLS<Progress>('progress', { stars: {}, best: {}, flights: 0, airtime: 0, distance: 0 }); }
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

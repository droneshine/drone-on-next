// A DroneSpec fully describes a flyable aircraft. Featured drones and community
// uploads use the same format, so anything the hangar can save, the sim can fly.

export type FlightMode = 'acro' | 'angle' | 'gps';
export type Tool = 'none' | 'sprayDown' | 'lance' | 'thermal' | 'camera';
export type Layout = 'quadX' | 'hexX' | 'octoX' | 'coaxX8';
export type ModelKind = 'dsolar' | 'dsolarmax' | 'dshine' | 'dscan' | 'racer' | 'cine' | 'generic' | 'spark' | 'bolt' | 'storm' | 'nova';

export interface Rates {
  rcRate: number;    // Betaflight style
  superRate: number;
  expo: number;
}

export interface DroneSpec {
  id: string;
  name: string;
  author: string;
  tagline: string;
  featured?: boolean;
  model: ModelKind;
  color: string;          // primary body colour
  accent: string;
  layout: Layout;
  armLength: number;      // m, centre to motor
  propDiameter: number;   // m
  mass: number;           // kg, take off mass without payload
  maxThrust: number;      // N per motor at full battery
  motorTau: number;       // s, spool time constant
  dragArea: number;       // m^2 equivalent flat plate, horizontal
  battery: { cells: number; capacityAh: number; };
  hoverPowerW?: number;   // optional override, else derived
  defaultMode: FlightMode;
  maxTilt: number;        // deg, angle and gps modes
  maxSpeed: number;       // m/s, gps mode horizontal
  maxClimb: number;       // m/s, gps mode
  maxYawRate: number;     // deg/s
  rates: Rates;
  camUptilt: number;      // deg, FPV camera
  tool: Tool;
  tank?: number;          // litres for sprayDown
  flow?: number;          // litres per minute
  hose?: boolean;         // ground fed tether
  glb?: string;           // data URL or http URL of a custom model
  glbScale?: number;
  glbYaw?: number;        // deg
  glbOffsetY?: number;
}

export const FEATURED: DroneSpec[] = [
  {
    id: 'dsolar', name: 'DSolar', author: 'DroneShine', featured: true,
    // MT50 platform: 2330 mm wheelbase, X13 drives, 30 kg frame + 2 x 18S 46 Ah, 30 kg payload, 90 kg MTOW
    tagline: 'Solar park cleaning platform. 30 L tank, four X13 drives, 55 minutes empty, 30 full.',
    model: 'dsolar', color: '#1f5e2c', accent: '#f2f2ee', layout: 'quadX',
    armLength: 1.165, propDiameter: 1.32, mass: 60, maxThrust: 360, motorTau: 0.11,
    dragArea: 0.5, battery: { cells: 18, capacityAh: 92 },
    defaultMode: 'gps', maxTilt: 20, maxSpeed: 5, maxClimb: 5, maxYawRate: 80,
    rates: { rcRate: 0.7, superRate: 0.4, expo: 0.2 }, camUptilt: -20,
    tool: 'sprayDown', tank: 30, flow: 5,
  },
  {
    // MT100 platform: 2300 mm wheelbase, 1420 mm props, T14 drives, 50 kg frame + 2 x 18S 35 Ah, 100 kg payload, 200 kg MTOW
    id: 'dsolarmax', name: 'DSolar Max', author: 'DroneShine', featured: true,
    tagline: 'The heavy one. 100 L tank, four T14 drives, 200 kg take off, 25 minutes empty, 9 full.',
    model: 'dsolarmax', color: '#1f5e2c', accent: '#f2f2ee', layout: 'quadX',
    armLength: 1.15, propDiameter: 1.42, mass: 100, maxThrust: 680, motorTau: 0.14,
    dragArea: 0.85, battery: { cells: 18, capacityAh: 70 },
    defaultMode: 'gps', maxTilt: 20, maxSpeed: 15, maxClimb: 5, maxYawRate: 70,
    rates: { rcRate: 0.6, superRate: 0.35, expo: 0.2 }, camUptilt: -20,
    tool: 'sprayDown', tank: 100, flow: 12,
  },
  {
    id: 'dshine', name: 'DShine', author: 'DroneShine', featured: true,
    tagline: 'High pressure facade and glass cleaner. Ground fed hose, 283 bar lance.',
    model: 'dshine', color: '#0f4a2b', accent: '#1c1c1c', layout: 'quadX',
    armLength: 0.55, propDiameter: 0.76, mass: 19.8, maxThrust: 105, motorTau: 0.07,
    dragArea: 0.28, battery: { cells: 14, capacityAh: 20 },
    defaultMode: 'gps', maxTilt: 20, maxSpeed: 10, maxClimb: 2.5, maxYawRate: 80,
    rates: { rcRate: 0.8, superRate: 0.4, expo: 0.2 }, camUptilt: -5,
    tool: 'lance', hose: true, flow: 10,
  },
  {
    id: 'dscan', name: 'DScan', author: 'DroneShine', featured: true,
    tagline: 'Thermal inspection prototype. Built in house, finds hotspots before they cost yield.',
    model: 'dscan', color: '#1f7a45', accent: '#161616', layout: 'quadX',
    armLength: 0.33, propDiameter: 0.254, mass: 2.9, maxThrust: 21, motorTau: 0.04,
    dragArea: 0.06, battery: { cells: 6, capacityAh: 8 },
    defaultMode: 'gps', maxTilt: 30, maxSpeed: 16, maxClimb: 5, maxYawRate: 120,
    rates: { rcRate: 1.0, superRate: 0.5, expo: 0.2 }, camUptilt: -15,
    tool: 'thermal',
  },
  {
    id: 'shine5', name: 'Shine 5', author: 'DroneShine', featured: true,
    tagline: 'Five inch freestyle quad. Acro mode, raw and fast. Where pilots are made.',
    model: 'racer', color: '#26c257', accent: '#111', layout: 'quadX',
    armLength: 0.115, propDiameter: 0.127, mass: 0.68, maxThrust: 14.5, motorTau: 0.025,
    dragArea: 0.012, battery: { cells: 6, capacityAh: 1.3 },
    defaultMode: 'acro', maxTilt: 55, maxSpeed: 30, maxClimb: 15, maxYawRate: 400,
    rates: { rcRate: 1.0, superRate: 0.7, expo: 0.3 }, camUptilt: 30,
    tool: 'camera',
  },
  {
    id: 'cine8', name: 'Cine 8', author: 'DroneShine', featured: true,
    tagline: 'Coaxial X8 cinema lifter. Smooth, heavy, unstoppable in wind.',
    model: 'cine', color: '#2a2f2c', accent: '#b5f78a', layout: 'coaxX8',
    armLength: 0.5, propDiameter: 0.46, mass: 14, maxThrust: 52, motorTau: 0.06,
    dragArea: 0.2, battery: { cells: 12, capacityAh: 22 },
    defaultMode: 'angle', maxTilt: 28, maxSpeed: 18, maxClimb: 5, maxYawRate: 100,
    rates: { rcRate: 0.9, superRate: 0.5, expo: 0.3 }, camUptilt: 0,
    tool: 'camera',
  },
];

export function motorCount(l: Layout) { return l === 'quadX' ? 4 : l === 'hexX' ? 6 : 8; }

/** Motor positions in body frame (x right, z back, y up) and spin direction. */
export function motorLayout(spec: DroneSpec): { x: number; z: number; y: number; dir: number }[] {
  const L = spec.armLength;
  const out: { x: number; z: number; y: number; dir: number }[] = [];
  if (spec.layout === 'coaxX8') {
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      const d = i % 2 === 0 ? 1 : -1;
      out.push({ x: Math.cos(a) * L, z: Math.sin(a) * L, y: 0.06, dir: d });
      out.push({ x: Math.cos(a) * L, z: Math.sin(a) * L, y: -0.06, dir: -d });
    }
    return out;
  }
  const n = motorCount(spec.layout);
  const off = spec.layout === 'quadX' ? Math.PI / 4 : spec.layout === 'hexX' ? Math.PI / 6 : Math.PI / 8;
  for (let i = 0; i < n; i++) {
    const a = off + i * (2 * Math.PI / n);
    out.push({ x: Math.cos(a) * L, z: Math.sin(a) * L, y: 0, dir: i % 2 === 0 ? 1 : -1 });
  }
  return out;
}

/** True when untrusted JSON looks like a DRONE ON drone file at all. */
export function looksLikeDrone(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return typeof r.name === 'string' && typeof r.mass === 'number' && isFinite(r.mass) && typeof r.maxThrust === 'number' && isFinite(r.maxThrust);
}

const RESERVED_IDS = () => new Set(FEATURED.map(f => f.id));

export function validateSpec(raw: unknown): DroneSpec {
  const base = featured('shine5');
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DroneSpec>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const str = (v: unknown, d: string, max = 80) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d;
  const layout: Layout = (['quadX', 'hexX', 'octoX', 'coaxX8'] as const).includes(r.layout as Layout) ? r.layout as Layout : 'quadX';
  const mode: FlightMode = (['acro', 'angle', 'gps'] as const).includes(r.defaultMode as FlightMode) ? r.defaultMode as FlightMode : 'angle';
  const tool: Tool = (['none', 'sprayDown', 'lance', 'thermal', 'camera'] as const).includes(r.tool as Tool) ? r.tool as Tool : 'camera';
  // tiny whoops are real drones too: 15 g and 2 cm arms are allowed
  const mass = num(r.mass, 2, 0.015, 200);
  const n = motorCount(layout);
  const tank = tool === 'sprayDown' ? num(r.tank, 10, 0.5, 100) : undefined;
  const flow = tool === 'sprayDown' || tool === 'lance' ? num(r.flow, 4, 0.1, 30) : undefined;
  // never allow a drone that cannot hover with a full tank and a sagging pack
  const minThrust = (mass + (tank ?? 0)) * 9.81 * 1.45 / n;
  let id = str(r.id, 'custom-' + Math.random().toString(36).slice(2, 8), 40).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  if (RESERVED_IDS().has(id)) id = id + '-custom';
  return {
    id,
    name: str(r.name, 'Custom drone', 32),
    author: str(r.author, 'Community', 40),
    tagline: str(r.tagline, 'A community drone.', 140),
    model: 'generic',
    color: /^#[0-9a-f]{6}$/i.test(String(r.color)) ? String(r.color) : '#26c257',
    accent: /^#[0-9a-f]{6}$/i.test(String(r.accent)) ? String(r.accent) : '#111111',
    layout,
    armLength: num(r.armLength, 0.3, 0.02, 2),
    propDiameter: num(r.propDiameter, 0.25, 0.02, 2),
    mass,
    maxThrust: Math.max(num(r.maxThrust, mass * 9.81 * 2.2 / n, 0.05, 2000), minThrust),
    motorTau: num(r.motorTau, 0.05, 0.01, 0.4),
    dragArea: num(r.dragArea, 0.05, 0.001, 2),
    battery: { cells: Math.round(num(r.battery?.cells, 6, 1, 24)), capacityAh: num(r.battery?.capacityAh, 1.5, 0.1, 100) },
    defaultMode: mode,
    maxTilt: num(r.maxTilt, 35, 10, 80),
    maxSpeed: num(r.maxSpeed, 15, 2, 60),
    maxClimb: num(r.maxClimb, 4, 0.5, 20),
    maxYawRate: num(r.maxYawRate, 150, 20, 900),
    rates: {
      rcRate: num(r.rates?.rcRate, base.rates.rcRate, 0.1, 2.5),
      superRate: num(r.rates?.superRate, base.rates.superRate, 0, 0.95),
      expo: num(r.rates?.expo, base.rates.expo, 0, 1),
    },
    camUptilt: num(r.camUptilt, 10, -60, 60),
    tool,
    tank,
    flow,
    // a ground hose only makes sense for a lance drone
    hose: tool === 'lance' && !!r.hose,
    // only embedded models: a remote URL would make every player fetch a stranger's file
    glb: typeof r.glb === 'string' && r.glb.startsWith('data:') ? r.glb : undefined,
    glbScale: num(r.glbScale, 1, 0.05, 20),
    glbYaw: num(r.glbYaw, 0, -360, 360),
    glbOffsetY: num(r.glbOffsetY, 0, -5, 5),
  };
}

export function featured(id: string): DroneSpec { return FEATURED.find(f => f.id === id) ?? FEATURED[0]; }

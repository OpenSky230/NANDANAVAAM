import { 
  Engine, Scene, FreeCamera, WebXRState, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode
} from "@babylonjs/core";
import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";
// Register glTF/GLB loader (prevents controller/hand model warnings)
import "@babylonjs/loaders";
import { PhotoDome } from "@babylonjs/core/Helpers/photoDome";
import { loadWalkthrough } from "./walkthrough-data.js";
import { 
  getAnalytics, trackNodeVisit, trackExperience, trackXRMode 
} from "./analytics.js";

/* Config */
// Mirror U to correct L/R orientation and rotate dome 180deg on X to keep upright.
const DEFAULT_FLIP_U = true, DEFAULT_FLIP_X = true, DOME_DIAMETER = 2000, FLOOR_HEIGHT_M = 3.0;
const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
const EXPERIENCE_PREFIX = "experiences/";
const ensureExpPath = (value = "") => {
  const input = String(value || "").trim().replace(/^\/+/, "");
  const slug = input.length ? input : "clubhouse";
  return slug.startsWith(EXPERIENCE_PREFIX) ? slug : `${EXPERIENCE_PREFIX}${slug}`.replace(/\/{2,}/g, "/");
};

const createMetaLookup = (list = []) => {
  const map = new Map();
  for (const entry of list) {
    const slug = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (slug) map.set(slug, entry);
  }
  return map;
};

// KTX2 decoder assets (self-hosted in `public/ktx2/*` to avoid runtime CDN fetches)
try{
  const KTX2_BASE = (BASE_URL + "ktx2/").replace(/\/{2,}/g, "/");
  KhronosTextureContainer2.URLConfig.jsDecoderModule = `${KTX2_BASE}babylon.ktx2Decoder.js`;
  KhronosTextureContainer2.URLConfig.jsMSCTranscoder = `${KTX2_BASE}msc_basis_transcoder.js`;
  KhronosTextureContainer2.URLConfig.wasmMSCTranscoder = `${KTX2_BASE}msc_basis_transcoder.wasm`;
  KhronosTextureContainer2.URLConfig.wasmZSTDDecoder = `${KTX2_BASE}zstddec.wasm`;
  KhronosTextureContainer2.URLConfig.wasmUASTCToASTC = `${KTX2_BASE}uastc_astc.wasm`;
  KhronosTextureContainer2.URLConfig.wasmUASTCToBC7 = `${KTX2_BASE}uastc_bc7.wasm`;
  KhronosTextureContainer2.URLConfig.wasmUASTCToRGBA_UNORM = `${KTX2_BASE}uastc_rgba8_unorm_v2.wasm`;
  KhronosTextureContainer2.URLConfig.wasmUASTCToRGBA_SRGB = `${KTX2_BASE}uastc_rgba8_srgb_v2.wasm`;
  KhronosTextureContainer2.URLConfig.wasmUASTCToR8_UNORM = `${KTX2_BASE}uastc_r8_unorm.wasm`;
  KhronosTextureContainer2.URLConfig.wasmUASTCToRG8_UNORM = `${KTX2_BASE}uastc_rg8_unorm.wasm`;
}catch{}

// Detect WebP support (sync)
const SUPPORTS_WEBP = (() => {
  try {
    const c = document.createElement('canvas');
    return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1;
  } catch { return false; }
})();
const PREFER_KTX2 = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    const v = String(qs.get("ktx2") ?? qs.get("ktx") ?? "").trim().toLowerCase();
    if (v === "1" || v === "true" || v === "on") return true;
    if (v === "0" || v === "false" || v === "off") return false;
  } catch {}
  try {
    const env = String(import.meta?.env?.VITE_PANO_KTX2 ?? "").trim();
    if (env === "1") return true;
    if (env === "0") return false;
  } catch {}
  return true;
})();
const LOAD_DEBUG = (()=>{ try{ return new URLSearchParams(location.search).has('loaddbg'); }catch{ return false; } })();
const VR_PANO_LOAD_TIMEOUT_MS = Math.max(6000, Number(import.meta?.env?.VITE_VR_PANO_TIMEOUT_MS) || 45000);
const VR_PANO_PROBE_TIMEOUT_MS = Math.max(400, Number(import.meta?.env?.VITE_VR_PANO_PROBE_TIMEOUT_MS) || 1200);

async function urlExistsFast(url, { timeoutMs = 1500 } = {}){
  let u = String(url || "").trim();
  if (!u) return false;
  try{ u = encodeURI(u); }catch{}
  let to = null;
  const controller = (()=>{ try { return new AbortController(); } catch { return null; } })();
  try{
    if (controller) to = setTimeout(()=>{ try{ controller.abort(); }catch{} }, Math.max(200, Number(timeoutMs) || 1500));
    let res = await fetch(u, { method: "HEAD", cache: "no-store", signal: controller?.signal });
    if (res?.ok) return true;
    if (res?.status === 405) {
      res = await fetch(u, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store", signal: controller?.signal });
      return !!res?.ok;
    }
    return false;
  }catch{
    return false;
  }finally{
    try{ if (to) clearTimeout(to); }catch{}
  }
}

const chooseFile = (f, preferOriginal = false, preferKtx2 = PREFER_KTX2) => {
  if (!f) return f;
  if (!preferOriginal && preferKtx2) {
    if (/\.ktx2$/i.test(f)) return f;
    if (/\.(?:png|jpe?g|webp)$/i.test(f)) return f.replace(/\.(?:png|jpe?g|webp)$/i, ".ktx2");
  }
  // We prune pano PNGs and keep `.jpg` fallbacks, so never request `.png`.
  if (/\.png$/i.test(f)) return f.replace(/\.png$/i, ".jpg");
  if (!SUPPORTS_WEBP || preferOriginal) {
    // Prefer JPEG for all non-KTX2 fallbacks (we prune pano PNGs and keep .jpg fallbacks).
    return f.replace(/\.(?:webp|png)$/i, '.jpg');
  }
  return f;
};

export async function initViewer({ roomId = "demo", exp, experienceId, experiencesMeta = [] } = {}) {
  const metaById = createMetaLookup(experiencesMeta);
  const initialTarget = exp ?? experienceId ?? "clubhouse";
  let expPath = ensureExpPath(initialTarget);
  let BASE = `${BASE_URL}${expPath}`.replace(/\/{2,}/g, "/");
  const uid = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const expSlug = () => expPath.split("/").filter(Boolean).pop();
  const currentMeta = () => metaById.get(expSlug()) || {};

  let data, nodesById, startNodeId;
  let currentNodeId = null;
  const currentNode = () => (nodesById && currentNodeId ? nodesById.get(currentNodeId) : null);

  const fileStem = (value = "") => {
    const name = String(value || "").trim().split("/").pop() || "";
    return name.replace(/\.[^/.]+$/, "").toLowerCase();
  };
  const matchesStereoPanos = (node, list) => {
    if (!node || !Array.isArray(list) || !list.length) return false;
    const nodeId = String(node?.id || "").trim().toLowerCase();
    const nodeFile = String(node?.file || "").trim().toLowerCase();
    const nodeStem = fileStem(nodeFile);
    const m = nodeStem.match(/(\d+)$/);
    const nodeTrailingNum = m ? Number.parseInt(m[1], 10) : null;

    for (const entry of list) {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        if (nodeTrailingNum !== null && nodeTrailingNum === Math.trunc(entry)) return true;
        continue;
      }
      const raw = String(entry ?? "").trim();
      if (!raw) continue;
      if (/^\d+$/.test(raw)) {
        const n = Number.parseInt(raw, 10);
        if (nodeTrailingNum !== null && nodeTrailingNum === n) return true;
        continue;
      }
      const token = raw.toLowerCase();
      if (token === nodeId || token === nodeFile || fileStem(token) === nodeStem) return true;
    }
    return false;
  };
  // Debug override: ?forceMono=1 forces all panos to mono, ?forceStereo=1 forces all to stereo
  const FORCE_MONO = (() => { try { return new URLSearchParams(location.search).get('forceMono') === '1'; } catch { return false; } })();
  const FORCE_STEREO = (() => { try { return new URLSearchParams(location.search).get('forceStereo') === '1'; } catch { return false; } })();
  const isStereo = () => {
    if (FORCE_MONO) return false;
    if (FORCE_STEREO) return true;
    const meta = currentMeta() || {};
    const node = currentNode();
    if (typeof node?.stereo === "boolean") return node.stereo;
    if (node && matchesStereoPanos(node, meta?.stereoPanos)) return true;
    return Boolean(meta?.stereo);
  };
  const flipU = () => (typeof currentMeta().flipU === "boolean" ? currentMeta().flipU : DEFAULT_FLIP_U);
  const flipX = () => (typeof currentMeta().flipX === "boolean" ? currentMeta().flipX : DEFAULT_FLIP_X);
  try {
    window.__nandanavanamDebug = window.__nandanavanamDebug || {};
    window.__nandanavanamDebug.getViewerMeta = () => {
      const meta = currentMeta() || {};
      return { exp: expSlug(), flipU: flipU(), flipX: flipX(), stereo: isStereo(), meta };
    };
    window.__nandanavanamDebug.getViewerTex = () => {
      const node = currentNode();
      const tex = domeMat?.emissiveTexture || null;
      const sz = tex ? (tex.getBaseSize?.() || tex.getSize?.() || null) : null;
      const w = tex ? (Number(sz?.width) || Number(tex?._texture?.baseWidth) || Number(tex?._texture?.width) || 0) : 0;
      const h = tex ? (Number(sz?.height) || Number(tex?._texture?.baseHeight) || Number(tex?._texture?.height) || 0) : 0;
      return {
        exp: expSlug(),
        file: node?.file,
        stereo: isStereo(),
        stereoHalf: STEREO_2D_HALF,
        w, h,
        uScale: tex?.uScale, uOffset: tex?.uOffset,
        vScale: tex?.vScale, vOffset: tex?.vOffset,
      };
    };
  } catch {}
  // Always use WebP panos (JPG files removed, WebP optimized for all experiences)
  // Allow adaptive pano folders (e.g., panos-mobile) for low-network devices.
  let PANOS_DIR = 'panos';
  const preferKtx2ByExp = new Map(); // expSlug -> boolean
  let preferKtx2Effective = PREFER_KTX2;
  async function refreshPreferKtx2Effective(sampleFile){
    const id = String(expSlug() || "").trim();
    if (!id) return;
    // Avoid slow/fragile HEAD probes on low-quality networks/servers.
    // Default to KTX2-first when enabled; if a KTX2 load later fails but the fallback succeeds,
    // we flip this flag for the experience to avoid repeated 404/timeouts.
    if (!PREFER_KTX2) { preferKtx2Effective = false; preferKtx2ByExp.set(id, false); return; }
    if (preferKtx2ByExp.has(id)) { preferKtx2Effective = preferKtx2ByExp.get(id); return; }
    preferKtx2Effective = true;
    preferKtx2ByExp.set(id, true);
  }
  const panoUrl = (f) => {
    const out = `${BASE}/${PANOS_DIR}/${chooseFile(f, false, preferKtx2Effective)}`.replace(/\/{2,}/g, "/");
    try{ return encodeURI(out); }catch{ return out; }
  };
  const panoUrlKtx2 = (f) => {
    const out = `${BASE}/${PANOS_DIR}/${chooseFile(f, false, /*preferKtx2*/ true)}`.replace(/\/{2,}/g, "/");
    try{ return encodeURI(out); }catch{ return out; }
  };
  const panoUrlOriginal = (f) => {
    const out = `${BASE}/${PANOS_DIR}/${chooseFile(f, true, preferKtx2Effective)}`.replace(/\/{2,}/g, "/");
    try{ return encodeURI(out); }catch{ return out; }
  };

  function isSlowNetwork(){
    try{
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType || '').toLowerCase();
      const save = Boolean(conn?.saveData);
      if (save) return true;
      return /^(slow-)?2g|3g$/.test(eff);
    }catch{ return false; }
  }

  async function maybeSelectMobilePanoDir(){
    try{
      const qs = new URLSearchParams(location.search);
      const mobileParam = qs.get('mobile');
      const forcedOn = mobileParam === '1';
      const forcedOff = mobileParam === '0';
      const needsMobile = forcedOn || (!forcedOff && isSlowNetwork());
      if (!needsMobile) return;

      const node = nodesById.get(startNodeId) || (nodesById.size ? nodesById.values().next().value : null);
      const file = node?.file;
      if (!file) return;

      const candidates = ["panos-mobile-6k", "panos-mobile"];
      for (const dir of candidates){
        const url = `${BASE}/${dir}/${chooseFile(file, false, preferKtx2Effective)}`.replace(/\/{2,}/g, "/");
        try{
          let res = await fetch(url, { method: "HEAD", cache: "no-store" });
          if (!res?.ok && res?.status === 405){
            res = await fetch(url, { method: "GET", cache: "no-store" });
          }
          if (res?.ok){
            PANOS_DIR = dir;
            console.info("[VIEWER] Using mobile panorama folder:", dir);
            return;
          }
        }catch{}
      }
    }catch{}
  }
  // UA flags (used for iOS memory-safe behavior)
  const UA = (navigator.userAgent || "").toLowerCase();
  const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
  /* Engine / Scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true, {
    disableWebGL2Support: IS_IOS,
    powerPreference: IS_IOS ? 'low-power' : 'high-performance',
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    stencil: false
  });
  // Warm-start KTX2 decoder/transcoders early so the first pano doesn't pay the full WASM/worker init cost.
  try{
    if (PREFER_KTX2) {
      const workers = (typeof KhronosTextureContainer2?.GetDefaultNumWorkers === "function")
        ? KhronosTextureContainer2.GetDefaultNumWorkers()
        : (KhronosTextureContainer2?.DefaultNumWorkers ?? 2);
      KhronosTextureContainer2._Initialize(workers);
      if (LOAD_DEBUG) console.log("[VIEWER] KTX2 init kicked", { workers });
    }
  }catch(e){
    if (LOAD_DEBUG) console.warn("[VIEWER] KTX2 init failed", e);
  }
  try {
    // Help Babylon recover cleanly from GPU context loss
    canvas?.addEventListener?.('webglcontextlost', (e)=>{ try{ e.preventDefault(); }catch{} }, false);
    canvas?.addEventListener?.('webglcontextrestored', ()=>{ try{ engine.resize(); refreshDomeForCurrentNode(); }catch{} }, false);
  } catch { }
  try {
    // Force HQ on request; otherwise cap to 2x for perf
    function determineDpr(){
      const qs = new URLSearchParams(location.search);
      const qOverride = (qs.get('q')||'').toLowerCase();
      const forceHQ = (qs.get('hq') === '1') || (String(import.meta?.env?.VITE_FORCE_HQ||'')==='1') || (qOverride==='high');
      const forceLow = (qOverride==='low');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let cap = forceHQ ? 3 : 2;
      if (forceLow) cap = 1; // favor speed on low quality
      const target = Math.min(cap, dpr);
      return IS_IOS ? Math.min(1.2, target) : target;
    }
    engine.setHardwareScalingLevel(1 / determineDpr());
  } catch {}

  function getQuality() {
    try {
      const qs = new URLSearchParams(location.search);
      const override = (qs.get('q') || import.meta?.env?.VITE_QUALITY || 'auto').toLowerCase();
      // Force low quality on iOS to prevent memory crashes
      if (IS_IOS && override !== 'high') return { mips: false, sampling: Texture.BILINEAR_SAMPLINGMODE, aniso: 1 };
      if (override === 'high' || override === 'auto') return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: (IS_IOS ? 4 : 8) };
      if (override === 'low')  return { mips: false, sampling: Texture.BILINEAR_SAMPLINGMODE, aniso: 1 };
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType || '').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      const mem = Number(navigator.deviceMemory || 4);
      if (slow || mem <= 2) return { mips: false, sampling: Texture.BILINEAR_SAMPLINGMODE, aniso: 1 };
      return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: (IS_IOS ? 4 : 8) };
    } catch { return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: (IS_IOS ? 4 : 8) }; }
  }
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);

  const cam = new FreeCamera("cam", new Vector3(0, 0, 0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  cam.fov = 1.1;
  cam.minZ = 0.1;
  cam.maxZ = 50000;

  /* Data */
  try{ window.dispatchEvent(new CustomEvent('loading:show', { detail:{ label: 'Loading tour…' } })); }catch{}
  ({ data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`));
  try{ window.dispatchEvent(new CustomEvent('loading:hide')); }catch{}
  currentNodeId = startNodeId;

  /* ===== Cinematic Zone Name Overlay ===== */
  let lastDisplayedZoneId = null;
  let zoneOverlayTimeout = null;
  const zoneOverlay = (() => {
    // Create overlay element if it doesn't exist
    let el = document.getElementById('zoneNameOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zoneNameOverlay';
      el.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: white;
        font-size: clamp(28px, 6vw, 56px);
        font-weight: 700;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        text-align: center;
        text-shadow: 0 4px 30px rgba(0,0,0,0.9), 0 0 60px rgba(0,0,0,0.6);
        letter-spacing: 0.2em;
        text-transform: uppercase;
        pointer-events: none;
        z-index: 999999;
        opacity: 0;
        transition: opacity 0.8s ease-out;
        max-width: 80vw;
        padding: 20px 40px;
        background: rgba(0,0,0,0.3);
        border-radius: 8px;
      `;
      document.body.appendChild(el);
      console.log('[VIEWER] Zone overlay element created');
    }
    return el;
  })();
  // Ensure it's appended (in case body wasn't ready)
  if (zoneOverlay && !zoneOverlay.parentNode) {
    document.body.appendChild(zoneOverlay);
  }

  function showZoneOverlay(zoneName) {
    if (!zoneName || !zoneOverlay) return;
    console.log('[VIEWER] Showing zone overlay:', zoneName);
    // Clear any pending hide
    if (zoneOverlayTimeout) {
      clearTimeout(zoneOverlayTimeout);
      zoneOverlayTimeout = null;
    }
    // Set text and fade in
    zoneOverlay.textContent = zoneName;
    zoneOverlay.style.opacity = '0';
    // Force reflow for transition
    void zoneOverlay.offsetWidth;
    zoneOverlay.style.opacity = '1';
    // Fade out after 3 seconds total (visible for ~2.2s, fade out ~0.8s)
    zoneOverlayTimeout = setTimeout(() => {
      zoneOverlay.style.opacity = '0';
    }, 2200);
  }

  function checkAndShowZone(node) {
    console.log('[VIEWER] checkAndShowZone called:', { nodeId: node?.id, zoneId: node?.zoneId, lastDisplayedZoneId });
    if (!node?.zoneId) {
      console.log('[VIEWER] Node has no zoneId');
      return;
    }
    // Only show if zone changed
    if (node.zoneId === lastDisplayedZoneId) {
      console.log('[VIEWER] Same zone, skipping');
      return;
    }
    lastDisplayedZoneId = node.zoneId;
    // Find zone name from data
    console.log('[VIEWER] Looking for zone in data.zones:', data?.zones?.length, 'zones');
    const zone = data?.zones?.find(z => z.id === node.zoneId);
    console.log('[VIEWER] Found zone:', zone);
    const zoneName = zone?.name || zone?.label || node.zoneId;
    if (zoneName) {
      showZoneOverlay(zoneName);
    }
  }

  // XR travel helpers - optimized for seamless transitions
  const NAV_DUR_MS = 600; // Reduced from 1000ms for snappier transitions
  const NAV_PUSH_M = 3.0;
  let worldYaw = 0;
  let navAnimating = false;
  function easeInOutSine(t){ return -(Math.cos(Math.PI*t)-1)/2; }
  function lerp(a,b,t){ return a + (b - a) * Math.max(0, Math.min(1, t)); }
  function lerpAngle(prev, next, alpha){ const TAU=Math.PI*2; let d=(next - prev)%TAU; if(d>Math.PI) d-=TAU; if(d<-Math.PI) d+=TAU; return prev + d * Math.max(0, Math.min(1, alpha)); }
  function cubicBezier(p0,p1,p2,p3,t){ const u=1-t, uu=u*u, tt=t*t; const uuu=uu*u, ttt=tt*t; const out=p0.scale(uuu); out.addInPlace(p1.scale(3*uu*t)); out.addInPlace(p2.scale(3*u*tt)); out.addInPlace(p3.scale(ttt)); return out; }

  // Mobile panos removed - always use high-quality originals (now compressed)

  // Periodic memory GC to keep texture cache tight on mobile
  try {
    setInterval(() => {
      try{
        const cur = nodesById.get(currentNodeId);
        if (!cur) return;
        const keep = new Set();
        const k = `${BASE}|${cur.file}`; keep.add(k);
        const neigh = neighborInfoFor(cur, 2);
        neigh.keys.forEach(x => keep.add(x));
        retainOnly(keep);
      } catch {}
    }, 45000);
  } catch {}

  /* Floors -> world positions */
  const floorIndex = new Map();
  const floorCenters = new Map();
  function rebuildFloorMaps() {
    floorIndex.clear();
    floorCenters.clear();
    data.floors.forEach((f, i) => floorIndex.set(f.id, i));
    for (const f of data.floors) {
      const on = data.nodes.filter((n) => n.floorId === f.id);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of on) {
        if (typeof n.x === "number" && typeof n.y === "number") {
          if (n.x < minX) minX = n.x;
          if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.y > maxY) maxY = n.y;
        }
      }
      const ppm = f.pxPerMeter || 100;
      const cx = isFinite(minX) ? (minX + maxX) / 2 : 0;
      const cy = isFinite(minY) ? (minY + maxY) / 2 : 0;
      floorCenters.set(f.id, { cx, cy, ppm });
    }
  }
  rebuildFloorMaps();
  const nodeWorldPos = (n) => {
    const f = floorCenters.get(n.floorId) || { cx: 0, cy: 0, ppm: 100 };
    const idx = floorIndex.get(n.floorId) ?? 0;
    return new Vector3((n.x - f.cx) / f.ppm, idx * FLOOR_HEIGHT_M, (n.y - f.cy) / f.ppm);
  };
  /* Dome */
  const worldRoot = new TransformNode("worldRoot", scene);
  const dome = MeshBuilder.CreateSphere("dome", { diameter: DOME_DIAMETER, segments: 64, sideOrientation: Mesh.BACKSIDE }, scene);
  dome.parent = worldRoot;
  if (flipX()) dome.rotation.x = Math.PI;
  // Render 2D dome on aux layer to exclude it from XR camera
  try { dome.layerMask = 0x2; } catch {}

  const domeMat = new StandardMaterial("panoMat", scene);
  domeMat.disableLighting = true;
  domeMat.backFaceCulling = false;
  domeMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
  dome.material = domeMat;

  // Optional 2D PhotoDome (disabled by default; the sphere dome is the current 2D pipeline)
  const ENABLE_2D_PHOTODOME = (String(import.meta?.env?.VITE_ENABLE_2D_PHOTODOME ?? '0') === '1');
  const dome2D = ENABLE_2D_PHOTODOME ? new PhotoDome("pd2d", "", { size: DOME_DIAMETER }, scene) : null;
  if (dome2D?.mesh) {
    dome2D.mesh.parent = worldRoot;
    dome2D.mesh.isVisible = false;
    // Keep 2D PhotoDome on aux layer (hidden from XR camera)
    try { dome2D.mesh.layerMask = 0x2; } catch {}
    try{
      const mode = isStereo() ? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
      if ("stereoMode" in dome2D) dome2D.stereoMode = mode;
      if ("imageMode" in dome2D) dome2D.imageMode = mode;
    }catch{}
  }

  // second dome for crossfade in 2D
  const crossDome = MeshBuilder.CreateSphere("domeX", { diameter: DOME_DIAMETER, segments: 64, sideOrientation: Mesh.BACKSIDE }, scene);
  crossDome.parent = worldRoot; if (flipX()) crossDome.rotation.x = Math.PI; try { crossDome.layerMask = 0x2; } catch {}
  crossDome.isPickable = false; crossDome.isVisible = false; try { crossDome.setEnabled(false); } catch {}
  const crossMat = new StandardMaterial("panoMatX", scene);
  crossMat.disableLighting = true; crossMat.backFaceCulling = false; crossMat.alpha = 0;
  crossMat.transparencyMode = Material.MATERIAL_ALPHABLEND; crossMat.disableDepthWrite = true;
  crossDome.material = crossMat; crossDome.renderingGroupId = 1;

  // Drag-to-rotate + pinch/wheel zoom for Viewer (2D) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â immediate (no drift)
  let dragging=false, lastX=0, lastY=0;
  let yawV=0, pitchV=0;
  const yawSpeed=0.005, pitchSpeed=0.003, pitchClamp=Math.PI*0.39;
  function applyCam(){
    const px = Math.max(-pitchClamp, Math.min(pitchClamp, pitchV));
    cam.rotation.y = yawV;
    cam.rotation.x = px;
  }
  const canvas2 = document.getElementById('renderCanvas');
  if (canvas2){
    canvas2.style.cursor='grab';
    const MIN_FOV=0.45, MAX_FOV=1.7; const clampF=(v)=>Math.max(MIN_FOV, Math.min(MAX_FOV, v));
    const touches=new Map(); let pinch=false, pinRef=0, pinBase=cam.fov; const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)||1;
    canvas2.addEventListener('pointerdown', (e)=>{
      touches.set(e.pointerId, {x:e.clientX, y:e.clientY});
      if (touches.size===2){ const it=[...touches.values()]; pinRef=dist(it[0],it[1]); pinBase=cam.fov; pinch=true; dragging=false; canvas2.style.cursor='grab'; }
      else if (touches.size===1){ dragging=true; lastX=e.clientX; lastY=e.clientY; try{ canvas2.setPointerCapture(e.pointerId); }catch{} canvas2.style.cursor='grabbing'; }
    }, { passive:false });
    canvas2.addEventListener('pointermove', (e)=>{
      const p=touches.get(e.pointerId); if (p){ p.x=e.clientX; p.y=e.clientY; }
      if (pinch && touches.size>=2){ const it=[...touches.values()]; const cur=dist(it[0],it[1]); const scale=Math.max(0.25,Math.min(4,cur/pinRef)); cam.fov = clampF(pinBase*scale); return; }
      if(!dragging) return; const dx=e.clientX-lastX, dy=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; yawV -= dx*yawSpeed; pitchV -= dy*pitchSpeed; applyCam();
    }, { passive:true });
    function endPtr(){ dragging=false; pinch=false; canvas2.style.cursor='grab'; }
    canvas2.addEventListener('pointerup', (e)=>{ touches.delete(e.pointerId); endPtr(); }, { passive:true });
    canvas2.addEventListener('pointerleave', (e)=>{ touches.delete(e.pointerId); endPtr(); }, { passive:true });
    canvas2.addEventListener('pointercancel', (e)=>{ touches.delete(e.pointerId); endPtr(); }, { passive:true });
    canvas2.addEventListener('wheel', (e)=>{ e.preventDefault(); const step=Math.max(-0.2,Math.min(0.2,(e.deltaY||0)*0.0012)); cam.fov = clampF(cam.fov + step); }, { passive:false });
  }

  // second dome for crossfade in 2D
  // Disable sphere-based crossfade in favor of PhotoDome pipeline (more robust)

  /* Texture cache & mapping */
  // LRU texture cache to prevent unbounded GPU memory growth
  const texCache = new Map();
  const inFlight = new Map();
  const ktx2FallbackWarned = new Set();
  const TEX_LIMIT = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('texLimit') || qs.get('textureLimit') || (import.meta?.env?.VITE_TEX_LIMIT ?? '');
      const override = Number.parseInt(String(raw || ''), 10);
      if (Number.isFinite(override) && override > 0) return Math.max(1, Math.min(override, 48));
    }catch{}
    try{
      const ua=(navigator.userAgent||'').toLowerCase();
      // iPhone: very conservative limit (stereo uses 2x memory)
      if(/iphone|ipad|ipod|ios/.test(ua)) return 1;
      if(/android/.test(ua)) return 8;
      return 16;
    }catch{ return 16; }
  })();
  const PREFETCH_LIMIT = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('prefetch') || qs.get('neighborPrefetch') || (import.meta?.env?.VITE_NEIGHBOR_PREFETCH ?? '');
      const override = Number.parseInt(String(raw || ''), 10);
      if (Number.isFinite(override) && override >= 0) return Math.max(0, Math.min(override, 6));
    }catch{}
    try{
      if (isSlowNetwork()) return 0;
    }catch{}
    return IS_IOS ? 0 : 2;
  })();
  const VR_PREFETCH_LIMIT = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('vrPrefetch') || qs.get('vrNeighborPrefetch') || (import.meta?.env?.VITE_VR_PREFETCH ?? '');
      const override = Number.parseInt(String(raw || ''), 10);
      if (Number.isFinite(override) && override >= 0) return Math.max(0, Math.min(override, 10));
    }catch{}
    try{
      if (isSlowNetwork()) return Math.max(PREFETCH_LIMIT, 1);
    }catch{}
    return Math.max(PREFETCH_LIMIT, 4);
  })();
  const VR_GPU_PREFETCH = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('vrGpuPrefetch') || (import.meta?.env?.VITE_VR_GPU_PREFETCH ?? '');
      if (String(raw || '').trim() === '0') return false;
    }catch{}
    try{
      if (isSlowNetwork()) return false;
    }catch{}
    return true;
  })();
  function touchLRU(key){ if(!texCache.has(key)) return; const v=texCache.get(key); texCache.delete(key); texCache.set(key,v); }
  function evictIfNeeded(curKey){
    try{
      let evicted = false;
      while (texCache.size > TEX_LIMIT){
        const firstKey = texCache.keys().next().value;
        if (!firstKey || firstKey === curKey) break;
        const tex = texCache.get(firstKey);
        try{ tex?.dispose?.(); }catch{}
        texCache.delete(firstKey);
        evicted = true;
      }
      // Force GC on iOS after texture disposal to prevent memory buildup
      if (evicted && IS_IOS) {
        try { scene?.getEngine?.()?.wipeCaches?.(true); } catch {}
      }
    }catch{}
  }
  function retainOnly(keep){
    try{
      for (const [k, tex] of texCache.entries()){
        if (!keep.has(k)) { try{ tex?.dispose?.(); }catch{} texCache.delete(k); }
      }
    }catch{}
  }
  function retainSW(urls){
    try{
      const abs = (urls || []).map((u) => { try { return new URL(u, location.origin).href; } catch { return u; } });
      navigator.serviceWorker?.controller?.postMessage({ type:'retain', urls: abs });
    }catch{}
  }
  const _warmFetchSeen = new Set();
  function warmFetchUrls(urls){
    try{
      if (!Array.isArray(urls) || urls.length === 0) return;
      // If SW isn't controlling the page (e.g., insecure context / cert issues),
      // still warm the HTTP cache so pano switches are faster.
      const list = [];
      for (const u of urls){
        const s = String(u || "").trim();
        if (!s || _warmFetchSeen.has(s)) continue;
        _warmFetchSeen.add(s);
        list.push(s);
      }
      if (!list.length) return;
      const MAX = 2;
      let idx = 0, inflight = 0;
      const pump = () => {
        while (inflight < MAX && idx < list.length){
          const u = list[idx++];
          inflight++;
          fetch(u, { credentials: "same-origin", cache: "force-cache" })
            .catch(()=>{})
            .finally(()=>{ inflight--; try{ pump(); }catch{} });
        }
      };
      pump();
    }catch{}
  }
  function precacheSW(urls){
    try{
      const ctrl = navigator.serviceWorker?.controller;
      if (ctrl){ ctrl.postMessage({ type:'precache', urls }); return; }
    }catch{}
    warmFetchUrls(urls);
  }

  function neighborInfoFor(n, limit = PREFETCH_LIMIT){
    const out = { files: [], keys: [], urls: [] };
    try{
      const hs = Array.isArray(n?.hotspots) ? n.hotspots : [];
      for (const h of hs){
        if (!h?.to || !nodesById.has(h.to)) continue;
        const f = nodesById.get(h.to).file;
        if (!f || out.files.includes(f)) continue;
        out.files.push(f);
        out.keys.push(`${BASE}|${f}`);
        out.urls.push(panoUrl(f));
        if (out.files.length >= limit) break;
      }
    }catch{}
    return out;
  }
  function purgeTextures(){
    try{
      for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} }
      texCache.clear();
      // Force GC on iOS to free memory immediately
      if (IS_IOS) {
        try { scene?.getEngine?.()?.wipeCaches?.(true); } catch {}
      }
    }catch{}
  }
  // Standard texture load: use the file as authored (with simple WebP support toggle from chooseFile)
  async function getTexture(file) {
    const key = `${BASE}|${file}`;
    if (texCache.has(key)) { touchLRU(key); return texCache.get(key); }
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async()=>{
      const q = getQuality();
      const loadTextureUrl = (url) => new Promise((resolve, reject) => {
        let settled = false;
        let tex = null;
        const noMipmap = /\.ktx2$/i.test(url) ? true : !q.mips;
        const finishOk = () => { if (settled) return; settled = true; resolve(tex); };
        const finishErr = (message, exception) => {
          if (settled) return;
          settled = true;
          try{ tex?.dispose?.(); }catch{}
          const err = exception instanceof Error ? exception : new Error(String(message || "Texture load failed"));
          reject(err);
        };
        tex = new Texture(url, scene, noMipmap, false, q.sampling, finishOk, finishErr);
        try { tex.anisotropicFilteringLevel = q.aniso; } catch {}
        setTimeout(() => finishErr(`Texture load timeout: ${url}`), 45000);
      });

      const primaryUrl = panoUrl(file);
      const fallbackUrl = /\.ktx2$/i.test(primaryUrl) ? panoUrlOriginal(file) : panoUrlKtx2(file);
      const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      let usedUrl = primaryUrl;
      let tex = null;
      try{
        tex = await loadTextureUrl(primaryUrl);
      }catch(e){
        if (fallbackUrl && fallbackUrl !== primaryUrl){
          if (/\.ktx2($|\?)/i.test(primaryUrl) && !ktx2FallbackWarned.has(primaryUrl)) {
            ktx2FallbackWarned.add(primaryUrl);
            try { console.warn("[VIEWER] KTX2 pano failed; falling back to original:", { file, primaryUrl, fallbackUrl, error: String(e?.message || e) }); } catch {}
          }
          try{
            tex = await loadTextureUrl(fallbackUrl);
            usedUrl = fallbackUrl;
            // If KTX2 failed but fallback succeeded, disable KTX2 for this experience going forward.
            if (/\.ktx2($|\?)/i.test(primaryUrl)){
              const id = String(expSlug() || "").trim();
              if (id) { preferKtx2Effective = false; preferKtx2ByExp.set(id, false); }
            }
          }catch{
            throw e;
          }
        } else {
          throw e;
        }
      }
      if (LOAD_DEBUG){
        const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        try{
          const ext = String(usedUrl || "").split("?")[0].split(".").pop();
          console.log("[VIEWER] pano loaded", { file, ext, ms: Math.round(Math.max(0, t1 - t0)), url: usedUrl });
        }catch{}
      }
      texCache.set(key, tex); evictIfNeeded(key); return tex;
    })();
    inFlight.set(key, p);
    p.finally(()=>inFlight.delete(key));
    return p;
  }

  // Aggressive preloading for VR to prevent black screens
  const preloadedUrls = new Set();
  function preloadForVR(node) {
    if (!node) return;
    try {
      // Get all neighbor nodes
      const neighbors = neighborInfoFor(node, VR_PREFETCH_LIMIT); // Preload neighbors in VR
      try { if (!IS_IOS && neighbors.urls.length) precacheSW(neighbors.urls); } catch {}
      for (const url of neighbors.urls) {
        if (preloadedUrls.has(url)) continue;
        preloadedUrls.add(url);
        // Note: `Image()` can't decode `.ktx2` and may not populate cache; rely on SW precache instead.
      }
      // Limit preload cache size
      if (preloadedUrls.size > 20) {
        const oldest = preloadedUrls.values().next().value;
        preloadedUrls.delete(oldest);
      }
    } catch {}
  }

  function applyMainTexture(file, tex){
    try { mapFor2D(tex, isStereo()); } catch {}
    domeMat.emissiveTexture = tex; try { dome.setEnabled(true); } catch {}
    try { remapFor2DWhenReady(tex); } catch {}
  }
  async function showFile(file){
    const tex = await getTexture(file);
    applyMainTexture(file, tex);
  }
  function runCrossFade(file, tex, fadeMs, delayMs = 0){
    if (!tex) return showFile(file);
    if (!(fadeMs > 0)) { applyMainTexture(file, tex); return Promise.resolve(); }
    // Prepare overlay with the next texture and fade it on top of current
    try { mapFor2D(tex, isStereo()); } catch {}
    try { remapFor2DWhenReady(tex); } catch {}
    return new Promise((resolve) => {
      const startFade = () => {
        try{
          crossMat.emissiveTexture = tex;
          // Keep UV mapping consistent with main texture (incl. mono-crop for stereo sources)
          try { mapFor2D(crossMat.emissiveTexture, isStereo()); } catch {}
          try { remapFor2DWhenReady(crossMat.emissiveTexture); } catch {}
          crossMat.alpha = 0;
          crossDome.setEnabled(true);
          crossDome.isVisible = true;
        }catch{}
        const started = performance.now();
        const observer = scene.onBeforeRenderObservable.add(() => {
          const elapsed = performance.now() - started;
          const t = Math.min(1, elapsed / Math.max(1, fadeMs));
          crossMat.alpha = t;
          if (t >= 1) {
            try{ scene.onBeforeRenderObservable.remove(observer); }catch{}
            try{
              crossMat.emissiveTexture = null; crossDome.isVisible = false; crossDome.setEnabled(false); crossMat.alpha = 0;
            }catch{}
            applyMainTexture(file, tex);
            resolve();
          }
        });
      };
      if (delayMs > 0) setTimeout(startFade, delayMs); else startFade();
    });
  }

  const STEREO_2D_HALF = (() => {
    try {
      const qs = new URLSearchParams(location.search);
      const qsHalf = String(qs.get("stereoHalf") || qs.get("introHalf") || "").trim().toLowerCase();
      if (qsHalf === "top" || qsHalf === "bottom") return qsHalf;
    } catch {}
    try {
      const envHalf = String(import.meta?.env?.VITE_STEREO_2D_HALF ?? import.meta?.env?.VITE_INTRO_STEREO_HALF ?? "").trim().toLowerCase();
      if (envHalf === "top" || envHalf === "bottom") return envHalf;
    } catch {}
    return "top";
  })();

  function remapFor2DWhenReady(tex) {
    if (!tex) return;
    const nodeIdAtSchedule = currentNodeId;
    const texAtSchedule = tex;
    let tries = 0;
    const obs = scene.onBeforeRenderObservable.add(() => {
      try {
        // Stop if navigation changed or the texture is no longer active on either dome.
        const stillCurrent = currentNodeId === nodeIdAtSchedule;
        const stillUsed = (domeMat?.emissiveTexture === texAtSchedule) || (crossMat?.emissiveTexture === texAtSchedule);
        if (!stillCurrent || !stillUsed) {
          try { scene.onBeforeRenderObservable.remove(obs); } catch {}
          return;
        }
        tries++;
        mapFor2D(texAtSchedule, isStereo());
        const sz = texAtSchedule.getBaseSize?.() || texAtSchedule.getSize?.();
        const w = Number(sz?.width) || Number(texAtSchedule?._texture?.baseWidth) || Number(texAtSchedule?._texture?.width) || 0;
        const h = Number(sz?.height) || Number(texAtSchedule?._texture?.baseHeight) || Number(texAtSchedule?._texture?.height) || 0;
        // Once size is known (or after a few frames), stop.
        if ((w > 0 && h > 0) || tries >= 6) {
          try { scene.onBeforeRenderObservable.remove(obs); } catch {}
        }
      } catch {
        try { scene.onBeforeRenderObservable.remove(obs); } catch {}
      }
    });
  }

  function mapFor2D(tex, stereo) {
    if (!tex) return;
    // Ensure equirect mapping like Agent (prevents full TB showing)
    try { tex.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE; } catch {}
    tex.uScale  = flipU() ? -1 : 1;
    tex.uOffset = flipU() ?  1 : 0;

    let vScale  = -1.0;
    let vOffset = 1.0;

    let shouldCrop = false;
    let cropSlices = 2; // how many vertical slices the texture contains
    let sliceIndex = (STEREO_2D_HALF === "bottom") ? 1 : 0; // which slice to show in mono 2D
    try {
      const sz = tex.getBaseSize?.() || tex.getSize?.();
      const w = Number(sz?.width) || Number(tex?._texture?.baseWidth) || Number(tex?._texture?.width) || 0;
      const h = Number(sz?.height) || Number(tex?._texture?.baseHeight) || Number(tex?._texture?.height) || 0;
      if (w > 0 && h > 0) {
        const ratioHW = h / w;
        // Only auto-crop by aspect when we see a clearly "tall" texture (typical TB stereo: h≈2w).
        // Avoid cropping regular mono equirect (usually w≈2h).
        const tallByShape = ratioHW > 1.3;
        if (stereo) {
          const nearSquare = Math.abs(ratioHW - 1) < 0.15; // e.g. 6000x6000
          const tallTopBottom = ratioHW > 1.7; // e.g. 2048x4096 rotated TB or true TB (h≈2w)
          const squashedTopBottom = ratioHW < 0.6; // e.g. TB stereo packed into 2:1
          shouldCrop = nearSquare || tallTopBottom || squashedTopBottom;
        } else {
          // If metadata missed the stereo flag, still crop tall TB sources in 2D.
          shouldCrop = tallByShape;
        }

        // If the texture is vertically stacked (ratioHW ≈ 1,2,3...), infer the number of slices.
        // Example: mono equirect is typically h/w≈0.5; TB stereo is ≈1.0; "double TB" becomes ≈2.0.
        if (ratioHW > 0.8) {
          const inferred = Math.round(2 * ratioHW); // 1->2 slices, 2->4 slices
          if (Number.isFinite(inferred) && inferred >= 2) cropSlices = Math.max(2, Math.min(inferred, 6));
        }

        // When user asks for "bottom", show the second slice (eye2) if available.
        // For 4-slice sources, this selects slice 1 (commonly the right-eye band) instead of the very bottom.
        sliceIndex = Math.min(Math.max(sliceIndex, 0), cropSlices - 1);
      } else if (stereo) {
        // Fallback: when marked stereo but size is unknown, assume TB and crop.
        shouldCrop = true;
      }
    } catch {
      if (stereo) shouldCrop = true;
    }

    if (shouldCrop) {
      // Sample exactly one vertical slice for the mono 2D view.
      // For TB stereo (2 slices): slice 0=top, slice 1=bottom.
      // For 4-slice sources (common when TB is accidentally stacked twice): slice 0..3.
      vScale = -1 / cropSlices;
      vOffset = (sliceIndex + 1) / cropSlices;
    }

    tex.vScale  = vScale;
    tex.vOffset = vOffset;
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    // aniso set in getTexture()
  }

  // Release GPU memory when tab is hidden/backgrounded (mobile stability)
  const PURGE_ON_HIDE = (String(import.meta?.env?.VITE_PURGE_ON_HIDE ?? '1') === '1');
  // And proactively restore the current panorama when returning to the tab
  try{
    document.addEventListener('visibilitychange', ()=>{
      try{
        if (document.visibilityState !== 'visible') {
          if (PURGE_ON_HIDE) purgeTextures();
        } else {
          // Tab became visible again: ensure textures are reloaded
          try { engine.resize(); } catch {}
          try { refreshDomeForCurrentNode(); } catch {}
        }
      }catch{}
    });
    addEventListener('pagehide', ()=>{ try{ if (PURGE_ON_HIDE) purgeTextures(); }catch{} });
    addEventListener('pageshow', ()=>{ try{ engine.resize(); refreshDomeForCurrentNode(); }catch{} });
  }catch{}

  // Apply initial orientation
  applyCam();

  /* WebXR (optional for viewer) */
  let xr = null; let inXR = false;
  // Thumbstick turning (smooth yaw rotation) in XR by rotating the panorama root.
  const XR_TURN_DEADZONE = 0.14;
  const XR_TURN_SPEED_RAD_PER_SEC = (140 * Math.PI / 180); // ~140°/s at full deflection
  const XR_TURN_SIGN = (() => {
    try{
      const qs = new URLSearchParams(location.search);
      const raw = (qs.get('turnSign') || import.meta?.env?.VITE_XR_TURN_SIGN || '').toString().trim().toLowerCase();
      if (raw === '-1' || raw === 'inv' || raw === 'invert' || raw === 'reverse' || raw === 'reversed') return -1;
      if (raw === '1' || raw === 'normal' || raw === 'default') return 1;
    }catch{}
    // Default: invert so "stick right" turns view right when rotating the pano root.
    return -1;
  })();
  // While entering XR, keep the 2D pano visible until the VR PhotoDome is actually ready (prevents black screens).
  let xrFallback2D = false;
  let xrEnterToken = 0;
  // Double-buffered PhotoDome to avoid black frames in VR
  const vrDomes = [null, null];
  let activeVr = 0;
  let prevHSL = null; // previous hardware scaling level (for clarity in XR)
  let vrReadyFile = null;
  let vrWarmPromise = null;
  let vrWarmTarget = null;
  function applyVrTextureMapping(dome){
    try{
      if (!dome) return;
      try{ if (dome.mesh) dome.mesh.rotation.x = 0; }catch{}
      const tex = dome.photoTexture;
      if (tex){
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      }
    }catch{}
  }
  try{
    if (navigator?.xr){
      // Allow reference space override via query param: ?xrRef=local | local-floor | bounded-floor
      const qs = new URLSearchParams(location.search);
      const xrRef = (qs.get('xrRef') || 'local-floor');
      xr = await scene.createDefaultXRExperienceAsync({
        uiOptions: { sessionMode: "immersive-vr", referenceSpaceType: xrRef },
        optionalFeatures: true
      });
      // Avoid network hand-mesh fetches and model parser noise
      try{ const fm = xr?.baseExperience?.featuresManager; fm?.enableFeature?.('hand-tracking','latest',{ xrInput: xr?.baseExperience?.input, jointMeshes:false, doNotLoadHandMesh:true }); }catch{}
    }
  }catch{}
  // Track the stereo mode each dome was created with (changing imageMode after creation is unreliable)
  const vrDomeModes = [null, null];
  const createVrDome = (index, stereoMode) => {
    // Dispose existing dome if present
    if (vrDomes[index]) {
      console.log('[VIEWER] Disposing old dome', index);
      try { vrDomes[index].dispose(); } catch {}
      vrDomes[index] = null;
    }
    const modeStr = stereoMode === PhotoDome.MODE_TOPBOTTOM ? 'TOPBOTTOM' : 'MONOSCOPIC';
    console.log('[VIEWER] Creating VR dome', index, 'with imageMode:', modeStr, '(', stereoMode, ')');
    const dome = new PhotoDome("pd_"+index, panoUrl(nodesById?.get?.(currentNodeId)?.file || ""), { size: DOME_DIAMETER, imageMode: stereoMode }, scene);
    dome.mesh.isVisible = false;
    // CRITICAL FIX: Parent to worldRoot to prevent drift in VR
    dome.mesh.parent = worldRoot;
    // Ensure VR domes render only on main layer used by XR camera
    try { dome.mesh.layerMask = 0x1; } catch {}
    applyVrTextureMapping(dome);
    vrDomes[index] = dome;
    vrDomeModes[index] = stereoMode;
    // Verify the mode was set correctly
    console.log('[VIEWER] Dome', index, 'created. Actual imageMode:', dome.imageMode, 'Expected:', stereoMode);
    return dome;
  };
  const ensureVrDome = (index) => {
    const neededMode = isStereo() ? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    // Recreate dome if mode changed (changing imageMode after creation is unreliable in some Babylon versions)
    if (vrDomes[index] && vrDomeModes[index] !== neededMode) {
      console.log('[VIEWER] Stereo mode changed, recreating dome', index, ':', vrDomeModes[index], '->', neededMode);
      return createVrDome(index, neededMode);
    }
    if (vrDomes[index]) return vrDomes[index];
    return createVrDome(index, neededMode);
  };
  const setVrStereoMode = (dome) => {
    const node = currentNode();
    const meta = currentMeta();
    const stereo = isStereo();
    const mode = stereo ? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    console.log('[VIEWER] setVrStereoMode:', {
      nodeId: node?.id,
      file: node?.file,
      stereo,
      mode: mode === PhotoDome.MODE_TOPBOTTOM ? 'TOPBOTTOM' : 'MONOSCOPIC',
      stereoPanos: meta?.stereoPanos,
      currentDomeMode: dome?.imageMode
    });
    // Set imageMode directly (PhotoDome uses this property)
    try { dome.imageMode = mode; } catch (e) { console.warn('[VIEWER] Failed to set imageMode:', e); }
    // Also try stereoMode for older Babylon versions
    try { if (dome.stereoMode !== undefined) dome.stereoMode = mode; } catch {}
  };
  async function loadUrlIntoDome(dome, url, timeoutMs = VR_PANO_LOAD_TIMEOUT_MS){
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (!dome?.photoTexture) return true;
    const tex = dome.photoTexture;
    let obs = null;
    let done = false;
    const cleanup = () => { if (obs){ try { tex.onLoadObservable.remove(obs); } catch {} obs = null; } };

    // Prevent black frames: keep PhotoDome texture blocking during URL swap/load.
    try { tex.isBlocking = true; } catch {}

    const ok = await new Promise((resolve)=>{
      const t0 = performance.now();
      const finish = (result)=>{
        if (done) return;
        done = true;
        cleanup();
        resolve(!!result);
      };

      try{
        obs = tex.onLoadObservable.add(()=>finish(true));
      }catch{}

      // Some Babylon paths can miss onLoadObservable; poll readiness as a fallback.
      const poll = ()=>{
        if (done) return;
        try{ if (tex.isReady?.()) return finish(true); }catch{}
        if ((performance.now() - t0) >= timeoutMs) return finish(false);
        try{ requestAnimationFrame(poll); }catch{ setTimeout(poll, 16); }
      };

      try { tex.updateURL(url); } catch { finish(false); return; }
      poll();
    });

    try { const t = dome.photoTexture; if (t) { t.anisotropicFilteringLevel = 8; } } catch {}
    if (ok) {
      // Give the GPU/runtime a moment to finish decode before allowing non-blocking rendering.
      try { await new Promise(r => setTimeout(r, IS_IOS ? 90 : 30)); } catch {}
    }
    try { tex.isBlocking = false; } catch {}
    applyVrTextureMapping(dome);
    if (LOAD_DEBUG){
      const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      try{
        const ext = String(url || "").split("?")[0].split(".").pop();
        console.log("[VIEWER] vr pano", { ok, ext, ms: Math.round(Math.max(0, t1 - t0)), url });
      }catch{}
    }
    return ok;
  }

  async function setVrPano(file){
    const primaryUrl = panoUrl(file);
    const fallbackUrl = /\.ktx2$/i.test(primaryUrl) ? panoUrlOriginal(file) : panoUrlKtx2(file);
    let url = primaryUrl;
    const neededMode = isStereo() ? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    const current = vrDomes[activeVr];
    // Check if we can reuse current dome (same file AND same stereo mode)
    if (current && current.__panoFile === file && vrDomeModes[activeVr] === neededMode){
      setVrStereoMode(current);
      try { current.mesh.isVisible = true; current.mesh.setEnabled(true); } catch {}
      vrReadyFile = file;
      return;
    }
    const next = 1 - activeVr;
    const nextDome = ensureVrDome(next);
    const curDome = vrDomes[activeVr];

    // CRITICAL: Set stereo mode BEFORE loading URL (like agent.js) to prevent twisted images
    setVrStereoMode(nextDome);

    // Keep the current pano visible until the next texture is actually ready.
    try { nextDome.mesh.isVisible = false; nextDome.mesh.setEnabled(false); } catch {}
    // Avoid treating "slow KTX2 decode/transcode" as a failure.
    // Only fall back quickly when the KTX2 URL appears missing/unreachable.
    let loaded = false;
    if (/\.ktx2($|\?)/i.test(primaryUrl) && fallbackUrl && fallbackUrl !== primaryUrl) {
      let primaryExists = true;
      try { primaryExists = await urlExistsFast(primaryUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS }); } catch {}
      if (primaryExists === false) {
        let fallbackExists = true;
        try { fallbackExists = await urlExistsFast(fallbackUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS }); } catch {}
        if (fallbackExists) {
          try { console.warn('[VIEWER] VR KTX2 missing; using fallback URL:', { file, primaryUrl, fallbackUrl }); } catch {}
          loaded = await loadUrlIntoDome(nextDome, fallbackUrl, VR_PANO_LOAD_TIMEOUT_MS);
          url = fallbackUrl;
          if (loaded) {
            try{
              const id = String(expSlug() || "").trim();
              if (id) { preferKtx2Effective = false; preferKtx2ByExp.set(id, false); }
            }catch{}
          }
        } else {
          loaded = await loadUrlIntoDome(nextDome, primaryUrl, VR_PANO_LOAD_TIMEOUT_MS);
        }
      } else {
        loaded = await loadUrlIntoDome(nextDome, primaryUrl, VR_PANO_LOAD_TIMEOUT_MS);
      }
    } else {
      loaded = await loadUrlIntoDome(nextDome, primaryUrl, VR_PANO_LOAD_TIMEOUT_MS);
    }
    // If primary load genuinely failed (decode error, etc.), try fallback as a last resort.
    if (!loaded && url === primaryUrl && fallbackUrl && fallbackUrl !== primaryUrl){
      try{
        const exists = await urlExistsFast(fallbackUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS });
        if (exists) {
          try { console.warn('[VIEWER] VR pano failed; retrying with fallback URL:', { file, primaryUrl, fallbackUrl }); } catch {}
          loaded = await loadUrlIntoDome(nextDome, fallbackUrl, VR_PANO_LOAD_TIMEOUT_MS);
          url = fallbackUrl;
          if (/\.ktx2($|\?)/i.test(primaryUrl) && loaded){
            try{
              const id = String(expSlug() || "").trim();
              if (id) { preferKtx2Effective = false; preferKtx2ByExp.set(id, false); }
            }catch{}
          }
        }
      }catch{}
    }
    if (!loaded){
      console.warn('[VIEWER] VR pano load timed out; keeping previous pano visible:', file);
      return;
    }

    nextDome.__panoFile = file;
    vrReadyFile = file;
    // Re-apply stereo mode after URL update (some engines reset flags on new texture)
    setVrStereoMode(nextDome);

    // ATOMIC SWAP: Show new dome FIRST, then hide old dome (no visual gap)
    nextDome.mesh.isVisible = true;
    try { nextDome.mesh.setEnabled(true); } catch {}

    // Small delay to ensure WebGL has rendered the new dome before hiding old
    await new Promise(r => setTimeout(r, 16)); // ~1 frame at 60fps

    if (curDome) {
      curDome.mesh.isVisible = false;
      try { curDome.mesh.setEnabled(false); } catch {}
    }
    activeVr = next;
    try{ retainSW([url]); }catch{}
  }

  // Defensive visibility guard to avoid any accidental 2D overlays in XR
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (inXR){
        // In XR, only hide 2D once the VR dome is ready; until then, keep 2D as a fallback (no black frames).
        if (!xrFallback2D){
          try { if (dome?.isEnabled?.()) dome.setEnabled(false); } catch {}
          try { if (dome2D?.mesh?.isVisible) dome2D.mesh.isVisible = false; } catch {}
        } else {
          try { if (dome && !dome.isEnabled()) dome.setEnabled(true); } catch {}
          try { if (dome2D?.mesh) dome2D.mesh.isVisible = true; } catch {}
        }
      } else {
        // Outside XR, keep 2D path active
        try { if (dome && !dome.isEnabled()) dome.setEnabled(true); } catch {}
        try { if (dome2D?.mesh && dome2D.mesh.isVisible === false) dome2D.mesh.isVisible = true; } catch {}
      }
    }catch{}
  });
  async function animateTravelXR(prevNode, nextNode){
    try{
      if (!prevNode || !nextNode || !inXR) return;
      navAnimating = true;
      const startPos = worldRoot.position.clone();
      const targetPos = nodeWorldPos(nextNode);
      const delta = targetPos.subtract(startPos);
      const distance = delta.length();
      const forward = distance>1e-4 ? delta.normalize() : new Vector3(0,0,-1);
      const startMag = Math.max(NAV_PUSH_M*0.35, Math.min(distance + NAV_PUSH_M*0.25, NAV_PUSH_M*1.2));
      const endMag   = Math.max(NAV_PUSH_M*0.25, Math.min(distance*0.5, NAV_PUSH_M*0.9));
      const ctrl1 = startPos.add(forward.scale(startMag));
      const ctrl2 = targetPos.subtract(forward.scale(endMag));
      const baseMs = NAV_DUR_MS + 420;
      const travelFactor = Math.max(1, (distance + 0.5) / Math.max(0.4, NAV_PUSH_M*0.5));
      const travelMs = Math.max(2400, Math.min(4800, baseMs * travelFactor * 2));
      // Keep current yaw in XR to avoid nausea; forward-only translation
      const startYaw = worldYaw;
      const t0 = performance.now();
      const obs = scene.onBeforeRenderObservable.add(()=>{
        const t = Math.min(1, (performance.now() - t0) / travelMs);
        const eased = easeInOutSine(t);
        const pos = cubicBezier(startPos, ctrl1, ctrl2, targetPos, eased);
        worldRoot.position.copyFrom(pos);
        // Do not auto-rotate in XR; preserve current yaw throughout travel
        worldYaw = startYaw; worldRoot.rotation.y = worldYaw;
        if (t >= 1){ try{ scene.onBeforeRenderObservable.remove(obs); }catch{} navAnimating = false; }
      });
      await new Promise(res=>setTimeout(res, Math.ceil(travelMs)));
    }catch{ navAnimating=false; }
  }
  let lastLoadedFile = null; // Track last loaded file to prevent unnecessary reloads
  let lastAppliedNodeId = null; // Track which node we last applied (even if same file)
  let loadInProgress = false; // Prevent concurrent loads
  let targetNodeId = null; // Track latest target for sync during rapid navigation
  let rerunQueued = false; // If navigation changes during an in-flight load, rerun once with the latest target.
  async function refreshDomeForCurrentNode() {
    const node = nodesById.get(currentNodeId);
    if (!node) return;
    // Track the target we're loading for sync check
    const loadTarget = currentNodeId;
    targetNodeId = loadTarget;

    // Optimization: avoid redundant reloads
    // If the same node is requested again and the file hasn't changed, skip.
    // But if the node changed (even with the same file), continue so we update state cleanly.
    if (node.file === lastLoadedFile && lastAppliedNodeId === loadTarget) {
      try { dome.setEnabled(true); } catch {}
      return;
    }

    // Prevent concurrent loads (causes stuck black screens)
    if (loadInProgress) {
      rerunQueued = true;
      console.warn('[VIEWER] Load already in progress, queueing latest target:', node.file);
      return;
    }
    loadInProgress = true;
    rerunQueued = false;

    // Safety timeout: prevent a permanent stuck "in progress" state (keep long enough for large panos).
    const safetyTimeout = setTimeout(() => {
      console.error('[VIEWER] Load timeout - forcing reset');
      loadInProgress = false;
      rerunQueued = true;
    }, 60000);
    try {
      if (inXR) {
        await setVrPano(node.file);
        // CHECK: Are we still trying to load this node, or did agent move again?
        if (loadTarget !== targetNodeId) {
          console.warn('[VIEWER] Target changed during load, skipping apply:', loadTarget, '→', targetNodeId);
          return; // Don't apply outdated panorama
        }
        dome.setEnabled(false);
        vrReadyFile = node.file;
        try{ const active = vrDomes[activeVr]; if (active) active.__panoFile = node.file; }catch{}
        lastLoadedFile = node.file; // Mark as loaded only if we applied it
        lastAppliedNodeId = loadTarget;
        // Preload neighbors for faster VR transitions
        preloadForVR(node);
        // Keep GPU texture cache tight even in XR (PhotoDome uses its own texture pipeline)
        try {
          const curKey = `${BASE}|${node.file}`;
          const keep = new Set([curKey]);
          const urls = [panoUrl(node.file)];
          const neigh = neighborInfoFor(node, PREFETCH_LIMIT);
          try { if (!IS_IOS && neigh.urls.length) precacheSW(neigh.urls); } catch {}
          neigh.keys.forEach(k=>keep.add(k));
          urls.push(...neigh.urls);
          retainOnly(keep);
          retainSW(urls);
        } catch {}
      } else {
        try{ vrDomes.forEach(d=>{ if(d) d.mesh.isVisible=false; }); }catch{}
        // DON'T show loading overlay - causes black screens
        const tex = await getTexture(node.file);
        // CHECK: Are we still trying to load this node?
        if (loadTarget !== targetNodeId) {
          console.warn('[VIEWER] Target changed during load, skipping apply:', loadTarget, '→', targetNodeId);
          return; // Don't apply outdated panorama
        }
        // CORRECT: In 2D, CROP stereo (show bottom half only for mono view)
        // In VR, PhotoDome handles full stereo automatically
        mapFor2D(tex, isStereo());
        domeMat.emissiveTexture = tex;
        dome.setEnabled(true);
        // retention: current + previous + warm next neighbors
        const prevKey = lastLoadedFile && lastLoadedFile!==node.file ? `${BASE}|${lastLoadedFile}` : null;
        const prevFile = lastLoadedFile && lastLoadedFile!==node.file ? lastLoadedFile : null;
        lastLoadedFile = node.file; // Mark as loaded only if we applied it
        lastAppliedNodeId = loadTarget;
        const curKey = `${BASE}|${node.file}`;
        const keep = new Set([curKey]);
        const urls = [panoUrl(node.file)];
        if (prevKey){ keep.add(prevKey); try{ if (prevFile) urls.push(panoUrl(prevFile)); }catch{} }
        // Warm neighbors asynchronously; retain them as well
        const neigh = neighborInfoFor(node, PREFETCH_LIMIT);
        try { if (!IS_IOS && neigh.urls.length) precacheSW(neigh.urls); } catch {}
        neigh.files.forEach(f=>{ try{ getTexture(f).catch(()=>{}); }catch{} });
        neigh.keys.forEach(k=>keep.add(k));
        urls.push(...neigh.urls);
        retainOnly(keep);
        retainSW(urls);
      }
    } catch (error) {
      console.error('[VIEWER] Failed to load panorama:', error);
      lastLoadedFile = null; // Reset so it can retry
    } finally {
      clearTimeout(safetyTimeout);
      loadInProgress = false;
      if (rerunQueued && targetNodeId && targetNodeId !== lastAppliedNodeId) {
        // Run once more with the latest requested target.
        Promise.resolve().then(() => refreshDomeForCurrentNode()).catch(() => {});
      }
    }
  }

  // Smooth travel + crossfade for 2D Viewer (matches Agent behavior closely)
  // Use existing NAV_* and easing helpers defined earlier in this file
  async function forwardPushThenSwap(nextNode, prevNode = null, options = {}){
    try{
      if (!nextNode) return Promise.resolve();
      const startPos = worldRoot.position.clone();
      const targetPos = nodeWorldPos(nextNode);
      const delta = targetPos.subtract(startPos);
      const distance = delta.length();
      let forward = null;
      try { forward = cam?.getForwardRay?.(1)?.direction?.clone?.(); } catch {}
      if (!forward || !Number.isFinite(forward.x) || !Number.isFinite(forward.z) || (forward.lengthSquared?.() || 0) < 1e-6) {
        forward = new Vector3(0, 0, -1);
      }
      forward.y = 0;
      if ((forward.lengthSquared?.() || 0) < 1e-6) forward = new Vector3(0, 0, -1);
      forward.normalize();
      const travelDir = distance>1e-4 ? delta.normalize() : forward.clone();
      const startMag = Math.max(NAV_PUSH_M*0.6, Math.min(distance + NAV_PUSH_M*0.35, NAV_PUSH_M*1.6));
      const endMag   = Math.max(NAV_PUSH_M*0.4, Math.min(distance*0.7, NAV_PUSH_M*1.2));
      const ctrl1 = startPos.add(forward.scale(startMag));
      const ctrl2 = targetPos.subtract(travelDir.scale(endMag));
      const baseMs = NAV_DUR_MS + 360;
      const travelFactor = Math.max(1, (distance + 0.4) / Math.max(0.4, NAV_PUSH_M*0.6));
      const travelMs = Math.max(900, Math.min(2400, baseMs * travelFactor));
      const tex = await getTexture(nextNode.file);
      navAnimating = true;
      const t0 = performance.now();
      const obs = scene.onBeforeRenderObservable.add(()=>{
        const t = Math.min(1, (performance.now() - t0) / travelMs);
        const eased = easeInOutSine(t);
        const pos = cubicBezier(startPos, ctrl1, ctrl2, targetPos, eased);
        worldRoot.position.copyFrom(pos);
        if (t >= 1){ try{ scene.onBeforeRenderObservable.remove(obs); }catch{} navAnimating = false; }
      });
      await runCrossFade(nextNode.file, tex, Math.min(travelMs, 1200), 0);
      // Retain like refreshDomeForCurrentNode
      const prevFile = lastLoadedFile && lastLoadedFile!==nextNode.file ? lastLoadedFile : null;
      lastLoadedFile = nextNode.file; lastAppliedNodeId = nextNode.id;
      const curKey = `${BASE}|${nextNode.file}`;
      const keep = new Set([curKey]); const urls = [panoUrl(nextNode.file)];
      if (prevFile){ keep.add(`${BASE}|${prevFile}`); urls.push(panoUrl(prevFile)); }
      const neigh = neighborInfoFor(nextNode, PREFETCH_LIMIT);
      neigh.files.forEach(f=>{ try{ getTexture(f).catch(()=>{}); }catch{} });
      neigh.keys.forEach(k=>keep.add(k)); urls.push(...neigh.urls);
      retainOnly(keep); retainSW(urls);
    }catch{ await refreshDomeForCurrentNode(); }
  }
  xr?.baseExperience?.onStateChangedObservable?.add((s)=>{
    const wasInXR = inXR;
    inXR = (s === WebXRState.IN_XR);
    // Track XR mode for analytics
    try { trackXRMode(inXR); } catch {}
    try {
      if (inXR) {
        // Initialize yaw from current world root orientation.
        try { worldYaw = worldRoot?.rotation?.y || 0; } catch {}
        xrSnapTurnLatch = 0;
        xrSnapTurnCooldownUntil = 0;
        xrFallback2D = true;
        const token = ++xrEnterToken;
        try { document.body.setAttribute('data-xr','1'); } catch {}
        // Improve clarity in XR: disable downscaling while in VR
        prevHSL = engine.getHardwareScalingLevel?.() ?? null;
        engine.setHardwareScalingLevel(1.0);
        // Ensure XR camera renders only the main layer (hide any auxiliary overlays)
        try { const xrcam = xr?.baseExperience?.camera; if (xrcam) xrcam.layerMask = 0x1; } catch {}
        // Keep 2D domes visible until the VR pano is actually ready (prevents black screens on slow networks).
        try { if (dome && !dome.isEnabled()) dome.setEnabled(true); } catch {}
        try { if (dome2D?.mesh) dome2D.mesh.isVisible = true; } catch {}

        // Load/show the VR dome asynchronously, then hide 2D fallback once ready.
        try {
          const node = nodesById.get(currentNodeId);
          // Start with VR domes hidden; `setVrPano` will show the ready dome atomically.
          vrDomes.forEach((d)=>{ try{ if (d?.mesh){ d.mesh.isVisible = false; d.mesh.setEnabled(false); } }catch{} });
          if (node?.file){
            void (async()=>{
              try { await setVrPano(node.file); } catch {}
              if (token !== xrEnterToken) return;
              if (!inXR) return;
              const cur = nodesById.get(currentNodeId);
              if (cur?.file === node.file){
                xrFallback2D = false;
                try { dome.setEnabled(false); } catch {}
                try { if (dome2D?.mesh) dome2D.mesh.isVisible = false; } catch {}
              }
            })();
          }
        } catch {}
      } else if (prevHSL != null) {
        try { document.body.removeAttribute('data-xr'); } catch {}
        xrSnapTurnLatch = 0;
        xrSnapTurnCooldownUntil = 0;
        xrFallback2D = false;
        engine.setHardwareScalingLevel(prevHSL);
        // Restore 2D view, hide VR domes
        try { vrDomes.forEach(d => { if (d?.mesh) { d.mesh.isVisible = false; d.mesh.setEnabled(false); } }); } catch {}
        try { dome.setEnabled(true); } catch {}
        try { if (dome2D?.mesh) dome2D.mesh.isVisible = true; } catch {}
      }
    } catch {}
    // Only refresh if we're transitioning modes (2D->VR or VR->2D), not on repeated state changes
    if (wasInXR !== inXR) {
      refreshDomeForCurrentNode();
    }
  });
  // XR thumbstick turning: apply yaw to `worldRoot.rotation.y` so the pano rotates around the viewer.
  let xrSnapTurnLatch = 0;
  let xrSnapTurnCooldownUntil = 0;
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (!inXR) return;
      if (navAnimating) return;
      const input = xr?.baseExperience?.input;
      const controllers = Array.from(input?.controllers || []);
      const wrap = (v)=>{ const TAU=Math.PI*2; let x=v%TAU; if(x>Math.PI) x-=TAU; if(x<-Math.PI) x+=TAU; return x; };
      const dtSec = Math.max(0, Math.min(0.05, (engine?.getDeltaTime?.() || 16) / 1000));
      let bestX = 0;
      const readX = (c)=>{
        try{
          // Prefer motion-controller component axes when available.
          const mc = c?.motionController;
          const thumbstick = mc?.getComponent?.('xr-standard-thumbstick') || mc?.getComponent?.('thumbstick');
          const ax = thumbstick?.axes;
          const fromComp =
            (typeof ax?.x === 'number' ? ax.x
              : (Array.isArray(ax) ? (Number(ax[0] || 0)) : null));
          if (fromComp != null && Number.isFinite(fromComp)) return fromComp;
        }catch{}
        // Fallback: raw gamepad axes, choose the strongest axis-pair by magnitude.
        try{
          const axes = c?.inputSource?.gamepad?.axes;
          if (!axes || typeof axes.length !== 'number' || axes.length < 2) return 0;
          let best = { x: 0, y: 0, m: 0 };
          for (let i = 0; i + 1 < axes.length; i += 2){
            const x = Number(axes[i] || 0);
            const y = Number(axes[i+1] || 0);
            const m = Math.hypot(x, y);
            if (m > best.m) best = { x, y, m };
          }
          return best.x || 0;
        }catch{ return 0; }
      };
      for (const c of controllers){
        const x = readX(c);
        if (Math.abs(x) > Math.abs(bestX)) bestX = x;
      }
      // Fallback: read directly from WebXR session inputSources.
      if (Math.abs(bestX) <= XR_TURN_DEADZONE){
        try{
          const session = xr?.baseExperience?.sessionManager?.session;
          const sources = session ? Array.from(session.inputSources || []) : [];
          for (const s of sources){
            const axes = s?.gamepad?.axes;
            if (!axes || typeof axes.length !== 'number' || axes.length < 2) continue;
            let best = { x: 0, y: 0, m: 0 };
            for (let i = 0; i + 1 < axes.length; i += 2){
              const x = Number(axes[i] || 0);
              const y = Number(axes[i+1] || 0);
              const m = Math.hypot(x, y);
              if (m > best.m) best = { x, y, m };
            }
            if (Math.abs(best.x) > Math.abs(bestX)) bestX = best.x;
          }
        }catch{}
      }
      // Fallback: use the generic Gamepad API if XR controllers aren't exposed by Babylon or polyfill.
      if (Math.abs(bestX) <= XR_TURN_DEADZONE){
        try{
          const gps = (navigator && navigator.getGamepads) ? (navigator.getGamepads() || []) : [];
          for (const gp of gps){
            const axes = gp?.axes;
            if (!axes || typeof axes.length !== 'number' || axes.length < 2) continue;
            let best = { x: 0, y: 0, m: 0 };
            for (let i = 0; i + 1 < axes.length; i += 2){
              const x = Number(axes[i] || 0);
              const y = Number(axes[i+1] || 0);
              const m = Math.hypot(x, y);
              if (m > best.m) best = { x, y, m };
            }
            if (Math.abs(best.x) > Math.abs(bestX)) bestX = best.x;
          }
        }catch{}
      }
      bestX = (Number(bestX) || 0) * (Number(XR_TURN_SIGN) || 1);
      if (Math.abs(bestX) <= XR_TURN_DEADZONE) return;
      const nowMs = performance.now();
      const SNAP_THRESHOLD = 0.82;
      const SNAP_RELEASE = 0.35;
      const SNAP_STEP_RAD = (30 * Math.PI / 180);
      let snapped = false;
      if (Math.abs(bestX) >= SNAP_THRESHOLD){
        const dir = Math.sign(bestX) || 0;
        if (dir && (dir !== xrSnapTurnLatch) && (nowMs >= (xrSnapTurnCooldownUntil || 0))){
          xrSnapTurnLatch = dir;
          xrSnapTurnCooldownUntil = nowMs + 220;
          worldYaw = wrap((Number(worldYaw) || 0) + (dir * SNAP_STEP_RAD));
          snapped = true;
        }
      } else if (Math.abs(bestX) <= SNAP_RELEASE) {
        xrSnapTurnLatch = 0;
      }
      if (!snapped){
        const s = Math.sign(bestX);
        const mag = (Math.abs(bestX) - XR_TURN_DEADZONE) / Math.max(1e-6, (1 - XR_TURN_DEADZONE));
        const scaled = s * Math.max(0, Math.min(1, mag));
        worldYaw = wrap((Number(worldYaw) || 0) + (scaled * XR_TURN_SPEED_RAD_PER_SEC * dtSec));
      }
      worldRoot.rotation.y = worldYaw;
    }catch{}
  });
  try { addEventListener('ui:exit', async ()=>{ try{ await xr?.baseExperience?.exitXRAsync?.(); }catch{} }); } catch {}
  // In XR mode, we allow smooth travel during autoplay (no auto-rotation).
  function computeViewerPose(){
    // Report pose relative to the panorama orientation (pano yaw is baked into worldRoot.rotation.y)
    const panoYaw = worldRoot?.rotation?.y || 0;
    const wrap = (v)=>{ const TAU=Math.PI*2; let x=v%TAU; if(x>Math.PI) x-=TAU; if(x<-Math.PI) x+=TAU; return x; };
    if (inXR && xr?.baseExperience?.camera){
      try{
        // In WebXR, use the actual eye camera when available (rigCameras[0] = left eye).
        // This avoids basis differences between WebXRCamera vs FreeCamera forward vectors.
        const xrCam = xr.baseExperience.camera;
        const eyeCam = (xrCam?.rigCameras && xrCam.rigCameras[0]) ? xrCam.rigCameras[0] : xrCam;
        try{ eyeCam?.computeWorldMatrix?.(true); }catch{}
        const q =
          eyeCam?.absoluteRotationQuaternion ||
          eyeCam?.rotationQuaternion ||
          xrCam?.absoluteRotationQuaternion ||
          xrCam?.rotationQuaternion ||
          null;
        if (q && typeof q.toEulerAngles === "function"){
          const e = q.toEulerAngles();
          const yaw = wrap((e?.y || 0) - panoYaw);
          const pitch = (e?.x || 0);
          const roll = (e?.z || 0);
          return { yaw, pitch, roll, mode: 'xr' };
        }
      }catch{}
      // Fallback: derive yaw/pitch from the camera forward vector.
      const dir = xr.baseExperience.camera.getForwardRay().direction;
      const yaw = wrap(Math.atan2(-dir.x, -dir.z) - panoYaw);
      const pitch = Math.asin(dir.y);
      return { yaw, pitch, roll: 0, mode: 'xr' };
    }
    // For 2D mode, align pitch sign with mirror expectations
    return { yaw: wrap(cam.rotation.y - panoYaw), pitch: cam.rotation.x, roll: 0, mode: '2d' };
  }

  /* WebSocket: follow Guide (primary + fallback) */
  // Default: viewer controls their own look. Opt-in via ?followYaw=1 only.
  const IGNORE_GUIDE_YAW = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const q = (qs.get('followYaw')||'').toLowerCase();
      if (q === '1' || q === 'true' || q === 'yes') return false;
      
    }catch{}
    return true;
  })();
  function toWs(url){ try{ if(!url) return null; const s=String(url); return s.replace(/^http(s?):/i, 'ws$1:'); }catch{ return url; } }
  const WS_PRIMARY = toWs(import.meta?.env?.VITE_WS_URL || "wss://vrsync.dev.opensky.co.in/");
  const WS_FALLBACK = toWs(import.meta?.env?.VITE_WS_URL_SECONDARY || import.meta?.env?.VITE_WS_FALLBACK || "https://22abcd9c-f607-41d5-9109-203a6cf0b79e-00-3nw6aihj3adm4.sisko.replit.dev/");
  function expandWs(u){
    if (!u) return [];
    try{
      const url=new URL(u);
      const list=[u];
      const hasPath = url.pathname && url.pathname !== '/' && url.pathname !== '';
      if (!hasPath){ list.push((u.endsWith('/')?u.slice(0,-1):u)+"/ws"); }
      return list;
    }catch{ return [u]; }
  }
  const WS_LIST = Array.from(new Set([ ...expandWs(WS_PRIMARY), ...expandWs(WS_FALLBACK) ].filter(Boolean)));
  let socket = null; let wsOpen=false; let lastPoseT=0; let poseObs=null; let wsIndex=0; let wsLockedIdx=-1;
  let lastGuideSeq = 0;
  let xrNavToken = 0;
  (function connect(){
    let retryMs=2000;
    const idx = (wsLockedIdx>=0 ? wsLockedIdx : (wsIndex % WS_LIST.length));
    const url = WS_LIST[idx];
    console.log('[VIEWER] Connecting to WebSocket:', url);
    try { socket = new WebSocket(url); } catch(e) { console.warn('[VIEWER] WebSocket create failed:', e); socket = null; if (wsLockedIdx<0) wsIndex=(wsIndex+1)%WS_LIST.length; return setTimeout(connect, retryMs); }
    let opened=false; const OPEN_TIMEOUT_MS=3500; const to=setTimeout(()=>{ if(!opened){ console.warn('[VIEWER] WebSocket timeout'); try{ socket?.close(); }catch{} } }, OPEN_TIMEOUT_MS);
    socket.addEventListener("open", () => { opened=true; clearTimeout(to); wsOpen=true; retryMs=2000; wsLockedIdx = idx; console.log('[VIEWER] WebSocket connected, joining room:', roomId); try { socket?.send(JSON.stringify({ type: "join", room: roomId, role: "viewer", uid })); } catch(e) { console.error('[VIEWER] Join send failed:', e); } });
    function schedule(reason){
      clearTimeout(to);
      wsOpen=false;
      console.warn('[VIEWER] WebSocket disconnected:', reason);
      try{ socket?.close(); }catch{};
      // On failure, rotate to the next endpoint instead of staying locked
      wsLockedIdx = -1;
      wsIndex = (wsIndex+1) % WS_LIST.length;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs*1.7, 15000);
    }
    socket.addEventListener("close", ()=>schedule('close'));
    socket.addEventListener("error", (e)=>{ console.error('[VIEWER] WebSocket error:', e); schedule('error'); });
    socket.addEventListener("message", async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type !== "sync" || msg.room !== roomId) return;
      // Ignore out-of-order guide messages when seq is present.
      const seq = Number(msg?.seq);
      if (Number.isFinite(seq) && seq > 0) {
        if (seq < lastGuideSeq) return;
        lastGuideSeq = seq;
      }
      const nextExpValue = msg.expPath ?? msg.exp;
      if (nextExpValue) {
        const nextPath = ensureExpPath(nextExpValue);
        if (`${BASE_URL}${nextPath}` !== BASE) {
          expPath = nextPath; BASE = `${BASE_URL}${expPath}`.replace(/\/{2,}/g, "/");
          PANOS_DIR = 'panos';
          ({ data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`));
          // Reset zone tracking for new experience
          lastDisplayedZoneId = null;
          // Track experience change for analytics
          try { trackExperience(expSlug(), expSlug()); } catch {}
          // Dispose old textures when switching experience
          try{ for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} } texCache.clear(); }catch{}
          vrReadyFile = null; vrWarmPromise = null; vrWarmTarget = null;
          // Clear dome state so they get recreated with correct stereo mode for new experience
          try{ vrDomes.forEach((d, i) => { if (d){ d.__panoFile = null; } vrDomeModes[i] = null; }); }catch{}
          rebuildFloorMaps();
          // CRITICAL FIX: Refresh panorama after experience change to prevent black screen
          // If agent's current node exists in new experience, load it; otherwise load start node
          const targetNodeId = (msg.nodeId && nodesById.has(msg.nodeId)) ? msg.nodeId : startNodeId;
          if (targetNodeId && nodesById.has(targetNodeId)) {
            currentNodeId = targetNodeId;
            const node = nodesById.get(targetNodeId);
            // Update zone display for new experience
            checkAndShowZone(node);
            // Refresh both 2D and VR views
            try { await refreshPreferKtx2Effective(node?.file); } catch {}
            try { await maybeSelectMobilePanoDir(); } catch {}
            await refreshDomeForCurrentNode();
            // If in VR, also refresh VR dome immediately
            if (inXR && node?.file) {
              try { await setVrPano(node.file); } catch (e) { console.error('[VIEWER] VR pano refresh failed:', e); }
            }
          }
        }
      }
      const applyGuideYaw = ()=>{
        // Rotation disabled: flythrough-only navigation across all modes.
      };
      const applyGuidePos = ()=>{
        if (!inXR && Array.isArray(msg.worldPos) && msg.worldPos.length === 3) {
          worldRoot.position.copyFrom(new Vector3(msg.worldPos[0], msg.worldPos[1], msg.worldPos[2]));
        }
      };
      if (msg.nodeId && nodesById.has(msg.nodeId)) {
        const nextNodeId = msg.nodeId;
        const prevNodeId = currentNodeId;
        const isNewNode = nextNodeId !== prevNodeId;
        const prevNode = nodesById.get(prevNodeId);
        const node = nodesById.get(nextNodeId);
        if (!node) return;
        applyGuideYaw();
        if (!isNewNode) {
          applyGuidePos();
          return;
        }
        currentNodeId = nextNodeId;
        // Show cinematic zone name overlay when entering a new zone
        checkAndShowZone(node);
        // Track node visit for analytics
        try {
          const zone = data?.zones?.find(z => z.id === node.zoneId);
          trackNodeVisit(node.id, node.file, node.zoneId, zone?.name || node.zoneId);
        } catch {}
          if (inXR) {
            // PRELOAD FIRST: Start preloading neighbors BEFORE we navigate
            // This way the next pano is already loading when agent moves again
            preloadForVR(node);

            const token = ++xrNavToken;
            await Promise.allSettled([
              setVrPano(node.file),
              animateTravelXR(prevNode, node)
            ]);
            if (token !== xrNavToken) return;
            worldYaw = worldRoot.rotation.y;
          } else {
            // Apply a smooth 2D travel + crossfade like Agent
            try {
              await forwardPushThenSwap(node, prevNode, {});
          } catch {
            await refreshDomeForCurrentNode();
          }
        }
      } else {
        applyGuideYaw();
        applyGuidePos();
      }
    });
    if (poseObs) { try { scene.onBeforeRenderObservable.remove(poseObs); } catch {} }
    // Helper for angular difference
    const aDelta = (a,b)=>{ const TAU=Math.PI*2; let d=(a-b)%TAU; if(d>Math.PI) d-=TAU; if(d<-Math.PI) d+=TAU; return Math.abs(d); };
    let lastSentYaw=0, lastSentPitch=0, lastSentRoll=0, lastSentMs=0;
    poseObs = scene.onBeforeRenderObservable.add(()=>{
      const now = performance.now();
      // OPTIMIZED: 10Hz (~100ms) for low bandwidth
      if (now - lastPoseT <= 100) return;
      const ready = !!(socket && socket.readyState === 1);
      if (!ready) { lastPoseT = now; return; }
      // Stream viewer pose with quantization and change detection
      try {
        const q = (v, step) => Math.round(v / step) * step;
        const pose = computeViewerPose();
        // Quantize to reduce sensor noise jitter
        pose.yaw   = q(pose.yaw,   0.005); // ~0.29ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°
        pose.pitch = q(pose.pitch, 0.005);
        if (typeof pose.roll === "number") pose.roll = q(pose.roll, 0.005);
        // Send only if meaningful change or periodic keepalive
        const MIN_DELTA = 0.0087; // ~0.5ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°
        const KEEPALIVE_MS = 1000;
        const roll = (typeof pose.roll === "number") ? pose.roll : 0;
        const changed = (aDelta(pose.yaw, lastSentYaw) >= MIN_DELTA) || (aDelta(pose.pitch, lastSentPitch) >= MIN_DELTA) || (aDelta(roll, lastSentRoll) >= MIN_DELTA);
        const needKeepAlive = (now - lastSentMs) >= KEEPALIVE_MS;
        if (changed || needKeepAlive){
          const payload = { type: "sync", room: roomId, from: "viewer", uid, nodeId: currentNodeId, pose };
          socket.send(JSON.stringify(payload));
          lastSentYaw = pose.yaw; lastSentPitch = pose.pitch; lastSentRoll = roll; lastSentMs = now;
        }
      } catch {}
      lastPoseT = now;
    });
  })();

  /* Start */
  const start = nodesById.get(startNodeId);
  currentNodeId = start.id;
  worldRoot.position.copyFrom(nodeWorldPos(start));
  worldRoot.rotation.y = 0;
  try { await refreshPreferKtx2Effective(start?.file); } catch {}
  try { await maybeSelectMobilePanoDir(); } catch {}
  await refreshDomeForCurrentNode();

  // Show initial zone name with a slight delay for cinematic effect (after image loads)
  setTimeout(() => {
    lastDisplayedZoneId = null; // Reset so starting zone always shows
    checkAndShowZone(start);
  }, 500);

  // Track initial experience and node for analytics
  try {
    trackExperience(expSlug(), expSlug());
    const startZone = data?.zones?.find(z => z.id === start.zoneId);
    trackNodeVisit(start.id, start.file, start.zoneId, startZone?.name || start.zoneId);
    console.log('[VIEWER] Analytics initialized for:', expSlug());
  } catch (e) { console.warn('[VIEWER] Analytics init error:', e); }

  worldYaw = worldRoot.rotation.y;

  engine.runRenderLoop(() => scene.render());
  const scheduleResize = (() => {
    let raf = 0;
    return () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try { engine.resize(); } catch {}
      });
    };
  })();
  try {
    addEventListener("resize", scheduleResize, { passive: true });
    addEventListener("orientationchange", () => setTimeout(scheduleResize, 50), { passive: true });
    window.visualViewport?.addEventListener?.("resize", scheduleResize, { passive: true });
    window.visualViewport?.addEventListener?.("scroll", scheduleResize, { passive: true });
    addEventListener("app:viewport", scheduleResize, { passive: true });
  } catch {}
  scheduleResize();
  return {};
}

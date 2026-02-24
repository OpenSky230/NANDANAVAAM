// 2D stays mono (cropped if the source is TB). XR uses true TB stereo via PhotoDome.

import {
  Engine, Scene, FreeCamera, WebXRState, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode, Color3, PointerEventTypes, Viewport, Ray
} from "@babylonjs/core";
import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import "@babylonjs/loaders";
import { PhotoDome } from "@babylonjs/core/Helpers/photoDome";
import { loadWalkthrough } from "./walkthrough-data.js";
import { buildMinimapDOM } from "./minimap-dom.js";
import { 
  getAnalytics, trackNodeVisit, trackExperience, trackXRMode, 
  trackHotspot, trackInteraction, getAnalyticsSummary 
} from "./analytics.js";

/* logs */
function LOG(){ try{ console.log.apply(console, arguments); }catch{} }
function stamp(){ return new Date().toISOString().split("T")[1].slice(0,12); }
function A(tag, obj){ LOG("[AGENT]", stamp(), tag, obj||""); }

/* constants */
const DEFAULT_FLIP_U = true;  // Mirror U so pano appears correct L/R on domes
const DEFAULT_FLIP_X = true;  // Apply 180deg X-rotation to keep panos upright in the dome
const DOME_DIAMETER = 2000, FLOOR_HEIGHT_M = 3.0;
const DOME_RADIUS = (DOME_DIAMETER / 2) * 0.98;
// Optimized transition duration for seamless VR experience
const NAV_DUR_MS = 600, NAV_PUSH_M = 3.0;
// Default: invert yaw but keep pitch aligned to viewer for mirror feeds
let MIRROR_YAW_SIGN = 1; // Set to 1 so mirror matches viewer direction
let MIRROR_PITCH_SIGN = 1; // Set to 1 so pitch matches viewer direction
const XR_DEBUG_PARAM = (()=>{ try{ return new URLSearchParams(location.search).has('xrdebug'); }catch{ return false; } })();
const XRDebugLog = (...args)=>{ if (XR_DEBUG_PARAM){ try{ console.log("[XRDEBUG]", ...args); }catch{} } };
// Unlock audio on platforms that require user interaction
let _ac = null; let _audioUnlocked = false;
async function unlockAudio(){
  try{
    if (_audioUnlocked) return true;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { _audioUnlocked = true; return true; }
    if (!_ac) _ac = new AC();
    if (_ac.state === 'suspended') { try { await _ac.resume(); } catch {} }
    const o = _ac.createOscillator(); const g = _ac.createGain(); g.gain.value = 0.00001; o.connect(g).connect(_ac.destination); o.start(); o.stop(_ac.currentTime + 0.02);
    _audioUnlocked = true; return true;
  }catch{ _audioUnlocked = false; return false; }
}
try{ window.unlockAudio = unlockAudio; }catch{}

/* env */
let BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
function toWs(url){ try{ if(!url) return null; const s=String(url); return s.replace(/^http(s?):/i, 'ws$1:'); }catch{ return url; } }
const WS_PRIMARY = toWs(import.meta?.env?.VITE_WS_URL || "wss://vrsync.dev.opensky.co.in/");
const WS_FALLBACK = toWs(import.meta?.env?.VITE_WS_URL_SECONDARY || import.meta?.env?.VITE_WS_FALLBACK || "https://22abcd9c-f607-41d5-9109-203a6cf0b79e-00-3nw6aihj3adm4.sisko.replit.dev/");
function expandWs(u){ if(!u) return []; try{ const url=new URL(u); const list=[u]; const hasPath=url.pathname && url.pathname!=='/' && url.pathname!==''; if(!hasPath){ list.push((u.endsWith('/')?u.slice(0,-1):u)+"/ws"); } return list; }catch{ return [u]; } }

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

// WebP support
const SUPPORTS_WEBP = (() => { try { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1; } catch { return false; } })();
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
  // Default ON (disable with `?ktx2=0` if needed).
  return true;
})();
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

const rad = d => d*Math.PI/180;
const wrapRad = (v)=>{
  const TAU = Math.PI * 2;
  let x = Number(v) || 0;
  x = x % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
};
const v3arr = v => [v.x,v.y,v.z];
const expNameFrom = base => { const p=base.split("/").filter(Boolean); return p[p.length-1]||"clubhouse"; };
const UA = (navigator.userAgent || "").toLowerCase();
const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
const IS_ANDROID = /android/.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID || /mobile/.test(UA);
const IS_PHONE = (() => {
  try {
    if (!IS_MOBILE) return false;
    const w = Math.max(0, Number(window.innerWidth) || 0, Number(document.documentElement?.clientWidth) || 0, Number(screen?.width) || 0);
    const h = Math.max(0, Number(window.innerHeight) || 0, Number(document.documentElement?.clientHeight) || 0, Number(screen?.height) || 0);
    return Math.min(w, h) > 0 && Math.min(w, h) <= 820;
  } catch { return false; }
})();
const CROSSFADE_MODE = (import.meta?.env?.VITE_CROSSFADE || 'auto').toLowerCase();
function wantsCrossfade(){ if (CROSSFADE_MODE==='on') return true; if (CROSSFADE_MODE==='off') return false; return !IS_IOS; }

// Ultra-slow auto-rotation during autoplay (XR comfort)
const AUTO_ROTATE_ENABLED = String(import.meta?.env?.VITE_TOUR_AUTO_ROTATE ?? '0') !== '0';
const AUTO_ROTATE_ALLOW_2D = String(import.meta?.env?.VITE_TOUR_AUTO_ROTATE_2D ?? '0') !== '0';
const AUTO_ROTATE_ALLOW_XR = String(import.meta?.env?.VITE_TOUR_AUTO_ROTATE_XR ?? '0') !== '0';
const AUTO_ROTATE_RATE_DPS = Math.max(0, Number(import.meta?.env?.VITE_TOUR_AUTO_ROTATE_DPS) || 0.15);
const AUTO_ROTATE_RATE_RPS = AUTO_ROTATE_RATE_DPS * Math.PI / 180;
const AUTO_ROTATE_REFRESH_MS = Math.max(500, Number(import.meta?.env?.VITE_TOUR_AUTO_ROTATE_REFRESH_MS) || 1600);
const VR_PANO_LOAD_TIMEOUT_MS = Math.max(6000, Number(import.meta?.env?.VITE_VR_PANO_TIMEOUT_MS) || 45000);
const VR_PANO_PROBE_TIMEOUT_MS = Math.max(400, Number(import.meta?.env?.VITE_VR_PANO_PROBE_TIMEOUT_MS) || 1200);

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

function remapFor2DWhenReady(scene, tex, getIsStereo, flipUValue, isStillUsed) {
  if (!scene || !tex) return;
  let tries = 0;
  const obs = scene.onBeforeRenderObservable.add(() => {
    try {
      if (typeof isStillUsed === "function" && !isStillUsed(tex)) {
        try { scene.onBeforeRenderObservable.remove(obs); } catch {}
        return;
      }
      tries++;
      try { mapFor2D(tex, /*stereo*/ (typeof getIsStereo === "function" ? !!getIsStereo() : false), !!flipUValue); } catch {}
      const sz = tex.getBaseSize?.() || tex.getSize?.();
      const w = Number(sz?.width) || Number(tex?._texture?.baseWidth) || Number(tex?._texture?.width) || 0;
      const h = Number(sz?.height) || Number(tex?._texture?.baseHeight) || Number(tex?._texture?.height) || 0;
      if ((w > 0 && h > 0) || tries >= 6) {
        try { scene.onBeforeRenderObservable.remove(obs); } catch {}
      }
    } catch {
      try { scene.onBeforeRenderObservable.remove(obs); } catch {}
    }
  });
}

/* 2D texture mapping (mono crop for TB stereo)
   - For stereo experiences, we still render a mono view in 2D by sampling a single eye.
   - Some pipelines pack TB stereo into different aspect ratios (square, tall-rotated, or "squashed" 2:1).
   - Here we auto-detect those shapes from the texture size and decide whether to crop. */
function mapFor2D(tex, stereo, flipU){
  if (!tex) return;
  tex.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;
  tex.uScale  = flipU ? -1 : 1;
  tex.uOffset = flipU ?  1 : 0;

  let vScale  = -1.0;
  let vOffset = 1.0;

  let shouldCrop = false;
  let cropSlices = 2;
  let sliceIndex = (STEREO_2D_HALF === "bottom") ? 1 : 0;
  try{
    const sz = tex.getBaseSize?.() || tex.getSize?.();
    const w = Number(sz?.width) || Number(tex?._texture?.baseWidth) || Number(tex?._texture?.width) || 0;
    const h = Number(sz?.height) || Number(tex?._texture?.baseHeight) || Number(tex?._texture?.height) || 0;
    if (w > 0 && h > 0){
      const ratioHW = h / w;
      const tallByShape = ratioHW > 1.3; // typical TB stereo: h≈2w
      if (stereo){
        const nearSquare        = Math.abs(ratioHW - 1) < 0.15; // e.g. 6000x6000
        const tallTopBottom     = ratioHW > 1.7;                // e.g. 2048x4096 rotated TB or true TB
        const squashedTopBottom = ratioHW < 0.6;                // e.g. TB stereo packed into 2:1
        shouldCrop = nearSquare || tallTopBottom || squashedTopBottom;
      } else {
        // If metadata missed the stereo flag, still crop tall TB sources in 2D.
        shouldCrop = tallByShape;
      }

      if (ratioHW > 0.8){
        const inferred = Math.round(2 * ratioHW);
        if (Number.isFinite(inferred) && inferred >= 2) cropSlices = Math.max(2, Math.min(inferred, 6));
      }
      sliceIndex = Math.min(Math.max(sliceIndex, 0), cropSlices - 1);
    } else if (stereo) {
      shouldCrop = true;
    }
  }catch{
    if (stereo) shouldCrop = true;
  }

  if (shouldCrop){
    vScale  = -1 / cropSlices;
    vOffset = (sliceIndex + 1) / cropSlices;
  }

  tex.vScale  = vScale;
  tex.vOffset = vOffset;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  // aniso set when texture is created based on quality profile
}

function createMetaLookup(list = []){
  const map = new Map();
  for (const entry of list){
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id) map.set(id, entry);
  }
  return map;
}

export async function initAgent(opts = {}){
  const roomId = (opts.roomId && String(opts.roomId).trim()) || "demo";
  const exp    = (opts.exp    && String(opts.exp).trim()) || "clubhouse";
  const experiencesMeta = Array.isArray(opts.experiencesMeta) ? opts.experiencesMeta : [];
  const metaById = createMetaLookup(experiencesMeta);
  const resolveMetaConfig = (expId) => {
    const meta = metaById.get(String(expId || "").trim());
    return {
      flipU: typeof meta?.flipU === "boolean" ? meta.flipU : DEFAULT_FLIP_U,
      flipX: typeof meta?.flipX === "boolean" ? meta.flipX : DEFAULT_FLIP_X,
      startFaceHotspot: typeof meta?.startFaceHotspot === "boolean" ? meta.startFaceHotspot : true,
      hotspotNavTags: typeof meta?.hotspotNavTags === "boolean" ? meta.hotspotNavTags : false,
    };
  };
  // Back-compat alias used by existing code paths.
  const resolveFlipConfig = resolveMetaConfig;
  let { flipU, flipX, startFaceHotspot, hotspotNavTags } = resolveMetaConfig(exp);
  try {
    window.__nandanavanamDebug = window.__nandanavanamDebug || {};
    window.__nandanavanamDebug.getExpMeta = () => {
      const id = (() => { try { return expName?.(); } catch { return ""; } })();
      const meta = (() => { try { return metaById.get(id) || null; } catch { return null; } })();
      return { exp: id, flipU, flipX, hotspotNavTags, stereo: Boolean(meta?.stereo), meta };
    };
    window.__nandanavanamDebug.getAgentTex = () => {
      const node = currentNode();
      const tex = domeMat?.emissiveTexture || null;
      const sz = tex ? (tex.getBaseSize?.() || tex.getSize?.() || null) : null;
      const w = tex ? (Number(sz?.width) || Number(tex?._texture?.baseWidth) || Number(tex?._texture?.width) || 0) : 0;
      const h = tex ? (Number(sz?.height) || Number(tex?._texture?.baseHeight) || Number(tex?._texture?.height) || 0) : 0;
      return {
        exp: (() => { try { return expName?.(); } catch { return ""; } })(),
        file: node?.file,
        stereoHalf: STEREO_2D_HALF,
        w, h,
        uScale: tex?.uScale, uOffset: tex?.uOffset,
        vScale: tex?.vScale, vOffset: tex?.vOffset,
      };
    };
  } catch {}

  let data, nodesById, startNodeId;
  let currentNodeId = null;
  const currentNode = () => (nodesById && currentNodeId ? nodesById.get(currentNodeId) : null);

  let BASE = (BASE_URL + "experiences/" + exp).replace(/\/{2,}/g,"/");
  let PANOS_DIR = "panos";
  const preferKtx2ByExp = new Map(); // expId -> boolean
  let preferKtx2Effective = PREFER_KTX2;
  const expName  = () => expNameFrom(BASE);
  const experienceIds = (() => {
    try {
      const list = Array.isArray(experiencesMeta) ? experiencesMeta : [];
      return list.map((e) => String(e?.id || "").trim()).filter(Boolean);
    } catch { return []; }
  })();
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
  const isStereo = () => {
    const meta = metaById.get(expName()) || {};
    const node = currentNode();
    if (typeof node?.stereo === "boolean") return node.stereo;
    if (node && matchesStereoPanos(node, meta?.stereoPanos)) return true;
    return Boolean(meta?.stereo);
  };
  async function refreshPreferKtx2Effective(expId, sampleFile){
    const id = String(expId || "").trim();
    if (!id) return;
    if (!PREFER_KTX2) { preferKtx2Effective = false; preferKtx2ByExp.set(id, false); return; }
    if (preferKtx2ByExp.has(id)) { preferKtx2Effective = preferKtx2ByExp.get(id); return; }

    const file = String(sampleFile || "").trim();
    if (!file) { preferKtx2Effective = PREFER_KTX2; preferKtx2ByExp.set(id, preferKtx2Effective); return; }

    const ktxCandidate = chooseFile(file, /*preferOriginal*/ false, /*preferKtx2*/ true);
    if (!/\.ktx2$/i.test(ktxCandidate) || ktxCandidate === file) {
      preferKtx2Effective = true;
      preferKtx2ByExp.set(id, true);
      return;
    }

    const url = (BASE + "/" + PANOS_DIR + "/" + ktxCandidate).replace(/\/{2,}/g, "/");
    const probeTimeoutMs = Math.max(2000, VR_PANO_PROBE_TIMEOUT_MS);
    let ok = false;
    try { ok = await urlExistsFast(url, { timeoutMs: probeTimeoutMs }); } catch {}
    if (!ok) {
      // If the KTX2 probe fails for transient reasons (timeout, HEAD blocked), avoid disabling KTX2 globally.
      // Only disable when the original file is reachable but the KTX2 variant is not.
      try{
        const origCandidate = chooseFile(file, /*preferOriginal*/ true, /*preferKtx2*/ false);
        const origUrl = (BASE + "/" + PANOS_DIR + "/" + origCandidate).replace(/\/{2,}/g, "/");
        const origOk = await urlExistsFast(origUrl, { timeoutMs: probeTimeoutMs });
        ok = !origOk; // if original exists but ktx doesn't -> disable; else keep KTX2
      }catch{
        ok = true;
      }
    }
    preferKtx2Effective = !!ok;
    preferKtx2ByExp.set(id, preferKtx2Effective);
  }

  // Always use WebP panos (JPG files removed, WebP optimized for all experiences)
  const panoPath = (dir, file) => {
    const out = (BASE + "/" + dir + "/" + chooseFile(file, false, preferKtx2Effective)).replace(/\/{2,}/g,"/");
    try{ return encodeURI(out); }catch{ return out; }
  };
  const panoPathKtx2 = (dir, file) => {
    const out = (BASE + "/" + dir + "/" + chooseFile(file, false, /*preferKtx2*/ true)).replace(/\/{2,}/g,"/");
    try{ return encodeURI(out); }catch{ return out; }
  };
  const panoPathOriginal = (dir, file) => {
    const out = (BASE + "/" + dir + "/" + chooseFile(file, true, preferKtx2Effective)).replace(/\/{2,}/g,"/");
    try{ return encodeURI(out); }catch{ return out; }
  };
  const panoUrl  = file => panoPath(PANOS_DIR, file);
  const panoUrlKtx2 = file => panoPathKtx2(PANOS_DIR, file);
  const panoUrlOriginal = file => panoPathOriginal(PANOS_DIR, file);
  const WS_LIST = Array.from(new Set([ ...expandWs(WS_PRIMARY), ...expandWs(WS_FALLBACK) ].filter(Boolean)));
  A("init", { roomId, exp:expName(), BASE, ws: WS_LIST });

  

  /* engine/scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true, {
    disableWebGL2Support: IS_IOS,
    powerPreference: IS_IOS ? "low-power" : "high-performance",
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
    }
  }catch{}
  try{
    // Force HQ on request; allow low quality to cap DPR at 1 for speed
    function determineDpr(){
      const qs = new URLSearchParams(location.search);
      const qOverride = (qs.get('q')||'').toLowerCase();
      const forceHQ = (qs.get('hq') === '1') || (String(import.meta?.env?.VITE_FORCE_HQ||'')==='1') || (qOverride==='high');
      const forceLow = (qOverride==='low');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let cap = forceHQ ? 3 : 2;
      if (forceLow) cap = 1;
      const target = Math.min(cap, dpr);
      return IS_IOS ? Math.min(1.2, target) : target;
    }
    engine.setHardwareScalingLevel(1 / determineDpr());
  }catch{}

  function getQuality(){
    try{
      const qs = new URLSearchParams(location.search);
      const override = (qs.get('q') || import.meta?.env?.VITE_QUALITY || 'auto').toLowerCase();
      if (override==='high' || override==='auto') return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso: IS_IOS ? 4 : 8 };
      if (override==='low')  return { mips:false, sampling:Texture.BILINEAR_SAMPLINGMODE, aniso:1 };
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType||'').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      const mem = Number(navigator.deviceMemory || 4);
      if (slow || mem <= 2) return { mips:false, sampling:Texture.BILINEAR_SAMPLINGMODE, aniso:1 };
      return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso: IS_IOS ? 4 : 8 };
    }catch{ return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso: IS_IOS ? 4 : 8 }; }
  }
  const scene  = new Scene(engine);
  scene.clearColor = new Color4(0,0,0,1);
  try { window.scene = scene; } catch {}

  const cam = new FreeCamera("cam", new Vector3(0,0,0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  // Render both layers in 2D (main + guide). XR camera will be forced to 0x1.
  cam.fov=1.1; cam.minZ=0.1; cam.maxZ=50000; cam.layerMask=0x3;
  scene.activeCamera = cam;

  /* data */
  try{ window.dispatchEvent(new CustomEvent('loading:show', { detail:{ label: 'Loading tour…' } })); }catch{}
  ({ data, nodesById, startNodeId } = await loadWalkthrough((BASE + "/walkthrough.json").replace(/\/{2,}/g,"/")));
  try{ window.dispatchEvent(new CustomEvent('loading:hide')); }catch{}
  currentNodeId = startNodeId;
  const experienceDataCache = new Map();
  const zoneOrderCache = new Map(); // expId -> Promise<string[]|null>
  // VR mirror preview state (used to prevent texture eviction while in use)
  let mirrorNodeId = null;
  let mirrorTexKey = null;
  let mirrorTexturePinned = false;

  /* ===== Cinematic Zone Name Overlay (DISABLED) ===== */
  let lastDisplayedZoneId = null;
  function showZoneOverlay(zoneName) { /* disabled */ }
  function checkAndShowZone(node) { /* disabled */ }

  function cloneHotspots(list){
    if (!Array.isArray(list)) return [];
    return list.map(h => ({
      to: h?.to,
      type: h?.type || "walk",
      yaw: typeof h?.yaw === 'number' ? h.yaw : 0,
      pitch: typeof h?.pitch === 'number' ? h.pitch : 0,
      absYaw: typeof h?.absYaw === 'number' ? h.absYaw : undefined,
      absPitch: typeof h?.absPitch === 'number' ? h.absPitch : undefined,
      dir: Array.isArray(h?.dir) ? h.dir.slice(0, 3) : undefined,
      uv: Array.isArray(h?.uv) ? h.uv.slice(0, 2) : undefined,
    }));
  }
  function cloneNodeDeep(node){
    if (!node) return null;
    return {
      id: node.id,
      file: node.file,
      floorId: node.floorId,
      x: node.x,
      y: node.y,
      z: node.z,
      yaw: node.yaw,
      zoneId: node.zoneId,
      name: node.name,
      label: node.label,
      hotspots: cloneHotspots(node.hotspots),
    };
  }
  function cloneZoneDeep(zone){
    if (!zone) return null;
    return {
      id: zone.id,
      name: zone.name,
      floorId: zone.floorId,
      repNodeId: zone.repNodeId,
      points: Array.isArray(zone.points) ? zone.points.map(p => ({ x: p.x, y: p.y })) : [],
    };
  }
  function cloneExperienceData(payload){
    if (!payload) return null;
    const src = payload.data || {};
    return {
      expId: payload.expId || expName(),
      zoneOrder: Array.isArray(payload.zoneOrder) ? payload.zoneOrder.slice() : null,
      startNodeId: src.startNodeId ?? payload.startNodeId ?? null,
      floors: Array.isArray(src.floors) ? src.floors.map(f => ({ ...f })) : [],
      nodes: Array.isArray(src.nodes) ? src.nodes.map(cloneNodeDeep) : [],
      zones: Array.isArray(src.zones) ? src.zones.map(cloneZoneDeep) : [],
    };
  }
  function rememberExperience(expId, pack){
    if (!expId || !pack) return;
    experienceDataCache.set(expId, {
      expId,
      base: pack.base ?? (BASE_URL + "experiences/" + expId).replace(/\/{2,}/g,"/"),
      data: pack.data,
      nodesById: pack.nodesById,
      startNodeId: pack.startNodeId ?? pack.data?.startNodeId ?? null,
      zoneOrder: Array.isArray(pack.zoneOrder) ? pack.zoneOrder.slice() : null,
    });
  }

  async function loadZoneOrderFor(expId, base){
    const key = String(expId || "").trim();
    if (!key) return null;
    if (zoneOrderCache.has(key)) return zoneOrderCache.get(key);
    const p = (async()=>{
      try{
        const url = `${String(base || "").replace(/\/+$/g,"")}/zone-order.json`.replace(/\/{2,}/g,"/");
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) return null;
        const json = await res.json();
        const list = Array.isArray(json) ? json : (Array.isArray(json?.zoneOrder) ? json.zoneOrder : null);
        if (!Array.isArray(list) || !list.length) return null;
        const out = [];
        for (const item of list){
          const id = typeof item === "string" ? item.trim() : "";
          if (id) out.push(id);
        }
        return out.length ? out : null;
      }catch{
        return null;
      }
    })();
    zoneOrderCache.set(key, p);
    return p;
  }

  function applyZoneOrderToData(targetData, zoneOrder){
    try{
      const zones = Array.isArray(targetData?.zones) ? targetData.zones : null;
      const order = Array.isArray(zoneOrder) ? zoneOrder : null;
      if (!zones || !zones.length || !order || !order.length) return;
      const idxById = new Map();
      for (let i = 0; i < order.length; i++){
        const id = typeof order[i] === "string" ? order[i].trim() : "";
        if (id && !idxById.has(id)) idxById.set(id, i);
      }
      targetData.zones = zones
        .map((z, i)=>({ z, i, o: idxById.has(String(z?.id || "")) ? idxById.get(String(z?.id || "")) : Number.POSITIVE_INFINITY }))
        .sort((a,b)=>(a.o-b.o)||(a.i-b.i))
        .map(x=>x.z);
    }catch{}
  }

  // Apply optional zone ordering for bottom zone bar + autoplay (if present in this experience folder).
  const initialZoneOrder = await loadZoneOrderFor(expName(), BASE);
  applyZoneOrderToData(data, initialZoneOrder);
  rememberExperience(expName(), { base: BASE, data, nodesById, startNodeId, zoneOrder: initialZoneOrder });

  async function loadExperiencePackage(expId){
    const key = String(expId || "").trim();
    if (!key) return null;
    if (experienceDataCache.has(key)) return experienceDataCache.get(key);
    const base = (BASE_URL + "experiences/" + key).replace(/\/{2,}/g,"/");
    try{
      const pack = await loadWalkthrough((base + "/walkthrough.json").replace(/\/{2,}/g,"/"));
      // Ensure zone-order.json is applied even when the experience isn't currently active.
      let zOrder = null;
      try { zOrder = await loadZoneOrderFor(key, base); } catch { zOrder = null; }
      try { applyZoneOrderToData(pack?.data, zOrder); } catch {}
      const entry = { expId: key, base, zoneOrder: zOrder, ...pack };
      rememberExperience(key, entry);
      return experienceDataCache.get(key);
    }catch{
      experienceDataCache.set(key, null);
      return null;
    }
  }

  async function maybeSelectMobilePanoDir(){
    const node = nodesById.get(startNodeId) || (nodesById.size ? nodesById.values().next().value : null);
    const file = node?.file;
    if (!file) return;
    const qs = new URLSearchParams(location.search);
    const mobileParam = qs.get('mobile');
    const forcedOn = (mobileParam === '1');
    const forcedOff = (mobileParam === '0');
    const needsMobile = (() => {
      if (forcedOn) return true;
      if (forcedOff) return false;
      try{
        const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
        const eff = String(conn?.effectiveType||'').toLowerCase();
        const save = Boolean(conn?.saveData);
        return /^(slow-)?2g|3g$/.test(eff) || save;
      }catch{ return false; }
    })();
    if (!needsMobile) return;
    const candidates = [];
    candidates.push("panos-mobile-6k");
    candidates.push("panos-mobile");
    for (const dir of candidates){
      const url = panoPath(dir, file);
      try{
        let res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (!res?.ok && res?.status === 405){
          res = await fetch(url, { method: "GET", cache: "no-store" });
        }
        if (res?.ok){
          PANOS_DIR = dir;
          console.info("[AGENT] Using mobile panorama folder:", dir);
          return;
        }
      }catch{}
    }
  }
  try{
    const probe = nodesById.get(startNodeId) || (nodesById.size ? nodesById.values().next().value : null);
    await refreshPreferKtx2Effective(expName(), probe?.file);
  }catch{}
  await maybeSelectMobilePanoDir();

  // Periodic memory GC - DISABLED to prevent black screen issues
  // The LRU cache with TEX_LIMIT handles memory automatically
  // GC only runs on visibility change and context loss events
  /*
  try{
    if (IS_MOBILE) setInterval(()=>{
      try{
        const curNode = nodesById.get(currentNodeId);
        if (!curNode) return;
        // Only clean if cache is above limit
        if (texCache.size <= TEX_LIMIT) return;
        const keep = new Set();
        if (typeof curNode.file === 'string') keep.add(BASE + '|' + curNode.file);
        retainOnly(keep);
      }catch{}
    }, 120000); // 2 minutes, only on mobile
  }catch{}
  */
  try{
  }catch{}

  /* floors */
  const floorIndex=new Map(), floorCenter=new Map();
  function rebuildFloorMaps(){
    floorIndex.clear(); floorCenter.clear();
    data.floors.forEach((f,i)=>floorIndex.set(f.id,i));
    for (const f of data.floors){
      const on=data.nodes.filter(n=>n.floorId===f.id);
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for (const n of on){ if(typeof n.x==="number"&&typeof n.y==="number"){ if(n.x<minX)minX=n.x; if(n.x>maxX)maxX=n.x; if(n.y<minY)minY=n.y; if(n.y>maxY)maxY=n.y; } }
      const ppm=f.pxPerMeter||100; const cx=isFinite(minX)?(minX+maxX)/2:0; const cy=isFinite(minY)?(minY+maxY)/2:0;
      floorCenter.set(f.id,{cx,cy,ppm});
    }
  }
  rebuildFloorMaps();
  const nodeWorldPos = (n)=>{ const f=floorCenter.get(n.floorId)||{cx:0,cy:0,ppm:100}; const idx=floorIndex.get(n.floorId)??0; return new Vector3((n.x-f.cx)/f.ppm, idx*FLOOR_HEIGHT_M, (n.y-f.cy)/f.ppm); };

  /* main dome */
  const worldRoot = new TransformNode("worldRoot", scene);
  const dome = MeshBuilder.CreateSphere("dome",{diameter:DOME_DIAMETER,segments:64,sideOrientation:Mesh.BACKSIDE},scene);
  dome.parent=worldRoot; if(flipX) dome.rotation.x=Math.PI; dome.layerMask=0x2; dome.isPickable=false;
  const domeMat=new StandardMaterial("panoMat",scene);
  domeMat.disableLighting=true; domeMat.backFaceCulling=false;
  domeMat.transparencyMode=Material.MATERIAL_ALPHABLEND; domeMat.disableDepthWrite=true;
  dome.material=domeMat; dome.renderingGroupId=0;

  // Secondary dome for optional crossfade
  const crossDome = MeshBuilder.CreateSphere("domeX",{diameter:DOME_DIAMETER,segments:64,sideOrientation:Mesh.BACKSIDE},scene);
  crossDome.parent=worldRoot; if(flipX) crossDome.rotation.x=Math.PI; crossDome.layerMask=0x2; crossDome.isPickable=false; crossDome.isVisible=false; crossDome.setEnabled(false);
  const crossMat=new StandardMaterial("panoMatX",scene);
  crossMat.disableLighting=true; crossMat.backFaceCulling=false; crossMat.alpha=0;
  crossMat.transparencyMode=Material.MATERIAL_ALPHABLEND; crossMat.disableDepthWrite=true;
  crossDome.material=crossMat; crossDome.renderingGroupId=1;
  let worldYaw = 0;
  let autoRotateTargetYaw = null;
  let autoRotateLastT = 0;
  let autoRotatePlanTouch = 0;
  /* textures */
  // LRU texture cache to prevent unbounded GPU memory growth on mobile
  const texCache=new Map(), inFlight=new Map();
  const TEX_LIMIT = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('texLimit') || qs.get('textureLimit') || (import.meta?.env?.VITE_TEX_LIMIT ?? '');
      const override = Number.parseInt(String(raw || ''), 10);
      if (Number.isFinite(override) && override > 0) return Math.max(1, Math.min(override, 48));
    }catch{}
    return IS_IOS ? 3 : (IS_ANDROID ? 6 : 12); // Much fewer on constrained GPUs
  })();
  const PREFETCH_LIMIT = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('prefetch') || qs.get('neighborPrefetch') || (import.meta?.env?.VITE_NEIGHBOR_PREFETCH ?? '');
      const override = Number.parseInt(String(raw || ''), 10);
      if (Number.isFinite(override) && override >= 0) return Math.max(0, Math.min(override, 6));
    }catch{}
    try{
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType||'').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      if (slow) return 0;
    }catch{}
    return IS_IOS ? 0 : (IS_ANDROID ? 1 : 2); // Disable prefetch on iOS
  })();
  const VR_PREFETCH_LIMIT = (()=>{
    try{
      const qs = new URLSearchParams(location.search);
      const raw = qs.get('vrPrefetch') || qs.get('vrNeighborPrefetch') || (import.meta?.env?.VITE_VR_PREFETCH ?? '');
      const override = Number.parseInt(String(raw || ''), 10);
      if (Number.isFinite(override) && override >= 0) return Math.max(0, Math.min(override, 10));
    }catch{}
    try{
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType||'').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      if (slow) return Math.max(PREFETCH_LIMIT, 1);
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
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType||'').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      if (slow) return false;
    }catch{}
    return true;
  })();
  
  // Periodic memory cleanup - DISABLED to prevent black screen
  // LRU cache with eviction handles memory automatically
  let lastMemoryCleanup = 0;
  function aggressiveMemoryCleanup(){
    // Disabled - was causing black screen issues
    // LRU eviction in getTexture handles memory management
    return;
  }
  
  function touchLRU(key){
    if (!texCache.has(key)) return;
    const val = texCache.get(key);
    texCache.delete(key);
    texCache.set(key, val);
  }
  function evictIfNeeded(currentKey){
    try{
      while (texCache.size > TEX_LIMIT){
        const pinned = new Set([currentKey, lastMainKey, (mirrorTexturePinned ? mirrorTexKey : null)].filter(Boolean));
        let evictKey = null;
        for (const k of texCache.keys()){
          if (!pinned.has(k)) { evictKey = k; break; }
        }
        if (!evictKey) break;
        const tex = texCache.get(evictKey);
        texCache.delete(evictKey);
        try{ tex?.dispose?.(); console.info('[AGENT] evicted texture:', evictKey); }catch{}
      }
    }catch{}
  }
  function purgeTextures(){
    // Only purge when page is hidden - keep current texture safe
    const safe = new Set([lastMainKey, (mirrorTexturePinned ? mirrorTexKey : null)].filter(Boolean));
    try{
      for (const [k,tex] of texCache.entries()){ 
        if (safe.has(k)) continue; // Never purge in-use textures
        try{ tex?.dispose?.(); }catch{} 
        texCache.delete(k);
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
  function neighborInfoFor(n, limit=2){
    const out={ files:[], keys:[], urls:[] };
    try{
      const hs=Array.isArray(n?.hotspots)? n.hotspots : [];
      for (const h of hs){
        if (!h?.to || !nodesById.has(h.to)) continue;
        const f = nodesById.get(h.to).file; if(!f || out.files.includes(f)) continue;
        out.files.push(f); out.keys.push(BASE+"|"+f); out.urls.push(panoUrl(f));
        if (out.files.length>=limit) break;
      }
    }catch{}
    return out;
  }
  function retainOnly(keep){
    try{
      for (const [k, tex] of texCache.entries()){
        if (!keep.has(k)) { try{ tex?.dispose?.(); }catch{} texCache.delete(k); }
      }
    }catch{}
  }
  // (do not redefine retainSW below)
  function loadTextureUrl(url, q){
    return new Promise((resolve, reject) => {
      let settled = false;
      let tex = null;
      const finishOk = () => { if (settled) return; settled = true; resolve(tex); };
      const finishErr = (message, exception) => {
        if (settled) return;
        settled = true;
        try{ tex?.dispose?.(); }catch{}
        const err = exception instanceof Error ? exception : new Error(String(message || "Texture load failed"));
        reject(err);
      };
      const noMipmap = /\.ktx2$/i.test(url) ? true : !q.mips;
      tex = new Texture(url, scene, noMipmap, false, q.sampling, finishOk, finishErr);
      try{ tex.anisotropicFilteringLevel = q.aniso; }catch{}
      setTimeout(() => finishErr(`Texture load timeout: ${url}`), 45000);
    });
  }
  // Standard texture load: use the file as authored (with basic WebP/KTX2 selection + safe fallback)
  function getTexture(file){
    const key=BASE+"|"+file;
    if (texCache.has(key)) { touchLRU(key); return Promise.resolve(texCache.get(key)); }
    if (inFlight.has(key)) return inFlight.get(key);
    const p=(async()=>{
      const q=getQuality();
      const primaryUrl = panoUrl(file);
      const fallbackUrl = /\.ktx2$/i.test(primaryUrl) ? panoUrlOriginal(file) : panoUrlKtx2(file);
      let tex = null;
      try{
        tex = await loadTextureUrl(primaryUrl, q);
      }catch(e){
        if (fallbackUrl && fallbackUrl !== primaryUrl){
          const ok = await urlExistsFast(fallbackUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS });
          if (!ok) throw e;
          tex = await loadTextureUrl(fallbackUrl, q);
        } else {
          throw e;
        }
      }
      texCache.set(key, tex); evictIfNeeded(key); return tex;
    })();
    inFlight.set(key,p); p.finally(()=>inFlight.delete(key));
    return p;
  }
  let lastMainFile = null;
  let lastMainKey = null;
  let lastNavigateSource = "program";
  function applyMainTexture(file, tex){
    try{ console.info('[AGENT] apply pano', file); }catch{}
    // CORRECT: In 2D, CROP stereo (bottom half only for mono view)
    mapFor2D(tex, /*stereo*/ isStereo(), flipU);
    
    // Store old texture key to dispose AFTER setting new one
    const oldKey = lastMainKey;
    const currentMainKey = BASE + "|" + file;
    
    // Apply new texture first
    domeMat.emissiveTexture = tex;
    try{ dome.setEnabled(true); dome.isVisible = true; }catch{}
    try{ if (crossDome?.isEnabled()) { crossDome.isVisible = false; crossDome.setEnabled(false); } }catch{}
    try {
      remapFor2DWhenReady(scene, tex, () => isStereo(), flipU, (t) => (domeMat?.emissiveTexture === t) || (crossMat?.emissiveTexture === t));
    } catch {}
    
    // Update tracking
    lastMainFile = file;
    lastMainKey = currentMainKey;
    
    // Dispose old texture AFTER new one is applied
    if (oldKey && oldKey !== currentMainKey){
      setTimeout(()=>{
        try{
          if (texCache.has(oldKey) && oldKey !== lastMainKey && (!mirrorTexturePinned || oldKey !== mirrorTexKey)){
            const oldTex = texCache.get(oldKey);
            texCache.delete(oldKey);
            try{ oldTex?.dispose?.(); }catch{}
            console.info('[AGENT] disposed old pano texture:', oldKey);
          }
        }catch{}
      }, 0);
    }
    
    // Prefetch neighbors (but don't retain aggressively)
    try{
      const curNode = nodesById.get(currentNodeId);
      const neigh = neighborInfoFor(curNode, PREFETCH_LIMIT);
      neigh.files.forEach(f=>{ try{ getTexture(f).catch(()=>{}); }catch{} });
      retainSW([panoUrl(file), ...neigh.urls]);
    }catch{}
    try{
      const curNode = nodesById.get(currentNodeId);
      preloadNeighborsForVR(curNode);
      prewarmVrDome(curNode?.file || file);
    }catch{}

    // Evict excess textures from cache (LRU)
    evictIfNeeded(currentMainKey);

  }
  async function showFile(file, opts = {}){
    // In XR, route to VR PhotoDome loader to avoid double domes and wrong mapping
    if (inXR === true) {
      try {
        await setVrPano(file, opts);
      } catch (err) {
        // Fallback: If VR pano fails, show a default texture or reload previous
        console.error('[AGENT] VR pano load failed:', err);
        // Try to reload previous pano or show a blank fallback
        if (lastMainFile) {
          try { await setVrPano(lastMainFile, {}); } catch {}
        } else {
          // Optionally set a solid color or default pano
          try { domeMat.emissiveColor = new Color3(0,0,0); } catch {}
        }
      }
      return;
    }
    // 2D path: standard texture with equirect mapping (mono crop if stereo)
    const tex = await getTexture(file);
    try { if (typeof opts?.beforeApply === "function") opts.beforeApply(); } catch {}
    applyMainTexture(file, tex);
  }
  function runCrossFade(file, tex, fadeMs, delayMs = 0){
    // In XR, always skip crossfade and apply directly
    if (inXR === true) {
        applyMainTexture(file, tex);
        return Promise.resolve();
    }
    if (!tex) return showFile(file);
    if (!(fadeMs > 0)) { applyMainTexture(file, tex); return Promise.resolve(); }
    mapFor2D(tex, /*stereo*/ isStereo(), flipU);
    try {
      remapFor2DWhenReady(scene, tex, () => isStereo(), flipU, (t) => (domeMat?.emissiveTexture === t) || (crossMat?.emissiveTexture === t));
    } catch {}
    return new Promise((resolve) => {
      const startFade = () => {
        try{
          dispatchEvent(new CustomEvent('agent:transition', {
            detail: { kind: 'crossfade', phase: 'start', file, fadeMs, delayMs, source: lastNavigateSource }
          }));
        }catch{}
        try{
          crossMat.emissiveTexture = tex;
          try { mapFor2D(crossMat.emissiveTexture, /*stereo*/ isStereo(), flipU); } catch {}
          try {
            remapFor2DWhenReady(scene, crossMat.emissiveTexture, () => isStereo(), flipU, (t) => (domeMat?.emissiveTexture === t) || (crossMat?.emissiveTexture === t));
          } catch {}
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
            scene.onBeforeRenderObservable.remove(observer);
            try{
              crossMat.emissiveTexture = null;
              crossDome.isVisible = false;
              crossDome.setEnabled(false);
              crossMat.alpha = 0;
            }catch{}
            applyMainTexture(file, tex);
            try{
              dispatchEvent(new CustomEvent('agent:transition', {
                detail: { kind: 'crossfade', phase: 'end', file, fadeMs, delayMs, source: lastNavigateSource }
              }));
            }catch{}
            resolve();
          }
        });
      };
      if (delayMs > 0) setTimeout(startFade, delayMs);
      else startFade();
    });
  }

  // Release GPU memory when tab is hidden/backgrounded (mobile stability)
  function tryReloadCurrent(){
    try{
      const n = nodesById.get(currentNodeId);
      if (!n || !n.file) return;
      // Reload texture - get fresh from cache or load new
      void showFile(n.file).catch(()=>{}); 
      const hasMirror = !!(mirrorDome?.material?.emissiveTexture);
      if (mirrorVisible && viewers.size > 0){
        const targetId = (mirrorNodeId && nodesById.has(mirrorNodeId)) ? mirrorNodeId : n.id;
        if (!hasMirror || mirrorNodeId !== targetId) { void setMirrorNode(targetId); }
      }
    }catch{}
  }
  try{
    document.addEventListener('visibilitychange', ()=>{
      if (document.visibilityState !== 'visible') {
        // Purge non-current textures on iOS/Android when hidden
        if (IS_IOS || IS_ANDROID) purgeTextures();
      } else {
        // Force reload after tab becomes visible again
        setTimeout(()=>{
          tryReloadCurrent();
          try{ updateMirrorLayout(); }catch{}
          try{ engine.resize(); }catch{}
          // Restart render loop if needed
          try{ if (!engine.isDisposed && !engine._activeRenderLoops?.length) engine.runRenderLoop(()=>scene.render()); }catch{}
        }, 150);
      }
    });
    // Handle iOS Safari memory pressure - only on page hide/freeze
    if (IS_IOS){
      window.addEventListener('pagehide', ()=>purgeTextures());
      window.addEventListener('freeze', ()=>purgeTextures());
      // Periodic cleanup DISABLED - was causing black screen
      // setInterval(()=>aggressiveMemoryCleanup(), 45000);
    }
    addEventListener('pageshow', (e)=>{
      // Also handle back/forward cache restoration
      setTimeout(()=>{
        tryReloadCurrent();
        try{ engine.resize(); }catch{}
      }, 150);
    });
    addEventListener('pagehide', ()=>purgeTextures());
  }catch{}

  try{
    engine.onContextLostObservable.add(()=>{
      console.warn("[AGENT] WebGL context lost - purging texture cache");
      purgeTextures();
    });
    engine.onContextRestoredObservable.add(()=>{
      console.info("[AGENT] WebGL context restored");
      try{
        const cur = nodesById.get(currentNodeId);
        if (cur?.file) { getTexture(cur.file).catch(()=>{}); }
      }catch{}
    });
  }catch{}

  /* hotspots */
  const hotspotRoot = new TransformNode("hotspots", scene); hotspotRoot.parent=dome; hotspotRoot.layerMask=0x2;
  const hotspotRootXR = new TransformNode("hotspotsXR", scene); hotspotRootXR.layerMask=0x1;
  // XR content should behave like a skybox: follow headset translation so hotspots don't "float" when the user moves.
  // Keep it independent from `worldRoot` (which can animate during navigation/minimap updates).
  const xrContentRoot = new TransformNode("xrContentRoot", scene); xrContentRoot.layerMask=0x1;
  function vecFromYawPitch(yawDeg,pitchDeg,R,flipY=false){ const y=rad(yawDeg), p=rad(pitchDeg||0), cp=Math.cos(p), sp=Math.sin(p); const ySign = flipY ? -1 : 1; return new Vector3(R*Math.cos(y)*cp, ySign*R*sp, -R*Math.sin(y)*cp); }
  let _hotspotPulseObs = null;
  let _activeHotspots = [];
  function clearHotspots(){
    const disposeRoot = (root)=>{
      try{
        const items = root?.getChildren?.() || [];
        for (const n of items){
          try{
            const kids = n?.getChildren?.() || [];
            for (const k of kids){
              try{ k?.dispose?.(false, true); }catch{ try{ k?.dispose?.(); }catch{} }
            }
          }catch{}
          try{ n?.dispose?.(); }catch{}
        }
      }catch{}
    };
    disposeRoot(hotspotRoot);
    disposeRoot(hotspotRootXR);
    try{ _activeHotspots = []; }catch{}
    try{
      if (_hotspotPulseObs){
        scene.onBeforeRenderObservable.remove(_hotspotPulseObs);
        _hotspotPulseObs = null;
      }
    }catch{}
  }
  
  // Calculate best initial camera yaw to face the first/primary hotspot
  function getBestInitialCamYaw(node, prevNodeId = null){
    if (!node?.hotspots?.length) return 0;
    // Priority: 1) Hotspot that's NOT the previous node, 2) First hotspot, 3) Zone hotspot
    let bestHotspot = null;
    
    // First pass: find walk hotspot not going back
    for (const h of node.hotspots){
      if (h?.yaw === undefined) continue;
      const kind = String(h?.type || 'walk').toLowerCase();
      if (kind === 'zone') continue;
      if (prevNodeId && h.to === prevNodeId) continue;
      bestHotspot = h;
      break;
    }
    
    // Second pass: any walk hotspot
    if (!bestHotspot){
      for (const h of node.hotspots){
        if (h?.yaw === undefined) continue;
        const kind = String(h?.type || 'walk').toLowerCase();
        if (kind === 'zone') continue;
        bestHotspot = h;
        break;
      }
    }
    
    // Third pass: zone hotspot
    if (!bestHotspot){
      for (const h of node.hotspots){
        if (h?.yaw !== undefined){
          bestHotspot = h;
          break;
        }
      }
    }
    
    if (!bestHotspot || bestHotspot.yaw === undefined) return 0;
    
    // Hotspot yaw is in dome-local space
    // vecFromYawPitch: yaw=0 → +X, yaw=90 → -Z, yaw=180 → -X, yaw=270 → +Z
    // Camera rotation.y: 0 → looks at -Z, PI/2 → looks at -X, -PI/2 → looks at +X
    // Since hotspots rotate WITH the dome (worldRoot), and camera is in world space,
    // we just need: camYaw = rad(hotspotYaw - 90)
    const hotspotYawDeg = Number(bestHotspot.yaw) || 0;
    const camYaw = rad(hotspotYawDeg - 90);
    console.log('[AGENT] Best cam yaw for', node.id, ':', hotspotYawDeg, '° → cam:', (camYaw * 180 / Math.PI).toFixed(1), '°');
    return camYaw;
  }

  function _zoneAnchorXY(zone){
    try{
      const z = (zone && typeof zone === 'object') ? zone : null;
      if (!z) return null;
      const pinX = Number(z?.pinX);
      const pinY = Number(z?.pinY);
      if (Number.isFinite(pinX) && Number.isFinite(pinY)) return { x: pinX, y: pinY };
      const repX = Number(z?.repPoint?.x);
      const repY = Number(z?.repPoint?.y);
      if (Number.isFinite(repX) && Number.isFinite(repY)) return { x: repX, y: repY };
      const pts = Array.isArray(z?.points) ? z.points : [];
      if (!pts.length) return null;
      let sx = 0, sy = 0, n = 0;
      for (const p of pts){
        const x = Number(p?.x);
        const y = Number(p?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        sx += x; sy += y; n++;
      }
      if (!n) return null;
      return { x: sx / n, y: sy / n };
    }catch{
      return null;
    }
  }

  function resolveZoneRepresentativeNodeId(zoneId, preferFloorId = null){
    try{
      const zid = String(zoneId || '').trim();
      if (!zid) return null;
      const zones = Array.isArray(data?.zones) ? data.zones : [];
      const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const zone = zones.find(z => String(z?.id || '') === zid) || null;

      const kindOf = (h)=>String(h?.type || 'walk').toLowerCase();
      const scoreHotspots = (n)=>{
        const hs = Array.isArray(n?.hotspots) ? n.hotspots : [];
        let total = 0;
        let internal = 0;
        for (const h of hs){
          const k = kindOf(h);
          if (k === 'info') continue;
          if (!h?.to) continue;
          total++;
          if (k !== 'zone') {
            const toNode = nodesById?.get?.(h.to);
            if (toNode && String(toNode?.zoneId || '') === zid) internal++;
          }
        }
        return { total, internal };
      };

      let candidates = nodes.filter(n => String(n?.zoneId || '') === zid);
      if (!candidates.length) return null;

      const floorPref = preferFloorId ? String(preferFloorId) : (zone?.floorId ? String(zone.floorId) : '');
      if (floorPref){
        const onFloor = candidates.filter(n => String(n?.floorId || '') === floorPref);
        if (onFloor.length) candidates = onFloor;
      }

      const explicit = (zone && typeof zone?.repNodeId === 'string') ? zone.repNodeId.trim() : '';
      if (explicit && nodesById?.has?.(explicit)) {
        const rep = nodesById.get(explicit) || null;
        const repScore = scoreHotspots(rep);
        const anyInternal = candidates.some((n)=>scoreHotspots(n).internal > 0);
        // If the authored rep node can't navigate within the zone but other nodes can, pick a better rep.
        if (repScore.internal > 0 || !anyInternal) return explicit;
      }

      const anchor = _zoneAnchorXY(zone);

      const parseNum = (id)=>{
        const m = String(id || '').match(/(\d+)/);
        return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
      };

      // Prefer a node that has walk links inside the zone (so entering a zone shows navigable hotspots),
      // then prefer richer connectivity, then prefer proximity to the zone anchor if available.
      const ranked = candidates
        .map((n, i)=>{
          const s = scoreHotspots(n);
          let d2 = Number.POSITIVE_INFINITY;
          if (anchor){
            const x = Number(n?.x);
            const y = Number(n?.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              const dx = x - anchor.x;
              const dy = y - anchor.y;
              d2 = dx*dx + dy*dy;
            }
          }
          return { n, i, num: parseNum(n?.id), internal: s.internal, total: s.total, d2 };
        })
        .sort((a,b)=>
          (b.internal-a.internal) ||
          (b.total-a.total) ||
          (a.d2-b.d2) ||
          (a.num-b.num) ||
          (a.i-b.i)
        );

      const bestId = String(ranked?.[0]?.n?.id || '').trim();
      return bestId && nodesById?.has?.(bestId) ? bestId : null;

    }catch{
      return null;
    }
  }

  function isFirstPanoOfZone(node){
    try{
      const zid = String(node?.zoneId || '').trim();
      if (!zid) return false;
      const nodeId = String(node?.id || '').trim();
      if (!nodeId) return false;
      const repId = resolveZoneRepresentativeNodeId(zid, node?.floorId || null);
      return Boolean(repId && repId === nodeId);
    }catch{ return false; }
  }

  // Back-compat: hotspot label logic expects this name.
  function isZoneRepresentativeNode(node){
    return isFirstPanoOfZone(node);
  }
  
  function buildHotspotsInRoot(node, parentRoot, flipXLocal=false, isXR=false){
    if (!node?.hotspots) return;
    // In XR, place hotspots at a comfortable distance rather than on the pano sphere surface.
    const XR_HOTSPOT_RADIUS_M = 4.2;
    const R = isXR ? XR_HOTSPOT_RADIUS_M : (DOME_DIAMETER/2) * 0.98;
    // Size in scene units. XR uses small world geometry; 2D uses large geometry scaled for a huge pano sphere.
    const scale2D = (!isXR && IS_PHONE) ? 1.35 : (!isXR && IS_MOBILE ? 1.18 : 1.0);
    // XR: decouple hit target size from visual ring size so rings don't dominate the view.
    const XR_HOTSPOT_PICK_DIAMETER_M = 1.05;
    const XR_HOTSPOT_RING_DIAMETER_M = 0.46;
    const pickDiameter = isXR ? XR_HOTSPOT_PICK_DIAMETER_M : (336 * scale2D);
    const ringRadius = isXR ? (XR_HOTSPOT_RING_DIAMETER_M * 0.5) : (70 * scale2D);
    const hoverScaleFactor = isXR ? 1.10 : 1.10;
    const RING_SVG_URL = (BASE_URL + (isXR ? "hotspot-rings-xr.svg" : "hotspot-rings-darkred.svg")).replace(/\/{2,}/g, "/");
    // Saturated gold; we add a soft shadow plane behind so it stays visible on bright/white panos.
    const RING_GOLD = new Color3(0.95, 0.76, 0.16); // ~ #F2C228
    const RING_GOLD_HOVER = new Color3(1.0, 0.88, 0.38); // ~ #FFE061
    let sharedRingOpacityTex = null;
    try {
      sharedRingOpacityTex = new Texture(RING_SVG_URL, scene, true, false);
      sharedRingOpacityTex.hasAlpha = true;
    } catch {}
    // In XR we stopped flipping the VR dome on the X axis; compensate yaw so hotspots face correctly.
    // Keep pitch as-authored in the data (positive = up).
    const yawSign = (isXR && !flipXLocal) ? -1 : 1;
    const isZoneRepNode = isZoneRepresentativeNode(node);
    // When we need to show a "zone name" label on the representative pano, keep it to ONE hotspot
    // (prevents duplicate zone labels under every walk hotspot on the rep pano).
    let primaryZoneLabelToId = null;
    if (isZoneRepNode) {
      try { primaryZoneLabelToId = pickNextInZoneByHotspot(node, lastNodeId) || null; } catch {}
      if (!primaryZoneLabelToId) {
        try {
          for (const hh of (node.hotspots || [])) {
            const kind2 = String(hh?.type || 'walk').toLowerCase();
            if (kind2 === 'zone' || kind2 === 'info') continue;
            if (hh?.to && nodesById?.has?.(hh.to)) { primaryZoneLabelToId = hh.to; break; }
          }
        } catch {}
      }
    }
    let hsIndex = 0;
    for (const h of node.hotspots){
      const idx = hsIndex++;
      const kind = String(h?.type || 'walk').toLowerCase();
      const isZone = (kind === 'zone');
      const isInfo = (kind === 'info');
      // User request: remove label/info hotspots entirely (do not render or pick).
      if (isInfo) continue;
      const toId = h?.to;
      if (isZone) {
        if (!toId) continue;
      } else if (!isInfo) {
        if ((!toId) || (!nodesById.has(toId))) continue;
      }
      const layer = parentRoot === hotspotRoot ? 0x2 : 0x1;
      const infoId = isInfo ? String(h?.id || idx) : "";
      const rootName = isZone ? `zone-${toId}` : (isInfo ? `info-${infoId}` : (toId||""));
      const root=new TransformNode("hs-"+ rootName,scene); root.parent=parentRoot||hotspotRoot; root.layerMask=layer;

      let ring = null;
      let pulseRing = null;

      if (!isInfo) {
        ring = MeshBuilder.CreatePlane("hsRing", { size: ringRadius * 2 }, scene);
        ring.billboardMode = Mesh.BILLBOARDMODE_ALL;
        const ringMat = new StandardMaterial("hsRingMat", scene);
        ringMat.disableLighting = true;
        ringMat.backFaceCulling = false;
        ringMat.disableDepthWrite = true;
        ringMat.zOffset = 1;
        ringMat.diffuseColor = Color3.Black();
        ringMat.specularColor = Color3.Black();
        ringMat.emissiveColor = RING_GOLD.clone();
        ringMat.alpha = 1;
        if (sharedRingOpacityTex) ringMat.opacityTexture = sharedRingOpacityTex;
        ring.material = ringMat;
        ring.parent = root;
        ring.layerMask = layer;
        ring.isPickable = true;
        ring.renderingGroupId = 2;

        // Shadow underlay for contrast on bright backgrounds (not an outline stroke).
        const ringShadow = MeshBuilder.CreatePlane("hsRingShadow", { size: ringRadius * 2 }, scene);
        ringShadow.billboardMode = Mesh.BILLBOARDMODE_ALL;
        const ringShadowMat = new StandardMaterial("hsRingShadowMat", scene);
        ringShadowMat.disableLighting = true;
        ringShadowMat.backFaceCulling = false;
        ringShadowMat.disableDepthWrite = true;
        ringShadowMat.zOffset = 0;
        ringShadowMat.diffuseColor = Color3.Black();
        ringShadowMat.specularColor = Color3.Black();
        ringShadowMat.emissiveColor = Color3.Black();
        ringShadowMat.alpha = 0.22;
        if (sharedRingOpacityTex) ringShadowMat.opacityTexture = sharedRingOpacityTex;
        ringShadow.material = ringShadowMat;
        ringShadow.parent = root;
        ringShadow.layerMask = layer;
        ringShadow.isPickable = false;
        ringShadow.renderingGroupId = 1;
        ringShadow.position.z = -0.02;
        ringShadow.scaling.set(1.08, 1.08, 1);

        // Pulse ring (radial in/out animation): expands outward and fades, loops.
        pulseRing = MeshBuilder.CreatePlane("hsRingPulse", { size: ringRadius * 2 }, scene);
        pulseRing.billboardMode = Mesh.BILLBOARDMODE_ALL;
        const pulseMat = new StandardMaterial("hsRingPulseMat", scene);
        pulseMat.disableLighting = true;
        pulseMat.backFaceCulling = false;
        pulseMat.disableDepthWrite = true;
        pulseMat.zOffset = 1;
        pulseMat.diffuseColor = Color3.Black();
        pulseMat.specularColor = Color3.Black();
        pulseMat.emissiveColor = RING_GOLD.clone();
        pulseMat.alpha = 1.0;
        if (sharedRingOpacityTex) pulseMat.opacityTexture = sharedRingOpacityTex;
        pulseRing.material = pulseMat;
        pulseRing.parent = root;
        pulseRing.layerMask = layer;
        pulseRing.isPickable = false;
        pulseRing.renderingGroupId = 2;
        pulseRing.position.z = -0.1;

        const pulseShadow = MeshBuilder.CreatePlane("hsRingPulseShadow", { size: ringRadius * 2 }, scene);
        pulseShadow.billboardMode = Mesh.BILLBOARDMODE_ALL;
        const pulseShadowMat = new StandardMaterial("hsRingPulseShadowMat", scene);
        pulseShadowMat.disableLighting = true;
        pulseShadowMat.backFaceCulling = false;
        pulseShadowMat.disableDepthWrite = true;
        pulseShadowMat.zOffset = 0;
        pulseShadowMat.diffuseColor = Color3.Black();
        pulseShadowMat.specularColor = Color3.Black();
        pulseShadowMat.emissiveColor = Color3.Black();
        pulseShadowMat.alpha = 0.14;
        if (sharedRingOpacityTex) pulseShadowMat.opacityTexture = sharedRingOpacityTex;
        pulseShadow.material = pulseShadowMat;
        pulseShadow.parent = root;
        pulseShadow.layerMask = layer;
        pulseShadow.isPickable = false;
        pulseShadow.renderingGroupId = 1;
        pulseShadow.position.z = -0.12;
        pulseShadow.scaling.set(1.06, 1.06, 1);
      } else {
        // Info tags should look like labels (no ring/pulse), in both 2D and XR.
        try {
          const titleRaw = String(h?.title || "").trim();
          const subtitleRaw = String(h?.subtitle || "").trim();
          const footerRaw = String(h?.footer || "").trim();
          const title = titleRaw || subtitleRaw || footerRaw;
          const subtitle = titleRaw ? (subtitleRaw || footerRaw) : (subtitleRaw && footerRaw ? footerRaw : "");

          // Dot marker
          const dotR = isXR ? 0.045 : (12 * scale2D);
          const dot = MeshBuilder.CreateDisc("hsInfoDot", { radius: dotR, tessellation: 32 }, scene);
          dot.billboardMode = Mesh.BILLBOARDMODE_ALL;
          const dotMat = new StandardMaterial("hsInfoDotMat", scene);
          dotMat.disableLighting = true;
          dotMat.backFaceCulling = false;
          dotMat.disableDepthWrite = true;
          dotMat.zOffset = 2;
          dotMat.emissiveColor = new Color3(0.30, 0.78, 1.0); // ~ #4CC7FF
          dotMat.alpha = 1.0;
          dot.material = dotMat;
          dot.parent = root;
          dot.layerMask = layer;
          dot.isPickable = false;
          dot.renderingGroupId = 2;
          dot.position.z = 0.6;

          // Label card
          if (title) {
            // Size tuned to match the reference "info tag" card without covering too much of the view.
            const labelPlaneW = isXR ? 1.05 : (ringRadius * 3.6);
            const labelPlaneH = isXR ? 0.34 : (ringRadius * 1.35);
            const labelPlane = MeshBuilder.CreatePlane("hsInfoLabel", { width: labelPlaneW, height: labelPlaneH }, scene);
            const labelMat = new StandardMaterial("hsInfoLabelMat", scene);
            labelMat.disableLighting = true;
            labelMat.backFaceCulling = false;
            labelMat.disableDepthWrite = true;
            labelMat.zOffset = 3;
            labelMat.emissiveColor = Color3.White();
            labelPlane.material = labelMat;
            labelPlane.parent = root;
            labelPlane.layerMask = layer;
            labelPlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
            labelPlane.isPickable = false;
            labelPlane.renderingGroupId = 2;
            const labelGap = isXR ? 0.12 : Math.max(10, dotR + (ringRadius * 0.22));
            labelPlane.position.y = (labelPlaneH * 0.5) + labelGap;
            // Keep close to the authored direction; avoid pulling toward the camera.
            labelPlane.position.z = isXR ? 0.02 : 0.0;
            try { labelPlane.showBoundingBox = false; labelPlane.isVisible = true; } catch {}

            const dtW = 1024;
            const dtH = 512;
            const dt = new DynamicTexture("hsInfoLabelText", { width: dtW, height: dtH }, scene, false);
            try {
              try {
                dt.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
                dt.anisotropicFilteringLevel = 8;
              } catch {}
              const ctx = dt.getContext();
              ctx.clearRect(0, 0, dtW, dtH);

              const radius = 46;
              const pad = 42;
              const x0 = pad, y0 = pad;
              const w = dtW - pad * 2, h = dtH - pad * 2;
              const r = Math.min(radius, w * 0.5, h * 0.5);
              ctx.beginPath();
              ctx.moveTo(x0 + r, y0);
              ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
              ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
              ctx.arcTo(x0, y0 + h, x0, y0, r);
              ctx.arcTo(x0, y0, x0 + w, y0, r);
              ctx.closePath();

              // Frosted-ish dark card
              ctx.fillStyle = "rgba(0,0,0,0.42)";
              ctx.fill();
              ctx.lineWidth = 4;
              ctx.strokeStyle = "rgba(255,255,255,0.28)";
              ctx.stroke();

              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.shadowColor = "rgba(0,0,0,0.30)";
              ctx.shadowBlur = 10;
              ctx.shadowOffsetX = 0;
              ctx.shadowOffsetY = 3;

              // Title (large)
              ctx.fillStyle = "#FFFFFF";
              ctx.font = `800 120px Inter, Arial, sans-serif`;
              ctx.fillText(String(title), dtW / 2, dtH * (subtitle ? 0.44 : 0.52));

              // Subtitle (smaller)
              if (subtitle) {
                ctx.shadowBlur = 8;
                ctx.font = `700 74px Inter, Arial, sans-serif`;
                ctx.fillText(String(subtitle), dtW / 2, dtH * 0.68);
              }

              dt.hasAlpha = true;
              dt.update();
              labelMat.emissiveTexture = dt;
              labelMat.opacityTexture = dt;
            } catch {}
          }
        } catch (e) { console.warn('[AGENT] Info label creation failed', e); }
      }

        // Add text labels
        // Default behavior (older): show simple destination labels only on zone rep panos.
        // For specific experiences (enabled via meta.json `hotspotNavTags:true`): show "Prev/Next" tags under every walk/zone hotspot.
        try {
          // Return only authored/human-friendly titles. Never fall back to file names like "panorama_123".
          const nodeTitle = (n) => {
            try {
              const name = String(n?.name || n?.label || "").trim();
              return name || "";
            } catch {
              return "";
            }
          };

          const drawRoundedRect = (ctx, x, y, w, h, r) => {
            const rr = Math.max(0, Math.min(r, w / 2, h / 2));
            ctx.beginPath();
            ctx.moveTo(x + rr, y);
            ctx.arcTo(x + w, y, x + w, y + h, rr);
            ctx.arcTo(x + w, y + h, x, y + h, rr);
            ctx.arcTo(x, y + h, x, y, rr);
            ctx.arcTo(x, y, x + w, y, rr);
            ctx.closePath();
          };

          const drawFittedLine = (ctx, text, {
            x, y, maxWidth, weight = 800, maxPx = 96, minPx = 28, color = "#FFFFFF",
          } = {}) => {
            let fontPx = Math.round(maxPx);
            while (fontPx > minPx) {
              ctx.font = `${weight} ${fontPx}px Inter, Arial, sans-serif`;
              if (ctx.measureText(text).width <= maxWidth) break;
              fontPx -= 3;
            }
            ctx.font = `${weight} ${fontPx}px Inter, Arial, sans-serif`;
            ctx.fillStyle = color;
            ctx.fillText(text, x, y);
          };

          if (hotspotNavTags && !isInfo) {
            const isBackHotspot = (!isZone && lastNodeId && String(toId) === String(lastNodeId));

            // Destination label (never fall back to pano file names).
            let destTitle = "";
            if (!isZone) {
              const targetNode = nodesById?.get?.(toId) || null;
              destTitle = nodeTitle(targetNode);
              if (!destTitle) {
                const zid = String(targetNode?.zoneId || "").trim();
                const z = zid ? (data?.zones || []).find(zz => String(zz?.id) === zid) : null;
                destTitle = String(z?.name || "").trim();
              }
            } else {
              const zone = (data?.zones || []).find(z => String(z?.id) === String(toId));
              destTitle = String(zone?.name || "").trim();
            }

            // Show "Back" only on the hotspot that returns to the pano you came from.
            // For zone hotspots on the first pano of a zone (rep node), show only the zone name (no "Next/Go to" prefix).
            const prevNode = lastNodeId ? (nodesById?.get?.(lastNodeId) || null) : null;
            let prevTitle = nodeTitle(prevNode);
            if (!prevTitle) {
              const zid = String(prevNode?.zoneId || "").trim();
              const z = zid ? (data?.zones || []).find(zz => String(zz?.id) === zid) : null;
              prevTitle = String(z?.name || "").trim();
            }

            // If we're just moving within the same zone, showing the zone name as a destination isn't useful.
            try {
              if (!isZone) {
                const curZid = String(node?.zoneId || "").trim();
                const curZ = curZid ? (data?.zones || []).find(zz => String(zz?.id) === curZid) : null;
                const curZoneName = String(curZ?.name || "").trim();
                if (curZoneName && destTitle && String(destTitle) === String(curZoneName)) destTitle = "";
              }
            } catch {}

            let titleLine = "";
            let subtitleLine = "";
            if (isBackHotspot) {
              titleLine = "Back";
              subtitleLine = prevTitle;
            } else if (isZone && isZoneRepNode) {
              titleLine = destTitle; // zone name only on zone entry pano
            } else if (isZone) {
              titleLine = destTitle; // keep zone name simple everywhere (no "Next")
            } else {
              // Walk hotspot: if we don't have a meaningful destination title, show a generic action.
              if (destTitle) {
                titleLine = "Go to";
                subtitleLine = destTitle;
              } else {
                titleLine = "Continue";
              }
            }

            const hasAnyLine = Boolean(String(titleLine || "").trim() || String(subtitleLine || "").trim());
            if (hasAnyLine) {
              const twoLine = Boolean(String(subtitleLine || "").trim());
              const labelPlaneW = isXR ? 1.18 : (ringRadius * (twoLine ? 3.85 : 3.10));
              const labelPlaneH = isXR ? (twoLine ? 0.40 : 0.28) : (ringRadius * (twoLine ? 1.35 : 0.98));
              const labelPlane = MeshBuilder.CreatePlane("hsNavTag", { width: labelPlaneW, height: labelPlaneH }, scene);
              const labelMat = new StandardMaterial("hsNavTagMat", scene);
              labelMat.disableLighting = true;
              labelMat.backFaceCulling = false;
              labelMat.disableDepthWrite = true;
              labelMat.zOffset = 3;
              labelMat.emissiveColor = Color3.White();
              labelPlane.material = labelMat;
              labelPlane.parent = ring || root;
              labelPlane.layerMask = layer;
              labelPlane.billboardMode = Mesh.BILLBOARDMODE_NONE; // inherit ring billboard
              labelPlane.isPickable = false;
              labelPlane.renderingGroupId = 2;
              const labelGap = isXR ? 0.06 : Math.max(8, ringRadius * 0.14);
              labelPlane.position.y = -(ringRadius + (labelPlaneH * 0.5) + labelGap);
              labelPlane.position.z = isXR ? 0.03 : 0.06;

              const dtW = 1024;
              const dtH = twoLine ? 512 : 320;
              const dt = new DynamicTexture("hsNavTagText", { width: dtW, height: dtH }, scene, false);
              try {
                try { dt.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE); dt.anisotropicFilteringLevel = 8; } catch {}
                const ctx = dt.getContext();
                ctx.clearRect(0, 0, dtW, dtH);

                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.shadowColor = "rgba(0,0,0,0.45)";
                ctx.shadowBlur = 12;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 3;

                const maxWidth = dtW * 0.88;
                const cx = dtW / 2;
                if (twoLine) {
                  drawFittedLine(ctx, String(titleLine), { x: cx, y: dtH * 0.40, maxWidth, weight: 900, maxPx: 78, minPx: 30, color: "#FFD657" });
                  drawFittedLine(ctx, String(subtitleLine), { x: cx, y: dtH * 0.70, maxWidth, weight: 900, maxPx: 112, minPx: 34, color: "#FFFFFF" });
                } else {
                  drawFittedLine(ctx, String(titleLine), { x: cx, y: dtH * 0.52, maxWidth, weight: 900, maxPx: 116, minPx: 34, color: "#FFFFFF" });
                }

                dt.hasAlpha = true;
                dt.update();
                labelMat.emissiveTexture = dt;
                labelMat.opacityTexture = dt;
              } catch {}
            }
          } else if (isZoneRepNode) {
            // Legacy: destination-only labels on rep pano of the zone
            try {
              let labelText = "";
              let wantLabel = false;

              if (!isZone) {
                const targetNode = nodesById?.get?.(toId) || null;
                const nodeName = String(targetNode?.name || targetNode?.label || "").trim();
                if (nodeName) {
                  labelText = nodeName;
                  wantLabel = true;
                } else if (isZoneRepNode && primaryZoneLabelToId && String(toId) === String(primaryZoneLabelToId)) {
                  const zid = String(targetNode?.zoneId || "").trim();
                  const z = zid ? (data?.zones || []).find(zz => String(zz?.id) === zid) : null;
                  labelText = String(z?.name || "").trim();
                  wantLabel = !!labelText;
                }
              } else if (isZoneRepNode) {
                const zone = (data?.zones || []).find(z => String(z?.id) === String(toId));
                labelText = String(zone?.name || "").trim();
                wantLabel = !!labelText;
              }

              if (wantLabel && labelText) {
                const labelPlaneW = isXR ? 0.95 : (ringRadius * 2.45);
                const labelPlaneH = isXR ? 0.22 : (ringRadius * 0.80);
                const labelPlane = MeshBuilder.CreatePlane("hsLabel", { width: labelPlaneW, height: labelPlaneH }, scene);
                const labelMat = new StandardMaterial("hsLabelMat", scene);
                labelMat.disableLighting = true;
                labelMat.backFaceCulling = false;
                labelMat.disableDepthWrite = true;
                labelMat.zOffset = 3;
                labelMat.emissiveColor = Color3.White();
                labelPlane.material = labelMat;
                labelPlane.parent = ring || root;
                labelPlane.layerMask = layer;
                labelPlane.billboardMode = Mesh.BILLBOARDMODE_NONE;
                labelPlane.isPickable = false;
                labelPlane.renderingGroupId = 2;
                const labelGap = isXR ? 0.06 : Math.max(8, ringRadius * 0.14);
                labelPlane.position.y = -(ringRadius + (labelPlaneH * 0.5) + labelGap);
                labelPlane.position.z = isXR ? 0.03 : 0.06;
                try { labelPlane.showBoundingBox = false; labelPlane.isVisible = true; } catch {}

                const dtW = 1024;
                const dtH = 256;
                const dt = new DynamicTexture("hsLabelText", { width: dtW, height: dtH }, scene, false);
                try {
                  try { dt.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE); dt.anisotropicFilteringLevel = 8; } catch {}
                  const ctx = dt.getContext();
                  ctx.clearRect(0, 0, dtW, dtH);
                  ctx.textBaseline = "middle";
                  ctx.textAlign = "center";

                  const text = String(labelText);
                  const maxWidth = dtW * 0.86;

                  let fontPx = Math.round(dtH * 0.46);
                  while (fontPx > 18) {
                    ctx.font = `800 ${fontPx}px Inter, Arial, sans-serif`;
                    if (ctx.measureText(text).width <= maxWidth) break;
                    fontPx -= 4;
                  }
                  ctx.font = `800 ${fontPx}px Inter, Arial, sans-serif`;

                  const x = dtW / 2;
                  const y = dtH / 2;

                  ctx.shadowColor = "rgba(0,0,0,0.42)";
                  ctx.shadowBlur = 10;
                  ctx.shadowOffsetX = 0;
                  ctx.shadowOffsetY = 3;
                  ctx.fillStyle = "rgba(232, 234, 238, 0.92)";
                  ctx.fillText(text, x, y);

                  dt.hasAlpha = true;
                  dt.update();
                  labelMat.emissiveTexture = dt;
                  labelMat.opacityTexture = dt;
                } catch {}
              }
            } catch (e) { console.warn('[AGENT] Hotspot label creation failed', e); }
          }
        } catch (e) { console.warn('[AGENT] Hotspot label creation failed', e); }

      const pick=MeshBuilder.CreateSphere("hsPick",{diameter:pickDiameter,segments:12},scene);
      const pm=new StandardMaterial("hsPickMat",scene); pm.alpha=0.001; pm.disableLighting=true; pm.backFaceCulling=false;
      pick.material=pm; pick.parent=root; pick.isPickable=true; pick.layerMask = layer;
      const baseScale = (root.scaling && typeof root.scaling.x === 'number') ? root.scaling.x : 1;
      const meta = {
        hotspot:true,
        targetType: isZone ? 'zone' : (isInfo ? 'info' : 'node'),
        to: isInfo ? infoId : toId,
        zoneId: isZone ? String(toId) : undefined,
        yawDeg: (typeof h?.yaw === "number" && Number.isFinite(h.yaw)) ? h.yaw : 0,
        pitchDeg: (typeof h?.pitch === "number" && Number.isFinite(h.pitch)) ? h.pitch : 0,
        infoId: isInfo ? infoId : undefined,
        infoTitle: isInfo ? String(h?.title || "").trim() : undefined,
        infoSubtitle: isInfo ? String(h?.subtitle || "").trim() : undefined,
        infoFooter: isInfo ? String(h?.footer || "").trim() : undefined,
        ring,
          pulseRing,
	        root,
	        preview:null,
	        baseScale,
          hoverScale: hoverScaleFactor * baseScale,
          ringBaseColor: RING_GOLD.clone(),
          ringHoverColor: RING_GOLD_HOVER.clone(),
          pulsePhase: Math.random() * 10,
          pulseCycleSec: isXR ? 1.9 : 1.55,
          pulseMaxScale: isXR ? 0.55 : 0.95
      };
	      root.metadata = meta;
	      if (ring) ring.metadata = meta;
	      pick.metadata = meta;
      // Prefer authored direction vectors when present. Some pano sets can have yaw basis mismatches,
      // which makes yaw/pitch placement appear "missing" (hotspots end up behind/out of view).
      let v = null;
      try {
        const d = Array.isArray(h?.dir) ? h.dir : null;
        if (d && d.length >= 3) {
          const dx = Number(d[0]);
          const dy = Number(d[1]);
          const dz = Number(d[2]);
          if (Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)) {
            // Data dir uses +Z where our yaw/pitch helper uses -Z, so invert Z to match existing convention.
            const vv = new Vector3(dx, dy, (-dz) * yawSign);
            if (flipXLocal) vv.y *= -1;
            if (vv.lengthSquared() > 1e-10) {
              vv.normalize();
              v = vv.scale(R);
            }
          }
        }
      } catch {}
      if (!v) {
        // When dome is flipped vertically, invert Y coordinate for hotspots.
        v = vecFromYawPitch((h.yaw || 0) * yawSign, (h.pitch || 0), R, flipXLocal);
      }
      root.position.copyFrom(v);
      try{ root.lookAt(Vector3.Zero()); }catch{}
      try { _activeHotspots.push(meta); } catch {}
    }

    // One lightweight per-frame pulse animator for the currently-built hotspots.
    if (!_hotspotPulseObs) {
      _hotspotPulseObs = scene.onBeforeRenderObservable.add(() => {
        try {
          const now = performance.now() * 0.001;
          for (const meta of _activeHotspots) {
            const ringMesh = meta?.ring;
            const pulseMesh = meta?.pulseRing;
            const ringMat = ringMesh?.material;
            const pulseMat = pulseMesh?.material;
            const phase = Number(meta?.pulsePhase) || 0;
            const cycle = Math.max(0.8, Number(meta?.pulseCycleSec) || 1.6);
            const maxScale = Math.max(0.1, Number(meta?.pulseMaxScale) || 0.95);

            // Keep the base ring scale stable so any child label (anchored under the ring) doesn't
            // appear to move "front/back" as the ring breathes.
            try { if (ringMesh?.scaling) ringMesh.scaling.set(1, 1, 1); } catch {}

            // Outward radial pulse: scale expands and fades, then loops.
            const t = ((now + phase) % cycle) / cycle; // 0..1
            const ease = t * (2 - t); // easeOutQuad
            const s = 1 + ease * maxScale;
            const a = Math.max(0, 1 - ease);
            try { if (pulseMesh?.scaling) pulseMesh.scaling.set(s, s, 1); } catch {}
            try { if (pulseMat) pulseMat.alpha = 0.9 * Math.pow(a, 1.6); } catch {}

            // Hover tint is handled elsewhere; keep pulse tint in sync with base if available.
            try {
              const c = meta?.ringBaseColor;
              if (c && pulseMat?.emissiveColor?.copyFrom) pulseMat.emissiveColor.copyFrom(c);
            } catch {}
          }
        } catch {}
      });
    }
  }
  function buildHotspotsFor(node, forXR=false){
    try{
      XRDebugLog("buildHotspots", {
        nodeId: node?.id,
        forXR,
        count: Array.isArray(node?.hotspots) ? node.hotspots.length : 0,
        hasRoot: !!(forXR ? hotspotRootXR : hotspotRoot)
      });
    }catch{}
    clearHotspots();
    if (forXR){
      // XR domes are rendered unflipped on the X axis; avoid inverting hotspot Y
      buildHotspotsInRoot(node, hotspotRootXR, /*flipXLocal*/ false, /*isXR*/ true);
      try{ hotspotRoot.setEnabled(false); hotspotRootXR.setEnabled(true); }catch{}
    } else {
      buildHotspotsInRoot(node, hotspotRoot,   /*flipXLocal*/ flipX, /*isXR*/ false);
      try{ hotspotRoot.setEnabled(true); hotspotRootXR.setEnabled(false); }catch{}
    }
  }

let hoveredHotspot = null;
  async function ensurePreview(meta){
    // Disable hotspot preview textures to save memory
    return;
    try{
      if (!meta || meta.preview) return;
      let next = null;
      if (meta.targetType === 'zone' && meta.zoneId){
        try{
          const cur = nodesById.get(currentNodeId);
          const repId = resolveZoneRepresentativeNodeId(meta.zoneId, cur?.floorId || null);
          next = repId ? nodesById.get(repId) : null;
        }catch{}
      } else {
        next = nodesById.get(meta.to);
      }
      if (!next || !next.file) return;
      // Size preview to sit inside the ring (leave a small gutter)
      const ringSize = (meta?.ring?.getBoundingInfo?.()?.boundingBox?.extendSize?.x || 32) * 2;
      const size = Math.max(64, Math.min(280, ringSize * 0.86));

      const plane = MeshBuilder.CreatePlane("hsPrev", { size }, scene);
      const mat = new StandardMaterial("hsPrevMat", scene);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      mat.zOffset = 1;

      // Load the next node texture and map like main pano (mono crop for TB stereo)
      const tex = await getTexture(next.file);
      mat.emissiveTexture = tex;
      try { mapFor2D(tex, /*stereo*/ isStereo(), flipU); } catch {}

      // Circular opacity mask so the preview is perfectly round inside the ring
      try{
        const maskSize = 512;
        const dt = new DynamicTexture("hsPrevMask", { width: maskSize, height: maskSize }, scene, false);
        const ctx = dt.getContext();
        ctx.clearRect(0,0,maskSize,maskSize);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(maskSize/2, maskSize/2, (maskSize/2) * 0.98, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
        dt.hasAlpha = true; dt.update();
        mat.opacityTexture = dt; // use as alpha mask
      }catch{}

      plane.material = mat;
      plane.parent = meta.root;
      plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
      plane.layerMask = meta.root.layerMask;
      plane.isPickable = false;
      plane.renderingGroupId = 2;
      // Slightly in front so it feels inside the ring
      plane.position.z += 0.5;
      // Start slightly smaller; we animate to full on hover for an expanding reveal
      plane.scaling.set(0.85, 0.85, 0.85);
      meta.preview = plane;
    }catch{}
  }
  function removePreview(meta){ try{ meta?.preview?.dispose?.(); meta.preview=null; }catch{} }
  function setHotspotHover(meta, active){
    if (!meta) return;
    try{
      const ringMat = meta.ring?.material;
      if (ringMat?.emissiveColor) {
        const c = active ? (meta.ringHoverColor || meta.ringBaseColor) : (meta.ringBaseColor || null);
        if (c && ringMat.emissiveColor.copyFrom) ringMat.emissiveColor.copyFrom(c);
      }
      const pulseMat = meta.pulseRing?.material;
      if (pulseMat?.emissiveColor) {
        const c = active ? (meta.ringHoverColor || meta.ringBaseColor) : (meta.ringBaseColor || null);
        if (c && pulseMat.emissiveColor.copyFrom) pulseMat.emissiveColor.copyFrom(c);
      }
      // Ring scale animation
      if (meta.root?.scaling){
        const base = meta.baseScale || 1;
        const target = active ? (meta.hoverScale || base * 1.1) : base;
        meta.root.scaling.set(target, target, target);
      }
      // Preview: ensure exists and ease its scale for a subtle reveal
      if (active){
        ensurePreview(meta).then(()=>{
          try{
            const p = meta.preview; if (!p) return;
            const start = performance.now();
            const from = Math.min(1, Math.max(0.7, p.scaling.x));
            const to = 1.0;
            const dur = 160;
            const obs = scene.onBeforeRenderObservable.add(()=>{
              const t = Math.min(1, (performance.now()-start)/dur);
              const s = from + (to-from)*t;
              p.scaling.set(s,s,s);
              if(t>=1) try{ scene.onBeforeRenderObservable.remove(obs); }catch{}
            });
          }catch{}
        });
      } else {
        removePreview(meta);
      }
    }catch{}
  }
  function updateHotspotHover(meta){
    if (hoveredHotspot === meta) return;
    if (hoveredHotspot) setHotspotHover(hoveredHotspot, false);
    hoveredHotspot = meta || null;
    if (hoveredHotspot){ setHotspotHover(hoveredHotspot, true); ensurePreview(hoveredHotspot); }
  }

  function resolveHotspotTargetNodeId(meta){
    try{
      if (!meta) return null;
      const toId = meta?.to;
      if (!toId) return null;
      if (nodesById?.has?.(toId)) return toId;

      const zoneId = (meta?.targetType === 'zone' && meta?.zoneId) ? String(meta.zoneId) : null;
      if (!zoneId) return null;
      const cur = nodesById?.get?.(currentNodeId) || null;
      const repId = resolveZoneRepresentativeNodeId(zoneId, cur?.floorId || null);
      if (repId) return repId;

      return null;
    }catch{
      return null;
    }
  }

  // 2D pick + hover highlight
  let _tap = { active:false, pointerId:null, pointerType:'', startX:0, startY:0, startAt:0, moved:false, downMeta:null };
  const TAP_MOVE_PX = (pointerType) => (pointerType === 'touch' ? 14 : 8);
  const TAP_MAX_MS = (pointerType) => (pointerType === 'touch' ? 420 : 900);
  const tapReset = () => { _tap = { active:false, pointerId:null, pointerType:'', startX:0, startY:0, startAt:0, moved:false, downMeta:null }; };
  const tapKey = (meta) => {
    try{
      if (!meta || meta.hotspot !== true) return null;
      // Stable key across pointer down/up comparisons.
      const to = String(meta?.to || "");
      const zoneId = String(meta?.zoneId || "");
      const targetType = String(meta?.targetType || "");
      return `${targetType}|${to}|${zoneId}`;
    }catch{
      return null;
    }
  };
  scene.onPointerObservable.add(poi=>{
    // In XR, Babylon's pointer-selection feature simulates pointer events with a populated `pickInfo`.
    // Use that instead of screen-space `pointerX/Y` picking.
    if (inXR === true){
      try{
        if (poi.type===PointerEventTypes.POINTERMOVE || poi.type===PointerEventTypes.POINTERDOWN){
          const meta = poi?.pickInfo?.pickedMesh?.metadata?.hotspot ? poi.pickInfo.pickedMesh.metadata : null;
          updateHotspotHover(meta);
        }
        if (poi.type===PointerEventTypes.POINTERUP){
          const md = poi?.pickInfo?.pickedMesh?.metadata;
           if (md?.hotspot){
             const targetId = resolveHotspotTargetNodeId(md);
            if (targetId) goTo(targetId, { source: 'user', broadcast: true, preserveHeading: { clickedYawDeg: md?.yawDeg } });
           }
          updateHotspotHover(null);
        }
      }catch{}
      return;
    }

    const ev = poi?.event || null;
    const pointerId = ev?.pointerId ?? null;
    const pointerType = String(ev?.pointerType || '');

    if (poi.type===PointerEventTypes.POINTERDOWN){
      const hit=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
      const meta = hit?.pickedMesh?.metadata?.hotspot ? hit.pickedMesh.metadata : null;
      updateHotspotHover(meta);
      _tap = {
        active: true,
        pointerId,
        pointerType,
        startX: Number(ev?.clientX) || 0,
        startY: Number(ev?.clientY) || 0,
        startAt: (typeof ev?.timeStamp === 'number' ? ev.timeStamp : performance.now()),
        moved: false,
        downMeta: meta || null
      };
    }

    if (poi.type===PointerEventTypes.POINTERMOVE){
      const hit=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
      const meta = hit?.pickedMesh?.metadata?.hotspot ? hit.pickedMesh.metadata : null;
      updateHotspotHover(meta);

      // If the user is rotating/dragging the view, don't treat the eventual POINTERUP as a tap.
      if (_tap.active && (_tap.pointerId == null || _tap.pointerId === pointerId)) {
        const dx = (Number(ev?.clientX) || 0) - (_tap.startX || 0);
        const dy = (Number(ev?.clientY) || 0) - (_tap.startY || 0);
        const dist = Math.hypot(dx, dy);
        if (dist > TAP_MOVE_PX(pointerType)) _tap.moved = true;
      }
    }

    if (poi.type===PointerEventTypes.POINTERUP){
      const pick=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
      const md = pick?.pickedMesh?.metadata;

      // Only navigate on a clean tap: finger/mouse down on hotspot, minimal movement, and up on same hotspot.
      const isSamePointer = (_tap.pointerId == null || _tap.pointerId === pointerId);
      const elapsedMs = (() => {
        const now = (typeof ev?.timeStamp === 'number' ? ev.timeStamp : performance.now());
        const start = Number(_tap.startAt) || 0;
        return Math.max(0, now - start);
      })();
      const okTap = _tap.active && isSamePointer && !_tap.moved && elapsedMs <= TAP_MAX_MS(_tap.pointerType || pointerType);
      if (okTap && md?.hotspot && _tap.downMeta?.hotspot){
        const downK = tapKey(_tap.downMeta);
        const upK = tapKey(md);
         if (downK && upK && downK === upK) {
           const targetId = resolveHotspotTargetNodeId(md);
          if (targetId) goTo(targetId, { source: 'user', broadcast: true, preserveHeading: { clickedYawDeg: md?.yawDeg } });
         }
      }
      tapReset();
      updateHotspotHover(null);
    }
  });
  canvas.addEventListener("pointerleave", ()=>{ tapReset(); updateHotspotHover(null); }, { passive:true });
  canvas.addEventListener("pointercancel", ()=>{ tapReset(); updateHotspotHover(null); }, { passive:true });

  /* minimap */
  let mini = null;
  let minimapMode = "nodes";
  const minimapPointsByFloor = new Map();
  const minimapZonesByFloor = new Map();
  const zoneRepById = new Map();
  let api = null;

  function getActiveMinimapId(){
    if (minimapMode !== "zones") return currentNodeId;
    const cur = nodesById.get(currentNodeId);
    if (cur?.zoneId) return cur.zoneId;
    for (const [zoneId, nodeId] of zoneRepById.entries()){
      if (nodeId === currentNodeId) return zoneId;
    }
    return null;
  }

  function rebuildMinimap(){
    document.querySelectorAll(".mini-wrap").forEach(el=>el.remove());
    minimapMode = "nodes";
    minimapPointsByFloor.clear();
    minimapZonesByFloor.clear();
    zoneRepById.clear();

    const padByFloor = new Map(data.floors.map(f=>[f.id,{x:0,y:0}]));
    const floorMetaById = new Map(data.floors.map(f=>[f.id, f]));
    // Coordinate reference per floor: auto-detect from zones (preferred) or nodes
    const coordByFloor = new Map(); // fid -> { w, h }
    const originByFloor = new Map(); // fid -> { x, y }
    const extentsByFloor = new Map(); // fid -> { minX, minY, maxX, maxY }
    const widenExtent = (fid, x, y)=>{
      if (!fid) return;
      const px = Number(x);
      const py = Number(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      const cur = extentsByFloor.get(fid) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      if (px < cur.minX) cur.minX = px;
      if (px > cur.maxX) cur.maxX = px;
      if (py < cur.minY) cur.minY = py;
      if (py > cur.maxY) cur.maxY = py;
      extentsByFloor.set(fid, cur);
    };

    const fallbackFloorId = data?.floors?.[0]?.id || null;
    const nodeList = Array.isArray(data?.nodes) ? data.nodes : [];
    const hasZones = Array.isArray(data?.zones) && data.zones.length > 0;
    if (hasZones){
      minimapMode = "zones";
      const centroid = (pts)=>{
        if (!Array.isArray(pts) || pts.length === 0) return { x: 0, y: 0 };
        let sx=0, sy=0;
        for (const p of pts){
          sx += Number(p?.x) || 0;
          sy += Number(p?.y) || 0;
        }
        return { x: sx/pts.length, y: sy/pts.length };
      };
      for (const z of (data.zones || [])){
        const floorId = z?.floorId || fallbackFloorId;
        if (!floorId) continue;
        const points = Array.isArray(z.points) ? z.points : [];
        for (const p of points){
          widenExtent(floorId, p?.x, p?.y);
        }
        let repId = resolveZoneRepresentativeNodeId(z.id, floorId);
        if (!repId){
          repId = startNodeId || (nodesById.size ? nodesById.values().next().value?.id : null);
        }
        if (repId) zoneRepById.set(z.id, repId);
        // Dot position = explicit repPoint if provided, else polygon centroid
        let px = 0, py = 0;
        if (z && typeof z === 'object' && z.repPoint && Number.isFinite(Number(z.repPoint.x)) && Number.isFinite(Number(z.repPoint.y))){
          px = Number(z.repPoint.x) || 0;
          py = Number(z.repPoint.y) || 0;
        } else {
          const c = centroid(points);
          px = Number(c.x) || 0;
          py = Number(c.y) || 0;
        }
        if (!minimapPointsByFloor.has(floorId)) minimapPointsByFloor.set(floorId, []);
        minimapPointsByFloor.get(floorId).push({
          id: z.id,
          x: px,
          y: py,
          label: (typeof z.name === "string" ? z.name.trim() || z.id : z.id)
        });
        if (!minimapZonesByFloor.has(floorId)) minimapZonesByFloor.set(floorId, []);
        minimapZonesByFloor.get(floorId).push({ id: z.id, points: (z.points||[]).map(p=>({x:p.x,y:p.y})), label: (typeof z.name==='string'? z.name : z.id) });
      }
    } else {
      minimapMode = "nodes";
      for (const n of nodeList){
        if (!n) continue;
        const floorId = n.floorId || fallbackFloorId;
        if (!floorId) continue;
        const px = Number(n.x);
        const py = Number(n.y);
        if (!minimapPointsByFloor.has(floorId)) minimapPointsByFloor.set(floorId, []);
        minimapPointsByFloor.get(floorId).push({
          id: n.id,
          x: Number.isFinite(px) ? px : 0,
          y: Number.isFinite(py) ? py : 0,
          label: (typeof n.label === "string" ? n.label : undefined),
          name: (typeof n.name === "string" ? n.name : undefined)
        });
      }
    }
    for (const n of nodeList){
      if (!n) continue;
      widenExtent(n.floorId, n.x, n.y);
    }
      for (const f of data.floors){
        const meta = floorMetaById.get(f.id) || f || {};
        // Authoring exports usually express all minimap coordinates in the floorplan coordinate space:
        // `planWidth/planHeight` (or `planImageWidth/planImageHeight`).
        // Use those as the coordinate reference so minimap pins land exactly where authored,
        // even if the actual floorplan image is a different pixel size.
        const explicitW = Number(meta?.width ?? meta?.w ?? meta?.imageWidth ?? meta?.planWidth ?? meta?.planImageWidth ?? 0);
        const explicitH = Number(meta?.height ?? meta?.h ?? meta?.imageHeight ?? meta?.planHeight ?? meta?.planImageHeight ?? 0);
        const hasExplicitSize = explicitW > 0 && explicitH > 0;

      const explicitOriginXRaw = meta?.originX;
      const explicitOriginYRaw = meta?.originY;
      const hasExplicitOrigin = Number.isFinite(Number(explicitOriginXRaw)) && Number.isFinite(Number(explicitOriginYRaw));
      const explicitOriginX = hasExplicitOrigin ? Number(explicitOriginXRaw) : 0;
      const explicitOriginY = hasExplicitOrigin ? Number(explicitOriginYRaw) : 0;

      const e = extentsByFloor.get(f.id);
      const spanX = e && Number.isFinite(e.maxX) && Number.isFinite(e.minX) ? (e.maxX - e.minX) : 0;
      const spanY = e && Number.isFinite(e.maxY) && Number.isFinite(e.minY) ? (e.maxY - e.minY) : 0;

      

      if (hasExplicitSize){
        let originX = hasExplicitOrigin ? explicitOriginX : 0;
        let originY = hasExplicitOrigin ? explicitOriginY : 0;
        let refW = explicitW;
        let refH = explicitH;
        if (e){
          if (Number.isFinite(e.minX) && e.minX < originX) originX = e.minX;
          if (Number.isFinite(e.minY) && e.minY < originY) originY = e.minY;
          if (Number.isFinite(e.maxX)) refW = Math.max(refW, e.maxX - originX);
          if (Number.isFinite(e.maxY)) refH = Math.max(refH, e.maxY - originY);
        }
        originByFloor.set(f.id, { x: originX, y: originY });
        if (refW > 0 && refH > 0) coordByFloor.set(f.id, { w: refW, h: refH });
        continue;
      }

    // If no explicit size/origin, rely on image natural size with origin (0,0) in minimap DOM.
    }
    const coordsModePref = "auto";
    const MINI_WIDTH_DEFAULT = "clamp(240px, min(52vw, 44vh), 520px)";
    const MINI_MAP_HEIGHT = "clamp(260px, 44vh, 560px)";
    const expIdForUI = expName();
    const expLower = String(expIdForUI || "").toLowerCase();
    const isEastWestVilla = expLower.includes("east villa") || expLower.includes("west villa");
    const VILLA_MINI_WIDTH = "clamp(220px, min(44vw, 38vh), 440px)";
    const VILLA_MINI_MAP_HEIGHT = "clamp(220px, 38vh, 500px)";
    const miniWidth = isEastWestVilla ? VILLA_MINI_WIDTH : MINI_WIDTH_DEFAULT;
    const miniMapHeight = isEastWestVilla ? VILLA_MINI_MAP_HEIGHT : MINI_MAP_HEIGHT;
    const floorsPlacement = "outside";

    function pickStartNodeIdForFloor(fid){
      try{
        const floorId = String(fid || "");
        if (!floorId) return null;

        // Prefer the first ordered zone on that floor (zone-order.json already applied to data.zones).
        const byFloor = minimapPointsByFloor.get(floorId) || [];
        const firstZoneId = minimapMode === "zones" ? String(byFloor?.[0]?.id || "") : "";
        if (firstZoneId) {
          const rep = zoneRepById.get(firstZoneId) || resolveZoneRepresentativeNodeId(firstZoneId, floorId) || null;
          if (rep && nodesById.has(rep)) return rep;
        }

        // Fallback: first node on that floor.
        const firstNode = nodeList.find(n => String(n?.floorId || "") === floorId);
        if (firstNode?.id && nodesById.has(firstNode.id)) return firstNode.id;

        return startNodeId || null;
      }catch{
        return startNodeId || null;
      }
    }

    mini = buildMinimapDOM({
      floors:data.floors, basePath:BASE, padByFloor, coordsMode: "auto", ui:"dropdown", 
      // Use auto mapping so authored pixel coordinates land exactly where placed on the floorplan.
      // (Some experiences have clustered points; forcing "editor" shifts them via normalization/insets.)
      mappingMode: "auto",
      panelWidth: miniWidth, mapHeight: miniMapHeight, floorsPlacement, position:"top-right", paddingPx:6, 
      coordByFloor, 
      originByFloor, 
      zonesByFloor: minimapZonesByFloor, 
      onSelectNode:id=>{
        if (!id) return;
        if (minimapMode === "zones"){
          const targetId = zoneRepById.get(id) || resolveZoneRepresentativeNodeId(id, nodesById.get(currentNodeId)?.floorId || null) || startNodeId || null;
          if (targetId) goTo(targetId, { source: 'user', broadcast: true });
          return;
        }
        goTo(id, { source: 'user', broadcast: true });
      },
      onFloorChange:(fid, meta)=>{
        mini.renderZones(minimapZonesByFloor.get(fid) || [], (nodesById.get(currentNodeId)||{}).zoneId || null);
        const active = getActiveMinimapId();
        // In zones mode, show one dot per zone (rep point) so users can jump between zones quickly.
        const list = minimapPointsByFloor.get(fid) || [];
        mini.renderPoints(list, active);
        updateMinimapTorch();

        if (String(meta?.source || "") === "user-floor") {
          const target = pickStartNodeIdForFloor(fid);
          if (target && target !== currentNodeId) goTo(target, { source: "user", broadcast: true });
        }
      }
    });
    const cur = nodesById.get(currentNodeId) || nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null);
    if (cur){
      mini.setActiveFloor(cur.floorId,true,true,{ source: "program" });
      mini.renderZones(minimapZonesByFloor.get(cur.floorId) || [], (nodesById.get(currentNodeId)||{}).zoneId || null);
      const active = getActiveMinimapId();
      const list = minimapPointsByFloor.get(cur.floorId) || [];
      mini.renderPoints(list, active);
      updateMinimapTorch();
    }
  }
  rebuildMinimap();

  // XR controller shortcuts (Quest / Touch controllers):
  // - Right controller A: next floor
  // - Right controller B: next experience
  function cycleMinimapFloor(delta = 1){
    try{
      if (!mini || !Array.isArray(data?.floors) || data.floors.length < 2) return;
      const floors = data.floors.map((f) => String(f?.id || "")).filter(Boolean);
      if (floors.length < 2) return;
      const cur = String(mini.getCurrentFloorId?.() || "");
      let idx = floors.indexOf(cur);
      if (idx < 0) idx = 0;
      const next = floors[(idx + delta + floors.length) % floors.length];
      // Trigger minimap's floor-change behavior (including optional jump to that floor's rep node).
      mini.setActiveFloor?.(next, true, true, { source: "user-floor", via: "xr-a" });
    }catch{}
  }
  async function cycleExperience(delta = 1){
    try{
      const ids = experienceIds;
      if (!Array.isArray(ids) || ids.length < 2) return;
      const cur = String(expName() || "").trim();
      let idx = ids.indexOf(cur);
      if (idx < 0) idx = 0;
      const next = ids[(idx + delta + ids.length) % ids.length];
      if (next && next !== cur) {
        await api?.switchExperience?.(next);
      }
    }catch{}
  }

  // Torch (orientation wedge) on minimap
  function getActiveZoneFirstPoint(){
    try{
      const cur = nodesById.get(currentNodeId);
      if (!cur) return null;
      const fid = cur.floorId;
      const zid = cur.zoneId;
      const zones = minimapZonesByFloor.get(fid) || [];
      const z = zones.find(s=>s.id===zid);
      if (!z || !Array.isArray(z.points) || !z.points.length) return null;
      if (z.repPoint && Number.isFinite(Number(z.repPoint.x)) && Number.isFinite(Number(z.repPoint.y))){
        return { floorId: fid, x: Number(z.repPoint.x)||0, y: Number(z.repPoint.y)||0 };
      }
      let sx=0, sy=0; for (const p of z.points){ sx+=Number(p?.x)||0; sy+=Number(p?.y)||0; }
      const cx=sx/z.points.length, cy=sy/z.points.length;
      return { floorId: fid, x: cx||0, y: cy||0 };
    }catch{ return null; }
  }
  function computeHeadingForMap(){
    try{
      const cur = nodesById.get(currentNodeId);
      if (!cur) return 0;
      const meta = (data?.floors||[]).find(f=>f.id===cur.floorId) || {};
      const DEFAULT_MAP_YAW_OFFSET_DEG = (Number(import.meta?.env?.VITE_MAP_YAW_OFFSET) || -90);
      const offsetDeg = Number(meta?.mapYawOffset ?? meta?.northDeg ?? meta?.rotationDeg ?? DEFAULT_MAP_YAW_OFFSET_DEG) || 0;
      const offset = rad(offsetDeg);
      // Camera heading relative to world + optional floor offset
      return (worldYaw + cam.rotation.y + offset);
    }catch{ return 0; }
  }
  
  // Get north offset for current floor (used for compass)
  function getFloorNorthDeg(){
    try{
      const cur = nodesById.get(currentNodeId);
      if (!cur) return 0;
      const meta = (data?.floors||[]).find(f=>f.id===cur.floorId) || {};
      return Number(meta?.northDeg ?? 0) || 0;
    }catch{ return 0; }
  }
  
  // Update the compass dial to show true north based on viewing direction
  function updateCompassDial(){
    try{
      const compassDial = document.getElementById('compassDial');
      const compassText = document.getElementById('compassText');
      const compassDirection = document.getElementById('compassDirection');
      if (!compassDial) return;
      
      // Get the current viewing direction relative to true north
      // worldYaw + cam.rotation.y gives the current view heading in radians
      // northDeg from floor data tells us where north is on the floor plan
      const northDeg = getFloorNorthDeg();
      const viewHeadingRad = worldYaw + cam.rotation.y;
      const viewHeadingDeg = viewHeadingRad * 180 / Math.PI;
      
      // The compass dial should rotate opposite to the view direction
      // so that "N" points to true north relative to current view
      // Adjust by northDeg to account for floor plan orientation
      const dialRotation = -viewHeadingDeg - northDeg;
      compassDial.style.transform = `rotate(${dialRotation}deg)`;
      
      // Update compass text to show current heading (0-360 degrees from north)
      // Normalize heading to 0-360 range
      let headingFromNorth = (viewHeadingDeg + northDeg) % 360;
      if (headingFromNorth < 0) headingFromNorth += 360;
      headingFromNorth = Math.round(headingFromNorth);
      
      // Show cardinal direction
      let cardinal = 'N';
      if (headingFromNorth >= 337.5 || headingFromNorth < 22.5) cardinal = 'N';
      else if (headingFromNorth >= 22.5 && headingFromNorth < 67.5) cardinal = 'NE';
      else if (headingFromNorth >= 67.5 && headingFromNorth < 112.5) cardinal = 'E';
      else if (headingFromNorth >= 112.5 && headingFromNorth < 157.5) cardinal = 'SE';
      else if (headingFromNorth >= 157.5 && headingFromNorth < 202.5) cardinal = 'S';
      else if (headingFromNorth >= 202.5 && headingFromNorth < 247.5) cardinal = 'SW';
      else if (headingFromNorth >= 247.5 && headingFromNorth < 292.5) cardinal = 'W';
      else if (headingFromNorth >= 292.5 && headingFromNorth < 337.5) cardinal = 'NW';
      
      if (compassText){
        compassText.textContent = `${headingFromNorth} ${cardinal}`;
      }
      if (compassDirection){
        compassDirection.textContent = cardinal;
      }
    }catch{}
  }
  
  function updateMinimapTorch(){
    try{
      if (!mini) return;
      const pp = getActiveZoneFirstPoint();
      if (!pp) { mini.setTorchPose({ visible:false }); return; }
      mini.setTorchPose({ floorId: pp.floorId, x: pp.x, y: pp.y, yawRad: computeHeadingForMap(), visible:true });
    }catch{}
    // Also update compass dial
    updateCompassDial();
  }

  /* move then swap */
  function easeInOutSine(t){ return -(Math.cos(Math.PI*t)-1)/2; }
  function cubicBezier(p0, p1, p2, p3, t){
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    const uuu = uu * u;
    const ttt = tt * t;
    const out = p0.scale(uuu);
    out.addInPlace(p1.scale(3 * uu * t));
    out.addInPlace(p2.scale(3 * u * tt));
    out.addInPlace(p3.scale(ttt));
    return out;
  }
  function forwardPushThenSwap(nextNode, prevNode = null, options = {}){
    const duration = Number.isFinite(options?.duration) ? options.duration : NAV_DUR_MS;
    const basePush = Number.isFinite(options?.push) ? options.push : NAV_PUSH_M;
    const source = typeof options?.source === 'string' ? options.source.toLowerCase() : 'program';
    const inXRMode = inXR === true;
    const push = inXRMode ? basePush * 0.35 : basePush;
    const lerp = (a,b,t)=>a + (b - a) * Math.max(0, Math.min(1, t));
    const startPos = worldRoot.position.clone();
    const targetPos = nodeWorldPos(nextNode);
    // Forward-only flythrough: no worldRoot rotation during travel.
    const activeCam = inXRMode ? (xr?.baseExperience?.camera || cam) : cam;
    let forward = null;
    try { forward = activeCam?.getForwardRay?.(1)?.direction?.clone?.(); } catch {}
    if (!forward || !Number.isFinite(forward.x) || !Number.isFinite(forward.z) || (forward.lengthSquared?.() || 0) < 1e-6) {
      forward = new Vector3(0, 0, -1);
    }
    forward.y = 0;
    if ((forward.lengthSquared?.() || 0) < 1e-6) forward = new Vector3(0, 0, -1);
    forward.normalize();
    const delta = targetPos.subtract(startPos);
    const distance = delta.length();
    const travelDir = distance > 1e-4 ? delta.normalize() : forward.clone();
    const startMag = Math.max(push * 0.65, Math.min(distance + push * 0.35, push * 1.8));
    const endMag = Math.max(push * 0.4, Math.min(distance * 0.6, push * 1.2));
    const ctrl1 = startPos.add(forward.scale(startMag));
    const ctrl2 = targetPos.subtract(travelDir.scale(endMag));
    const liftScale = inXRMode ? 0.3 : 1;
    const lift = Math.min(1.2, Math.max(0.2, startMag * 0.1 * liftScale));
    ctrl1.y += lift;
    ctrl2.y += lift * 0.5;
    const baseMs = duration + 480;
    const travelFactor = Math.max(1, (distance + 0.5) / Math.max(0.4, push * 0.5));
    let travelMs = Math.max(900, Math.min(2400, baseMs * travelFactor));
    if (inXRMode) {
      // Much slower easing for immersive comfort
      travelMs = Math.max(2600, Math.min(5200, travelMs * 2.5));
    }
    const preserveRelYawRadOnSwap = Number.isFinite(options?.preserveRelYawRadOnSwap)
      ? wrapRad(Number(options.preserveRelYawRadOnSwap))
      : null;
    const beforeApply = preserveRelYawRadOnSwap !== null
      ? () => _applyRelativeViewYawRad(preserveRelYawRadOnSwap)
      : null;

    // If we're preserving heading, avoid crossfade: rotating during a fade can make it look like
    // the camera "readjusts after load" (the old pano would visibly rotate under the fade).
    const forceCross = options?.forceCrossfade === true;
    const useCross = (!inXRMode) && (preserveRelYawRadOnSwap === null) && (forceCross || wantsCrossfade());
    
    const startFov = cam.fov;
    const midFov = Math.max(0.70, Math.min(startFov - (inXRMode ? 0.03 : 0.12), 1.05));
    const destFov = startFov;
    const travelPromise = new Promise((resolve) => {
      const startTime = performance.now();
      const observer = scene.onBeforeRenderObservable.add(() => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(1, elapsed / travelMs);
        const eased = easeInOutSine(t);
        const pos = cubicBezier(startPos, ctrl1, ctrl2, targetPos, eased);
        worldRoot.position.copyFrom(pos);
        const focus = Math.sin(Math.min(Math.PI, eased * Math.PI));
        cam.fov = startFov - (startFov - midFov) * focus;
        if (t >= 1) {
          scene.onBeforeRenderObservable.remove(observer);
          cam.fov = destFov;
          resolve();
        }
      });
    });
    const texturePromise = useCross ? getTexture(nextNode.file).catch(()=>null) : Promise.resolve(null);
    return texturePromise.then((tex)=>{
      const fadeDelay = Math.round(travelMs * 0.25);
      const fadeMs = Math.max(420, Math.min(1400, travelMs * 0.7));
      const transitionPromise = (useCross && tex)
        ? runCrossFade(nextNode.file, tex, fadeMs, fadeDelay)
        : showFile(nextNode.file, beforeApply ? { beforeApply } : {});
      return Promise.all([travelPromise, transitionPromise]);
    }).catch(()=>Promise.all([travelPromise, showFile(nextNode.file, beforeApply ? { beforeApply } : {})])).then(()=>{
      worldRoot.position.copyFrom(targetPos);
      buildHotspotsFor(nextNode, /*forXR*/ inXR === true);
    });
  }
  let navLock=false;
  let lastNodeId = null;

  function _relativeViewYawRadNow(){
    try{
      const panoYaw = (inXR === true) ? (Number(xrYawOffset) || 0) : (Number(worldRoot?.rotation?.y) || 0);
      if (inXR === true && xr?.baseExperience?.camera){
        const dir = xr.baseExperience.camera.getForwardRay().direction;
        const headYaw = Math.atan2(-dir.x, -dir.z);
        return wrapRad(headYaw - panoYaw);
      }
      return wrapRad((Number(cam?.rotation?.y) || 0) - panoYaw);
    }catch{
      return 0;
    }
  }

  function _applyRelativeViewYawRad(targetRelYawRad){
    const rel = wrapRad(targetRelYawRad);
    try{
      if (inXR === true && xr?.baseExperience?.camera){
        const dir = xr.baseExperience.camera.getForwardRay().direction;
        const headYaw = Math.atan2(-dir.x, -dir.z);
        const nextPanoYaw = wrapRad(headYaw - rel);
        xrYawOffset = nextPanoYaw;
        try { xrContentRoot.rotation.y = nextPanoYaw; } catch {}
        return;
      }
    }catch{}
    try{
      const panoYaw = Number(worldRoot?.rotation?.y) || 0;
      cam.rotation.y = wrapRad(panoYaw + rel);
    }catch{}
  }

  function _backHotspotYawDeg(nextNode, prevNodeId){
    try{
      const hs = Array.isArray(nextNode?.hotspots) ? nextNode.hotspots : [];
      for (const h of hs){
        const kind = String(h?.type || 'walk').toLowerCase();
        if (kind === 'zone' || kind === 'info') continue;
        if (String(h?.to || '') === String(prevNodeId || '')) {
          const y = Number(h?.yaw);
          if (Number.isFinite(y)) return y;
        }
      }
    }catch{}
    return null;
  }
  function pickNextInZoneByHotspot(cur, prevId = null){
    if (!cur?.zoneId || !Array.isArray(cur?.hotspots) || !cur.hotspots.length) return null;
    const zoneId = String(cur.zoneId);
    // Prefer a walk hotspot that doesn't go back to the previous node
    for (const h of cur.hotspots){
      const kind = String(h?.type || 'walk').toLowerCase();
      if (kind === 'zone') continue;
      const to = h?.to;
      if (!to || !nodesById.has(to)) continue;
      const next = nodesById.get(to);
      if (String(next?.zoneId || '') !== zoneId) continue;
      if (prevId && to === prevId) continue;
      return to;
    }
    // Fallback: first in-zone walk hotspot (even if it goes back)
    for (const h of cur.hotspots){
      const kind = String(h?.type || 'walk').toLowerCase();
      if (kind === 'zone') continue;
      const to = h?.to;
      if (!to || !nodesById.has(to)) continue;
      const next = nodesById.get(to);
      if (String(next?.zoneId || '') !== zoneId) continue;
      return to;
    }
    return null;
  }
  function goTo(targetId, opts = {}){
    if (navLock) return Promise.resolve();
    if (!(targetId && targetId!==currentNodeId)) return Promise.resolve();
    const node=nodesById.get(targetId); if(!node) return Promise.resolve();
    const prevNode = nodesById.get(currentNodeId) || null;

    // Heading continuity ("walk" feel):
    // When clicking a hotspot while looking in some direction, keep that direction consistent after navigation.
    // Compute the camera's yaw offset vs the clicked hotspot, then apply it at the exact pano swap moment
    // (so it doesn't visibly rotate after the new pano loads).
    let preserveHeading = null;
    try{
      const clickedYawDeg = Number(opts?.preserveHeading?.clickedYawDeg);
      if (prevNode && Number.isFinite(clickedYawDeg)) {
        const relNow = _relativeViewYawRadNow();
        const relToClicked = wrapRad(rad(clickedYawDeg - 90));
        const offsetRad = wrapRad(relNow - relToClicked);
        preserveHeading = { prevNodeId: prevNode.id, clickedYawDeg, offsetRad };
      }
    }catch{ preserveHeading = null; }

    let preserveRelYawRadOnSwap = null;
    try{
      if (preserveHeading && preserveHeading.prevNodeId) {
        const backYaw = _backHotspotYawDeg(node, preserveHeading.prevNodeId);
        const baseYawDeg = Number.isFinite(Number(backYaw))
          ? ((Number(backYaw) + 180) % 360)
          : ((Number(preserveHeading.clickedYawDeg) % 360) + 360) % 360;
        preserveRelYawRadOnSwap = wrapRad(rad(baseYawDeg - 90) + (Number(preserveHeading.offsetRad) || 0));
      }
    }catch{ preserveRelYawRadOnSwap = null; }

    lastNodeId = prevNode?.id || null;
    navLock=true; currentNodeId=node.id;
    try{ console.info('[AGENT] goTo', node.id, node.file); }catch{}
    const source = String(opts?.source || 'program').toLowerCase();
    lastNavigateSource = source;
    const shouldBroadcast = opts?.broadcast !== undefined ? Boolean(opts.broadcast) : (source !== 'program');
    const shouldSync = opts?.sync !== undefined ? Boolean(opts.sync) : shouldBroadcast;

    // Important: broadcast the node switch immediately so viewers start transitioning
    // at the same time as the guide, instead of waiting for the local travel animation to finish.
    if (shouldSync) {
      try { sendSync(currentNodeId); } catch {}
    }
    
    // Show zone name overlay when entering a new zone
    checkAndShowZone(node);
    
    // Analytics: track node visit
    try {
      const zone = (data?.zones || []).find(z => z.id === node.zoneId);
      trackNodeVisit(node.id, node.file, node.zoneId, zone?.name || node.zoneId);
      trackHotspot(prevNode?.id, node.id, source);
    } catch {}
    
    try { dispatchEvent(new CustomEvent('agent:navigate', { detail: { nodeId: currentNodeId, source } })); } catch {}
    const fid=node.floorId; mini?.setActiveFloor(fid,true,true,{ source: "nav" });
    mini?.renderZones(minimapZonesByFloor.get(fid) || [], node.zoneId || null);
    const list = minimapPointsByFloor.get(fid) || [];
    const activeMiniId = minimapMode === "zones" ? (node.zoneId || null) : node.id;
    mini?.renderPoints(list, activeMiniId);
    updateMinimapTorch();
    const faceHotspot = Boolean(opts?.faceHotspot);
    return forwardPushThenSwap(node, prevNode, {
      duration: opts?.duration,
      push: opts?.push,
      forceCrossfade: opts?.forceCrossfade === true,
      preserveRelYawRadOnSwap,
      source
    })
      .then(()=>{
        if (shouldSync) {
          sendSync(currentNodeId);
        }
      })
      .finally(()=>{ navLock=false; });
  }

  /* ===== Mirror grid (multi-UID) ===== */
  // Mirror viewport panel anchored to bottom-right
  const PANEL = { x: 1 - 0.20 - 0.02, y: 1 - 0.26 - 0.02, w: 0.20, h: 0.26 };
  const viewers = new Map(); // uid -> {cam, root, nodeId, last, yaw?, pitch?}
  let _mirrorCams = [];
  let mirrorVisible = true;
  let mirrorPrimary = false;        // when true -> mirror grid is large and main cam small
  let mirrorExpanded = false;
  const MIRROR_DEBUG = (()=>{ try{ return new URLSearchParams(location.search).has('mirrordebug'); }catch{ return false; } })();

  const hud = document.getElementById("mirrorHud");
  const mirrorFrameEl = document.getElementById("vrMirrorFrame");
  const mirrorFrameWindowEl = mirrorFrameEl?.querySelector?.(".vr-mirror-window") || null;
  const mirrorFrameViewportEl = mirrorFrameEl?.querySelector?.(".vr-mirror-viewport") || null;
  const mirrorFrameToggleBtn = document.getElementById("vrMirrorToggle");

  const VR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="vrG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,0.95)"/><stop offset="1" stop-color="rgba(255,255,255,0.72)"/></linearGradient></defs><path d="M12 3.2c-3.3 0-6 2.5-6.3 5.6h12.6c-.3-3.1-3-5.6-6.3-5.6Z" fill="none" stroke="url(#vrG)" stroke-width="1.7" stroke-linecap="round"/><path d="M5.2 9.4c-1.2.2-2.2 1.2-2.2 2.5v3.2c0 1.4 1.2 2.6 2.6 2.6h1.3c.8 0 1.6-.4 2.1-1.1l.8-1.1c.2-.3.5-.4.8-.4h2.8c.3 0 .6.1.8.4l.8 1.1c.5.7 1.3 1.1 2.1 1.1h1.3c1.4 0 2.6-1.2 2.6-2.6v-3.2c0-1.3-1-2.3-2.2-2.5" fill="none" stroke="url(#vrG)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.1 12.8h2.8M13.1 12.8h2.8" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2.8" stroke-linecap="round"/><path d="M5.7 9.6c.9.6 1.6 1.6 2 2.6M18.3 9.6c-.9.6-1.6 1.6-2 2.6" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="1.5" stroke-linecap="round"/></svg>';
  function applyMirrorSize(){
    if (!mirrorFrameEl) return;
    try { mirrorFrameEl.setAttribute('data-size', mirrorExpanded ? 'lg' : 'sm'); } catch {}
    try { localStorage.setItem('vrMirrorSize', mirrorExpanded ? 'lg' : 'sm'); } catch {}
  }
  function readMirrorSmallPos(){
    try{
      const raw = localStorage.getItem('vrMirrorPos');
      if (!raw) return null;
      const data = JSON.parse(raw);
      const left = Number(data?.left);
      const top = Number(data?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left, top };
    }catch{
      return null;
    }
  }
  function writeMirrorSmallPos({ left, top } = {}){
    try{
      const l = Number(left);
      const t = Number(top);
      if (!Number.isFinite(l) || !Number.isFinite(t)) return;
      localStorage.setItem('vrMirrorPos', JSON.stringify({ left: Math.round(l), top: Math.round(t) }));
    }catch{}
  }
  function applyMirrorSmallPos(){
    if (!mirrorFrameEl) return;
    const pos = readMirrorSmallPos();
    if (!pos) {
      try{ mirrorFrameEl.removeAttribute('data-dragged'); }catch{}
      try{
        mirrorFrameEl.style.left = '';
        mirrorFrameEl.style.top = '';
        mirrorFrameEl.style.right = '';
        mirrorFrameEl.style.bottom = '';
      }catch{}
      return;
    }
    try{
      mirrorFrameEl.setAttribute('data-dragged','1');
      mirrorFrameEl.style.left = `${pos.left}px`;
      mirrorFrameEl.style.top = `${pos.top}px`;
      mirrorFrameEl.style.right = 'auto';
      mirrorFrameEl.style.bottom = 'auto';
    }catch{}
  }
  function normalizeMirrorPositionAfterResize(){
    if (!mirrorFrameEl) return;
    // If user never dragged the panel, keep it anchored to the CSS top/right position.
    const dragged = mirrorFrameEl.getAttribute('data-dragged') === '1';
    if (!dragged){
      try{
        mirrorFrameEl.style.left = '';
        mirrorFrameEl.style.top = '';
        mirrorFrameEl.style.right = '';
        mirrorFrameEl.style.bottom = '';
      }catch{}
      return;
    }

    // If the user dragged, clamp to viewport so expanding doesn't "jump" awkwardly off-screen.
    try{
      const r = mirrorFrameEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const maxX = window.innerWidth - r.width;
      const maxY = window.innerHeight - r.height;
      const curLeft = Number.parseFloat(mirrorFrameEl.style.left || `${r.left}`);
      const curTop = Number.parseFloat(mirrorFrameEl.style.top || `${r.top}`);
      if (!Number.isFinite(curLeft) || !Number.isFinite(curTop)) return;
      const nextLeft = Math.max(8, Math.min(maxX - 8, curLeft));
      const nextTop = Math.max(8, Math.min(maxY - 8, curTop));
      mirrorFrameEl.style.left = `${Math.round(nextLeft)}px`;
      mirrorFrameEl.style.top = `${Math.round(nextTop)}px`;
      mirrorFrameEl.style.right = 'auto';
      mirrorFrameEl.style.bottom = 'auto';
    }catch{}
  }
  function clampMirrorFrameToCanvas({ pad = 8 } = {}){
    try{
      if (!mirrorFrameEl || !canvas?.getBoundingClientRect) return;
      const cr = canvas.getBoundingClientRect();
      const r = mirrorFrameEl.getBoundingClientRect();
      if (!cr.width || !cr.height || !r.width || !r.height) return;

      // Clamp to the actual render canvas rect (important for embedded/fake fullscreen layouts).
      const minLeft = cr.left + pad;
      const maxLeft = cr.right - r.width - pad;
      const minTop = cr.top + pad;
      const maxTop = cr.bottom - r.height - pad;

      // If it fits, keep current positioning.
      let nextLeft = r.left;
      let nextTop = r.top;
      if (maxLeft < minLeft) {
        // Panel wider than canvas; pin to left padding.
        nextLeft = minLeft;
      } else {
        nextLeft = Math.max(minLeft, Math.min(maxLeft, nextLeft));
      }
      if (maxTop < minTop) {
        nextTop = minTop;
      } else {
        nextTop = Math.max(minTop, Math.min(maxTop, nextTop));
      }

      const moved = (Math.abs(nextLeft - r.left) > 0.5) || (Math.abs(nextTop - r.top) > 0.5);
      if (!moved) return;

      mirrorFrameEl.style.left = `${Math.round(nextLeft)}px`;
      mirrorFrameEl.style.top = `${Math.round(nextTop)}px`;
      mirrorFrameEl.style.right = 'auto';
      mirrorFrameEl.style.bottom = 'auto';
      // Do not persist this as "small position" when expanded; it's a clamp only.
    }catch{}
  }
  function setMirrorFrameVisible(show){
    if (!mirrorFrameEl) return;
    try { mirrorFrameEl.style.display = show ? "" : "none"; } catch {}
  }
  function clamp01(v){ return Math.max(0, Math.min(1, v)); }
  function computePanelViewportRect(){
    try{
      const el = mirrorFrameViewportEl || mirrorFrameWindowEl || mirrorFrameEl;
      if (!el || !canvas?.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      if (!cr.width || !cr.height || !r.width || !r.height) return null;
      const x = clamp01((r.left - cr.left) / cr.width);
      const w = clamp01(r.width / cr.width);
      const y = clamp01(1 - ((r.top - cr.top + r.height) / cr.height));
      const h = clamp01(r.height / cr.height);
      if (w <= 0.01 || h <= 0.01) return null;
      return { x, y, w, h };
    }catch{
      return null;
    }
  }
  function computePanelDomRect(){
    try{
      const el = mirrorFrameViewportEl || mirrorFrameWindowEl || mirrorFrameEl;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return r;
    }catch{
      return null;
    }
  }
  const uidNum = new Map(); const getUidNum = uid => { if (!uidNum.has(uid)) uidNum.set(uid, uidNum.size + 1); return uidNum.get(uid); };
  function ensureBadge(uid){ if (!hud) return null; let el = hud.querySelector(`[data-uid="${uid}"]`); if (!el){ el = document.createElement("div"); el.dataset.uid = uid; el.className = "mirror-badge"; el.textContent = getUidNum(uid); hud.appendChild(el); } return el; }

  let soloMirrorCam = null;
  let soloMirrorRoot = null;
  function ensureSoloMirror(){
    if (soloMirrorCam && soloMirrorRoot) return;
    soloMirrorCam = new FreeCamera("mcam_solo", new Vector3(0,0,0), scene);
    soloMirrorRoot = new TransformNode("mCamRoot_solo", scene);
    soloMirrorCam.parent = soloMirrorRoot;
    // Keep mirror cameras at the exact pano center so the view matches the remote viewer.
    // Off-centre cameras introduce parallax/distortion inside the sky-dome.
    soloMirrorCam.position.set(0, 0, 0);
    soloMirrorCam.fov = 1.1;
    soloMirrorCam.minZ = 0.1;
    soloMirrorCam.maxZ = 50000;
    // MIRROR_LAYER is declared below; this is only called after boot.
    soloMirrorCam.layerMask = MIRROR_LAYER;
  }

  function updateMirrorLayout(){
    // In XR, never override activeCameras; keep XR camera active.
    if (inXR === true){
      mirrorTexturePinned = false;
      try{ scene.activeCameras = [ (xr?.baseExperience?.camera || scene.activeCamera) ]; }catch{}
      if (hud) hud.innerHTML='';
      setMirrorFrameVisible(false);
      _mirrorCams = [];
      return;
    }
    const cams=[], list=[...viewers.values()], n=list.length;
    mirrorTexturePinned = n > 0;
    const uids = [...viewers.keys()];
    if (MIRROR_DEBUG) console.log('[MIRROR] updateMirrorLayout - viewers:', n, 'mirrorVisible:', mirrorVisible, 'has texture:', !!mirrorMat.emissiveTexture);
    try{
      if (n) document.body.setAttribute('data-has-viewer', '1');
      else document.body.removeAttribute('data-has-viewer');
    }catch{}
    try{
      if (mirrorFrameEl && mirrorFrameToggleBtn){
        mirrorFrameToggleBtn.innerHTML = VR_ICON;
        mirrorFrameToggleBtn.setAttribute('aria-label', mirrorExpanded ? 'Minimize VR preview' : 'Maximize VR preview');
        mirrorFrameToggleBtn.setAttribute('title', mirrorExpanded ? 'Minimize' : 'Maximize');
      }
    }catch{}
    if (!mirrorVisible){
      setMirrorFrameVisible(true);
      try { mirrorFrameEl?.classList?.add?.('minimized'); } catch {}
      _mirrorCams=[]; cam.viewport=new Viewport(0,0,1,1); scene.activeCameras=[cam]; if(hud) hud.innerHTML=''; if (MIRROR_DEBUG) console.log('[MIRROR] Mirror minimized'); return;
    }
    try { mirrorFrameEl?.classList?.remove?.('minimized'); } catch {}
    setMirrorFrameVisible(true);
    const fallback = { x: PANEL.x, y: 1-(PANEL.y+PANEL.h), w: PANEL.w, h: PANEL.h };
    const PANEL_RECT = computePanelViewportRect() || fallback;
    const panelDomRect = computePanelDomRect();
    // If no viewers are connected, hide the mirror completely (only show in guided mode with viewers).
    if (!n){
      setMirrorFrameVisible(false);
      if (hud) hud.innerHTML='';
      _mirrorCams = [];
      cam.viewport = new Viewport(0,0,1,1);
      scene.activeCameras = [cam];
      if (MIRROR_DEBUG) console.log('[MIRROR] No viewers - mirror hidden');
      return;
    }
    const cols=Math.ceil(Math.sqrt(n)), rows=Math.ceil(n/cols), tileW=PANEL_RECT.w/cols, tileH=PANEL_RECT.h/rows;
    cam.viewport = mirrorPrimary ? new Viewport(PANEL_RECT.x, PANEL_RECT.y, PANEL_RECT.w, PANEL_RECT.h) : new Viewport(0,0,1,1);
    for (let i=0;i<n;i++){
      const v=list[i]; const col=i%cols, row=(i/cols)|0;
      const vx = PANEL_RECT.x + col*tileW;
      const vy = PANEL_RECT.y + (PANEL_RECT.h - (row + 1)*tileH);
      const vw = tileW, vh = tileH;
      v.cam.viewport = mirrorPrimary ? new Viewport(0,0,1,1) : new Viewport(vx, vy, vw, vh);
      cams.push(v.cam);
      const uid = uids[i];
      const el=ensureBadge(uid);
      if (el){
        const pad=6, size=22;
        if (panelDomRect){
          const tileDomW = panelDomRect.width / cols;
          const tileDomH = panelDomRect.height / rows;
          const pxLeft = panelDomRect.left + (col + 1) * tileDomW - (pad + size);
          const pxTop  = panelDomRect.top  + (row + 1) * tileDomH - (pad + size);
          el.style.left = `${Math.round(pxLeft)}px`;
          el.style.top  = `${Math.round(pxTop)}px`;
        }
        el.textContent=getUidNum(uid);
      }
    }
    _mirrorCams = cams;
    scene.activeCameras = mirrorPrimary ? [..._mirrorCams, cam] : [cam, ..._mirrorCams];
    if (MIRROR_DEBUG) console.log('[MIRROR] Created', cams.length, 'mirror cameras, activeCameras:', scene.activeCameras.length);
  }

  const mirrorDome = MeshBuilder.CreateSphere("mirrorDome",{diameter:DOME_DIAMETER,segments:48,sideOrientation:Mesh.BACKSIDE},scene);
  // Use a dedicated layer so mirror cameras don't see the guide/agent domes (prevents unintended spins)
  const MIRROR_LAYER = 0x4;
  if(flipX) mirrorDome.rotation.x=Math.PI; mirrorDome.layerMask=MIRROR_LAYER; mirrorDome.isPickable=false;
  const mirrorMat = new StandardMaterial("mirrorMat",scene);
  mirrorMat.disableLighting=true; mirrorMat.backFaceCulling=false;
  mirrorMat.transparencyMode=Material.MATERIAL_ALPHABLEND; mirrorMat.disableDepthWrite=true;
  mirrorDome.material = mirrorMat;

  // Draggable glass panel (like minimap) + hide/show button.
  (function installMirrorFrameDrag(){
    if (!mirrorFrameEl) return;
    let dragState = null;
    const stop = (ev)=>{ try{ ev.preventDefault?.(); ev.stopPropagation?.(); }catch{} };
    const perfNow = ()=>{ try{ return performance.now(); }catch{ return Date.now(); } };
    function syncMirrorLayoutFor(ms = 240){
      const start = perfNow();
      const tick = () => {
        try{ clampMirrorFrameToCanvas({ pad: 8 }); }catch{}
        try{ updateMirrorLayout(); }catch{}
        if ((perfNow() - start) < ms) {
          try{ requestAnimationFrame(tick); }catch{}
        }
      };
      try{ requestAnimationFrame(tick); }catch{ try{ tick(); }catch{} }
    }
    // Restore persisted size preference + last small position (if any)
    try{
      const saved = String(localStorage.getItem('vrMirrorSize') || '').toLowerCase();
      mirrorExpanded = saved === 'lg';
    }catch{}
    try{ applyMirrorSize(); }catch{}
    try{ if (!mirrorExpanded) applyMirrorSmallPos(); }catch{}
    function startDrag(ev){
      try{
        if (mirrorExpanded) return;
        if (!mirrorVisible) return;
        if (ev.button && ev.button !== 0) return;
        if (ev.target?.closest?.("button")) return;
        const rect = mirrorFrameEl.getBoundingClientRect();
        try{ mirrorFrameEl.setAttribute('data-dragged','1'); }catch{}
        dragState = { offsetX: ev.clientX - rect.left, offsetY: ev.clientY - rect.top };
        mirrorFrameEl.classList.add("dragging");
        mirrorFrameEl.style.left = rect.left + "px";
        mirrorFrameEl.style.top = rect.top + "px";
        mirrorFrameEl.style.right = "auto";
        mirrorFrameEl.style.bottom = "auto";
        stop(ev);
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", endDrag, { once:true });
      }catch{}
    }
    function onDragMove(ev){
      if (!dragState) return;
      const rect = mirrorFrameEl.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;
      const nextLeft = Math.max(8, Math.min(maxX - 8, ev.clientX - dragState.offsetX));
      const nextTop  = Math.max(8, Math.min(maxY - 8, ev.clientY - dragState.offsetY));
      mirrorFrameEl.style.left = `${nextLeft}px`;
      mirrorFrameEl.style.top  = `${nextTop}px`;
      try{ updateMirrorLayout(); }catch{}
    }
    function endDrag(){
      dragState = null;
      mirrorFrameEl.classList.remove("dragging");
      window.removeEventListener("pointermove", onDragMove);
      try{
        const r = mirrorFrameEl.getBoundingClientRect();
        if (r?.width && r?.height) writeMirrorSmallPos({ left: r.left, top: r.top });
      }catch{}
      try{ updateMirrorLayout(); }catch{}
    }
    mirrorFrameEl.addEventListener("pointerdown", startDrag);
    // Keep canvas viewport in sync with CSS transition.
    try{
      mirrorFrameEl.addEventListener("transitionend", (ev)=>{
        if (!ev) return;
        const prop = String(ev.propertyName || '');
        if (prop === 'width' || prop === 'transform') {
          try{ updateMirrorLayout(); }catch{}
        }
      });
    }catch{}
    mirrorFrameToggleBtn?.addEventListener?.("pointerdown", stop);
    mirrorFrameToggleBtn?.addEventListener?.("click", (ev)=>{
      stop(ev);
      mirrorExpanded = !mirrorExpanded;
      try{ applyMirrorSize(); }catch{}
      try{ normalizeMirrorPositionAfterResize(); }catch{}
      // Ensure the panel itself stays inside the render canvas when expanded.
      try{
        requestAnimationFrame(() => {
          try{ clampMirrorFrameToCanvas({ pad: 8 }); }catch{}
        });
      }catch{}
      // Sync during animation for seamless switch.
      try{ syncMirrorLayoutFor(260); }catch{}
    });
  })();

  // Solo mirror is no longer used - mirror only shows when viewers are connected.

  async function setMirrorNode(id){
    if (!id || id===mirrorNodeId || !nodesById.has(id)) return;
    const file = nodesById.get(id).file, key = BASE + "|" + file;
    if (mirrorTexKey === key) { mirrorNodeId = id; return; }
    const tex = await getTexture(file);
    mirrorMat.emissiveTexture = tex;
    mapFor2D(tex, /*stereo*/ isStereo(), flipU);
    mirrorTexKey = key;
    mirrorNodeId = id;
    try{ touchLRU(key); }catch{}
  }

  /* WebSocket (guide + viewers) */
  let socket=null; let wsIndex=0; let wsLockedIdx=-1;
  function safeSend(o){ if (socket && socket.readyState===1){ try{ socket.send(JSON.stringify(o)); }catch{} } }
  let guideSyncSeq = 0;
  let wsPingTimer = null;
  function stopWsPing(){ try{ if (wsPingTimer){ clearInterval(wsPingTimer); wsPingTimer = null; } }catch{} }
  function startWsPing(){
    stopWsPing();
    try{
      wsPingTimer = setInterval(()=>{
        try{ safeSend({ type:"ping", room: roomId, from:"guide", ts: Date.now() }); }catch{}
      }, 10000);
    }catch{}
  }

  function computeGuidePose(){
    try{
      // In XR we rotate the pano via `xrContentRoot.rotation.y` (thumbstick turning).
      // Outside XR, pano yaw is worldRoot rotation (currently 0 unless an experience sets it).
      const panoYaw = (inXR && xrContentRoot?.rotation) ? (xrContentRoot.rotation.y || 0) : (worldRoot?.rotation?.y || 0);
      const wrap = (v)=>{ const TAU=Math.PI*2; let x=v%TAU; if(x>Math.PI) x-=TAU; if(x<-Math.PI) x+=TAU; return x; };
      if (inXR && xr?.baseExperience?.camera){
        const dir = xr.baseExperience.camera.getForwardRay().direction;
        const yaw = wrap(Math.atan2(-dir.x, -dir.z) - panoYaw);
        const pitch = Math.asin(dir.y);
        return { yaw, pitch, mode: 'xr' };
      }
      return { yaw: wrap((cam?.rotation?.y || 0) - panoYaw), pitch: (cam?.rotation?.x || 0), mode: '2d' };
    }catch{
      return { yaw: 0, pitch: 0, mode: (inXR ? 'xr' : '2d') };
    }
  }

  function sendSync(nodeId){
    if (!nodeId) return;
    const expPath = `experiences/${expName()}`;
    safeSend({
      type: "sync",
      from: "guide",
      room: roomId,
      nodeId,
      exp: expName(),
      expPath,
      worldPos: v3arr(worldRoot.position),
      pose: computeGuidePose(),
      seq: (++guideSyncSeq),
      ts: Date.now()
    });
  }
  // Smooth angle interpolation (handles wrap-around at +-PI)
  function lerpAngle(prev, next, alpha){
    const TAU = Math.PI * 2;
    let d = (next - prev) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return prev + d * Math.max(0, Math.min(1, alpha));
  }
  function angleDelta(target, source){
    const TAU = Math.PI * 2;
    let diff = (target - source) % TAU;
    if (diff > Math.PI) diff -= TAU;
    if (diff < -Math.PI) diff += TAU;
    return diff;
  }
  function isTourPlaying(){ try{ return Boolean(window?.__tour?.isPlaying?.()); }catch{ return false; } }
  function computeAutoRotateTargetYaw(){
    try{
      const tour = (window && window.__tour) ? window.__tour : null;
      if (!tour || typeof tour.getSteps !== 'function') return null;
      const idx = Number(tour.getIndex?.() ?? -1);
      const steps = tour.getSteps?.() || [];
      const next = steps[idx + 1];
      if (!next?.nodeId || !nodesById?.has?.(next.nodeId)) return null;
      const nextNode = nodesById.get(next.nodeId);
      const curNode = nodesById.get(currentNodeId);
      if (curNode){
        try{
          const start = nodeWorldPos(curNode);
          const end = nodeWorldPos(nextNode);
          const delta = end.subtract(start);
          if (delta.lengthSquared() > 1e-4){
            return Math.atan2(-delta.x, -delta.z);
          }
        }catch{}
      }
      if (Number.isFinite(nextNode?.yaw)) return -rad(nextNode.yaw);
    }catch{}
    return null;
  }
  function resetAutoRotate(){
    autoRotateLastT = 0;
    autoRotateTargetYaw = null;
    autoRotatePlanTouch = 0;
  }
  (function connect(){
    let retryMs=2000;
    const idx = (wsLockedIdx>=0 ? wsLockedIdx : (wsIndex % WS_LIST.length));
    const url = WS_LIST[idx];
    A("ws try", { url, idx, locked: wsLockedIdx });
    try{ socket=new WebSocket(url); }catch{ socket=null; if (wsLockedIdx<0) wsIndex=(wsIndex+1)%WS_LIST.length; return setTimeout(connect, retryMs); }
    let opened=false; const OPEN_TIMEOUT_MS=2500; const to=setTimeout(()=>{ if(!opened){ A("ws timeout",{url}); try{ socket?.close(); }catch{} } }, OPEN_TIMEOUT_MS);
    socket.addEventListener("open", ()=>{ opened=true; clearTimeout(to); retryMs=2000; wsLockedIdx = idx; A("ws open",{url,room:roomId, locked:true}); safeSend({type:"join", room:roomId, role:"guide"}); startWsPing(); if(currentNodeId) sendSync(currentNodeId); });
    function schedule(reason){ clearTimeout(to); try{ socket?.close(); }catch{}; wsLockedIdx = -1; wsIndex = (wsIndex+1) % WS_LIST.length; A("ws retry", { reason, next: WS_LIST[wsIndex] }); setTimeout(connect, retryMs); retryMs = Math.min(retryMs*1.7, 15000); }
    socket.addEventListener("close", ()=>{ stopWsPing(); socket=null; if(!opened) schedule("close-before-open"); else schedule("closed"); });
    socket.addEventListener("error", ()=>{ stopWsPing(); schedule("error"); });
    socket.addEventListener("message", (ev)=>{
      let msg; try{ msg=JSON.parse(ev.data); }catch{ return; }
      if (!(msg && msg.room===roomId)) return;
      // From viewers: { type:"sync", from:"viewer", uid, pose:{yaw,pitch,mode}, nodeId? }
      const isViewer = msg.type==="sync" && msg.from==="viewer" && typeof msg.uid==="string";
      if (isViewer){
        if (MIRROR_DEBUG) A("viewer msg", { uid: msg.uid, pose: msg.pose, nodeId: msg.nodeId });
         if (!viewers.has(msg.uid)){
           const mCam = new FreeCamera("mcam_"+msg.uid, new Vector3(0,0,0), scene);
           const root = new TransformNode("mCamRoot_"+msg.uid, scene);
           mCam.parent = root;
           mCam.position.set(0,0,0);
           mCam.fov=1.1; mCam.minZ=0.1; mCam.maxZ=50000; mCam.layerMask=MIRROR_LAYER;
           viewers.set(msg.uid, { cam:mCam, root, nodeId:null, last: performance.now(), hasPose:false, targetYaw:0, targetPitch:0, targetRoll:0 });
           updateMirrorLayout();
         }
         const v = viewers.get(msg.uid); v.last = performance.now();
         if (msg.pose){
           const targetYaw = (MIRROR_YAW_SIGN) * (typeof msg.pose.yaw==='number'? msg.pose.yaw : 0);
           const targetPitch = (MIRROR_PITCH_SIGN) * (typeof msg.pose.pitch==='number'? msg.pose.pitch : 0);
           const targetRoll = (typeof msg.pose.roll==='number'? msg.pose.roll : 0);

           v.targetYaw = targetYaw;
           v.targetPitch = targetPitch;
           v.targetRoll = targetRoll;
           if (!v.hasPose){
             v.hasPose = true;
             try{ v.root.rotation.y = targetYaw; }catch{}
             try{ v.root.rotation.x = targetPitch; }catch{}
             try{ v.root.rotation.z = targetRoll; }catch{}
           }
         }
         if (msg.nodeId) { v.nodeId = msg.nodeId; setMirrorNode(msg.nodeId); }
       }
    });
  })();

  // Periodically remove stale viewer mirrors (no updates for 30s)
  setInterval(()=>{
    const now = performance.now();
    let changed = false;
    for (const [uid, v] of viewers.entries()){
      if ((now - (v.last||0)) > 30000){ try{ v.cam?.dispose?.(); }catch{} try{ v.root?.dispose?.(); }catch{} viewers.delete(uid); changed = true; }
    }
    if (changed) updateMirrorLayout();
  }, 10000);

  // Smooth viewer pose every frame (network updates can be low-frequency/jittery)
  let _mirrorPosePrevT = 0;
  scene.onBeforeRenderObservable.add(()=>{
    if (inXR === true) return;
    if (!viewers.size) return;
    const now = performance.now();
    if (!_mirrorPosePrevT) _mirrorPosePrevT = now;
    const dtMs = Math.max(0, Math.min(80, now - _mirrorPosePrevT));
    _mirrorPosePrevT = now;

    const SNAP_THRESHOLD = 0.02; // ~1 degree
    const SMOOTH_MS = 110;
    const alpha = 1 - Math.exp(-dtMs / Math.max(1, SMOOTH_MS));

    for (const v of viewers.values()){
      if (!v?.hasPose) continue;
      if (!v?.root) continue;
      const ty = v.targetYaw;
      const tp = v.targetPitch;
      if (Number.isFinite(ty)){
        const dy = Math.abs(angleDelta(ty, v.root.rotation.y));
        if (dy < SNAP_THRESHOLD) v.root.rotation.y = ty;
        else v.root.rotation.y = lerpAngle(v.root.rotation.y, ty, alpha);
      }
      if (Number.isFinite(tp)){
        const dp = Math.abs(angleDelta(tp, v.root.rotation.x));
        if (dp < SNAP_THRESHOLD) v.root.rotation.x = tp;
        else v.root.rotation.x = lerpAngle(v.root.rotation.x, tp, alpha);
      }
      const tr = v.targetRoll;
      if (Number.isFinite(tr)){
        const dr = Math.abs(angleDelta(tr, v.root.rotation.z));
        if (dr < SNAP_THRESHOLD) v.root.rotation.z = tr;
        else v.root.rotation.z = lerpAngle(v.root.rotation.z, tr, alpha);
      }
    }
  });

  // Ensure mirror texture follows the most recent viewer continuously (guards against missed messages)
  let lastMirrorUpdate = 0;
  scene.onBeforeRenderObservable.add(()=>{
    const now = performance.now();
    if (now - lastMirrorUpdate < 800) return; // throttle ~1.25Hz
    lastMirrorUpdate = now;
    try{
      let newest = null, newestT = -Infinity;
      for (const v of viewers.values()){ if (v?.nodeId && (v.last||0) > newestT){ newest = v; newestT = v.last; } }
      // Only show viewer's node when viewers are connected (mirror is hidden otherwise)
      if (newest && newest.nodeId && newest.nodeId !== mirrorNodeId){
        if (MIRROR_DEBUG) console.log('[MIRROR] Updating to viewer node:', newest.nodeId);
        setMirrorNode(newest.nodeId);
      }
    }catch{}
  });

  // Update minimap torch heading at ~10Hz
  let _miniTorchTick = 0;
  scene.onBeforeRenderObservable.add(()=>{
    const t = performance.now();
    if (t - _miniTorchTick < 100) return; // 10Hz
    _miniTorchTick = t;
    updateMinimapTorch();
  });

  // Gentle auto-rotation during autoplay to face the upcoming pano direction
  scene.onBeforeRenderObservable.add(()=>{
    // Rotation disabled: flythrough-only navigation across all modes.
    resetAutoRotate();
    return;
  });

  /* camera drag */
  let dragging=false,lastX=0,lastY=0,cPitch=0;
  const yawSpeed=0.005, pitchSpeed=0.003, pitchClamp=rad(70);
  function setCamPitch(p){ cPitch=Math.max(-pitchClamp,Math.min(pitchClamp,p)); cam.rotation.x=cPitch; }
  canvas.style.cursor="grab"; try{ canvas.addEventListener("pointerdown", ()=>{ unlockAudio(); }, { passive:true }); }catch{}
  canvas.addEventListener("pointerdown",e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; try{canvas.setPointerCapture(e.pointerId);}catch{} canvas.style.cursor="grabbing"; },{passive:false});
  canvas.addEventListener("pointermove",e=>{ if(!dragging) return; const dx=e.clientX-lastX, dy=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; cam.rotation.y -= dx*yawSpeed; setCamPitch(cPitch - dy*pitchSpeed); sendSync(currentNodeId); },{passive:true});
  canvas.addEventListener("pointerup",()=>{ dragging=false; canvas.style.cursor="grab"; try{ canvas.addEventListener("pointerdown", ()=>{ unlockAudio(); }, { passive:true }); }catch{} },{passive:true});
  // Zoom and pinch
  const MIN_FOV = 0.45, MAX_FOV = 1.7; function clampFov(v){ return Math.max(MIN_FOV, Math.min(MAX_FOV, v)); }
  const fingers = new Map(); let pinchOn=false, pinchRef=0, pinchBase=cam.fov;
  function pDist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy) || 1; }
  canvas.addEventListener("pointerdown", (e)=>{ fingers.set(e.pointerId, { x:e.clientX, y:e.clientY }); if (fingers.size === 2){ const arr=[...fingers.values()]; pinchRef = pDist(arr[0], arr[1]); pinchBase = cam.fov; pinchOn = true; dragging = false; canvas.style.cursor='grab'; } }, { passive:false });
  canvas.addEventListener("pointermove", (e)=>{ const p=fingers.get(e.pointerId); if (p){ p.x=e.clientX; p.y=e.clientY; } if (pinchOn && fingers.size>=2){ const arr=[...fingers.values()]; const cur = pDist(arr[0], arr[1]); const scale = Math.max(0.25, Math.min(4, cur / (pinchRef || 1))); cam.fov = clampFov(pinchBase * scale); } }, { passive:true });
  function endPinch(e){ fingers.delete(e.pointerId); if (fingers.size < 2) pinchOn = false; }
  canvas.addEventListener("pointerup", endPinch, { passive:true });
  canvas.addEventListener("pointercancel", endPinch, { passive:true });
  canvas.addEventListener("pointerleave", endPinch, { passive:true });
  canvas.addEventListener("wheel", (e)=>{ e.preventDefault(); const step = Math.max(-0.2, Math.min(0.2, (e.deltaY||0)*0.0012)); cam.fov = clampFov(cam.fov + step); }, { passive:false });

  // Keep direct mapping (no extra smoothing) for responsive control

  /* XR (optional) */
  let xr=null; let inXR=false; const vrDomes=[null,null]; const vrDomeModes=[null,null]; let activeVr=0; let prevHSL=null;
  // Artificial yaw rotation for XR (thumbstick turning). Applied to xrContentRoot so the pano/hotspots rotate around the user.
  let xrYawOffset = 0;
  let xrTurnLastSyncMs = 0;
  let xrSnapTurnLatch = 0;
  let xrSnapTurnCooldownUntil = 0;
  let vrReadyFile = null;
  let vrWarmPromise = null;
  let vrWarmTarget = null;
  const vrPreloadedUrls = new Set();
  function applyVrTextureMapping(d){
    try{
      if (!d) return;
      try{ if (d.mesh) d.mesh.rotation.x = 0; }catch{}
      const tex = d.photoTexture;
      if (tex){
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      }
    }catch{}
  }
  function preloadNeighborsForVR(node, limit = VR_PREFETCH_LIMIT){
    if (!node) return;
    try{
      const neigh = neighborInfoFor(node, limit);
      neigh.urls.forEach((url, idx)=>{
        if (vrPreloadedUrls.has(url)) return;
        vrPreloadedUrls.add(url);
        // `Image()` can't decode `.ktx2` (and will spam console); warm the HTTP/SW cache with fetch instead.
        try{
          if (/\.ktx2($|\?)/i.test(String(url || ""))) {
            fetch(url, { credentials: "same-origin", cache: "force-cache" }).catch(()=>{});
          } else {
            const img = new Image(); img.decoding = "async"; img.loading = "eager"; img.src = url;
          }
        }catch{}
        if (VR_GPU_PREFETCH){
          const f = neigh.files[idx];
          if (f){ try{ getTexture(f).catch(()=>{}); }catch{} }
        }
      });
      while (vrPreloadedUrls.size > 40){
        const first = vrPreloadedUrls.values().next().value;
        vrPreloadedUrls.delete(first);
      }
    }catch{}
  }
  function prewarmVrDome(file){
    if (!file || inXR) return;
    if (vrReadyFile === file && !vrWarmPromise) return;
    if (vrWarmTarget === file && vrWarmPromise) return vrWarmPromise;
    const primaryUrl = panoUrl(file);
    const fallbackUrl = /\.ktx2$/i.test(primaryUrl) ? panoUrlOriginal(file) : panoUrlKtx2(file);
    const dome = ensureVrDome(activeVr);
    vrWarmTarget = file;
    vrWarmPromise = (async()=>{
      let ok = false;
      if (/\.ktx2($|\?)/i.test(primaryUrl) && fallbackUrl && fallbackUrl !== primaryUrl) {
        let primaryExists = true;
        try { primaryExists = await urlExistsFast(primaryUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS }); } catch {}
        if (primaryExists === false) {
          let fallbackExists = true;
          try { fallbackExists = await urlExistsFast(fallbackUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS }); } catch {}
          if (fallbackExists) {
            ok = await loadUrlIntoDome(dome, fallbackUrl, VR_PANO_LOAD_TIMEOUT_MS);
          } else {
            ok = await loadUrlIntoDome(dome, primaryUrl, VR_PANO_LOAD_TIMEOUT_MS);
          }
        } else {
          ok = await loadUrlIntoDome(dome, primaryUrl, VR_PANO_LOAD_TIMEOUT_MS);
        }
      } else {
        ok = await loadUrlIntoDome(dome, primaryUrl, VR_PANO_LOAD_TIMEOUT_MS);
      }
      if (!ok && fallbackUrl && fallbackUrl !== primaryUrl){
        try {
          const exists = await urlExistsFast(fallbackUrl, { timeoutMs: VR_PANO_PROBE_TIMEOUT_MS });
          if (exists) ok = await loadUrlIntoDome(dome, fallbackUrl, VR_PANO_LOAD_TIMEOUT_MS);
        } catch {}
      }
      if (!ok) return;
      applyVrTextureMapping(dome);
      dome.__panoFile = file;
      vrReadyFile = file;
    })().catch(()=>{}).finally(()=>{ if (vrWarmTarget === file){ vrWarmPromise = null; vrWarmTarget = null; } });
    return vrWarmPromise;
  }
  function setVrStereoMode(d){
    const mode = isStereo()? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    try{ if ("stereoMode" in d) d.stereoMode = mode; }catch{}
    try{ if ("imageMode" in d) d.imageMode = mode; }catch{}
  }
  function ensureVrDome(index){
    const neededMode = isStereo()? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    if (vrDomes[index] && vrDomeModes[index] === neededMode) return vrDomes[index];
    if (vrDomes[index]) {
      try { vrDomes[index].dispose(); } catch {}
      vrDomes[index] = null;
      vrDomeModes[index] = null;
    }
    const domeVR = new PhotoDome(
      "pd_"+index,
      panoUrl(nodesById?.get?.(currentNodeId)?.file || ""),
      // Important: set `imageMode` at construction time; changing it later is unreliable in Babylon.
      { size: DOME_DIAMETER, imageMode: neededMode },
      scene
    );
    domeVR.mesh.isVisible = false;
    domeVR.mesh.isPickable = false;
    try{ domeVR.mesh.layerMask = 0x1; }catch{}
    domeVR.mesh.parent = xrContentRoot; // follow headset translation (skybox behavior)
    applyVrTextureMapping(domeVR);
    // Apply correct stereo mode up-front based on current experience
    setVrStereoMode(domeVR);
    vrDomes[index] = domeVR;
    vrDomeModes[index] = neededMode;
    return domeVR;
  }
  const loadUrlIntoDome = async (dome, url, timeoutMs = VR_PANO_LOAD_TIMEOUT_MS)=>{
    if (!dome?.photoTexture) return true;
    const tex = dome.photoTexture;
    let obs = null;
    let done = false;
    const cleanup = ()=>{ if (obs){ try{ tex.onLoadObservable.remove(obs); }catch{} obs = null; } };

    // Prevent black frames while the XR runtime/GPU decodes the new pano.
    try { tex.isBlocking = true; } catch {}

    const ok = await new Promise((resolve)=>{
      const t0 = performance.now();
      const finish = (result)=>{
        if (done) return;
        done = true;
        cleanup();
        resolve(!!result);
      };

      try{ obs = tex.onLoadObservable.add(()=>finish(true)); }catch{}

      const poll = ()=>{
        if (done) return;
        try{ if (tex.isReady?.()) return finish(true); }catch{}
        if ((performance.now() - t0) >= timeoutMs) return finish(false);
        try{ requestAnimationFrame(poll); }catch{ setTimeout(poll, 16); }
      };

      try{ tex.updateURL(url); }catch{ finish(false); return; }
      poll();
    });

    try{ const t = dome?.photoTexture; if (t){ t.anisotropicFilteringLevel = 8; } }catch{}
    if (ok) {
      // Give the GPU a moment to finish decoding before allowing non-blocking rendering.
      try { await new Promise(r => setTimeout(r, 90)); } catch {}
    }
    try { tex.isBlocking = false; } catch {}
    applyVrTextureMapping(dome);
    return ok;
  };
  function attachXRHotspotsToCurrentDome(){
    try{
      // In XR we want hotspots anchored to a "skybox" root that follows headset translation.
      // This prevents hotspots drifting/floating when the user leans or moves.
      hotspotRootXR.parent = xrContentRoot;
    }catch{}
  }
  const tmpPointerRay = new Ray(new Vector3(), new Vector3(0,0,1), DOME_DIAMETER);

  // Build a picking ray from an XR controller/pointer combo; prefer Babylon's world pointer ray
  function makeHotspotRayFromPointer(ptr, controller){
    try{
      if (!ptr && !controller) return { ray: null, hit: null };
      const pred = (m)=>m?.metadata?.hotspot===true;
      const candidates = [];
      const pushRay = (originVec, directionVec)=>{
        if (!originVec || !directionVec) return;
        const dir = directionVec.clone ? directionVec.clone() : directionVec;
        if (typeof dir.lengthSquared === "function" && dir.lengthSquared() === 0) return;
        if (dir.normalize) dir.normalize();
        const origin = originVec.clone ? originVec.clone() : originVec;
        candidates.push(new Ray(origin, dir, DOME_DIAMETER));
      };
      try{
        if (controller?.getWorldPointerRayToRef){
          controller.getWorldPointerRayToRef(tmpPointerRay);
          tmpPointerRay.length = DOME_DIAMETER;
          if (tmpPointerRay.origin && tmpPointerRay.direction){
            pushRay(tmpPointerRay.origin, tmpPointerRay.direction);
            const reverseDir = tmpPointerRay.direction.clone ? tmpPointerRay.direction.clone().scaleInPlace(-1) : null;
            if (reverseDir) pushRay(tmpPointerRay.origin, reverseDir);
          }
        } else if (controller?.getWorldPointerRay){
          const ray = controller.getWorldPointerRay();
          if (ray?.origin && ray?.direction){
            pushRay(ray.origin, ray.direction);
            const reverseDir = ray.direction.clone ? ray.direction.clone().scaleInPlace(-1) : null;
            if (reverseDir) pushRay(ray.origin, reverseDir);
          }
        }
      }catch{}
      try{
        const forwardRay = ptr?.getForwardRay?.(DOME_DIAMETER);
        if (forwardRay?.origin && forwardRay?.direction){
          pushRay(forwardRay.origin, forwardRay.direction);
          const reverseDir = forwardRay.direction.clone ? forwardRay.direction.clone().scaleInPlace(-1) : null;
          if (reverseDir) pushRay(forwardRay.origin, reverseDir);
        }
      }catch{}
      if (!candidates.length && ptr){
        const origin = ptr.getAbsolutePosition?.() || ptr.absolutePosition || ptr.position || Vector3.Zero();
        const world = ptr.getWorldMatrix?.();
        if (world){
          const fwd = Vector3.TransformNormal(new Vector3(0,0, 1), world);
          const back = Vector3.TransformNormal(new Vector3(0,0,-1), world);
          pushRay(origin, fwd);
          pushRay(origin, back);
        } else if (ptr.getDirection){
          const fwd = ptr.getDirection(new Vector3(0,0,1), scene);
          const back = ptr.getDirection(new Vector3(0,0,-1), scene);
          pushRay(origin, fwd);
          pushRay(origin, back);
        }
      }
      let bestRay = candidates[0] || null;
      let bestHit = null;
      let bestDist = Infinity;
      for (const ray of candidates){
        if (!ray) continue;
        const hit = scene.pickWithRay(ray, pred, false, null, xr?.baseExperience?.camera || scene.activeCamera);
        if (hit?.hit && hit.distance <= bestDist){
          bestDist = hit.distance;
          bestRay = ray;
          bestHit = hit;
        }
      }
      return { ray: bestRay, hit: bestHit };
    }catch{ return { ray: null, hit: null }; }
  }
  async function setVrPano(file, opts = {}){
    const primaryUrl = panoUrl(file);
    const fallbackUrl = /\.ktx2$/i.test(primaryUrl) ? panoUrlOriginal(file) : panoUrlKtx2(file);
    let url = primaryUrl;
    const current = vrDomes[activeVr];
    if (current && current.__panoFile === file){
      try{ current.mesh.isVisible = true; current.mesh.setEnabled(true); }catch{}
      vrReadyFile = file;
      try{ preloadNeighborsForVR(nodesById?.get?.(currentNodeId)); }catch{}
      attachXRHotspotsToCurrentDome();
      try{ hotspotRoot.setEnabled(false); hotspotRootXR.setEnabled(true); }catch{}
      try{ const curNode = nodesById?.get?.(currentNodeId); if (curNode) buildHotspotsFor(curNode, /*forXR*/ true); }catch{}
      return;
    }
    const next = 1 - activeVr;
    const nextDome = ensureVrDome(next);
    setVrStereoMode(nextDome);
    try{ nextDome.mesh.isVisible = false; nextDome.mesh.setEnabled(false); }catch{}
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
          try { console.warn('[AGENT] VR KTX2 missing; using fallback URL:', { file, primaryUrl, fallbackUrl }); } catch {}
          loaded = await loadUrlIntoDome(nextDome, fallbackUrl, VR_PANO_LOAD_TIMEOUT_MS);
          url = fallbackUrl;
          if (loaded) {
            try{
              const id = String(expName() || "").trim();
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
          try{ console.warn('[AGENT] VR pano failed; retrying with fallback URL:', { file, primaryUrl, fallbackUrl }); }catch{}
          loaded = await loadUrlIntoDome(nextDome, fallbackUrl, VR_PANO_LOAD_TIMEOUT_MS);
          url = fallbackUrl;
        }
      }catch{}
    }
    if (!loaded){
      console.warn('[AGENT] VR pano load timed out; keeping previous pano visible:', file);
      return;
    }
    nextDome.__panoFile = file;

    // Hide the old pano first, then apply any heading correction, then show the new pano.
    // This prevents a visible "rotate after load" on the previous pano.
    const cur = vrDomes[activeVr];
    if (cur){ try{ cur.mesh.isVisible = false; cur.mesh.setEnabled(false); }catch{} }
    try { if (typeof opts?.beforeApply === "function") opts.beforeApply(); } catch {}
    try{ nextDome.mesh.setEnabled(true); }catch{}
    nextDome.mesh.isVisible = true;
    await new Promise(r => setTimeout(r, 16)); // ~1 frame at 60fps
    activeVr = next;
    vrReadyFile = file;
    try{ preloadNeighborsForVR(nodesById?.get?.(currentNodeId)); }catch{}
    attachXRHotspotsToCurrentDome();
    try{ hotspotRoot.setEnabled(false); hotspotRootXR.setEnabled(true); }catch{}
    try{ const curNode = nodesById?.get?.(currentNodeId); if (curNode) buildHotspotsFor(curNode, /*forXR*/ true); }catch{}
    try{ retainSW([url]); }catch{}
  }
  try{
    if (navigator?.xr){
      const qs = new URLSearchParams(location.search);
      const xrRef = (qs.get('xrRef') || 'local-floor');
      const XR_DEBUG = qs.has('xrdebug');
      const XR_TURN_SIGN = (() => {
        try{
          const raw = (qs.get('turnSign') || import.meta?.env?.VITE_XR_TURN_SIGN || '').toString().trim().toLowerCase();
          if (raw === '-1' || raw === 'inv' || raw === 'invert' || raw === 'reverse' || raw === 'reversed') return -1;
          if (raw === '1' || raw === 'normal' || raw === 'default') return 1;
        }catch{}
        // Default: invert so "stick right" turns view right when rotating the pano root.
        return -1;
      })();
      let xrDebugLabel = null;
      let lastXRDebugText = null;
      const ensureXRDebugLabel = ()=>{
        if (!XR_DEBUG || xrDebugLabel) return;
        try{
          xrDebugLabel = document.createElement('div');
          xrDebugLabel.style.position = 'fixed';
          xrDebugLabel.style.left = '12px';
          xrDebugLabel.style.bottom = '12px';
          xrDebugLabel.style.maxWidth = '50vw';
          xrDebugLabel.style.fontSize = '12px';
          xrDebugLabel.style.fontFamily = 'monospace';
          xrDebugLabel.style.background = 'rgba(0,0,0,0.65)';
          xrDebugLabel.style.color = '#9cf';
          xrDebugLabel.style.padding = '6px 8px';
          xrDebugLabel.style.borderRadius = '6px';
          xrDebugLabel.style.pointerEvents = 'none';
          xrDebugLabel.style.whiteSpace = 'pre';
          xrDebugLabel.style.zIndex = '10000';
          document.body.appendChild(xrDebugLabel);
        }catch{}
      };
      const updateXRDebug = (msg)=>{
        if (!XR_DEBUG) return;
        try{
          ensureXRDebugLabel();
          const text = msg || '';
          if (xrDebugLabel) xrDebugLabel.textContent = text;
          if (text !== lastXRDebugText){
            lastXRDebugText = text;
            XRDebugLog(text);
          }
        }catch{}
      };
      xr = await scene.createDefaultXRExperienceAsync({
        uiOptions:{sessionMode:"immersive-vr", referenceSpaceType:xrRef },
        optionalFeatures:true,
        // Avoid teleport "capturing" trigger presses; we use hotspots for navigation.
        disableTeleportation:true,
        // Ensure we get pointers on all controllers and at our scene scale.
        pointerSelectionOptions:{
          enablePointerSelectionOnAllControllers:true,
          maxPointerDistance:DOME_DIAMETER,
        }
      });
      // Fallback: manual ray from controllers + trigger
      try{
        const input = xr?.baseExperience?.input;
        const lasers = new Map();
        const abLastPressed = new WeakMap(); // controller -> { a:boolean, b:boolean }
        let abPollCooldownUntil = 0;
        // Thumbstick forward navigation state
        let thumbstickNavCooldown = 0;
        const THUMBSTICK_NAV_COOLDOWN_MS = 800; // Prevent rapid repeated navigation
        const THUMBSTICK_FORWARD_THRESHOLD = 0.55; // How far forward to push (0-1)
        
        const setupController = (source)=>{
          try{
            if (!source || lasers.has(source)) return;
            const ptr = source?.pointer || source?.grip || null;
            const len = DOME_DIAMETER*0.9;
            const laser = MeshBuilder.CreateBox("laser_"+(lasers.size+1), { height:0.01, width:0.01, depth: len }, scene);
            const lm = new StandardMaterial("laserMat", scene); lm.disableLighting=true; lm.emissiveColor=new Color3(0.95,0.8,0.2); lm.backFaceCulling=false;
            laser.material=lm; laser.isPickable=false;
            if (ptr){ laser.parent=ptr; laser.position.z = len/2; }
            else { laser.setEnabled(false); laser.isVisible = false; }
            laser.layerMask = 0x1;
            lasers.set(source, { laser, pointer: ptr, hit: null, distance: null, motionController: null });
            const hookMotionController = (mc)=>{
              try{
                if (!mc) return;
                const info = lasers.get(source);
                if (info) info.motionController = mc;

                const attachSelectComponent = (comp)=>{
                  try{
                    if (!comp || comp.__agentNavHooked) return;
                    comp.__agentNavHooked = true;
                    comp?.onButtonStateChangedObservable?.add((c)=>{
                      if (!c?.pressed) return;
                      try{
                        const res = makeHotspotRayFromPointer(ptr, source);
                        const md = res?.hit?.pickedMesh?.metadata;
                        const targetId = resolveHotspotTargetNodeId(md);
                        if (targetId) goTo(targetId, { source: 'user', broadcast: true, preserveHeading: { clickedYawDeg: md?.yawDeg } });
                        if (XR_DEBUG) updateXRDebug(`[select] ${source.uniqueId} -> ${targetId || 'none'}`);
                      }catch{}
                    });
                  }catch{}
                };

                let abComponentCooldownUntil = 0;
                const attachShortcutButton = (comp, handler, tag)=>{
                  try{
                    if (!comp || comp.__agentShortcutHooked) return;
                    comp.__agentShortcutHooked = true;
                    comp?.onButtonStateChangedObservable?.add((c)=>{
                      try{
                        // Important: Quest reports `touched` when finger rests on A/B without a click.
                        // Only treat as a shortcut when the button is actually pressed.
                        const pressed = (c?.pressed === true);
                        if (!pressed) return;
                        if (inXR !== true) return;
                        const now = performance.now();
                        if (now < abComponentCooldownUntil) return;
                        abComponentCooldownUntil = now + 280;
                        handler?.();
                        if (XR_DEBUG) updateXRDebug(`[${tag}] ${source?.inputSource?.handedness || source.uniqueId}`);
                      }catch{}
                    });
                  }catch{}
                };
                const main = mc?.getMainComponent?.();
                // Selection/navigation: keep it on trigger-like components only (avoid A/B conflicts).
                if (main) attachSelectComponent(main);
                const triggerIds = ['xr-standard-trigger','trigger','select','xr-standard-select'];
                for (const id of triggerIds){
                  const comp = mc?.getComponent?.(id);
                  if (comp && comp !== main) attachSelectComponent(comp);
                }

                // Right controller shortcuts (Quest 3): A=next floor, B=next experience.
                const handed = String(source?.inputSource?.handedness || '').toLowerCase();
                if (handed === 'right') {
                  const aBtn =
                    mc?.getComponent?.('a-button') ||
                    mc?.getComponent?.('xr-standard-button-1') ||
                    mc?.getComponent?.('primary-button') ||
                    mc?.getComponent?.('button-1') ||
                    null;
                  const bBtn =
                    mc?.getComponent?.('b-button') ||
                    mc?.getComponent?.('xr-standard-button-2') ||
                    mc?.getComponent?.('secondary-button') ||
                    mc?.getComponent?.('button-2') ||
                    null;
                  attachShortcutButton(aBtn, () => cycleMinimapFloor(+1), 'A');
                  attachShortcutButton(bBtn, () => { void cycleExperience(+1); }, 'B');
                } else if (handed === 'left') {
                  const xBtn =
                    mc?.getComponent?.('x-button') ||
                    mc?.getComponent?.('xr-standard-button-1') ||
                    mc?.getComponent?.('button-1') ||
                    null;
                  const yBtn =
                    mc?.getComponent?.('y-button') ||
                    mc?.getComponent?.('xr-standard-button-2') ||
                    mc?.getComponent?.('button-2') ||
                    null;
                  attachShortcutButton(xBtn, () => cycleMinimapFloor(-1), 'X');
                  attachShortcutButton(yBtn, () => { void cycleExperience(-1); }, 'Y');
                }
              }catch{}
            };

            try{ source.onMotionControllerInitObservable.add(hookMotionController); }catch{}
            try{ if (source?.motionController) hookMotionController(source.motionController); }catch{}
          }catch{}
        };
        input?.onControllerAddedObservable?.add(setupController);
        input?.onControllerRemovedObservable?.add((source)=>{
          try{
            const info = lasers.get(source);
            info?.laser?.dispose?.();
            lasers.delete(source);
          }catch{}
        });
        // Handle controllers that were already available before our observers attached.
        try{ (input?.controllers || []).forEach?.(setupController); }catch{}
        // XR hover highlighting using controller pointer; also provide gaze fallback when no controllers are present
        scene.onBeforeRenderObservable.add(()=>{
          try{
            // Keep XR pano + hotspots centered on the headset (skybox behavior).
            // This cancels headset translation so hotspots don't appear to drift in space.
            try{
              const xrcam = xr?.baseExperience?.camera;
              if (xrcam?.position?.copyToRef && xrContentRoot?.position?.copyFrom) {
                xrContentRoot.position.copyFrom(xrcam.position);
              } else if (xrcam?.position && xrContentRoot?.position) {
                xrContentRoot.position.x = Number(xrcam.position.x) || 0;
                xrContentRoot.position.y = Number(xrcam.position.y) || 0;
                xrContentRoot.position.z = Number(xrcam.position.z) || 0;
              }
              // Do not apply any pitch/roll, but allow yaw offset for thumbstick turning.
              try{
                xrContentRoot.rotation.x = 0;
                xrContentRoot.rotation.z = 0;
                xrContentRoot.rotation.y = Number(xrYawOffset) || 0;
              }catch{}
            }catch{}

            let hoverMeta = null;
            let debugLines = [];
            const bestGamepadYAxis = (controller)=>{
              try{
                const axes = controller?.inputSource?.gamepad?.axes;
                if (!axes || typeof axes.length !== 'number' || axes.length < 2) return 0;
                let best = { x: 0, y: 0, m: 0 };
                for (let i = 0; i + 1 < axes.length; i += 2){
                  const x = Number(axes[i] || 0);
                  const y = Number(axes[i+1] || 0);
                  const m = Math.hypot(x, y);
                  if (m > best.m) best = { x, y, m };
                }
                return best.y || 0;
              }catch{ return 0; }
            };
            const bestGamepadXAxis = (controller)=>{
              try{
                const axes = controller?.inputSource?.gamepad?.axes;
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

            const pollABFromSession = ()=>{
              try{
                if (!inXR) return;
                const nowMs = performance.now();
                if (nowMs < (abPollCooldownUntil || 0)) return;
                const session = xr?.baseExperience?.sessionManager?.session;
                const sources = session ? Array.from(session.inputSources || []) : [];
                if (!sources.length) return;

                const buttonPressed = (btn)=>!!(btn && btn.pressed === true);
                const getBtn = (buttons, idx)=> (Array.isArray(buttons) && buttons.length > idx) ? buttons[idx] : null;

                for (const s of sources){
                  const handed = String(s?.handedness || '').toLowerCase();
                  if (handed !== 'right' && handed !== 'left') continue;
                  const buttons = s?.gamepad?.buttons;
                  if (!buttons) continue;

                  // WebXR "xr-standard" mapping: buttons[4]=button1 (A/X), buttons[5]=button2 (B/Y).
                  const primaryNow = buttonPressed(getBtn(buttons, 4));
                  const secondaryNow = buttonPressed(getBtn(buttons, 5));
                  const prev = abLastPressed.get(s) || { primary: false, secondary: false };

                  if (handed === 'right') {
                    if (primaryNow && !prev.primary) { abPollCooldownUntil = nowMs + 280; cycleMinimapFloor(+1); if (XR_DEBUG) debugLines.push(`${handed}: A(btn4)->floor`); }
                    if (secondaryNow && !prev.secondary) { abPollCooldownUntil = nowMs + 280; void cycleExperience(+1); if (XR_DEBUG) debugLines.push(`${handed}: B(btn5)->exp`); }
                  } else {
                    if (primaryNow && !prev.primary) { abPollCooldownUntil = nowMs + 280; cycleMinimapFloor(-1); if (XR_DEBUG) debugLines.push(`${handed}: X(btn4)->floor-`); }
                    if (secondaryNow && !prev.secondary) { abPollCooldownUntil = nowMs + 280; void cycleExperience(-1); if (XR_DEBUG) debugLines.push(`${handed}: Y(btn5)->exp-`); }
                  }

                  if (XR_DEBUG){
                    try{
                      const pressed = [];
                      for (let i = 0; i < Math.min(12, buttons.length); i++){
                        if (buttonPressed(buttons[i])) pressed.push(i);
                      }
                      if (pressed.length){
                        const mapping = String(s?.gamepad?.mapping || '');
                        debugLines.push(`session ${handed} map=${mapping || 'n/a'} pressed=[${pressed.join(',')}]`);
                      }
                    }catch{}
                  }

                  abLastPressed.set(s, { primary: primaryNow, secondary: secondaryNow });
                }
              }catch{}
            };

            if (inXR && lasers.size){
              let closest = Infinity;
              for (const [controller, info] of lasers.entries()){
                const res = makeHotspotRayFromPointer(info?.pointer, controller);
                const hit = res?.hit;
                info.hit = hit;
                info.distance = hit?.distance ?? null;
                if (hit?.hit && hit.distance < closest){
                  closest = hit.distance;
                  hoverMeta = hit.pickedMesh?.metadata?.hotspot ? hit.pickedMesh.metadata : null;
                }
                if (XR_DEBUG){
                  const label = controller?.inputSource?.handedness || controller?.uniqueId || `controller${debugLines.length+1}`;
                  if (hit?.hit){
                    const meta = hit.pickedMesh?.metadata;
                    debugLines.push(`${label}: hit d=${hit.distance.toFixed(1)} to=${meta?.to || 'n/a'}`);
                  } else {
                    debugLines.push(`${label}: no hit`);
                  }
                  try{
                    const mc = info?.motionController;
                    const thumbstick = mc?.getComponent?.('xr-standard-thumbstick') || mc?.getComponent?.('thumbstick');
                    const ax = thumbstick?.axes;
                    const x = (ax?.x ?? 0);
                    const y = (ax?.y ?? 0);
                    if (thumbstick && ax) debugLines.push(`${label}: stick x=${x.toFixed(2)} y=${y.toFixed(2)} src=${thumbstick?.id || 'thumbstick'}`);
                    else {
                      const gy = bestGamepadYAxis(controller);
                      if (gy) debugLines.push(`${label}: gamepad y=${gy.toFixed(2)}`);
                    }
                  }catch{}
                }

                // Fallback A/B detection using raw WebXR Gamepad buttons.
                try{
                  const handed = String(controller?.inputSource?.handedness || '').toLowerCase();
                  const buttonPressed = (btn)=>!!(btn && btn.pressed === true);
                  const btn = (buttons, idx)=> (Array.isArray(buttons) && buttons.length > idx) ? buttons[idx] : null;
                  if (handed === 'right') {
                    const gp = controller?.inputSource?.gamepad;
                    const buttons = gp?.buttons;
                    const aNow = buttonPressed(btn(buttons,4));
                    const bNow = buttonPressed(btn(buttons,5));
                    const prev = abLastPressed.get(controller) || { a: false, b: false };
                    const nowMs = performance.now();
                    if (nowMs >= (abPollCooldownUntil || 0)) {
                      if (aNow && !prev.a) { abPollCooldownUntil = nowMs + 280; cycleMinimapFloor(+1); if (XR_DEBUG) debugLines.push(`${handed}: A->floor`); }
                      if (bNow && !prev.b) { abPollCooldownUntil = nowMs + 280; void cycleExperience(+1); if (XR_DEBUG) debugLines.push(`${handed}: B->exp`); }
                    }
                    abLastPressed.set(controller, { a: aNow, b: bNow });
                  } else if (handed === 'left') {
                    const gp = controller?.inputSource?.gamepad;
                    const buttons = gp?.buttons;
                    const xNow = buttonPressed(btn(buttons,4));
                    const yNow = buttonPressed(btn(buttons,5));
                    const prev = abLastPressed.get(controller) || { x: false, y: false };
                    const nowMs = performance.now();
                    if (nowMs >= (abPollCooldownUntil || 0)) {
                      if (xNow && !prev.x) { abPollCooldownUntil = nowMs + 280; cycleMinimapFloor(-1); if (XR_DEBUG) debugLines.push(`${handed}: X->floor-`); }
                      if (yNow && !prev.y) { abPollCooldownUntil = nowMs + 280; void cycleExperience(-1); if (XR_DEBUG) debugLines.push(`${handed}: Y->exp-`); }
                    }
                    abLastPressed.set(controller, { x: xNow, y: yNow });
                  }
                }catch{}
              }
            } else {
              if (XR_DEBUG) updateXRDebug('not in XR');
            }
            // Poll from the raw XR session as an extra fallback (works even when motion-controller
            // components aren't available and/or pointers are disabled).
            pollABFromSession();

            // Apply hover (controller-only; gaze selection disabled)
            updateHotspotHover(hoverMeta);

            // Thumbstick turning (smooth rotation) - rotates the pano/hotspots around the user.
            try{
              if (inXR){
                const TURN_DEADZONE = 0.14;
                const TURN_SPEED_RAD_PER_SEC = rad(140); // ~140°/s at full deflection
                const wrap = (v)=>{ const TAU=Math.PI*2; let x=v%TAU; if(x>Math.PI) x-=TAU; if(x<-Math.PI) x+=TAU; return x; };
                const dtSec = Math.max(0, Math.min(0.05, (engine?.getDeltaTime?.() || 16) / 1000));
                let bestX = 0;
                const ctrls = Array.from(xr?.baseExperience?.input?.controllers || []);
                const readX = (source)=>{
                  try{
                    // Prefer motion-controller component axes when available (works in some emulators/runtimes).
                    const mc = source?.motionController;
                    const thumbstick = mc?.getComponent?.('xr-standard-thumbstick') || mc?.getComponent?.('thumbstick');
                    const ax = thumbstick?.axes;
                    const fromComp =
                      (typeof ax?.x === 'number' ? ax.x
                        : (Array.isArray(ax) ? (Number(ax[0] || 0)) : null));
                    if (fromComp != null && Number.isFinite(fromComp)) return fromComp;
                    // Fallback: raw gamepad axes (pick the strongest axis-pair by magnitude).
                    return bestGamepadXAxis(source) || 0;
                  }catch{}
                  return 0;
                };
                for (const c of ctrls){
                  const x = readX(c);
                  if (Math.abs(x) > Math.abs(bestX)) bestX = x;
                }
                // Fallback: read directly from WebXR session inputSources (bypasses Babylon wrappers).
                if (Math.abs(bestX) <= TURN_DEADZONE){
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
                // Fallback: some polyfills/emulators don't populate Babylon controller wrappers correctly.
                if (Math.abs(bestX) <= TURN_DEADZONE){
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
                if (XR_DEBUG) { try{ debugLines.push(`turn bestX=${bestX.toFixed(2)} sign=${XR_TURN_SIGN} yawOff=${(Number(xrYawOffset)||0).toFixed(2)}`); }catch{} }
                // Snap turn at high deflection (more noticeable + comfortable), smooth turn otherwise.
                const nowMs = performance.now();
                const SNAP_THRESHOLD = 0.82;
                const SNAP_RELEASE = 0.35;
                const SNAP_STEP_RAD = rad(30);
                let snapped = false;
                if (Math.abs(bestX) >= SNAP_THRESHOLD){
                  const dir = Math.sign(bestX) || 0;
                  if (dir && (dir !== xrSnapTurnLatch) && (nowMs >= (xrSnapTurnCooldownUntil || 0))){
                    xrSnapTurnLatch = dir;
                    xrSnapTurnCooldownUntil = nowMs + 220;
                    xrYawOffset = wrap((Number(xrYawOffset) || 0) + (dir * SNAP_STEP_RAD));
                    snapped = true;
                    xrTurnLastSyncMs = nowMs;
                    try{ sendSync(currentNodeId); }catch{}
                  }
                } else if (Math.abs(bestX) <= SNAP_RELEASE) {
                  xrSnapTurnLatch = 0;
                }

                if (!snapped && Math.abs(bestX) > TURN_DEADZONE){
                  const s = Math.sign(bestX);
                  const mag = (Math.abs(bestX) - TURN_DEADZONE) / Math.max(1e-6, (1 - TURN_DEADZONE));
                  const scaled = s * Math.max(0, Math.min(1, mag));
                  xrYawOffset = wrap((Number(xrYawOffset) || 0) + (scaled * TURN_SPEED_RAD_PER_SEC * dtSec));
                  const now = nowMs;
                  // Throttle sync to ~10Hz while turning so viewers see rotation without spamming.
                  if (now - (xrTurnLastSyncMs || 0) >= 100){
                    xrTurnLastSyncMs = now;
                    try{ sendSync(currentNodeId); }catch{}
                  }
                }
              }
            }catch{}
             
            // Thumbstick forward navigation: look at hotspot + push thumbstick forward to navigate
            if (inXR && lasers.size){
              const now = performance.now();
              if (now > thumbstickNavCooldown){
                for (const [controller, info] of lasers.entries()){
                  try{
                    const mc = info?.motionController;
                    // Try to get thumbstick component; fall back to raw gamepad axes if needed.
                    const thumbstick = mc?.getComponent?.('xr-standard-thumbstick') || mc?.getComponent?.('thumbstick');
                    const axes = thumbstick?.axes;
                    const yAxis = (axes?.y ?? bestGamepadYAxis(controller)) || 0;
                      
                    // Forward push detected (most controllers use negative Y for "up/forward", but some runtimes invert)
                    if (yAxis < -THUMBSTICK_FORWARD_THRESHOLD || yAxis > THUMBSTICK_FORWARD_THRESHOLD){
                      // Controller-only: navigate only when clearly pointing at a hotspot.
                      const targetMeta = hoverMeta;
                      const targetId = resolveHotspotTargetNodeId(targetMeta);
                      if (targetId){
                        goTo(targetId, { source: 'user', broadcast: true, preserveHeading: { clickedYawDeg: targetMeta?.yawDeg } });
                        thumbstickNavCooldown = now + THUMBSTICK_NAV_COOLDOWN_MS;
                        if (XR_DEBUG){
                          debugLines.push(`thumbstick nav -> ${targetId}`);
                        }
                        break; // Only navigate once per frame
                      }
                    }
                  }catch{}
                }
              }
            }

            if (XR_DEBUG && debugLines.length){
              updateXRDebug(debugLines.join("\n"));
            }
          }catch{}
        });
      }catch{}
      xr?.baseExperience?.onStateChangedObservable?.add(s=>{
        inXR = (s === WebXRState.IN_XR);
        // Analytics: track XR mode change
        try { trackXRMode(inXR); } catch {}
        // Allow UI/app layer to react (e.g., resume/attach audio for XR).
        try { dispatchEvent(new CustomEvent('xr:state', { detail: { inXR } })); } catch {}
        try{
          if (inXR){
            xrYawOffset = 0;
            xrTurnLastSyncMs = 0;
            xrSnapTurnLatch = 0;
            xrSnapTurnCooldownUntil = 0;
            try{ document.body.setAttribute('data-xr','1'); }catch{}
            prevHSL = engine.getHardwareScalingLevel?.() ?? null;
            engine.setHardwareScalingLevel(1.0);
            try{ unlockAudio(); }catch{}
            // Ensure XR camera renders only main layer (exclude mirror layer 0x2)
            try{ const xrcam = xr?.baseExperience?.camera; if (xrcam) xrcam.layerMask = 0x1; }catch{}
            // Disable mirror grid cameras to avoid any overlay conflicts inside XR
            mirrorVisible = false; updateMirrorLayout();
            // Hide 2D domes and mirror while in XR
            try{ dome.setEnabled(false); dome.isVisible = false; }catch{}
            try{ crossDome.setEnabled(false); crossDome.isVisible = false; }catch{}
            try{ mirrorDome.setEnabled(false); mirrorDome.isVisible = false; }catch{}
            // Load current pano into VR PhotoDome and attach XR hotspots
            const cur = nodesById?.get?.(currentNodeId);
            if (cur && cur.file){
              try{ const active = ensureVrDome(activeVr); active.mesh.isVisible = true; active.mesh.setEnabled(true); }catch{}
              setVrPano(cur.file).catch(()=>{});
              attachXRHotspotsToCurrentDome();
              buildHotspotsFor(cur, /*forXR*/ true);
            }
          } else {
            try{ document.body.removeAttribute('data-xr'); }catch{}
            xrYawOffset = 0;
            xrTurnLastSyncMs = 0;
            xrSnapTurnLatch = 0;
            xrSnapTurnCooldownUntil = 0;
            if (prevHSL != null){ engine.setHardwareScalingLevel(prevHSL); }
            // Restore 2D domes and mirror; hide VR domes
            try{ dome.setEnabled(true); dome.isVisible = true; }catch{}
            try{ crossDome.setEnabled(false); crossDome.isVisible = false; }catch{}
            try{ mirrorDome.setEnabled(true); mirrorDome.isVisible = true; }catch{}
            try{ vrDomes.forEach(d=>{ if (d?.mesh){ d.mesh.isVisible = false; d.mesh.setEnabled(false); } }); }catch{}
            // Re-enable mirror grid if it was visible before
            mirrorVisible = true; updateMirrorLayout();
            const cur = nodesById?.get?.(currentNodeId);
            if (cur && cur.file){
              showFile(cur.file).catch?.(()=>{});
              buildHotspotsFor(cur, /*forXR*/ false);
            }
          }
        }catch{}
      });
      try { addEventListener('ui:exit', async ()=>{ try{ await xr?.baseExperience?.exitXRAsync?.(); }catch{} }); } catch {}
      // Also respond to XR pointer selection events (in case controller trigger observable is unavailable)
      try{
        const ps = xr?.pointerSelection;
        if (ps){
          // Restrict built-in XR selection to our hotspots only
          try { ps.raySelectionPredicate = (m)=>!!(m?.metadata?.hotspot===true); } catch {}
          ps.onSelectionObservable?.add((evt)=>{
            try{
              const picked = evt?.pickInfo;
               const md = picked?.pickedMesh?.metadata;
               const targetId = resolveHotspotTargetNodeId(md);
              if (targetId) goTo(targetId, { source: 'user', broadcast: true, preserveHeading: { clickedYawDeg: md?.yawDeg } });
             }catch{}
           });
         }
        // Fallback: session 'select' events (covers emulators / limited runtimes)
        try{
          const session = xr?.baseExperience?.sessionManager?.session;
          if (session && !session.__agentSelectHooked){
            session.__agentSelectHooked = true;
            const handler = ()=>{
              try{
                const xrcam = xr?.baseExperience?.camera;
                const pred = (m)=>m?.metadata?.hotspot===true;
                const ray = xrcam?.getForwardRay ? xrcam.getForwardRay(DOME_DIAMETER) : null;
                const hit = ray ? scene.pickWithRay(ray, pred, false, null, xrcam) : null;
                const md = hit?.pickedMesh?.metadata;
                const targetId = resolveHotspotTargetNodeId(md);
                if (targetId) goTo(targetId, { source: 'user', broadcast: true, preserveHeading: { clickedYawDeg: md?.yawDeg } });
              }catch{}
            };
            session.addEventListener('select', handler);
          }
        }catch{}
      }catch{}
    }
  }catch{}

  // Defensive guard: keep 2D domes disabled while in XR sessions
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (!inXR) return;
      if (dome?.isEnabled()) dome.setEnabled(false);
      if (crossDome?.isEnabled()) crossDome.setEnabled(false);
      if (mirrorDome?.isEnabled()) mirrorDome.setEnabled(false);
    }catch{}
  });

  /* boot */
  const start = nodesById.get(startNodeId);
  await showFile(start.file);
  worldRoot.position.copyFrom(nodeWorldPos(start));
  worldYaw = 0;
  worldRoot.rotation.y = 0;
  // By default, face the first/primary hotspot; allow experiences to opt out
  // (so the authored pano yaw controls the initial direction).
  cam.rotation.y = 0;
  cam.rotation.x = 0;
  // Clubhouse: start view rotated 180° (requested orientation for the start pano).
  if (expName() === "clubhouse") {
    cam.rotation.y = Math.PI;
  }
  setCamPitch(0);
  buildHotspotsFor(start, /*forXR*/ false);
  await setMirrorNode(start.id);
  // Keep mirror dome unrotated; mirror cameras apply remote viewer yaw/pitch directly.
  mirrorDome.rotation.y = 0;
  updateMirrorLayout();
  sendSync(start.id);
  
  // Show initial zone name after image loaded
  setTimeout(() => {
    lastDisplayedZoneId = null; // Reset so starting zone always shows
    checkAndShowZone(start);
  }, 500);
  
  // Analytics: track initial experience and node
  try {
    trackExperience(exp, exp);
    const startZone = (data?.zones || []).find(z => z.id === start.zoneId);
    trackNodeVisit(start.id, start.file, start.zoneId, startZone?.name || start.zoneId);
  } catch {}

  api = {
    isInXR: ()=>inXR === true,
    getPose: ()=>{
      try{
        if (inXR === true) {
          const xrCam = xr?.baseExperience?.camera || null;
          const dir = xrCam?.getForwardRay?.(1)?.direction || null;
          if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z)) {
            const yaw = Math.atan2(-dir.x, -dir.z);
            const pitch = Math.asin(Math.max(-1, Math.min(1, Number(dir.y) || 0)));
            return { yaw, pitch, mode: 'xr' };
          }
          return { yaw: cam.rotation.y, pitch: cam.rotation.x, mode: 'xr' };
        }
      }catch{}
      return { yaw: cam.rotation.y, pitch: cam.rotation.x, mode: '2d' };
    },
    setPose: ({ yaw, pitch, sync = false } = {})=>{
      try{
        if (Number.isFinite(Number(yaw))) cam.rotation.y = Number(yaw);
      }catch{}
      try{
        if (Number.isFinite(Number(pitch))) setCamPitch(Number(pitch));
      }catch{}
      if (sync) { try{ sendSync(currentNodeId); }catch{} }
    },
    preloadNode: (nodeId)=>{
      try{
        const id = String(nodeId || '').trim();
        if (!id || !nodesById.has(id)) return;
        const node = nodesById.get(id);
        const file = node?.file;
        if (!file) return;
        // Best-effort preload: 2D warms texture cache; XR already guards against black frames on navigation.
        if (inXR === true) return;
        void getTexture(file).catch(()=>{});
      }catch{}
    },
    nudgeYaw:  d=>{ cam.rotation.y += (d||0); sendSync(currentNodeId); },
    nudgePitch:d=>{ const clamp=Math.PI*70/180; const nx=Math.max(-clamp,Math.min(clamp,cam.rotation.x + (d||0))); cam.rotation.x = nx; sendSync(currentNodeId); },
    adjustFov: d=>{ const MIN_FOV=0.45, MAX_FOV=1.7; cam.fov=Math.max(MIN_FOV,Math.min(MAX_FOV, cam.fov + (d||0))); },
    toggleMirror: ()=>{ mirrorVisible=!mirrorVisible; if (!mirrorVisible) cam.viewport=new Viewport(0,0,1,1); updateMirrorLayout(); },
    switchView: ()=>{ mirrorPrimary = !mirrorPrimary; updateMirrorLayout(); },
    toggleMinimap: ()=>{ const wrap=document.querySelector('.mini-wrap'); if(wrap){ const show=wrap.style.display==='none'; wrap.style.display= show? '' : 'none'; } },
    toggleXR: async ()=>{
      if (!xr?.baseExperience) return;
      try{
        const inx = (xr.baseExperience.state === WebXRState.IN_XR);
        if (inx) {
          await xr.baseExperience.exitXRAsync?.();
          return;
        }
        // Reduce chance of black frame on entry: try to prewarm the current pano into the VR dome first.
        try{
          const cur = nodesById?.get?.(currentNodeId) || null;
          if (cur?.file) {
            const warm = prewarmVrDome(cur.file);
            if (warm) await Promise.race([warm, new Promise(r => setTimeout(r, 2500))]);
          }
        }catch{}
        await xr.baseExperience.enterXRAsync?.("immersive-vr", "local-floor");
      }catch{}
    },
    switchExperience: async (newExp)=>{
      if (!newExp) return;
      const normalized = String(newExp).trim();
      
      // Analytics: track experience change
      try { trackExperience(normalized, normalized); } catch {}
      
      const pack = await loadExperiencePackage(normalized);
      if (!pack) return;
      if (pack.base === BASE && nodesById.has(pack.startNodeId || pack.data?.startNodeId || '')) return;
      const nextMeta = resolveMetaConfig(normalized);
      const flipXChanged = nextMeta.flipX !== flipX;
      flipU = nextMeta.flipU;
      flipX = nextMeta.flipX;
      startFaceHotspot = nextMeta.startFaceHotspot;
      hotspotNavTags = nextMeta.hotspotNavTags;
      if (flipXChanged){
        dome.rotation.x = flipX ? Math.PI : 0;
        crossDome.rotation.x = flipX ? Math.PI : 0;
        mirrorDome.rotation.x = flipX ? Math.PI : 0;
        try{ vrDomes.forEach(d=>{ if (d?.mesh) d.mesh.rotation.x = flipX ? Math.PI : 0; }); }catch{}
      }
      try{ vrDomes.forEach(applyVrTextureMapping); }catch{}
      vrReadyFile = null; vrWarmPromise = null; vrWarmTarget = null; try{ vrPreloadedUrls.clear(); }catch{} try{ vrDomes.forEach(d=>{ if (d){ d.__panoFile = null; } }); }catch{}
      BASE = pack.base;
      PANOS_DIR = "panos";
      try{ for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} } texCache.clear(); }catch{}
      data = pack.data;
      nodesById = pack.nodesById;
      startNodeId = pack.data?.startNodeId ?? pack.startNodeId ?? startNodeId;
      // Apply experience-specific zone ordering (zone-order.json) if provided.
      applyZoneOrderToData(data, await loadZoneOrderFor(normalized, BASE));
      rememberExperience(normalized, pack);
      try{
        const probe = nodesById.get(startNodeId) || (nodesById.size ? nodesById.values().next().value : null);
        await refreshPreferKtx2Effective(normalized, probe?.file);
      }catch{}
      await maybeSelectMobilePanoDir();
      rebuildFloorMaps();
      const node = nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null); if (!node) return;
      currentNodeId = node.id;
      lastNodeId = null;
      if (inXR === true) {
        // Switch experience without exiting XR: load into VR dome + rebuild XR hotspots.
        try { const active = ensureVrDome(activeVr); active.mesh.isVisible = true; active.mesh.setEnabled(true); } catch {}
        try { await setVrPano(node.file); } catch {}
        try { attachXRHotspotsToCurrentDome(); } catch {}
        try { buildHotspotsFor(node, /*forXR*/ true); } catch {}
        // Ensure 2D domes remain disabled in XR.
        try{ dome.setEnabled(false); dome.isVisible = false; }catch{}
        try{ crossDome.setEnabled(false); crossDome.isVisible = false; }catch{}
        try{ mirrorDome.setEnabled(false); mirrorDome.isVisible = false; }catch{}
      } else {
        await showFile(node.file);
        buildHotspotsFor(node, /*forXR*/ false);
      }
      worldRoot.position.copyFrom(nodeWorldPos(node));
      worldYaw = 0;
      worldRoot.rotation.y = 0;
      cam.rotation.y = 0;
      cam.rotation.x = 0;
      // Clubhouse: start view rotated 180°.
      if (normalized === "clubhouse") {
        cam.rotation.y = Math.PI;
      }
      setCamPitch(0);
      await setMirrorNode(node.id);
      rebuildMinimap(); updateMirrorLayout(); sendSync(node.id);
      try{ dispatchEvent(new CustomEvent('agent:experience', { detail: { expId: normalized, nodeId: node.id } })); }catch{}
    },
    // Allow UI to refresh overlays on fullscreen changes
    refreshOverlays: ()=>{ try{ rebuildMinimap(); }catch{} try{ updateMirrorLayout(); }catch{} },
    // Allow UI to trigger a resize after CSS pseudo-fullscreen / viewport changes (iOS)
    resize: ()=>{ try{ engine.resize(); }catch{} try{ updateMirrorLayout(); }catch{} },
    setMirrorPitchSign: (s)=>{ const n = Number(s); if (n===1 || n===-1){ MIRROR_PITCH_SIGN = n; } },
    toggleMirrorPitchSign: ()=>{ MIRROR_PITCH_SIGN *= -1; },
    setMirrorYawSign: (s)=>{ const n = Number(s); if (n===1 || n===-1){ MIRROR_YAW_SIGN = n; } },
    toggleMirrorYawSign: ()=>{ MIRROR_YAW_SIGN *= -1; },
    // Expose minimal navigation and data for AI assistant
    getContext: ()=>({
      exp: expName(),
      zoneOrder: (()=>{
        try { return experienceDataCache.get(expName())?.zoneOrder || null; } catch { return null; }
      })(),
      floors: data?.floors||[],
      zones: data?.zones||[],
      nodes: data?.nodes?.map(n=>({ id:n.id, floorId:n.floorId, zoneId:n.zoneId }))||[],
      currentNodeId
    }),
    getExperienceData: async (expId)=>{
      const target = String(expId || expName()).trim();
      if (!target || target === expName()){
        const zOrder = (()=>{ try { return experienceDataCache.get(expName())?.zoneOrder || null; } catch { return null; } })();
        return cloneExperienceData({ data, expId: expName(), startNodeId, zoneOrder: zOrder });
      }
      const pack = await loadExperiencePackage(target);
      if (!pack) return null;
      return cloneExperienceData(pack);
    },
    goToNode: (id, options)=>goTo(id, {
      source: (options && typeof options === 'object' && options.source) ? options.source : 'user',
      broadcast: options?.broadcast,
      sync: options?.sync,
      duration: options?.duration,
      push: options?.push,
      forceCrossfade: options?.forceCrossfade,
    }),
    // Legacy hook (kept for compatibility): mirror dome stays unrotated.
    syncMirrorYaw: ()=>{
      mirrorDome.rotation.y = 0;
    },
    goToZoneByName: (nameOrId, options={})=>{
      if (!nameOrId) return Promise.resolve();
      const q = String(nameOrId).toLowerCase().trim();
      const zones = data?.zones || [];
      // Search by id first, then by name
      let zone = zones.find(z => String(z.id).toLowerCase() === q);
      if (!zone) zone = zones.find(z => String(z.name || '').toLowerCase() === q);
      if (!zone) zone = zones.find(z => String(z.name || '').toLowerCase().includes(q));
      if (!zone) { console.warn('[AGENT] Zone not found:', nameOrId); return Promise.resolve(); }
      // Choose rep node or first node within that zone on current floor, else any
      const cur = nodesById.get(currentNodeId) || null;
      const repId = resolveZoneRepresentativeNodeId(zone.id, cur?.floorId || null);
      const cand = repId ? nodesById.get(repId) : null;
      if (cand) return goTo(cand.id, {
        source: (options && typeof options === 'object' && options.source) ? options.source : 'user',
        broadcast: options?.broadcast,
        sync: options?.sync,
        // When entering a zone from the zone bar, face the primary walk hotspot so
        // the "next pano" is immediately visible and clickable.
        faceHotspot: options?.faceHotspot !== undefined ? Boolean(options.faceHotspot) : true,
      });
      console.warn('[AGENT] No node found for zone:', zone.id);
      return Promise.resolve();
    },
    goToNextInZone: ()=>{
      const cur = nodesById.get(currentNodeId); if(!cur||!cur.zoneId) return Promise.resolve();
      const nextId = pickNextInZoneByHotspot(cur, lastNodeId);
      if (nextId && nodesById.has(nextId)) return goTo(nextId, { source:'user', broadcast:true, faceHotspot:true });
      const list=(data?.nodes||[]).filter(n=>n.zoneId===cur.zoneId);
      if (!list.length) return Promise.resolve();
      const i = Math.max(0, list.findIndex(n=>n.id===cur.id));
      const next = list[(i+1)%list.length];
      return goTo(next.id,{ source:'user', broadcast:true, faceHotspot:true });
    },
    goToPrevInZone: ()=>{
      const cur = nodesById.get(currentNodeId); if(!cur||!cur.zoneId) return Promise.resolve();
      if (lastNodeId && nodesById.has(lastNodeId)){
        const prev = nodesById.get(lastNodeId);
        if (String(prev?.zoneId || '') === String(cur.zoneId)) {
          return goTo(prev.id, { source:'user', broadcast:true, faceHotspot:true });
        }
      }
      const list=(data?.nodes||[]).filter(n=>n.zoneId===cur.zoneId);
      if (!list.length) return Promise.resolve();
      const i = Math.max(0, list.findIndex(n=>n.id===cur.id));
      const prev = list[(i-1+list.length)%list.length];
      return goTo(prev.id,{ source:'user', broadcast:true, faceHotspot:true });
    },
    // Analytics API
    getAnalytics: ()=>getAnalyticsSummary(),
    exportAnalytics: ()=>{ try{ getAnalytics().exportAnalytics(); }catch{} }
  };

  try{
    if (typeof window !== "undefined"){
      window.__xrDebug = {
        xrHotspots: ()=>({
          xr: hotspotRootXR?.getChildren?.()?.length ?? 0,
          dom: hotspotRoot?.getChildren?.()?.length ?? 0
        }),
        xrControllers: ()=>Array.from(xr?.baseExperience?.input?.controllers || []).map(c=>({
          id: c?.uniqueId,
          handedness: c?.inputSource?.handedness,
          hasMotionController: !!c?.motionController
        })),
        xrHotspotMeshes: ()=>(hotspotRootXR?.getChildren?.() || []).map(m=>({
          name: m?.name,
          meta: m?.metadata,
          children: m?.getChildMeshes?.()?.map(ch=>({ name: ch?.name, meta: ch?.metadata })) || []
        })),
        xrState: ()=>({ inXR, controllers: Array.from(xr?.baseExperience?.input?.controllers || []).length }),
        currentNode: ()=>{
          const n = nodesById.get(currentNodeId);
          return n ? { id: n.id, hotspots: Array.isArray(n.hotspots)? n.hotspots.map(h=>({ to:h?.to, yaw:h?.yaw, pitch:h?.pitch })) : [] } : null;
        }
      };
    }
  }catch{}

  engine.runRenderLoop(()=>scene.render());
  const scheduleResize = (() => {
    let raf = 0;
    return () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try { engine.resize(); } catch {}
        try { updateMirrorLayout(); } catch {}
      });
    };
  })();

  // Stream guide pose so viewers can match the guide's view direction (throttled).
  // This is only used by guided viewers (app.js passes followGuideYaw=true).
  let _guidePoseLastT = 0;
  let _guidePoseLastSent = { yaw: 0, pitch: 0 };
  scene.onBeforeRenderObservable.add(()=>{
    try{
      const now = performance.now();
      if (now - _guidePoseLastT < 100) return; // ~10Hz
      _guidePoseLastT = now;
      if (!(socket && socket.readyState === 1)) return;
      if (!currentNodeId) return;

      const pose = computeGuidePose();
      const q = (v, step) => Math.round(v / step) * step;
      pose.yaw = q(pose.yaw, 0.005);
      pose.pitch = q(pose.pitch, 0.005);
      const dy = Math.abs(angleDelta(pose.yaw, _guidePoseLastSent.yaw));
      const dp = Math.abs(angleDelta(pose.pitch, _guidePoseLastSent.pitch));
      const MIN_DELTA = 0.0087; // ~0.5°
      if (dy < MIN_DELTA && dp < MIN_DELTA) return;

      _guidePoseLastSent = { yaw: pose.yaw, pitch: pose.pitch };
      // Pose-only sync (keep it small; nodeId/expPath included for robustness)
      const expPath = `experiences/${expName()}`;
      safeSend({ type:"sync", from:"guide", room: roomId, nodeId: currentNodeId, exp: expName(), expPath, pose, seq:(++guideSyncSeq), ts: Date.now() });
    }catch{}
  });
  try {
    window.addEventListener("resize", scheduleResize, { passive: true });
    window.addEventListener("orientationchange", () => setTimeout(scheduleResize, 50), { passive: true });
    window.visualViewport?.addEventListener?.("resize", scheduleResize, { passive: true });
    window.visualViewport?.addEventListener?.("scroll", scheduleResize, { passive: true });
    window.addEventListener("app:viewport", scheduleResize, { passive: true });
  } catch {}
  scheduleResize();
  // Keep mirror/minimap healthy during long sessions (avoid reloading panos; that causes visible "jerks").
  try { setInterval(()=>{ try{ updateMirrorLayout(); }catch{} }, 30000); } catch {}
  return api;
}

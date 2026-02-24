// Autoplay controller (separate from tour.js)
// Drives pano-to-pano playback following the bottom zone bar order.

function now() { try { return performance.now(); } catch { return Date.now(); } }

const TWO_PI = Math.PI * 2;
const DEFAULT_DWELL_SEC = 7;
const DEFAULT_ROTATION_PERIOD_SEC = 10;
const DEFAULT_ROTATION_DIR = (()=>{
  try{
    const qs = new URLSearchParams(location.search);
    const raw = String(qs.get('tourDir') || qs.get('tourRotateDir') || '').trim().toLowerCase();
    if (raw === 'ccw' || raw === 'left' || raw === '-1') return -1;
    if (raw === 'cw' || raw === 'right' || raw === '1') return 1;
  }catch{}
  try{
    const raw = String(import.meta?.env?.VITE_TOUR_ROTATE_DIR ?? '').trim().toLowerCase();
    if (raw === 'ccw' || raw === 'left' || raw === '-1') return -1;
    if (raw === 'cw' || raw === 'right' || raw === '1') return 1;
  }catch{}
  return 1;
})();

const clampDwellMs = (sec) => {
  const v = Number(sec);
  const s = Number.isFinite(v) ? v : DEFAULT_DWELL_SEC;
  return Math.max(1000, Math.round(s * 1000));
};

const clampRotationPeriodSec = (sec) => {
  const v = Number(sec);
  if (!Number.isFinite(v)) return DEFAULT_ROTATION_PERIOD_SEC;
  return Math.max(2, Math.min(120, v));
};

function wrapPi(a){
  let x = Number(a);
  if (!Number.isFinite(x)) return 0;
  x = (x + Math.PI) % (TWO_PI);
  if (x < 0) x += TWO_PI;
  return x - Math.PI;
}
function angleDelta(target, current){
  return wrapPi(Number(target) - Number(current));
}
function easeInOutSine(t){
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  return -(Math.cos(Math.PI * x) - 1) / 2;
}
function camYawFromHotspotYawDeg(hotspotYawDeg){
  const d = Number(hotspotYawDeg);
  if (!Number.isFinite(d)) return null;
  return (d - 90) * Math.PI / 180;
}

function buildNodeIndex(expData){
  const nodes = Array.isArray(expData?.nodes) ? expData.nodes : [];
  const nodesById = new Map();
  for (const n of nodes){
    const id = String(n?.id || '');
    if (id) nodesById.set(id, n);
  }
  return nodesById;
}

function computeTargetYaw({ curNode, nextNode, nextNodeId } = {}){
  if (!curNode) return null;

  // Prefer an explicit hotspot pointing to the next pano (best continuity).
  try{
    const hs = Array.isArray(curNode?.hotspots) ? curNode.hotspots : [];
    const targetId = String(nextNodeId || nextNode?.id || '');
    if (targetId){
      const h = hs.find(x => String(x?.to || '') === targetId) || null;
      const hsYaw = (typeof h?.absYaw === 'number') ? h.absYaw : h?.yaw;
      const byHotspot = camYawFromHotspotYawDeg(hsYaw);
      if (byHotspot != null) return byHotspot;
    }
  }catch{}

  // Fallback: face the spatial direction to the next pano (using authored minimap coords).
  try{
    const ax = Number(curNode?.x), az = Number(curNode?.y);
    const bx = Number(nextNode?.x), bz = Number(nextNode?.y);
    if (Number.isFinite(ax) && Number.isFinite(az) && Number.isFinite(bx) && Number.isFinite(bz)) {
      const dx = bx - ax;
      const dz = bz - az;
      if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) {
        return Math.atan2(-dx, -dz); // yaw=0 looks at -Z
      }
    }
  }catch{}

  return null;
}

function orderNodesForZones(expData){
  const nodes = Array.isArray(expData?.nodes) ? expData.nodes : [];
  const zones = Array.isArray(expData?.zones) ? expData.zones : [];

  // Prefer an explicit zone order (from zone-order.json) when available.
  const explicitZoneOrder = Array.isArray(expData?.zoneOrder) ? expData.zoneOrder : null;
  const zonesById = new Map();
  for (let i = 0; i < zones.length; i++){
    const id = String(zones[i]?.id || '').trim();
    if (id && !zonesById.has(id)) zonesById.set(id, i);
  }

  const orderedZoneIds = [];
  const seenZoneIds = new Set();
  if (explicitZoneOrder && explicitZoneOrder.length){
    for (const item of explicitZoneOrder){
      const id = String(item || '').trim();
      if (!id || seenZoneIds.has(id)) continue;
      if (!zonesById.has(id)) continue;
      seenZoneIds.add(id);
      orderedZoneIds.push(id);
    }
  }
  // Append any zones not mentioned in zone-order.json (preserve authored zone array order).
  for (const z of zones){
    const id = String(z?.id || '').trim();
    if (!id || seenZoneIds.has(id)) continue;
    seenZoneIds.add(id);
    orderedZoneIds.push(id);
  }

  const zoneIdSet = new Set(orderedZoneIds);
  const out = [];

  for (const zid of orderedZoneIds){
    if (!zid) continue;
    const inZone = nodes.filter(n => String(n?.zoneId || '') === zid);
    for (const n of inZone){
      const id = String(n?.id || '');
      if (id) out.push(id);
    }
  }

  // Unzoned + unknown-zone nodes go last, preserving authored order.
  for (const n of nodes){
    const zid = String(n?.zoneId || '');
    if (zid && zoneIdSet.has(zid)) continue;
    const id = String(n?.id || '');
    if (id) out.push(id);
  }

  // Deduplicate while preserving order.
  const seen = new Set();
  const deduped = [];
  for (const id of out){
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

export function createAutoplayController({
  api,
  dwellSec = DEFAULT_DWELL_SEC,
  rotationPeriodSec = DEFAULT_ROTATION_PERIOD_SEC,
  rotationDir = DEFAULT_ROTATION_DIR,
  experiencesMeta = [],
  onEvent
} = {}){
  let playing = false;
  let plan = []; // [{ exp, nodeId }]
  let index = -1; // points at current step in plan
  let runToken = 0;
  const expCache = new Map(); // expId -> { expData, nodesById, route }
  const rotationRateRps = TWO_PI / clampRotationPeriodSec(rotationPeriodSec); // used as a max-speed guard
  let activeExpId = '';
  let suppressExperienceStopUntil = 0;
  let internalExperienceSwitch = false;

  function emit(name, detail){
    try { onEvent?.(name, detail); } catch {}
    try { dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }

  function getExperienceList(){
    const ids = [];
    const push = (id)=>{
      const v = String(id || '').trim();
      if (!v) return;
      if (ids.includes(v)) return;
      ids.push(v);
    };
    if (Array.isArray(experiencesMeta)) {
      for (const item of experiencesMeta) push(item?.id);
    }
    return ids;
  }

  async function loadExperience(expId){
    const key = String(expId || '').trim();
    if (!key) return null;
    if (expCache.has(key)) return expCache.get(key);
    try{
      const expData = await api?.getExperienceData?.(key);
      const nodesById = buildNodeIndex(expData);
      const route = orderNodesForZones(expData);
      const entry = { expData, nodesById, route };
      expCache.set(key, entry);
      return entry;
    }catch{
      expCache.set(key, null);
      return null;
    }
  }

  async function ensurePlan({ fromCurrent = true } = {}){
    const ctx = await api?.getContext?.();
    const curExp = String(ctx?.exp || '').trim();
    if (!curExp) throw new Error('Autoplay: missing experience id');
    activeExpId = curExp;

    const expList = getExperienceList();
    if (!expList.length) expList.push(curExp);
    if (!expList.includes(curExp)) expList.unshift(curExp);

    const startExpIdx = Math.max(0, expList.indexOf(curExp));
    const expTail = expList.slice(startExpIdx);

    const steps = [];
    for (const expId of expTail){
      const pack = await loadExperience(expId);
      const route = pack?.route || [];
      if (!route.length) continue;
      for (const nodeId of route){
        steps.push({ exp: expId, nodeId });
      }
    }
    if (!steps.length) throw new Error('Autoplay: empty plan');

    plan = steps;
    index = -1;

    if (fromCurrent) {
      const curNodeId = String(ctx?.currentNodeId || '').trim();
      if (curNodeId){
        const i = plan.findIndex(s => s?.exp === curExp && String(s?.nodeId || '') === curNodeId);
        if (i >= 0) index = i;
      }
    }
    if (index < 0) index = 0;
    return ctx;
  }

  function stopInternal(reason = 'stop'){
    playing = false;
    runToken++;
    emit('tour:stop', { reason, index, exp: activeExpId });
  }

  async function syncIndexToCurrent(){
    const ctx = await api?.getContext?.();
    const nodeId = String(ctx?.currentNodeId || '').trim();
    const expId = String(ctx?.exp || '').trim();
    if (!nodeId) return false;
    if (!expId) return false;
    const i = plan.findIndex(s => s?.exp === expId && String(s?.nodeId || '') === nodeId);
    if (i >= 0) { index = i; activeExpId = expId; return true; }
    return false;
  }

  async function animateRotation({ targetYaw, dwellMs, token } = {}){
    const ms = Math.max(250, Number(dwellMs) || 0);

    const waitCancelable = (msWait) => new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, Number(msWait) || 0));
      const tick = () => {
        if (token !== runToken) { clearTimeout(t); resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const pose = api?.getPose?.();
    const mode = String(pose?.mode || '2d');
    const isXR = mode === 'xr' || mode === 'webxr' || api?.isInXR?.() === true;

    if (isXR) {
      await waitCancelable(ms);
      return;
    }

    const startYaw = Number(pose?.yaw);
    const startPitch = Number(pose?.pitch);

    if (!Number.isFinite(startYaw)) {
      await waitCancelable(ms);
      return;
    }

    const dir = (Number(rotationDir) === -1) ? -1 : 1;
    const safeTargetYaw = Number.isFinite(Number(targetYaw))
      ? Number(targetYaw)
      : (startYaw + (dir * rotationRateRps * (ms / 1000))); // Always rotate, even without a next-target.

    // Cinematic plan:
    // - Single continuous rotation over the entire dwell time.
    // - End EXACTLY facing the next pano direction (no post-rotation "adjust" phase).
    // - Use easing for a filmic feel while keeping motion stable.
    let delta = angleDelta(safeTargetYaw, startYaw); // shortest path

    // Enforce ONE rotation direction across all panos (no back-and-forth).
    // This intentionally chooses the long way around if needed.
    if (dir > 0 && delta < 0) delta += TWO_PI;
    if (dir < 0 && delta > 0) delta -= TWO_PI;

    // Speed guard (at most one full turn per `rotationPeriodSec` seconds).
    const maxDelta = rotationRateRps * (ms / 1000);
    if (Math.abs(delta) > maxDelta + 1e-6) delta = dir * maxDelta;
    const finalYaw = startYaw + delta;

    const startedAt = now();
    await new Promise((resolve) => {
      const step = () => {
        if (token !== runToken) return resolve();
        const t = Math.min(1, (now() - startedAt) / Math.max(1, ms));
        const eased = easeInOutSine(t);
        const yaw = startYaw + delta * eased;
        try { api?.setPose?.({ yaw, pitch: startPitch, sync: false }); } catch {}
        if (t >= 1) return resolve();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    if (token === runToken) {
      try { api?.setPose?.({ yaw: finalYaw, pitch: startPitch, sync: true }); } catch {}
    }
  }

  async function runLoop(){
    const token = ++runToken;
    const dwellMs = clampDwellMs(dwellSec);

    while (playing && token === runToken && index >= 0 && index < plan.length) {
      const curStep = plan[index] || null;
      const nextStep = (index + 1 < plan.length) ? plan[index + 1] : null;
      const curExp = String(curStep?.exp || '').trim();
      const curNodeId = String(curStep?.nodeId || '').trim();
      const nextExp = String(nextStep?.exp || '').trim();
      const nextNodeId = String(nextStep?.nodeId || '').trim();
      activeExpId = curExp || activeExpId;

      const curPack = curExp ? await loadExperience(curExp) : null;
      const nextPack = nextExp ? await loadExperience(nextExp) : null;
      const curNode = (curPack?.nodesById && curNodeId) ? curPack.nodesById.get(curNodeId) : null;
      const nextNode = (nextPack?.nodesById && nextNodeId && nextExp === curExp) ? nextPack.nodesById.get(nextNodeId) : null;

      // Prefetch next pano early to avoid stalls/black frames (only meaningful within same experience).
      if (nextNodeId && nextExp === curExp) { try { api?.preloadNode?.(nextNodeId); } catch {} }

      // Direction for the next pano (only reliable within the same experience).
      // If we can't compute a target, rotate at the configured speed anyway (one-direction).
      let targetYaw = null;
      if (nextNodeId && nextExp === curExp) targetYaw = computeTargetYaw({ curNode, nextNode, nextNodeId });

      emit('tour:step', { index, nodeId: curNodeId, nextNodeId, exp: curExp, nextExp });

      await animateRotation({ targetYaw, dwellMs, token });
      if (!playing || token !== runToken) break;

      if (nextStep) {
        // If we are crossing experiences, switch first (best-effort preserve pose).
        if (nextExp && nextExp !== curExp && typeof api?.switchExperience === 'function') {
          try{
            internalExperienceSwitch = true;
            suppressExperienceStopUntil = now() + 4000;
            const pose = api?.getPose?.();
            await api.switchExperience(nextExp);
            activeExpId = nextExp;
            if (pose && typeof api?.setPose === 'function') {
              try { api.setPose({ yaw: pose.yaw, pitch: pose.pitch, sync: false }); } catch {}
            }
          }catch{}
          finally{
            // Keep suppression for a short time because the agent emits `agent:experience`
            // at the end of its async switch routine.
            internalExperienceSwitch = false;
            suppressExperienceStopUntil = Math.max(suppressExperienceStopUntil, now() + 750);
          }
        }
        try {
          await api?.goToNode?.(nextNodeId, {
            source: 'tour',
            broadcast: true,
            sync: true,
            duration: 600,
            forceCrossfade: true,
          });
        } catch {}
        index += 1;
      } else {
        // Finished the last step: do not replay.
        playing = false;
        emit('tour:complete', { count: plan.length, index, exp: curExp });
        break;
      }
    }
  }

  // Stop autoplay if the user navigates manually (zone bar click, hotspot click, etc).
  try{
    addEventListener('agent:navigate', (ev)=>{
      if (!playing) return;
      const d = ev?.detail || {};
      const src = String(d?.source || '').toLowerCase();
      if (src === 'user') stopInternal('user');
    });
    addEventListener('agent:experience', ()=>{
      if (!playing) return;
      // Autoplay intentionally switches experiences; don't stop the tour for that.
      if (internalExperienceSwitch) return;
      if (now() < suppressExperienceStopUntil) return;
      stopInternal('experience-change');
    });
  }catch{}

  return {
    start: async ({ fromCurrent = true } = {}) => {
      await ensurePlan({ fromCurrent });
      playing = true;
      emit('tour:start', { count: plan.length, index, exp: activeExpId });
      await runLoop();
    },
    pause: async () => {
      if (!playing) return;
      playing = false;
      runToken++;
      emit('tour:pause', { index, exp: activeExpId });
    },
    resume: async () => {
      if (playing) return;
      await ensurePlan({ fromCurrent: true }).catch(()=>{});
      await syncIndexToCurrent().catch(()=>{});
      playing = true;
      emit('tour:resume', { index, exp: activeExpId });
      await runLoop();
    },
    stop: () => stopInternal('stop'),
    isPlaying: () => playing,
    getIndex: () => index,
    getSteps: () => Array.isArray(plan) ? plan.slice() : [],
  };
}

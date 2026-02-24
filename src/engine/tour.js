// Simple guided tour controller for Agent/Guide mode
// Drives cross-experience navigation, step timing, and narration.

function now() { try { return performance.now(); } catch { return Date.now(); } }

// Force slower pano cadence for VR comfort: 12s per step
const DEFAULT_DWELL = 12;
const DWELL_MIN = 12;
const DWELL_MAX = 12;
const clampDwell = (sec) => {
  const v = Number(sec);
  if (!Number.isFinite(v)) return DEFAULT_DWELL;
  return Math.max(DWELL_MIN, Math.min(DWELL_MAX, v));
};

export function createTourController({ api, tourId = 'default', onEvent, experiencesMeta = [] } = {}) {
  let steps = [];
  let index = -1;
  let playing = false;
  let timer = null;
  let remainingMs = 0;
  let stepStartedAt = 0;
  let plan = [];
  let zoneNameById = new Map();
  let activeExperienceId = '';
  const experienceCache = new Map();
  const experienceLabelById = new Map();
  if (Array.isArray(experiencesMeta)) {
    for (const item of experiencesMeta) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      const label = (typeof item?.label === 'string' && item.label.trim()) ? item.label.trim() : id;
      experienceLabelById.set(id, label);
    }
  }
  function titleCase(input = ''){
    return input.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  }
  function getExperienceLabel(expId){
    const key = String(expId || '').trim();
    if (!key) return '';
    if (experienceLabelById.has(key)) return experienceLabelById.get(key) || key;
    const fallback = key.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const label = fallback ? titleCase(fallback) : key;
    experienceLabelById.set(key, label);
    return label;
  }
  function getActivePlan(){
    return (plan.length ? plan : steps);
  }
  function getStepAt(idx){
    const arr = getActivePlan();
    if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
    return arr[idx];
  }
  function resolveZoneLabel(step, expId){
    const zoneKey = String(step?.zoneId || '').trim();
    if (!zoneKey) return step?.zoneName || '';
    const expKey = String(expId || activeExperienceId || '').trim();
    const mapped = zoneNameById.get(`${expKey}:${zoneKey}`) || zoneNameById.get(zoneKey);
    if (step?.zoneName && step.zoneName.trim()) return step.zoneName.trim();
    return mapped || zoneKey;
  }
  function isMidZone(idx, arr){
    const list = Array.isArray(arr) ? arr : getActivePlan();
    if (!Array.isArray(list) || idx <= 0) return false;
    const curr = list[idx];
    const prev = list[idx - 1];
    if (!curr || !prev) return false;
    return Boolean(
      SHORT_CUE_ENABLED &&
      curr.zoneId && prev.zoneId &&
      curr.zoneId === prev.zoneId &&
      curr.nodeId && prev.nodeId &&
      curr.nodeId !== prev.nodeId
    );
  }
  function buildNarration(step, idx, { midZone = false, experienceId = null, zoneLabel: providedZone } = {}){
    const expId = experienceId || step?.exp || activeExperienceId;
    const expLabel = getExperienceLabel(expId);
    const zoneLabel = providedZone || resolveZoneLabel(step, expId);
    const parts = [];
    if (expLabel) parts.push(`You are in the ${expLabel} experience.`);
    const hasZone = Boolean(zoneLabel);
    if (hasZone) {
      parts.push(midZone ? `Staying in zone ${zoneLabel}.` : `Entering zone ${zoneLabel}.`);
    } else {
      parts.push(`Exploring the current area.`);
    }
    let action = '';
    if (step?.nodeId) {
      if (midZone && hasZone) {
        action = `Moving to the next view in ${zoneLabel}.`;
      } else {
        action = `Moving to view ${idx + 1}${hasZone ? ` in ${zoneLabel}` : ''}.`;
      }
    } else {
      action = hasZone ? `Moving deeper into ${zoneLabel}.` : `Moving to the next section.`;
    }
    if (action) parts.push(action);
    return parts.join(' ');
  }
  function applyAutoNarration(list){
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++){
      const step = list[i];
      if (!step) continue;
      const audio = (step?.narration?.audio || '').trim();
      const hasText = typeof step?.narration?.text === 'string' && step.narration.text.trim().length > 0;
      if (!step.narration) step.narration = {};
      if (!hasText && !audio){
        step.narration.text = buildNarration(step, i, { midZone: isMidZone(i, list) });
      }
    }
  }
  async function ensureExperienceData(expId){
    const key = String(expId || '').trim();
    if (!key) return null;
    if (experienceCache.has(key)) return experienceCache.get(key);
    let payload = null;
    if (typeof api?.getExperienceData === 'function'){
      try {
        payload = await api.getExperienceData(key);
      } catch {}
    }
    if (payload && typeof payload === 'object'){
      const normalized = {
        expId: key,
        floors: Array.isArray(payload.floors) ? payload.floors : [],
        nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
        zones: Array.isArray(payload.zones) ? payload.zones : [],
        startNodeId: payload.startNodeId || null,
      };
      experienceCache.set(key, normalized);
      normalized.zones.forEach(z => {
        const label = (typeof z.name === 'string' && z.name.trim()) ? z.name.trim() : z.id;
        zoneNameById.set(`${key}:${z.id}`, label);
        zoneNameById.set(z.id, label);
      });
      return normalized;
    }
    experienceCache.set(key, null);
    return null;
  }
  // Track last node we advanced to in order to avoid duplicate step triggers
  let lastAppliedNodeId = null;
  const SHORT_CUE_ENABLED = (import.meta?.env?.VITE_TOUR_NEXT_VIEW_CUE || '1') !== '0';

  function emit(type, detail = {}) { try { onEvent?.({ type, ...detail }); } catch {} }
  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  function stopNarration() {}

  async function resourceExists(url, { timeoutMs = 3000 } = {}){
    try{
      const ctl = ('AbortController' in window) ? new AbortController() : null;
      const to = setTimeout(()=>{ try{ ctl?.abort?.(); }catch{} }, timeoutMs);
      let res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctl?.signal });
      clearTimeout(to);
      if (res?.ok) return true;
      if (res?.status === 405) {
        const ctl2 = ('AbortController' in window) ? new AbortController() : null;
        const to2 = setTimeout(()=>{ try{ ctl2?.abort?.(); }catch{} }, timeoutMs);
        res = await fetch(url, { method: 'GET', cache: 'no-store', signal: ctl2?.signal });
        clearTimeout(to2);
        return !!(res && res.ok);
      }
      return false;
    } catch { return false; }
  }

  async function buildAutoPlanAll({ defaultDwell = DEFAULT_DWELL } = {}){
    plan = [];
    zoneNameById = new Map();
    const ids = Array.isArray(experiencesMeta) ? experiencesMeta.map(x => String(x?.id||'').trim()).filter(Boolean) : [];
    for (const expId of ids){
      const expData = await ensureExperienceData(expId);
      if (!expData || !Array.isArray(expData.nodes) || expData.nodes.length === 0) continue;
      // Quick image existence check on the first node to avoid hanging on missing assets
      const firstFile = String(expData.nodes[0]?.file||'').trim();
      if (!firstFile) continue;
      const testUrl = `/experiences/${encodeURIComponent(expId)}/panos/${encodeURIComponent(firstFile)}`.replace(/\/{2,}/g,'/');
      const ok = await resourceExists(testUrl).catch(()=>false);
      if (!ok) { try{ console.warn('[tour] skipping experience with missing assets:', expId); }catch{} continue; }

      // Map zone labels
      if (Array.isArray(expData.zones)){
        expData.zones.forEach(z => {
          const label = (typeof z?.name === 'string' && z.name.trim()) ? z.name.trim() : (z?.id || '');
          zoneNameById.set(`${expId}:${z.id}`, label);
          zoneNameById.set(z.id, label);
        });
      }
      const allNodes = Array.isArray(expData.nodes) ? expData.nodes : [];
      const zones = Array.isArray(expData.zones) ? expData.zones : [];
      const floors = Array.isArray(expData.floors) ? expData.floors : [];

      // Floor-first autoplay: walk every node on floor 1, then floor 2, etc.
      if (floors.length > 0){
        for (const floor of floors){
          const floorNodes = allNodes.filter(n => String(n.floorId || '') === String(floor.id || ''));
          if (!floorNodes.length) continue;

          if (zones.length > 0){
            // Within each floor, keep nodes grouped by zone where possible.
            for (const z of zones){
              const zNodes = floorNodes.filter(n => String(n.zoneId || '') === String(z.id || ''));
              if (!zNodes.length) continue;
              let first = true;
              for (const n of zNodes){
                plan.push({
                  exp: expId,
                  nodeId: n.id,
                  dwellSec: clampDwell(defaultDwell),
                  narration: first ? {} : {},
                  zoneId: z.id,
                  zoneName: zoneNameById.get(`${expId}:${z.id}`) || z.id,
                });
                first = false;
              }
            }
            // Nodes on this floor without any zone come after zone-grouped nodes.
            const unzonedFloor = floorNodes.filter(n => !n.zoneId);
            for (const n of unzonedFloor){
              plan.push({ exp: expId, nodeId: n.id, dwellSec: clampDwell(defaultDwell), narration: {} });
            }
          } else {
            // No zones defined: just walk nodes on this floor in their existing order.
            for (const n of floorNodes){
              plan.push({ exp: expId, nodeId: n.id, dwellSec: clampDwell(defaultDwell), narration: {} });
            }
          }
        }
      } else {
        // Fallback for experiences without floor metadata: preserve previous behaviour
        if (zones.length > 0){
          for (const z of zones){
            const zNodes = allNodes.filter(n => String(n.zoneId||'') === String(z.id));
            let first = true;
            for (const n of zNodes){
              plan.push({
                exp: expId,
                nodeId: n.id,
                dwellSec: clampDwell(defaultDwell),
                narration: first ? {} : {},
                zoneId: z.id,
                zoneName: zoneNameById.get(`${expId}:${z.id}`) || z.id,
              });
              first = false;
            }
          }
          const unzoned = allNodes.filter(n => !n.zoneId);
          for (const n of unzoned){
            plan.push({ exp: expId, nodeId: n.id, dwellSec: clampDwell(defaultDwell), narration: {} });
          }
        } else {
          for (const n of allNodes){
            plan.push({ exp: expId, nodeId: n.id, dwellSec: clampDwell(defaultDwell), narration: {} });
          }
        }
      }
    }
    applyAutoNarration(getActivePlan());
  }

  async function load() {
    const res = await fetch(`/tours/${encodeURIComponent(tourId)}.json`, { cache: 'no-cache' });
    const json = await res.json();
    steps = Array.isArray(json?.steps) ? json.steps : [];
    plan = [];
    zoneNameById = new Map();
    const wantsAll = (String(json?.auto||'').toLowerCase() === 'all') || steps.length === 0;
    let activeExp = '';
    try {
      const ctx = await api?.getContext?.();
      activeExp = String(ctx?.exp || '').trim();
    } catch {}
    if (activeExp) activeExperienceId = activeExp;
    if (wantsAll){ await buildAutoPlanAll({ defaultDwell: DEFAULT_DWELL }); return; }
    for (const s of steps) {
      const dwell = clampDwell(s?.dwellSec);
      const nar = s?.narration || {};
      const rawExp = s?.exp ? String(s.exp).trim() : '';
      const expId = rawExp || activeExp;
      const expData = expId ? await ensureExperienceData(expId) : null;
      // If the referenced experience cannot be loaded, skip this step entirely.
      if (!expData) {
        try { console.warn('[tour] skipping step for missing experience:', expId); } catch {}
        continue;
      }
      // From here on, we have a valid experience context
      if (expId) activeExp = expId;
      expData.zones.forEach(z => {
        zoneNameById.set(`${expId}:${z.id}`, (typeof z.name === 'string' && z.name.trim()) ? z.name.trim() : z.id);
      });
      if (s?.nodeId) {
        plan.push({ exp: expId, nodeId: s.nodeId, dwellSec: dwell, narration: nar });
        continue;
      }
      const zoneRef = s?.zoneId ? String(s.zoneId).trim() : '';
      if (!zoneRef) {
        plan.push({ exp: expId, nodeId: null, dwellSec: dwell, narration: nar, zoneId: null });
        continue;
      }
      const zoneLower = zoneRef.toLowerCase();
      const zoneList = Array.isArray(expData?.zones) ? expData.zones : [];
      const nodeList = Array.isArray(expData?.nodes) ? expData.nodes : [];
      const zoneMatch =
        zoneList.find(z => String(z.id || '').toLowerCase() === zoneLower) ||
        zoneList.find(z => String(z.name || '').trim().toLowerCase() === zoneLower) || null;
      const zoneId = zoneMatch?.id || zoneRef;
      const zoneLabel = zoneMatch?.name?.trim?.() || zoneId;
      if (zoneId) {
        zoneNameById.set(`${expId}:${zoneId}`, zoneLabel);
        zoneNameById.set(zoneId, zoneLabel);
      }
      const nodesInZone = nodeList.filter(n => {
        const zid = String(n.zoneId || '').trim();
        if (!zid) return false;
        return zid === zoneId || zid.toLowerCase() === zoneLower;
      });
      if (nodesInZone.length > 0) {
        let first = true;
        for (const node of nodesInZone) {
          plan.push({ exp: expId, nodeId: node.id, dwellSec: dwell, narration: first ? nar : {}, zoneId, zoneName: zoneLabel });
          first = false;
        }
        continue;
      }
      plan.push({ exp: expId, nodeId: null, dwellSec: dwell, narration: nar, zoneId, zoneName: zoneLabel });
    }
    applyAutoNarration(getActivePlan());
  }

  async function goToStep(i) {
    index = i;
    const currentPlan = getActivePlan();
    const s = currentPlan[index];
    if (!s) return complete();
    lastAppliedNodeId = s?.nodeId || null;
    const stepExp = s?.exp ? String(s.exp).trim() : '';
    const desiredExp = stepExp || activeExperienceId;
    if (desiredExp && typeof api?.switchExperience === 'function' && desiredExp !== activeExperienceId) {
      await api.switchExperience(desiredExp);
      activeExperienceId = desiredExp;
      await ensureExperienceData(desiredExp);
    } else if (desiredExp && !activeExperienceId) {
      activeExperienceId = desiredExp;
      await ensureExperienceData(desiredExp);
    }
    // zone or node
    if (s.nodeId && typeof api?.goToNode === 'function') {
      await api.goToNode(s.nodeId, { source: 'tour', broadcast: true, sync: true });
    } else if (s.zoneId && typeof api?.goToZoneByName === 'function') {
      const zoneLabel = s?.zoneName || zoneNameById.get(`${activeExperienceId}:${s.zoneId}`) || zoneNameById.get(s.zoneId) || s.zoneId;
      await api.goToZoneByName(zoneLabel, { source: 'tour', broadcast: true, sync: true });
    }
    // narration (voice cues removed for VR comfort)
    stopNarration();

    const dwellSec = clampDwell(s?.dwellSec);
    const dwellMs = Math.max(3000, Math.round(dwellSec * 1000));
    remainingMs = dwellMs; stepStartedAt = now();
    clearTimer(); timer = setTimeout(next, dwellMs);
    emit('tour:step', { index, step: s });
  }

  async function findIndexForCurrentNode(){
    try{
      const ctx = await api?.getContext?.();
      const nodeId = ctx?.currentNodeId;
      if (!nodeId) return -1;
      const arr = getActivePlan();
      if (!Array.isArray(arr) || !arr.length) return -1;
      return arr.findIndex(s => String(s?.nodeId || "") === String(nodeId));
    }catch{
      return -1;
    }
  }
  async function syncToCurrentNode(){
    const idx = await findIndexForCurrentNode();
    if (idx >= 0 && idx !== index){
      clearTimer(); stopNarration(); playing = true;
      await goToStep(idx);
      return true;
    }
    return false;
  }

  function pause() {
    if (!playing) return;
    playing = false; clearTimer();
    const elapsed = Math.max(0, now() - stepStartedAt);
    remainingMs = Math.max(500, (remainingMs || 0) - elapsed);
    emit('tour:pause', { index });
  }
  async function resume() {
    if (playing) return;
    playing = true; clearTimer();
    // If the user navigated while paused, resume from the currently visible pano.
    try{
      const synced = await syncToCurrentNode();
      if (synced) { emit('tour:resume', { index }); return; }
    }catch{}
    const ms = Math.max(500, remainingMs || 1000);
    stepStartedAt = now();
    timer = setTimeout(next, ms);
    emit('tour:resume', { index });
  }
  function prev() { clearTimer(); stopNarration(); goToStep(Math.max(0, (index - 1))); }
  function next() { clearTimer(); stopNarration(); goToStep(index + 1); }
  function stop() { playing = false; clearTimer(); stopNarration(); emit('tour:stop', {}); }
  function complete() { stop(); emit('tour:complete', {}); }

  return {
    load,
    start: async ({ fromCurrent = true } = {}) => {
      await load();
      playing = true;
      let startIdx = 0;
      if (fromCurrent) {
        try{
          const idx = await findIndexForCurrentNode();
          if (idx >= 0) startIdx = idx;
        }catch{}
      }
      await goToStep(startIdx);
      emit('tour:start', { count: getActivePlan().length, index: startIdx });
    },
    pause, resume, prev, next, stop,
    isPlaying: () => playing,
    getIndex: () => index,
    getSteps: () => {
      const arr = getActivePlan();
      return Array.isArray(arr) ? arr.slice() : [];
    },
    jumpToNode: async (nodeId) => { try{ if (nodeId && nodeId===lastAppliedNodeId) return; const arr = getActivePlan(); const idx = Array.isArray(arr) ? arr.findIndex(s=>s?.nodeId===nodeId) : -1; if(idx>=0 && idx!==index){ clearTimer(); stopNarration(); playing = true; await goToStep(idx); } }catch{} },
  };
}

// Allow manual navigation during autoplay: keep the tour in sync with Agent moves
try {
  addEventListener('agent:navigate', (ev)=>{
    const d = ev?.detail || {}; const tour = (window && window.__tour) ? window.__tour : null;
    if (!tour || !tour.isPlaying || !tour.isPlaying()) return;
    const src = String(d?.source || '').toLowerCase();
    if (src === 'user') {
      try{ tour.stop(); }catch{}
      return;
    }
    if (!d?.nodeId || src === 'tour') return;
    try{
      tour.jumpToNode?.(d.nodeId);
    }catch{}
  });
} catch {}

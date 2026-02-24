// Lazy-load heavy engine modules only when needed
// Note: dynamic imports create separate chunks and keep initial bundle light

import { createAutoplayAudio } from "./engine/autoplay-audio.js";

const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
const BASE_TRIMMED = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;
const EXPERIENCES_ROOT = `${BASE_TRIMMED || ""}/experiences`.replace(/\/{2,}/g, "/");
const EXPERIENCE_FALLBACK = [
  { id: "skywalk", label: "Skywalk", stereo: false },
  { id: "Indra & Kubera", label: "Indra & Kubera", stereo: true },
];
// Preload configuration (tunable via Vite env)
// Default to 'auto' to avoid blocking startup on large pano sets.
const PRELOAD_MODE = (import.meta?.env?.VITE_PRELOAD_MODE || 'auto').toLowerCase(); // 'auto' | 'all' | 'stage'
const PRELOAD_CONCURRENCY = Math.max(1, Number(import.meta?.env?.VITE_PRELOAD_CONCURRENCY) || 6);

const gate = document.getElementById("roleGate");
const startGate = document.getElementById("startGate");
const btnSelfExplore = document.getElementById("btnSelfExplore");
const btnGuided = document.getElementById("btnGuided");
const expDrawer = document.getElementById("expDrawer");
const expDrawerToggle = document.getElementById("expDrawerToggle");
const expDrawerClose = document.getElementById("expDrawerClose");
const expMenuGrid = document.getElementById("expMenuGrid");
const menuCloseExperience = document.getElementById("menuCloseExperience");
const roomInput = document.getElementById("roomInput");
const expSelect = document.getElementById("expSelect");
const expSelectLive = document.getElementById("expSelectLive");
const gateList = document.getElementById("gateExpList");
const liveList = document.getElementById("expList");
const gateNext = document.getElementById("gateNext");
const gateClose = document.getElementById("gateClose");
const overlay = document.getElementById("preloadOverlay");
const barFill = document.getElementById("barFill");
const exitFSBtn = document.getElementById("exitFSBtn");
const pwaHint = document.getElementById("pwaHint");
const pwaHintClose = document.getElementById("pwaHintClose");
const rotateOverlay = document.getElementById("rotateOverlay");
const tapStartBtn = document.getElementById("tapStart");
const compassHud = document.getElementById("compassHud");
// Panel removed - not needed
const hudPanel = null;
const hudPanelToggle = null;
const hudClosePanel = null;
const hudEnterXR = document.getElementById("hudEnterXR");
const hudToggleXR = document.getElementById("hudToggleXR");
const hudToggleMini = document.getElementById("hudToggleMini");
const hudTourToggle = document.getElementById("hudTourToggle");
const hudTourStop = document.getElementById("hudTourStop");
const hudZoomRange = document.getElementById("hudZoomRange");
const hudZoomVal = document.getElementById("hudZoomVal");
const hudZoneSelect = document.getElementById("hudZoneSelect");
const hudPrevZone = document.getElementById("hudPrevZone");
const hudNextZone = document.getElementById("hudNextZone");
const hudPrevPano = document.getElementById("hudPrevPano");
const hudNextPano = document.getElementById("hudNextPano");
const hudPlayState = document.getElementById("hudPlayState");
const hudZoneHint = document.getElementById("hudZoneHint");
const zoneBar = document.getElementById("zoneBar");
const zoneBarList = document.getElementById("zoneBarList");
const zoneBarPrev = document.getElementById("zoneBarPrev");
const zoneBarNext = document.getElementById("zoneBarNext");

const onboardOverlay = document.getElementById("onboardOverlay");
const onboardSpotlight = document.getElementById("onboardSpotlight");
const onboardCard = document.getElementById("onboardCard");
const onboardTitle = document.getElementById("onboardTitle");
const onboardBody = document.getElementById("onboardBody");
const onboardHint = document.getElementById("onboardHint");
const onboardProgress = document.getElementById("onboardProgress");
const onboardSkip = document.getElementById("onboardSkip");
const onboardNext = document.getElementById("onboardNext");

try {
  if (startGate && gate) gate.style.display = "none";
} catch {}

// Let CSS control compass styling/position
try{
  if (compassHud){
    compassHud.removeAttribute("style");
    const dial = compassHud.querySelector(".compass-dial");
    if (dial){
      dial.removeAttribute("style");
    }
  }
}catch{}

const UA = (navigator.userAgent || "").toLowerCase();
const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
const IS_IOS_PHONE = /iphone|ipod/.test(UA);
const IS_ANDROID = /android/.test(UA);
const IS_MOBILE = /android|iphone|ipad|ipod|mobile|crios|fxios/.test(UA);
const IS_IFRAME = (() => {
  try { return window.self !== window.top; } catch { return true; }
})();
const IS_STANDALONE = (() => {
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
      window.navigator?.standalone === true
    );
  } catch {
    return false;
  }
})();
let LAST_GESTURE_AT = 0;

function showPwaHintOnce() {
  try {
    if (!pwaHint) return;
    if (!IS_IOS_PHONE || IS_STANDALONE) return;
    const KEY = 'nandanavanam:pwa-hint:v1';
    try {
      if (localStorage.getItem(KEY) === '1') return;
      localStorage.setItem(KEY, '1');
    } catch {}
    pwaHint.hidden = false;
    pwaHint.setAttribute('data-open', '1');
    pwaHint.setAttribute('aria-hidden', 'false');
  } catch {}
}

function hidePwaHint() {
  try {
    if (!pwaHint) return;
    pwaHint.hidden = true;
    pwaHint.removeAttribute('data-open');
    pwaHint.setAttribute('aria-hidden', 'true');
  } catch {}
}

try {
  pwaHintClose?.addEventListener?.('click', (e) => {
    try { e.preventDefault?.(); e.stopPropagation?.(); } catch {}
    hidePwaHint();
  }, { passive: false });
} catch {}

// Embedded hosts (iframes) may have their own bottom nav overlaying our UI.
// Allow an adjustable offset via query param, with a safe default when embedded.
try {
  const qs = new URLSearchParams(window.location.search);
  const rawOffset =
    qs.get('uiBottomOffset') ||
    qs.get('embedBottomOffset') ||
    qs.get('bottomOffset') ||
    qs.get('offsetBottom');
  let offsetPx = Number.parseInt(rawOffset ?? '', 10);
  if (!Number.isFinite(offsetPx)) offsetPx = IS_IFRAME ? 56 : 0;
  offsetPx = Math.max(0, Math.min(offsetPx, 200));
  document.documentElement.style.setProperty('--embed-bottom-offset', `${offsetPx}px`);
  if (IS_IFRAME) document.body.classList.add('embedded');
} catch {}

function updateViewportVars(){
  try{
    const vv = window.visualViewport;
    const width = Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 0);
    const height = Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 0);
    if (width) document.documentElement.style.setProperty('--app-width', `${width}px`);
    if (height) document.documentElement.style.setProperty('--app-height', `${height}px`);
    if (width) document.documentElement.style.setProperty('--vw', `${width * 0.01}px`);
    if (height) document.documentElement.style.setProperty('--vh', `${height * 0.01}px`);
    if (width && height) {
      try { window.dispatchEvent(new CustomEvent('app:viewport', { detail: { width, height } })); } catch {}
    }

    // When using CSS-based fullscreen (iOS), force html/body to the visible viewport
    // to avoid 100vh overscroll / address-bar artifacts.
    if (document.body.classList.contains('fakefs') && height) {
      document.documentElement.style.height = `${height}px`;
      document.body.style.height = `${height}px`;
      document.body.style.minHeight = `${height}px`;
    }
  }catch{}
}

function syncFullscreenResize() {
  try { updateViewportVars(); } catch {}
  try { state.agentApi?.resize?.(); } catch {}
  try { window.dispatchEvent(new Event('resize')); } catch {}
  try { window.dispatchEvent(new Event('app:viewport')); } catch {}
  try { setTimeout(() => { try { updateViewportVars(); } catch {} try { state.agentApi?.resize?.(); } catch {} }, 0); } catch {}
  try { setTimeout(() => { try { updateViewportVars(); } catch {} try { state.agentApi?.resize?.(); } catch {} }, 250); } catch {}
}

function applyFakeFullscreenStyles(enable){
  try{
    if (enable){
      document.documentElement.style.height = '100%';
      document.documentElement.style.width = '100%';
      document.documentElement.style.position = 'fixed';
      document.documentElement.style.inset = '0';
      document.documentElement.style.overflow = 'hidden';
      document.body.style.height = '100%';
      document.body.style.width = '100%';
      document.body.style.position = 'fixed';
      document.body.style.inset = '0';
      document.body.style.overflow = 'hidden';
      // iOS-specific: use dynamic viewport height and try to hide address bar
      if (IS_IOS) {
        document.body.style.touchAction = 'manipulation';
        // Re-sync after Safari adjusts the visual viewport (URL bar, rotation)
        setTimeout(updateViewportVars, 0);
        setTimeout(updateViewportVars, 250);
        setTimeout(()=>{ try { window.scrollTo(0, 1); } catch {} }, 50);
      }
      updateViewportVars();
    } else {
      document.documentElement.style.height = '';
      document.documentElement.style.width = '';
      document.documentElement.style.position = '';
      document.documentElement.style.inset = '';
      document.documentElement.style.overflow = '';
      document.body.style.height = '';
      document.body.style.width = '';
      document.body.style.position = '';
      document.body.style.inset = '';
      document.body.style.overflow = '';
      if (IS_IOS) {
        document.body.style.minHeight = '';
        document.body.style.touchAction = '';
      }
    }
  }catch{}
}

function isEditableTarget(el) {
  try {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') return true;
    if (el.isContentEditable) return true;
    const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : '';
    if (role && /textbox|input/i.test(role)) return true;
  } catch {}
  return false;
}

function updateHtmlFlags() {
  try {
    const el = document.documentElement;
    const w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    const h = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
    const orient = (w >= h) ? 'landscape' : 'portrait';
    el.setAttribute('data-orient', orient);
    const device = IS_MOBILE ? (Math.min(w, h) <= 820 ? 'phone' : 'tablet') : 'desktop';
    el.setAttribute('data-device', device);
  } catch {}
}

function isPhoneLayout(){
  try { return document.documentElement.getAttribute('data-device') === 'phone'; } catch { return false; }
}

function minimizeMinimapOnce(){
  try{
    if (!isPhoneLayout()) return;
    if (state.phoneMinimapMinimized) return;
    const wrap = document.querySelector('.mini-wrap');
    if (!wrap) return;
    if (wrap.classList.contains('minimized')) { state.phoneMinimapMinimized = true; return; }
    const btn = wrap.querySelector('.mini-min-inner') || wrap.querySelector('.mini-min') || null;
    if (!btn) return;
    try { btn.click(); } catch {}
    state.phoneMinimapMinimized = true;
  }catch{}
}

function isFullscreenActive() {
  const d = document;
  return Boolean(
    d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement ||
    document.body.classList.contains('fakefs') || document.body.getAttribute('data-xr') === '1'
  );
}

function updateFSButtonVisibility() {
  try { 
    if (exitFSBtn) exitFSBtn.style.display = isFullscreenActive() ? 'block' : 'none'; 
    if (btnFullscreen) {
      const exp = document.body.getAttribute('data-experience') === '1';
      btnFullscreen.style.display = (!isFullscreenActive() && exp) ? 'flex' : 'none';
    }
    // Ensure UI elements are visible
    ensureUIVisible();
  } catch {}
}

// Ensure bottom bar and minimap remain visible
function ensureUIVisible(){
  try{
    const miniWrap = document.querySelector('.mini-wrap');
    if (miniWrap) miniWrap.style.display = '';
  }catch{}
}

function showOverlay(){ if (overlay){ overlay.setAttribute('aria-busy','true'); } }
function hideOverlay(){ if (overlay){ overlay.removeAttribute('aria-busy'); } }
function setProgress(p){ const pct = Math.max(0, Math.min(100, Math.round(p*100))); if (barFill) barFill.style.width = `${pct}%`; }

function hideStartGate() {
  if (!startGate) return;
  startGate.style.display = "none";
  try { startGate.setAttribute("aria-hidden", "true"); } catch {}
}

function showStartGate() {
  if (!startGate) return;
  startGate.style.display = "";
  try { startGate.setAttribute("aria-hidden", "false"); } catch {}
}

function setExperienceLoaded(loaded) {
  try {
    if (loaded) {
      document.body.setAttribute("data-experience", "1");
      try { updateFSButtonVisibility(); } catch {}
    }
    else {
      document.body.removeAttribute("data-experience");
      setExpDrawer(false);
      document.body.removeAttribute("data-ui");
    }
  } catch {}
}

setExperienceLoaded(false);

function setExpDrawer(open) {
  if (!expDrawer) return;
  expDrawer.setAttribute("data-open", open ? "true" : "false");
  expDrawer.setAttribute("aria-hidden", open ? "false" : "true");
}

// Listen for app-wide progress events from engine modules
addEventListener('loading:show', ()=>{ showOverlay(); setProgress(0); });
addEventListener('loading:progress', (ev)=>{ const d=ev?.detail||{}; setProgress(d.progress ?? 0); });
addEventListener('loading:hide', ()=>{ setProgress(1); hideOverlay(); });

const btnGuide = document.getElementById("btnGuide");
const btnViewer = document.getElementById("btnViewer");
const btnUp = document.getElementById("btnUp");
const btnDown = document.getElementById("btnDown");
const btnLeft = document.getElementById("btnLeft");
const btnRight = document.getElementById("btnRight");

let gateSelectedRole = "guide";
function setGateRole(role) {
  gateSelectedRole = role === "viewer" ? "viewer" : "guide";
  const setActive = (el, active) => {
    if (!el) return;
    el.classList.toggle("active", active);
    try { el.setAttribute("aria-pressed", active ? "true" : "false"); } catch {}
  };
  setActive(btnGuide, gateSelectedRole === "guide");
  setActive(btnViewer, gateSelectedRole === "viewer");
}
function getGateRole() { return gateSelectedRole; }
const btnZoomIn = document.getElementById("btnZoomIn");
const btnZoomOut = document.getElementById("btnZoomOut");
const btnFullscreen = document.getElementById("btnFullscreen");
// Legacy IDs from previous project UI (kept for parity)
const zoomInLegacy = document.getElementById("zoomIn");
const zoomOutLegacy = document.getElementById("zoomOut");
const btnFS = document.getElementById("btnFS");
const btnMirror = document.getElementById("btnMirror");
const btnMini = document.getElementById("btnMini");
// Tour controls
const tourToggleBtn = (document.getElementById('tourToggleTop') || document.getElementById('tourToggle') || document.getElementById('tourPause'));
const tourStopBtn  = document.getElementById('tourStop');
const tourStopTop  = document.getElementById('tourStopTop');
// New guide UI: centered zone title
const roomTitleText = document.getElementById('roomTitleText');

// Dollhouse (3D model viewer overlay)
const dollhouseToggleBtn = document.getElementById('dollhouseToggleTop');
const dollhouseOverlay = document.getElementById('dollhouseOverlay');
const dollhouseCloseBtn = document.getElementById('dollhouseClose');
const dollhouseCanvas = document.getElementById('dollhouseCanvas');
const dollhouseStatus = document.getElementById('dollhouseStatus');

const state = {
  manifest: [],
  manifestById: new Map(),
  activeExpId: null,
  agentApi: null,
  setGateExp: null,
  setLiveExp: null,
  tour: null,
  boundExperienceListener: false,
  zoneNavigateListener: null,
  expMenuBound: false,
  zoneBarZonesKey: "",
  zoneBarWheelBound: false,
  zoneBarDragBound: false,
  zoneBarButtonsBound: false,
  zoneBarSuppressClickUntil: 0,
  currentExperienceId: null, // Track current experience for feedback
  phoneInitDone: false,
  phoneMinimapMinimized: false,
  _zoneOrderCache: new Map(), // expId -> Promise<string[]|null>
  _dollhouse: null,
  _dollhouseOpen: false,
};

const STEP_YAW = 0.06;
const STEP_PITCH = 0.045;

function setupAutoplayAudio(){
  try{
    if (state._autoplayAudioBound) return;
    state._autoplayAudioBound = true;
  }catch{}

  const bgmFilenames = [
    // Prefer .mp3 for iOS Safari compatibility.
    "WhatsApp Audio 2026-01-27 at 11.55.04 AM.mp3",
    // Legacy filename (same bytes, different extension).
    "WhatsApp Audio 2026-01-27 at 11.55.04 AM.mpeg",
  ];
  const bgmUrls = bgmFilenames.map((bgmFilename) => {
    try {
      const base = (BASE_TRIMMED || "");
      return `${base}/assets/${encodeURIComponent(bgmFilename)}`.replace(/\/{2,}/g, "/");
    } catch {
      return `/assets/${encodeURIComponent(bgmFilename)}`;
    }
  });

  // Prefer a real audio track for autoplay BGM.
  const ensureBgm = () => {
    try{
      if (state._tourBgm) return state._tourBgm;
      // Pick the best URL based on what the browser claims it can decode.
      // (Also prefer .mp3 to avoid iOS treating .mpeg as video/mpeg.)
      const test = document.createElement('audio');
      const canMpeg = (() => {
        try { return (test.canPlayType?.('audio/mpeg') || '') !== ''; } catch { return true; }
      })();
      const url =
        canMpeg ? (bgmUrls[0] || bgmUrls[1]) :
        (bgmUrls[0] || bgmUrls[1]);

      const a = new Audio(url);
      a.preload = "auto";
      a.loop = true;
      a.volume = 0.35;
      try { a.playsInline = true; } catch {}
      try { a.setAttribute?.('playsinline', ''); } catch {}
      try { a.setAttribute?.('webkit-playsinline', ''); } catch {}
      a.crossOrigin = "anonymous";
      try { a.load?.(); } catch {}
      state._tourBgm = a;
      return a;
    }catch{
      state._tourBgm = null;
      return null;
    }
  };

  let wantAmbient = false;
  let lastTransitionSfxAt = 0;
  let lastBgmTryAt = 0;
  try{
    if (!state._autoplayAudio) {
      state._autoplayAudio = createAutoplayAudio({
        enabled: true,
        ambientVolume: 0.24,
        transitionVolume: 0.10,
      });
    }
  }catch{
    state._autoplayAudio = null;
  }

  const resumeAudio = () => { try { state._autoplayAudio?.resume?.(); } catch {} };
  const isBgmAudiblePlaying = () => {
    try{
      const a = state._tourBgm;
      if (!a) return false;
      return a.paused === false && a.ended === false && Number.isFinite(a.currentTime);
    }catch{ return false; }
  };
  const tryStartBgm = ({ requireUserActivation = false } = {}) => {
    try{
      if (!wantAmbient) return false;
      if (!(state.tour?.isPlaying?.() && state.tour.isPlaying())) return false;
      const a = ensureBgm();
      if (!a) return false;

      if (requireUserActivation) {
        try {
          const ua = navigator?.userActivation;
          if (ua && ua.isActive === false) return false;
        } catch {}
      }

      if (isBgmAudiblePlaying()) return true;

      const now = Date.now();
      if (now - lastBgmTryAt < 800) return false;
      lastBgmTryAt = now;

      // Attempt to play the real BGM track. On mobile this may fail until a user gesture happens.
      const p = a.play?.();
      if (p && typeof p.catch === "function") {
        p.then(() => {
          // If the real track starts, stop the synth bed so only the music plays.
          try { state._autoplayAudio?.stopAmbient?.(); } catch {}
        }).catch(() => {});
      }
      return true;
    }catch{
      return false;
    }
  };
  const startAmbient = () => {
    wantAmbient = true;
    resumeAudio();
    try {
      const a = ensureBgm();
      if (a) {
        // Try to start the real BGM. If this fails (mobile autoplay policy), fall back to synth.
        // We'll retry from the next user gesture via listeners below.
        const p = a.play?.();
        if (p && typeof p.catch === "function") {
          p.then(() => { try { state._autoplayAudio?.stopAmbient?.(); } catch {} })
           .catch(() => { try { state._autoplayAudio?.startAmbient?.(); } catch {} });
        }
        if (p) return;
      }
    } catch {}
    // Fallback: synth bed (no external track available / failed to play).
    try { state._autoplayAudio?.startAmbient?.(); } catch {}
  };
  const stopAmbient = ({ keepWanted = false } = {}) => {
    if (!keepWanted) wantAmbient = false;
    try { state._autoplayAudio?.stopAmbient?.(); } catch {}
    try { state._tourBgm?.pause?.(); } catch {}
  };
  const playTransition = () => {
    try{
      const playing = Boolean(state.tour?.isPlaying?.() && state.tour.isPlaying());
      if (!playing) return;
      const t = Date.now();
      if (t - lastTransitionSfxAt < 350) return;
      lastTransitionSfxAt = t;
      resumeAudio();
      // Small cinematic duck so the whoosh reads clearly over BGM.
      try{
        const bgm = state._tourBgm;
        if (bgm){
          const base = Number.isFinite(state._tourBgmBaseVol) ? state._tourBgmBaseVol : Number(bgm.volume);
          if (!Number.isFinite(state._tourBgmBaseVol)) state._tourBgmBaseVol = base;
          const duck = Math.max(0, Math.min(1, base * 0.72));
          bgm.volume = duck;
          setTimeout(()=>{ try{ if (state._tourBgm && (state.tour?.isPlaying?.() && state.tour.isPlaying())) state._tourBgm.volume = base; }catch{} }, 520);
        }
      }catch{}
      try { state._autoplayAudio?.playTransition?.(); } catch {}
    }catch{}
  };

  try{
    addEventListener('tour:start', startAmbient);
    addEventListener('tour:resume', startAmbient);
    addEventListener('tour:pause', ()=>stopAmbient({ keepWanted: false }));
    addEventListener('tour:stop', ()=>stopAmbient({ keepWanted: false }));
    addEventListener('tour:complete', ()=>stopAmbient({ keepWanted: false }));
    // Sync the transition SFX to the *actual* crossfade start (more cinematic).
    addEventListener('agent:transition', (ev)=>{
      const d = ev?.detail || {};
      if (String(d?.kind || '') !== 'crossfade') return;
      if (String(d?.phase || '') !== 'start') return;
      const src = String(d?.source || '').toLowerCase();
      if (src !== 'tour') return;
      playTransition();
    });
    // Fallback for modes that don't use 2D crossfade (e.g. XR / direct swap).
    addEventListener('agent:navigate', (ev)=>{
      const src = String(ev?.detail?.source || '').toLowerCase();
      if (src !== 'tour') return;
      playTransition();
    });
    // Ensure the audio context is resumable as soon as the user touches/clicks.
    const onUserGesture = () => {
      resumeAudio();
      try { ensureBgm(); } catch {}
      // Retry BGM on mobile after user interaction so phones match desktop.
      tryStartBgm({ requireUserActivation: true });
    };
    document.addEventListener('pointerdown', onUserGesture, { passive: true });
    // Some iOS browsers are flaky with Pointer Events on buttons; keep a touchend fallback.
    document.addEventListener('touchend', onUserGesture, { passive: true });
    document.addEventListener('visibilitychange', ()=>{
      if (document.hidden) stopAmbient({ keepWanted: true });
      else if (wantAmbient && state.tour?.isPlaying?.() && state.tour.isPlaying()) {
        startAmbient();
        tryStartBgm({ requireUserActivation: false });
      }
    }, { passive: true });

    // When entering XR, some browsers suspend audio; retry BGM on XR state changes.
    addEventListener('xr:state', (ev)=>{
      try{
        const inXR = ev?.detail?.inXR === true;
        if (!inXR) return;
        resumeAudio();
        tryStartBgm({ requireUserActivation: false });
      }catch{}
    }, { passive: true });
  }catch{}

  try{
    state._autoplayAudioStart = startAmbient;
    state._autoplayAudioStop = () => stopAmbient({ keepWanted: false });
  }catch{}
}

// ========== Finish Button & Feedback System ==========
const finishExpBtn = document.getElementById('finishExpBtn');
const feedbackOverlay = document.getElementById('feedbackOverlay');
const feedbackForm = document.getElementById('feedbackForm');
const feedbackThankyou = document.getElementById('feedbackThankyou');
const starRating = document.getElementById('starRating');
const feedbackText = document.getElementById('feedbackText');
const bestExperienceSelect = document.getElementById('bestExperienceSelect');
const visitToggle = document.getElementById('visitToggle');
const submitFeedback = document.getElementById('submitFeedback');
const skipFeedback = document.getElementById('skipFeedback');
const closeFeedback = document.getElementById('closeFeedback');

let selectedRating = 0;
let wouldVisitInPerson = null; // null = not answered, 'yes' or 'no'

function showFinishButton(experienceId) {
  state.currentExperienceId = experienceId;
  if (finishExpBtn) {
    finishExpBtn.hidden = false;
    finishExpBtn.style.display = '';
  }
}

function hideFinishButton() {
  if (finishExpBtn) {
    finishExpBtn.hidden = true;
    finishExpBtn.style.display = 'none';
  }
}

function populateBestExperienceDropdown() {
  if (!bestExperienceSelect) return;
  // Clear existing options except the first placeholder
  bestExperienceSelect.innerHTML = '<option value="">Select an experience...</option>';
  
  // Add experiences from manifest
  if (state.manifest && state.manifest.length > 0) {
    state.manifest.forEach(exp => {
      const opt = document.createElement('option');
      opt.value = exp.id;
      opt.textContent = exp.label || exp.id;
      bestExperienceSelect.appendChild(opt);
    });
  }
}

function resetFeedbackForm() {
  selectedRating = 0;
  wouldVisitInPerson = null;
  if (feedbackText) feedbackText.value = '';
  if (bestExperienceSelect) bestExperienceSelect.value = '';
  updateStarDisplay();
  updateVisitToggle();
}

function showFeedbackModal() {
  // Populate experiences dropdown
  populateBestExperienceDropdown();
  
  // Reset form
  resetFeedbackForm();
  
  // Show form, hide thank you
  if (feedbackForm) feedbackForm.style.display = '';
  if (feedbackThankyou) feedbackThankyou.style.display = 'none';
  
  // Show modal
  if (feedbackOverlay) {
    feedbackOverlay.classList.add('active');
  }
}

function hideFeedbackModal() {
  if (feedbackOverlay) {
    feedbackOverlay.classList.remove('active');
  }
}

function updateStarDisplay() {
  if (!starRating) return;
  const stars = starRating.querySelectorAll('button');
  stars.forEach((star, index) => {
    if (index < selectedRating) {
      star.classList.add('active');
    } else {
      star.classList.remove('active');
    }
  });
}

function updateVisitToggle() {
  if (!visitToggle) return;
  const buttons = visitToggle.querySelectorAll('button');
  buttons.forEach(btn => {
    if (btn.dataset.value === wouldVisitInPerson) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function showThankYou() {
  if (feedbackForm) feedbackForm.style.display = 'none';
  if (feedbackThankyou) feedbackThankyou.style.display = '';
}

async function submitFeedbackData() {
  try {
    const { trackFeedback, endExperience } = await import('./engine/analytics.js');
    
    // Gather all feedback data
    const feedbackData = {
      rating: selectedRating,
      bestExperience: bestExperienceSelect?.value || '',
      wouldVisitInPerson: wouldVisitInPerson || '',
      comments: feedbackText?.value || ''
    };
    
    trackFeedback(feedbackData, state.currentExperienceId);
    endExperience();
  } catch (e) {
    console.warn('[Feedback] Failed to track:', e);
  }
}

function finishExperience() {
  // Stop any running tour
  if (state.tour) {
    try { state.tour.stop(); } catch {}
  }
  
  // Hide finish button
  hideFinishButton();
  
  // Show feedback modal
  showFeedbackModal();
}

function closeFeedbackAndReload() {
  hideFeedbackModal();
  // Reload the page to return to the gate
  window.location.reload();
}

// Wire up feedback event listeners
if (finishExpBtn) {
  finishExpBtn.addEventListener('click', finishExperience);
}

if (starRating) {
  starRating.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    selectedRating = parseInt(btn.dataset.rating, 10) || 0;
    updateStarDisplay();
  });
}

if (visitToggle) {
  visitToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    wouldVisitInPerson = btn.dataset.value || null;
    updateVisitToggle();
  });
}

if (submitFeedback) {
  submitFeedback.addEventListener('click', async () => {
    await submitFeedbackData();
    showThankYou();
  });
}

if (skipFeedback) {
  skipFeedback.addEventListener('click', async () => {
    // Still track that they ended, just no rating
    try {
      const { endExperience } = await import('./engine/analytics.js');
      endExperience();
    } catch {}
    closeFeedbackAndReload();
  });
}

if (closeFeedback) {
  closeFeedback.addEventListener('click', closeFeedbackAndReload);
}

// ========== End Finish Button & Feedback System ==========

// Global fullscreen helper so we can trigger it from role buttons
export async function enterFullscreenLandscape(){
  const d = document;
  const target = d.documentElement;
  try {
    // If already fullscreen (native, fake fullscreen, or XR), exit.
    if (isFullscreenActive()) {
      await exitFullscreenMode();
      return;
    }

    const fullscreenEnabled = (() => {
      try {
        const enabled = (d.fullscreenEnabled ?? d.webkitFullscreenEnabled);
        return enabled !== false;
      } catch { return true; }
    })();

    const hasNativeRequest = Boolean(
      target.requestFullscreen ||
      target.webkitRequestFullscreen ||
      target.mozRequestFullScreen ||
      target.msRequestFullscreen
    );

    const preferNative = fullscreenEnabled && hasNativeRequest && !IS_IOS;

    const enableFake = () => {
      document.body.classList.add('fakefs');
      applyFakeFullscreenStyles(true);
      showPwaHintOnce();
    };

    const clearFake = () => {
      document.body.classList.remove('fakefs');
      applyFakeFullscreenStyles(false);
    };

    if (preferNative) {
      let ok = false;
      try {
        if (target.requestFullscreen) {
          try {
            await target.requestFullscreen({ navigationUI: 'hide' });
            ok = true;
          } catch {
            await target.requestFullscreen();
            ok = true;
          }
        } else {
          await (target.webkitRequestFullscreen?.() || target.mozRequestFullScreen?.() || target.msRequestFullscreen?.());
          ok = true;
        }
      } catch (e) {
        console.warn('[FS] Native requestFullscreen failed; falling back to CSS fullscreen.', e);
      }
      if (!ok) enableFake();
      else clearFake();
    } else {
      // iOS tabs and embedded hosts without fullscreen permission: use CSS-based fullscreen.
      enableFake();
    }
    
    // Try to lock orientation on supported devices
    if (screen?.orientation?.lock && !IS_IOS) {
      try { await screen.orientation.lock('landscape'); } catch {}
    }
    
    // Scroll to hide address bar on mobile
    try { window.scrollTo(0, 1); } catch {}
  } catch (err) {
    // Final fallback
    document.body.classList.add('fakefs');
    applyFakeFullscreenStyles(true);
    showPwaHintOnce();
  }
  updateFSButtonVisibility();
  ensureUIVisible();
  syncFullscreenResize();
}

async function exitFullscreenMode(){
  console.log('[FS] Exiting fullscreen mode');
  const d = document;
  // Always remove fakefs class first
  document.body.classList.remove('fakefs');
  applyFakeFullscreenStyles(false);
  hidePwaHint();
  
  // Try native exit
  try {
    const fsEl = d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement;
    if (fsEl) {
      if (d.exitFullscreen) await d.exitFullscreen();
      else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
      else if (d.mozCancelFullScreen) await d.mozCancelFullScreen();
      else if (d.msExitFullscreen) await d.msExitFullscreen();
    }
  } catch(e) { console.warn('[FS] Exit error:', e); }
  
  try { screen?.orientation?.unlock?.(); } catch {}
  try { dispatchEvent(new CustomEvent('ui:exit')); } catch {}
  updateFSButtonVisibility();
  ensureUIVisible();
  syncFullscreenResize();
  console.log('[FS] Fullscreen exit complete');
}

async function toggleFullscreenMode(){
  if (isFullscreenActive()) await exitFullscreenMode();
  else await enterFullscreenLandscape();
}

function bindFullscreenButton(button, { exitOnly = false } = {}){
  if (!button) return;
  const handler = async (event) => {
    try {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    } catch {}

    // iOS often triggers a synthetic click after a touch/pointer gesture. Deduplicate
    // so "enter fullscreen" doesn't immediately "exit fullscreen".
    try{
      const now = Date.now();
      const type = String(event?.type || '');
      const isGesture = (type === 'touchend' || type === 'pointerdown' || type === 'pointerup');
      if (isGesture) LAST_GESTURE_AT = now;
      if (type === 'click' && now - LAST_GESTURE_AT < 650) return;
    }catch{}

    console.log('[FS] Button clicked, isFullscreen:', isFullscreenActive(), 'exitOnly:', exitOnly);
    if (exitOnly || isFullscreenActive()) {
      await exitFullscreenMode();
    } else {
      await enterFullscreenLandscape();
    }
  };
  // Use click for better mobile compatibility - removed capture mode for iOS
  button.addEventListener('click', handler, { passive: false });
  // Prefer Pointer Events on touch devices for fullscreen user-activation (pointerdown is the most reliable).
  const wantsPointerDown = (() => {
    if (IS_MOBILE) return true;
    try { return window.matchMedia?.('(pointer: coarse)')?.matches === true; } catch { return false; }
  })();
  if (wantsPointerDown) button.addEventListener('pointerdown', handler, { passive: false });
}

function requestFullscreenFromGesture(){
  if (isFullscreenActive()) return;
  try {
    const ua = navigator?.userActivation;
    if (ua && ua.isActive === false) return;
  } catch {}
  void enterFullscreenLandscape();
}

function initPhoneTemplateOnce(){
  try{
    if (!isPhoneLayout()) return;
    if (state.phoneInitDone) return;
    state.phoneInitDone = true;
    try { setExpDrawer(false); } catch {}
    // Minimap stays in place, but start minimized (eye closed).
    let tries = 0;
    const attempt = () => {
      tries += 1;
      minimizeMinimapOnce();
      if (state.phoneMinimapMinimized) return;
      if (tries < 16) setTimeout(attempt, 250);
    };
    setTimeout(attempt, 250);
  }catch{}
}

function startOnboardingTips({ force = false } = {}){
  const KEY = 'nandanavanam:onboard:v1';
  try{
    if (!onboardOverlay || !onboardSpotlight || !onboardCard || !onboardBody || !onboardNext || !onboardSkip) return;
    if (!force) {
      try { if (localStorage.getItem(KEY) === '1') return; } catch {}
    }

    const role = String(document.body.getAttribute('data-role') || '').toLowerCase();
    const isViewer = role === 'viewer';

    const steps = [
      {
        title: 'Menu',
        body: 'Tap here to switch experiences and open settings.',
        target: '#expDrawerToggle',
        before: () => { try { setExpDrawer(false); } catch {} }
      },
      {
        title: 'Zones',
        body: 'Use this bar to jump between zones/rooms.',
        target: '#zoneBar',
        before: () => {}
      },
      ...(!isViewer ? [{
        title: 'Minimap',
        body: 'Tap the eye on the minimap to show/hide it.',
        target: '.mini-wrap .mini-bar .mini-min',
        before: () => { try { minimizeMinimapOnce(); } catch {} }
      }] : []),
      {
        title: 'Fullscreen',
        body: 'Tap to expand the experience. Tap again or use ESC to exit.',
        target: '#btnFullscreen',
        before: () => { try { setExpDrawer(false); } catch {} }
      },
      {
        title: 'Hotspots',
        body: 'Tap the glowing rings in the scene to move to the next viewpoint.',
        target: '#renderCanvas',
        before: () => { try { setExpDrawer(false); } catch {} }
      }
    ];

    let i = 0;
    let timer = null;
    let activeTarget = null;
    let activeRect = null;
    let rafPending = false;
    let cleanedUp = false;

    let onDocPointerDown = null;
    let onScroll = null;
    let onResize = null;
    let onVvResize = null;
    let onVvScroll = null;

    const clearTimer = () => { try { if (timer) clearTimeout(timer); } catch {} timer = null; };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { if (onDocPointerDown) document.removeEventListener('pointerdown', onDocPointerDown); } catch {}
      try { if (onScroll) removeEventListener('scroll', onScroll); } catch {}
      try { if (onResize) removeEventListener('resize', onResize); } catch {}
      try { if (onResize) removeEventListener('orientationchange', onResize); } catch {}
      try { if (onVvResize) window.visualViewport?.removeEventListener?.('resize', onVvResize); } catch {}
      try { if (onVvScroll) window.visualViewport?.removeEventListener?.('scroll', onVvScroll); } catch {}
    };

    const hide = () => {
      clearTimer();
      cleanup();
      try { onboardOverlay.hidden = true; } catch {}
      try { onboardOverlay.setAttribute('aria-hidden', 'true'); } catch {}
      try { onboardSpotlight.style.display = 'none'; } catch {}
      try { document.body.classList.remove('onboarding'); } catch {}
      try { localStorage.setItem(KEY, '1'); } catch {}
    };

    const rectFor = (sel) => {
      try{
        const list = Array.from(document.querySelectorAll(sel));
        for (const el of list) {
          try{
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
            const r = el.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0) return r;
          }catch{}
        }
        return null;
      }catch{ return null; }
    };

    const placeSpotlight = (sel) => {
      try{
        const pad = 10;
        let r = rectFor(sel);
        if (!r && sel === '#renderCanvas') {
          r = { left: 18, top: 80, width: window.innerWidth - 36, height: Math.max(180, Math.min(320, window.innerHeight * 0.38)) };
        }
        if (!r) {
          onboardSpotlight.style.display = 'none';
          return;
        }
        activeRect = r;
        onboardSpotlight.style.display = '';
        onboardSpotlight.style.left = `${Math.max(8, r.left - pad)}px`;
        onboardSpotlight.style.top = `${Math.max(8, r.top - pad)}px`;
        onboardSpotlight.style.width = `${Math.max(44, r.width + pad * 2)}px`;
        onboardSpotlight.style.height = `${Math.max(44, r.height + pad * 2)}px`;
      }catch{}
    };

    const placeCardNear = (sel) => {
      try{
        if (!onboardCard) return;
        const margin = 12;
        let r = rectFor(sel);
        if (!r && sel === '#renderCanvas') r = { left: 18, top: 120, width: window.innerWidth - 36, height: 220 };
        const vw = Math.max(0, window.innerWidth || 0);
        const vh = Math.max(0, window.innerHeight || 0);

        // Default size (CSS), but clamp within viewport.
        const cardW = Math.min(360, Math.max(260, Math.floor(vw * 0.88)));
        onboardCard.style.width = `${cardW}px`;

        const measureH = () => Math.max(0, onboardCard.getBoundingClientRect().height || 0);
        const ch = measureH() || 160;

        let left = margin;
        let top = margin;
        if (r) {
          // Prefer below the target; if no space, place above.
          left = Math.min(vw - cardW - margin, Math.max(margin, r.left));
          const below = r.top + r.height + 10;
          const above = r.top - ch - 10;
          if (below + ch + margin <= vh) top = below;
          else if (above >= margin) top = above;
          else top = Math.min(vh - ch - margin, Math.max(margin, below));
        }

        onboardCard.style.left = `${Math.round(left)}px`;
        onboardCard.style.top = `${Math.round(top)}px`;

        // Arrow points back toward the highlighted rect (roughly).
        try{
          if (r) {
            const cardRect = onboardCard.getBoundingClientRect();
            const cx = Math.max(16, Math.min(cardRect.width - 16, (r.left + r.width / 2) - cardRect.left));
            const cy = (top > (r.top + r.height)) ? 8 : (cardRect.height - 8);
            onboardCard.style.setProperty('--coach-arrow-x', `${Math.round(cx)}px`);
            onboardCard.style.setProperty('--coach-arrow-y', `${Math.round(cy)}px`);
          }
        }catch{}
      }catch{}
    };

    const renderProgress = (idx) => {
      try{
        if (!onboardProgress) return;
        onboardProgress.innerHTML = '';
        for (let k = 0; k < steps.length; k++) {
          const dot = document.createElement('div');
          dot.className = 'onboard-dot' + (k === idx ? ' active' : '');
          onboardProgress.appendChild(dot);
        }
      }catch{}
    };

    const requestReposition = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!activeTarget) return;
        placeSpotlight(activeTarget);
        placeCardNear(activeTarget);
      });
    };

    const render = () => {
      try{
        // Skip steps whose target isn't present/visible in this layout/role.
        let step = steps[i];
        let guard = 0;
        while (step && step.target !== '#renderCanvas' && !rectFor(step.target) && guard < 10) {
          i += 1;
          step = steps[i];
          guard += 1;
        }
        if (!step) { hide(); return; }
        activeTarget = step.target;
        try { step.before?.(); } catch {}
        try { onboardTitle.textContent = step.title; } catch {}
        try { onboardBody.textContent = step.body; } catch {}
        try { if (onboardHint) onboardHint.style.display = step.target === '#renderCanvas' ? 'none' : ''; } catch {}
        try { onboardNext.textContent = (i === steps.length - 1) ? 'Got it' : 'Next'; } catch {}
        placeSpotlight(step.target);
        placeCardNear(step.target);
        renderProgress(i);
        clearTimer();
        // Still auto-advance eventually, but prefer interaction.
        timer = setTimeout(() => next(), 11000);
      }catch{}
    };

    const next = () => {
      try{
        i += 1;
        render();
      }catch{}
    };

    const begin = () => {
      try{
        onboardOverlay.hidden = false;
        onboardOverlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('onboarding');
        i = 0;
        render();
      }catch{}
    };

    // Ensure we don't accumulate listeners across repeated starts.
    try{
      onboardSkip.onclick = () => hide();
      onboardNext.onclick = () => { if (i === steps.length - 1) hide(); else next(); };
      onboardOverlay.onclick = (e) => {
        const t = e?.target;
        if (!t) return;
        if (t === onboardOverlay || t.classList?.contains?.('onboard-dim')) { if (i === steps.length - 1) hide(); else next(); }
      };
      addEventListener('keydown', (e) => { if (e.key === 'Escape' && !onboardOverlay.hidden) hide(); }, { once: true });
    }catch{}

    // Let users tap the highlighted control to proceed (without blocking the click).
    onDocPointerDown = (e) => {
      try{
        if (onboardOverlay.hidden) return;
        if (!activeRect) return;
        const targetEl = e?.target;
        if (targetEl && onboardCard && onboardCard.contains(targetEl)) return;
        const x = Number(e?.clientX) || 0;
        const y = Number(e?.clientY) || 0;
        const pad = 12;
        const hit =
          x >= (activeRect.left - pad) &&
          x <= (activeRect.left + activeRect.width + pad) &&
          y >= (activeRect.top - pad) &&
          y <= (activeRect.top + activeRect.height + pad);
        if (!hit) return;
        clearTimer();
        // Let the underlying UI react first, then advance.
        setTimeout(() => { if (i === steps.length - 1) hide(); else next(); }, 280);
      }catch{}
    };
    document.addEventListener('pointerdown', onDocPointerDown, { passive: true });

    onScroll = () => requestReposition();
    onResize = () => requestReposition();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onResize, { passive: true });
    addEventListener('orientationchange', onResize, { passive: true });
    try{
      onVvResize = onResize;
      onVvScroll = onScroll;
      window.visualViewport?.addEventListener?.('resize', onVvResize, { passive: true });
      window.visualViewport?.addEventListener?.('scroll', onVvScroll, { passive: true });
    }catch{}

    begin();
  }catch{}
}

/* Glass HUD (shared controls for 2D + WebXR) */
let hudPoll = null;
function syncHudFov(){
  try{
    if (!hudZoomRange || !hudZoomVal || !state.agentApi?.getFov) return;
    const fov = Number(state.agentApi.getFov());
    if (!Number.isFinite(fov)) return;
    hudZoomRange.value = fov.toFixed(3);
    hudZoomVal.textContent = fov.toFixed(2);
  }catch{}
}
async function refreshHudZones(){
  if (!hudZoneSelect || !state.agentApi?.getContext) return;
  try{
    const ctx = await state.agentApi.getContext();
    const expId = String(ctx?.exp || "").trim();
    const zoneOrder = await loadZoneOrderForUI(expId);
    const zones = filterZonesForUI(expId, applyZoneOrderForUI((Array.isArray(ctx?.zones) ? ctx.zones : []), zoneOrder));
    const nodes = Array.isArray(ctx?.nodes) ? ctx.nodes : [];
    const curId = ctx?.currentNodeId;
    const curNode = nodes.find(n=>n.id===curId) || null;
    const curZone = curNode?.zoneId || null;
    hudZoneSelect.innerHTML = "";
    zones.forEach(z=>{
      const opt = document.createElement("option");
      opt.value = z.id; opt.textContent = z.name || z.id;
      if (curZone && String(z.id) === String(curZone)) opt.selected = true;
      hudZoneSelect.appendChild(opt);
    });
    if (hudZoneHint) hudZoneHint.textContent = curZone ? String(curZone) : "-";
  }catch{}
}
function updateHudPlayState(){
  try{
    const playing = Boolean(state.tour?.isPlaying?.() && state.tour.isPlaying());
    if (hudPlayState) hudPlayState.textContent = playing ? "playing" : "paused";
  }catch{}
}
function setHudPanelOpen(open){
  if (!hudPanel) return;
  const next = Boolean(open);
  hudPanel.hidden = !next;
  hudPanel.setAttribute("data-open", next ? "1" : "0");
  if (next){
    syncHudFov();
    refreshHudZones();
    updateHudPlayState();
    if (!hudPoll) { hudPoll = setInterval(syncHudFov, 600); }
  } else if (hudPoll){
    clearInterval(hudPoll); hudPoll = null;
  }
}
function setupHudPanel(){
  if (!hudPanel) return;
  hudPanelToggle?.addEventListener("click", ()=>{ const openNow = hudPanel.getAttribute("data-open")==="1"; setHudPanelOpen(!openNow); }, { passive:true });
  hudClosePanel?.addEventListener("click", ()=>setHudPanelOpen(false), { passive:true });
  hudEnterXR?.addEventListener("click", ()=>{ state.agentApi?.toggleXR?.(); }, { passive:true });
  hudToggleXR?.addEventListener("click", ()=>{ state.agentApi?.toggleXR?.(); }, { passive:true });
  hudToggleMini?.addEventListener("click", ()=>{ state.agentApi?.toggleMinimap?.(); }, { passive:true });
  hudTourToggle?.addEventListener("click", async ()=>{
    try{
      if (!state.tour){
        const { createAutoplayController } = await import('./engine/autoplay.js');
        state.tour = createAutoplayController({ api: state.agentApi, dwellSec: 7, experiencesMeta: state.manifest });
        window.__tour = state.tour;
      }
      if (!state.tour) return;
      if (state.tour.isPlaying && state.tour.isPlaying()) state.tour.pause();
      else {
        const idx = Number(state.tour.getIndex?.() || -1);
        if (idx >= 0) state.tour.resume();
        else await state.tour.start();
      }
      updateHudPlayState();
    }catch(e){ console.error("[hud] tour toggle failed", e); }
  }, { passive:false });
  hudTourStop?.addEventListener("click", ()=>{ try{ state.tour?.stop?.(); updateHudPlayState(); }catch{} }, { passive:true });
  hudZoneSelect?.addEventListener("change", ()=>{ try{ const sel=hudZoneSelect.options[hudZoneSelect.selectedIndex]; if (sel?.value) state.agentApi?.goToZoneByName?.(sel.value, { broadcast:true }); }catch{} });
  hudPrevZone?.addEventListener("click", ()=>state.agentApi?.goToPrevInZone?.());
  hudNextZone?.addEventListener("click", ()=>state.agentApi?.goToNextInZone?.());
  hudPrevPano?.addEventListener("click", ()=>state.agentApi?.goToPrevInZone?.());
  hudNextPano?.addEventListener("click", ()=>state.agentApi?.goToNextInZone?.());
  hudZoomRange?.addEventListener("input", (e)=>{ try{ state.agentApi?.setFov?.(Number(e.target?.value || hudZoomRange.value)); syncHudFov(); }catch{} });
  // Keep zones and tour state in sync with navigation and events
  addEventListener("agent:navigate", ()=>{ refreshHudZones(); });
  ["tour:start","tour:resume","tour:pause","tour:stop","tour:complete"].forEach(ev=>addEventListener(ev, updateHudPlayState));
  setHudPanelOpen(false);
}

function getQS() {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}

function setDollhouseOpen(open) {
  const next = Boolean(open);
  state._dollhouseOpen = next;
  try {
    if (!dollhouseOverlay) return;
    dollhouseOverlay.hidden = !next;
    dollhouseOverlay.setAttribute('data-open', next ? '1' : '0');
    dollhouseOverlay.setAttribute('aria-hidden', next ? 'false' : 'true');
  } catch {}
  try {
    dollhouseToggleBtn?.classList?.toggle?.('is-active', next);
  } catch {}
}

async function openDollhouse() {
  try {
    if (!dollhouseOverlay || !dollhouseCanvas) return;
    const { id } = getSelectedExperience();
    if (id !== 'Indra & Kubera') return;
    setDollhouseOpen(true);
    try { dollhouseStatus.textContent = 'Loading 3D model…'; } catch {}

    if (!state._dollhouse) {
      const { createDollhouseViewer } = await import('./engine/dollhouse-viewer.js');
      state._dollhouse = createDollhouseViewer({ canvas: dollhouseCanvas, statusEl: dollhouseStatus });
    }

    const glbUrl = experienceAssetUrl(id, 'dollhouse/model.glb');
    try {
      await state._dollhouse.loadModel(glbUrl);
    } catch {
      const gltfUrl = experienceAssetUrl(id, 'dollhouse/model.gltf');
      await state._dollhouse.loadModel(gltfUrl);
    }

    // Place zone hotspots (prefer authored 3D anchors when available).
    try {
      const { loadWalkthrough } = await import('./engine/walkthrough-data.js');
      const { data } = await loadWalkthrough(experienceAssetUrl(id, 'walkthrough.json'));
      const zones = Array.isArray(data?.zones) ? data.zones : [];
      const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const floors = Array.isArray(data?.floors) ? data.floors : [];
      const floorById = new Map(floors.map((f) => [String(f?.id || ''), f]));

      const ext = state._dollhouse.getExtents?.();
      const min = ext?.min;
      const max = ext?.max;
      if (!min || !max) throw new Error('missing model extents');

      const size3 = max.subtract(min);
      const maxDim = Math.max(0.001, Math.abs(size3.x), Math.abs(size3.y), Math.abs(size3.z));

      const srcBoundsByFloor = new Map(); // floorId -> { minX,maxX,minY,maxY }
      const getFloorBounds = (floorId) => {
        const fallback = String(floors?.[0]?.id || '');
        const key = String(floorId || fallback || '');
        if (srcBoundsByFloor.has(key)) return srcBoundsByFloor.get(key);
        const fm = floorById.get(key) || floors[0] || {};
        const planW = Number(fm?.planWidth ?? fm?.planImageWidth ?? fm?.imageWidth ?? fm?.width);
        const planH = Number(fm?.planHeight ?? fm?.planImageHeight ?? fm?.imageHeight ?? fm?.height);
        if (Number.isFinite(planW) && planW > 0 && Number.isFinite(planH) && planH > 0) {
          const b = { minX: 0, maxX: planW, minY: 0, maxY: planH };
          srcBoundsByFloor.set(key, b);
          return b;
        }
        // Fallback: compute from authored points/nodes
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const usePt = (x, y) => {
          const nx = Number(x), ny = Number(y);
          if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
          minX = Math.min(minX, nx); maxX = Math.max(maxX, nx);
          minY = Math.min(minY, ny); maxY = Math.max(maxY, ny);
        };
        zones.forEach((z) => {
          if (String(z?.floorId || '') !== key) return;
          const rp = z?.repPoint;
          if (rp) usePt(rp.x, rp.y);
          (Array.isArray(z?.points) ? z.points : []).forEach((p) => usePt(p?.x, p?.y));
        });
        nodes.forEach((n) => { if (String(n?.floorId || '') === key) usePt(n?.x, n?.y); });
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY) || minX === maxX || minY === maxY) {
          const b = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
          srcBoundsByFloor.set(key, b);
          return b;
        }
        // Pad slightly so edge points are still inside.
        const padX = (maxX - minX) * 0.03;
        const padY = (maxY - minY) * 0.03;
        const b = { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
        srcBoundsByFloor.set(key, b);
        return b;
      };

      const rangeX = max.x - min.x;
      const rangeY = max.y - min.y;
      const rangeZ = max.z - min.z;
      const hoverY = max.y + (Number.isFinite(rangeY) && rangeY > 0 ? rangeY * 0.03 : 0.08);

      const map2DToModel = (floorId, pt) => {
        const b = getFloorBounds(floorId);
        const x = Number(pt?.x), y = Number(pt?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const nx = (x - b.minX) / Math.max(1e-6, (b.maxX - b.minX));
        const ny = (y - b.minY) / Math.max(1e-6, (b.maxY - b.minY));
        const px = min.x + (Math.max(0, Math.min(1, nx)) * rangeX);
        const pz = max.z - (Math.max(0, Math.min(1, ny)) * rangeZ); // invert Y (image coords)
        return { x: px, y: hoverY, z: pz };
      };

      const resolveZonePoint = (z) => {
        const rp = z?.repPoint;
        if (rp && Number.isFinite(Number(rp.x)) && Number.isFinite(Number(rp.y))) return { x: rp.x, y: rp.y };
        const pts = Array.isArray(z?.points) ? z.points : [];
        if (pts[0] && Number.isFinite(Number(pts[0].x)) && Number.isFinite(Number(pts[0].y))) return { x: pts[0].x, y: pts[0].y };
        const repId = typeof z?.repNodeId === 'string' ? z.repNodeId : null;
        if (repId) {
          const n = nodes.find((nn) => String(nn?.id || '') === repId) || null;
          if (n && Number.isFinite(Number(n.x)) && Number.isFinite(Number(n.y))) return { x: n.x, y: n.y };
        }
        return null;
      };

      const qs = getQS();
      const parseBool = (key, def) => {
        try {
          const raw = qs.get(key);
          if (raw == null || raw === '') return def;
          if (raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'on') return true;
          if (raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'off') return false;
          return def;
        } catch { return def; }
      };

      // If `dollhouse/hotspots.json` exists for the experience, use it (authoritative 3D anchors).
      let customHotspots = null;
      try {
        const url = experienceAssetUrl(id, 'dollhouse/hotspots.json');
        const res = await fetch(url, { cache: 'no-store' });
        if (res?.ok) {
          const json = await res.json();
          if (Array.isArray(json)) customHotspots = json;
        }
      } catch {}

      const hotspotItems = [];
      if (Array.isArray(customHotspots) && customHotspots.length) {
        for (const h of customHotspots) {
          const label = String(h?.label || h?.id || '').trim();
          if (!label) continue;
          const p = h?.position;
          const n = h?.normal;
          const x = Number(p?.x), y = Number(p?.y), z = Number(p?.z);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
          const nn =
            (n && Number.isFinite(Number(n.x)) && Number.isFinite(Number(n.y)) && Number.isFinite(Number(n.z)))
              ? { x: Number(n.x), y: Number(n.y), z: Number(n.z) }
              : null;
          hotspotItems.push({
            id: label,
            label,
            position: { x, y, z },
            ...(nn ? { normal: nn } : {}),
          });
        }
      } else {
      for (const z of zones) {
        const zid = String(z?.id || '').trim();
        if (!zid) continue;
        const label = (typeof z?.name === 'string' && z.name.trim()) ? z.name.trim() : zid;
        
        // Preferred: if the walkthrough has 3D anchors, use them directly (model-space/world coords).
        const ma = (z && typeof z === 'object') ? z.modelAnchor : null;
        const maPos = Array.isArray(ma?.position) ? ma.position : null;
        if (maPos && maPos.length >= 3) {
          const x = Number(maPos[0]), y = Number(maPos[1]), zz = Number(maPos[2]);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zz)) {
            const nrm = Array.isArray(ma?.normal) && ma.normal.length >= 3
              ? { x: Number(ma.normal[0]), y: Number(ma.normal[1]), z: Number(ma.normal[2]) }
              : null;
            hotspotItems.push({
              id: zid,
              label,
              meshName: (typeof ma?.meshName === 'string' && ma.meshName.trim()) ? ma.meshName.trim() : null,
              position: { x, y, z: zz },
              ...(nrm ? { normal: nrm } : {}),
            });
            continue;
          }
        }

        // Next: try named anchors inside the GLB.
        const candidates = [zid, label, z?.repNodeId].filter(Boolean);
        const anchorPos = state._dollhouse.findAnchorPosition?.(candidates) || null;
        if (anchorPos) {
          hotspotItems.push({ id: zid, label, position: { x: anchorPos.x, y: anchorPos.y, z: anchorPos.z } });
          continue;
        }

        // Fallback: map 2D floorplan points onto the model bounds.
        const pt = resolveZonePoint(z);
        const pos = map2DToModel(z?.floorId || floors[0]?.id, pt);
        if (!pos) continue;
        hotspotItems.push({ id: zid, label, position: pos });
      }
      }

      state._dollhouse.setHotspots?.(hotspotItems, {
        onPick: (md) => {
          try {
            const zoneKey = String(md?.id || md?.label || '').trim();
            if (!zoneKey) return;
            state.agentApi?.goToZoneByName?.(zoneKey, { broadcast: true, faceHotspot: true });
            closeDollhouse();
          } catch {}
        },
        // Defaults: custom hotspots are in model coordinates (no flips/fit needed). For the older
        // fallback mapping, we keep the previous defaults.
        flipZ: parseBool('dhFlipZ', !customHotspots),
        flipX: parseBool('dhFlipX', !customHotspots),
        autoFit: parseBool('dhAutoFit', !customHotspots),
        anchorScale: (() => {
          try {
            const v = Number(qs.get('dhScale') || '');
            return Number.isFinite(v) && v > 0 ? v : 1;
          } catch { return 1; }
        })(),
      });

      try {
        if (!hotspotItems.length) dollhouseStatus.textContent = 'Model loaded (no zone points found for hotspots).';
        else dollhouseStatus.textContent = `Hotspots: ${hotspotItems.length} (tap to go)`;
      } catch {}
    } catch (e) {
      console.warn('[dollhouse] hotspots failed', e);
    }
  } catch (e) {
    try { dollhouseStatus.textContent = 'Model not found (add dollhouse/model.glb).'; } catch {}
    console.warn('[dollhouse] open failed', e);
  }
}

function closeDollhouse({ dispose = true } = {}) {
  try {
    setDollhouseOpen(false);
    if (dispose) {
      try { state._dollhouse?.dispose?.(); } catch {}
      state._dollhouse = null;
    }
  } catch {}
}

function experiencesRootPath() {
  return EXPERIENCES_ROOT.startsWith("/") ? EXPERIENCES_ROOT : `/${EXPERIENCES_ROOT}`;
}

function experienceAssetUrl(id, relative = "") {
  const cleanId = String(id || "").replace(/^\/+|\/+$/g, "");
  const suffix = relative ? `/${relative.replace(/^\/+/, "")}` : "";
  const out = `${experiencesRootPath()}/${cleanId}${suffix}`.replace(/\/{2,}/g, "/");
  try { return encodeURI(out); } catch { return out; }
}

// WebP support detection (sync via canvas)
function supportsWebp() {
  try { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1; } catch { return false; }
}

// Keep preload URLs aligned with the engine (KTX2-first by default; disable with ?ktx2=0 or VITE_PANO_KTX2=0)
const PRELOAD_PREFER_KTX2 = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    const v = String(qs.get("ktx2") ?? qs.get("ktx") ?? "").trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off") return false;
    if (v === "1" || v === "true" || v === "on") return true;
  } catch {}
  try {
    const env = String(import.meta?.env?.VITE_PANO_KTX2 ?? "").trim().toLowerCase();
    if (env === "0" || env === "false" || env === "off") return false;
    if (env === "1" || env === "true" || env === "on") return true;
  } catch {}
  return true;
})();

function choosePanoPath(absUrl) {
  let out = absUrl;
  if (!supportsWebp() && /\.webp($|\?)/i.test(out)) out = out.replace(/\.webp(\?|$)/i, ".jpg$1");
  // Prefer JPEG for non-KTX2 fallbacks (pano PNGs are pruned at build time).
  if (/\.png($|\?)/i.test(out)) out = out.replace(/\.png(\?|$)/i, ".jpg$1");
  if (PRELOAD_PREFER_KTX2 && /\.(?:png|jpe?g|webp)($|\?)/i.test(out) && !/\.ktx2($|\?)/i.test(out)) {
    out = out.replace(/\.(?:png|jpe?g|webp)($|\?)/i, ".ktx2$1");
  }
  return out;
}

function choosePanoPathWithKtxPreference(absUrl, preferKtx2) {
  let out = absUrl;
  if (!supportsWebp() && /\.webp($|\?)/i.test(out)) out = out.replace(/\.webp(\?|$)/i, ".jpg$1");
  // Prefer JPEG for non-KTX2 fallbacks (pano PNGs are pruned at build time).
  if (/\.png($|\?)/i.test(out)) out = out.replace(/\.png(\?|$)/i, ".jpg$1");
  if (preferKtx2 && /\.(?:png|jpe?g|webp)($|\?)/i.test(out) && !/\.ktx2($|\?)/i.test(out)) {
    out = out.replace(/\.(?:png|jpe?g|webp)($|\?)/i, ".ktx2$1");
  }
  return out;
}

async function urlExistsFastForPreload(url, { timeoutMs = 1200 } = {}){
  let u = String(url || "").trim();
  if (!u) return false;
  try { u = encodeURI(u); } catch {}
  let to = null;
  const controller = (()=>{ try { return new AbortController(); } catch { return null; } })();
  try{
    if (controller) to = setTimeout(()=>{ try{ controller.abort(); }catch{} }, Math.max(200, Number(timeoutMs) || 1200));
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

async function loadManifest() {
  const manifestUrl = `${experiencesRootPath()}/manifest.json`.replace(/\/{2,}/g, "/");
  try {
    const res = await fetch(manifestUrl, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Manifest request failed (${res.status})`);
    const payload = await res.json();
    const list = Array.isArray(payload?.experiences) ? payload.experiences : [];
    if (!list.length) return EXPERIENCE_FALLBACK;
    const base = list
      .map((item, index) => ({
        id: String(item?.id || "").trim() || EXPERIENCE_FALLBACK[0].id,
        label: (item?.label && String(item.label).trim()) || item?.id || EXPERIENCE_FALLBACK[0].label,
        order: Number.isFinite(item?.order) ? item.order : index,
        stereo: Boolean(item?.stereo),
        stereoPanos: Array.isArray(item?.stereoPanos) ? item.stereoPanos.slice() : undefined,
        // Optional per-experience mapping/config flags (forwarded into engine init)
        flipU: (typeof item?.flipU === "boolean") ? item.flipU : undefined,
        flipX: (typeof item?.flipX === "boolean") ? item.flipX : undefined,
        startFaceHotspot: (typeof item?.startFaceHotspot === "boolean") ? item.startFaceHotspot : undefined,
        hotspotNavTags: (typeof item?.hotspotNavTags === "boolean") ? item.hotspotNavTags : undefined,
      }));

    // Optional overlay: per-experience `meta.json` inside each experience folder.
    // This lets you tweak stereo/stereoPanos/flip flags without editing the global manifest.
    let merged = base;
    try {
      const results = await Promise.allSettled(
        base.map(async (exp) => {
          const metaUrl = experienceAssetUrl(exp.id, "meta.json");
          let metaRes;
          try { metaRes = await fetch(metaUrl, { cache: "no-cache" }); } catch { return exp; }
          if (!metaRes?.ok) return exp;
          let meta;
          try { meta = await metaRes.json(); } catch { return exp; }
          if (!meta || typeof meta !== "object") return exp;
          return {
            ...exp,
            label: (meta?.label && String(meta.label).trim()) ? String(meta.label).trim() : exp.label,
            order: Number.isFinite(meta?.order) ? meta.order : exp.order,
            stereo: (typeof meta?.stereo === "boolean") ? meta.stereo : exp.stereo,
            stereoPanos: Array.isArray(meta?.stereoPanos) ? meta.stereoPanos.slice() : exp.stereoPanos,
            flipU: (typeof meta?.flipU === "boolean") ? meta.flipU : exp.flipU,
            flipX: (typeof meta?.flipX === "boolean") ? meta.flipX : exp.flipX,
            startFaceHotspot: (typeof meta?.startFaceHotspot === "boolean") ? meta.startFaceHotspot : exp.startFaceHotspot,
            hotspotNavTags: (typeof meta?.hotspotNavTags === "boolean") ? meta.hotspotNavTags : exp.hotspotNavTags,
          };
        })
      );
      merged = results.map((r, i) => (r.status === "fulfilled" ? r.value : base[i]));
    } catch {}

    return merged.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  } catch (err) {
    console.warn("[manifest] using fallback", err);
    return EXPERIENCE_FALLBACK;
  }
}

function wireCustomSelect({ wrapId, btnId, listId, labelId, selectId }) {
  const wrap = document.getElementById(wrapId);
  const btn = document.getElementById(btnId);
  const list = document.getElementById(listId);
  const label = document.getElementById(labelId);
  const select = document.getElementById(selectId);
  if (!wrap || !btn || !list || !label || !select) return () => {};

  function setValue(val, trigger = true) {
    select.value = val;
    const selectedOption = select.options[select.selectedIndex];
    label.textContent = selectedOption?.textContent || val;
    [...list.children].forEach((li) => {
      const active = li.getAttribute("data-value") === val;
      li.classList.toggle("active", active);
      li.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (trigger) select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  btn.addEventListener("click", () => {
    const open = wrap.getAttribute("data-open") === "true";
    wrap.setAttribute("data-open", open ? "false" : "true");
    btn.setAttribute("aria-expanded", (!open).toString());
  });

  list.addEventListener("click", (event) => {
    const li = event.target.closest?.("li[data-value]");
    if (!li) return;
    setValue(li.getAttribute("data-value"));
    wrap.setAttribute("data-open", "false");
    btn.setAttribute("aria-expanded", "false");
  });

  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) {
      wrap.setAttribute("data-open", "false");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  return setValue;
}

function populateSelect(selectEl, listEl, experiences, activeId) {
  if (!selectEl || !listEl) return;
  selectEl.innerHTML = "";
  listEl.innerHTML = "";

  experiences.forEach((exp, index) => {
    const option = document.createElement("option");
    option.value = exp.id;
    option.textContent = exp.label;
    if (exp.id === activeId || (!activeId && index === 0)) option.selected = true;
    selectEl.appendChild(option);

    const li = document.createElement("li");
    li.dataset.value = exp.id;
    li.role = "option";
    li.textContent = exp.label;
    li.setAttribute("aria-selected", exp.id === activeId ? "true" : "false");
    if (exp.id === activeId) li.classList.add("active");
    listEl.appendChild(li);
  });
}

function normaliseExpId(id) {
  return String(id || "").trim() || EXPERIENCE_FALLBACK[0].id;
}

async function loadZoneOrderForUI(expId){
  const key = normaliseExpId(expId);
  try{
    if (state._zoneOrderCache?.has?.(key)) return state._zoneOrderCache.get(key);
  }catch{}
  const p = (async()=>{
    try{
      const url = experienceAssetUrl(key, "zone-order.json");
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) return null;
      const json = await res.json();
      const list = Array.isArray(json) ? json : (Array.isArray(json?.zoneOrder) ? json.zoneOrder : null);
      if (!Array.isArray(list) || !list.length) return null;
      const out = [];
      for (const item of list){
        const id = (typeof item === "string") ? item.trim() : "";
        if (id && !out.includes(id)) out.push(id);
      }
      return out.length ? out : null;
    }catch{
      return null;
    }
  })();
  try { state._zoneOrderCache.set(key, p); } catch {}
  return p;
}

function applyZoneOrderForUI(zones, zoneOrder){
  const list = Array.isArray(zones) ? zones : [];
  const order = Array.isArray(zoneOrder) ? zoneOrder : null;
  if (!list.length || !order || !order.length) return list;
  try{
    const idxById = new Map();
    for (let i = 0; i < order.length; i++){
      const id = typeof order[i] === "string" ? order[i].trim() : "";
      if (id && !idxById.has(id)) idxById.set(id, i);
    }
    return list
      .map((z, i)=>({ z, i, o: idxById.has(String(z?.id || "")) ? idxById.get(String(z?.id || "")) : Number.POSITIVE_INFINITY }))
      .sort((a,b)=>(a.o-b.o)||(a.i-b.i))
      .map(x=>x.z);
  }catch{
    return list;
  }
}

async function fetchWalkthrough(expId) {
  const url = experienceAssetUrl(expId, "walkthrough.json");
  const response = await fetch(url, { cache: "no-cache" });
  const text = await response.text();
  if (!response.ok) throw new Error(`walkthrough.json fetch failed (${response.status}) at ${url}`);
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`Expected JSON at ${url}, got: ${text.slice(0, 80)}`); }
  const candidate = (raw && (raw.data || raw.project)) || raw || {};
  return candidate;
}

function preloadImages(urls, onProgress, concurrency = 2) {
  return new Promise((resolve) => {
    const total = urls.length;
    if (total === 0) {
      onProgress(1, 0, 0);
      return resolve();
    }
    let done = 0, errs = 0, idx = 0, inFlight = 0;
    function next() {
      if (done + errs >= total) { resolve(); return; }
      while (inFlight < concurrency && idx < total) {
        const url = urls[idx++];
        inFlight++;
        const img = new Image();
        img.onload = () => { inFlight--; done++; onProgress((done + errs) / total, done, errs); next(); };
        img.onerror = () => { inFlight--; errs++; onProgress((done + errs) / total, done, errs); next(); };
        img.decoding = "async";
        img.loading = "eager";
        img.src = url;
      }
    }
    next();
  });
}

// Streaming preloader with byte-level progress (smoother progress on slow links)
async function preloadImagesStreaming(urls, onProgress, concurrency = 3) {
  const total = urls.length;
  if (total === 0) { onProgress?.(1); return; }
  let active = 0, idx = 0, done = 0;
  let totalKnown = 0, loadedKnown = 0;
  
  // Report progress more frequently
  const report = () => {
    let p;
    if (totalKnown > 0 && loadedKnown > 0) {
      // Blend byte progress with file count progress for smoother updates
      const byteProgress = loadedKnown / totalKnown;
      const countProgress = done / total;
      p = (byteProgress * 0.7) + (countProgress * 0.3);
    } else {
      p = done / total;
    }
    onProgress?.(Math.min(0.95, p));
  };

  const queue = urls.slice();

  await new Promise((resolve) => {
    function next() {
      if (done >= total && active === 0) { report(); resolve(); return; }
      while (active < concurrency && idx < total) {
        const url = queue[idx++];
        active++;
        (async () => {
          try {
            const res = await fetch(url, { cache: 'force-cache' });
            if (res && res.ok) {
              const reader = res.body?.getReader?.();
              const expected = Number(res.headers.get('content-length')) || 0;
              if (expected > 0) totalKnown += expected;
              if (reader) {
                while (true) {
                  const { done: rdone, value } = await reader.read();
                  if (rdone) break;
                  if (expected > 0) { loadedKnown += value.byteLength; report(); }
                }
              } else {
                // No stream reader available: consume body to warm cache.
                try { await res.arrayBuffer(); } catch {}
                if (expected > 0) { loadedKnown += expected; report(); }
              }
            }
          } catch {}
          finally {
            done++; report();
            active--; next();
          }
        })();
      }
    }
    next();
  });
}

function getNetworkProfile() {
  try {
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const effective = String(conn?.effectiveType || '').toLowerCase();
    const saveData = Boolean(conn?.saveData);
    const slow = /^(slow-)?2g|3g$/.test(effective);
    const isMobile = /Android|iPhone|iPad|iPod|Quest|Oculus/i.test(navigator.userAgent);
    return { conn, effective, saveData, slow, isMobile };
  } catch { return { conn: null, effective: '', saveData: false, slow: false, isMobile: false }; }
}

// Mobile panos removed - always use original panos folder
async function resolvePanoDirForPreload(expId, sampleFile) {
  return 'panos';
}

async function preloadExperience(expId) {
  // Keep the overlay visible across the entire boot; app will hide it
  // only after the engine is fully initialized and first frame is ready.
  showOverlay();
  setProgress(0);

  const data = await fetchWalkthrough(expId);
  const startNodeId = data?.startNodeId || data?.start || data?.startNode || null;
  const startNode =
    (startNodeId && Array.isArray(data?.nodes) ? (data.nodes || []).find((n)=>String(n?.id||"")===String(startNodeId)) : null) ||
    ((data?.nodes || []).find((n) => n?.file) || null);
  const startFile = startNode?.file || '';
  const sampleFile = (data?.nodes || []).find((n) => n?.file)?.file || '';
  const panoDir = await resolvePanoDirForPreload(expId, sampleFile);

  // Some experiences (e.g. Skywalk) may not have KTX2 variants yet; avoid preloading missing files.
  let preferKtx2ForPreload = PRELOAD_PREFER_KTX2;
  try{
    if (preferKtx2ForPreload && sampleFile) {
      const sampleAbs = experienceAssetUrl(expId, `${panoDir}/${sampleFile}`);
      const sampleKtx = choosePanoPathWithKtxPreference(sampleAbs, true);
      if (/\.ktx2($|\\?)/i.test(sampleKtx) && sampleKtx !== sampleAbs) {
         const ok = await urlExistsFastForPreload(sampleKtx, { timeoutMs: 2500 });
         if (!ok) preferKtx2ForPreload = false;
       }
     }
   }catch{}

  const files = Array.from(new Set(
    (data?.nodes || [])
      .map((node) => node?.file ? choosePanoPathWithKtxPreference(experienceAssetUrl(expId, `${panoDir}/${node.file}`), preferKtx2ForPreload) : null)
      .filter(Boolean)
  ));
  const floorImages = Array.from(new Set(
    (data?.floors || [])
      .map((f) => (f?.image ? experienceAssetUrl(expId, `floors/${f.image}`) : null))
      .filter(Boolean)
  ));
  const firstPano = startFile ? choosePanoPathWithKtxPreference(experienceAssetUrl(expId, `${panoDir}/${startFile}`), preferKtx2ForPreload) : (files[0] || null);

  const { saveData, slow, isMobile } = getNetworkProfile();
  let mode = PRELOAD_MODE;
  if (mode !== 'all' && mode !== 'stage' && mode !== 'auto') mode = 'auto';
  if (mode === 'auto') mode = 'stage';

  // Always prioritize "first pano shows ASAP": preload only the start pano before boot,
  // then warm the remaining panos after the first frame.
  const stagePanos = firstPano ? [firstPano] : files.slice(0, 1);
  const stageList = [...floorImages, ...stagePanos];
  const restList = files.filter((u) => !stagePanos.includes(u));
  const backgroundBudget = slow ? (isMobile ? 18 : 30) : (isMobile ? 3 : 6);
  const shouldWarmBackground = mode !== 'all' && restList.length > 0 && !saveData;
  const backgroundWarmList = shouldWarmBackground ? restList.slice(0, Math.min(restList.length, backgroundBudget)) : [];
  const precacheTargets = Array.from(new Set([
    experienceAssetUrl(expId, "walkthrough.json"),
    experienceAssetUrl(expId, "meta.json"),
    ...floorImages,
    ...(mode === 'all' ? files : stageList),
  ]));

  // Preload hint for the very first pano
  const head = document.head || document.getElementsByTagName('head')[0];
  if (stagePanos[0] && head) {
    try {
      const link = document.createElement('link');
      link.rel = 'preload'; link.as = 'image'; link.href = stagePanos[0];
      link.fetchPriority = 'high';
      head.appendChild(link);
    } catch {}
  }

  // Ask SW (if present) to precache just what we're about to touch (or everything when safe)
  if (precacheTargets.length) {
    try { navigator.serviceWorker?.controller?.postMessage({ type: 'precache', urls: precacheTargets }); } catch {}
  }

  // Smoothing wrapper so the bar moves continuously even when sizes are unknown
  let uiProgress = 0, target = 0, rafId = null; let lastUpdate = performance.now();
  const PROGRESS_CAP = 0.95;
  function tick() {
    if (uiProgress >= (PROGRESS_CAP - 0.001) && target >= (PROGRESS_CAP - 0.001)) {
      uiProgress = PROGRESS_CAP;
      try { dispatchEvent(new CustomEvent('loading:progress', { detail: { progress: PROGRESS_CAP } })); } catch {}
      rafId = null;
      return;
    }
    const delta = Math.max(0.002, (target - uiProgress) * 0.18);
    if (target > uiProgress) { uiProgress = Math.min(PROGRESS_CAP, uiProgress + delta); try { dispatchEvent(new CustomEvent('loading:progress', { detail: { progress: uiProgress } })); } catch {} }
    rafId = requestAnimationFrame(tick);
  }
  function onRawProgress(p) {
    target = Math.max(target, Math.min(PROGRESS_CAP, p));
    lastUpdate = performance.now();
    if (!rafId) rafId = requestAnimationFrame(tick);
  }
  // Trickle toward completion if network doesnâ€™t expose byte sizes
  const trickle = setInterval(() => {
    if (performance.now() - lastUpdate > 700) {
      target = Math.min(PROGRESS_CAP - 0.02, target + 0.01);
      if (!rafId) rafId = requestAnimationFrame(tick);
    }
  }, 300);

  // Optimized concurrency: higher for desktop, moderate for mobile
  const mobileConc = IS_IOS ? 2 : (IS_ANDROID ? 3 : PRELOAD_CONCURRENCY);
  const desktopConc = Math.max(mobileConc, PRELOAD_CONCURRENCY);
  const concurrency = isMobile ? mobileConc : desktopConc;

  await preloadImagesStreaming(stageList, onRawProgress, concurrency);
  if (mode === 'all' && restList.length) {
    await preloadImagesStreaming(restList, onRawProgress, concurrency);
  }

  // Keep the bar below 100% until the engine has shown the first frame.
  clearInterval(trickle);
  target = PROGRESS_CAP; if (!rafId) rafId = requestAnimationFrame(tick);

  return {
    expId,
    stageList,
    warmAfterBoot: (mode === 'all') ? [] : restList,
    backgroundWarmAfterBoot: (mode === 'all') ? [] : backgroundWarmList,
    slowWarmAllAfterBoot: (mode === 'all') ? [] : ((restList.length && slow && !saveData) ? restList : []),
    network: { saveData, slow, isMobile }
  };
}

const _postBootWarmInFlight = new Map(); // expId -> Promise
function schedulePostBootWarm(preloadInfo){
  try{
    const expId = preloadInfo?.expId;
    if (!expId) return;
    if (_postBootWarmInFlight.has(expId)) return;
    const saveData = !!preloadInfo?.network?.saveData;
    if (saveData) return;
    const slow = !!preloadInfo?.network?.slow;
    const isMobile = !!preloadInfo?.network?.isMobile;

    const urls =
      (slow && Array.isArray(preloadInfo?.slowWarmAllAfterBoot) && preloadInfo.slowWarmAllAfterBoot.length)
        ? preloadInfo.slowWarmAllAfterBoot
        : (Array.isArray(preloadInfo?.backgroundWarmAfterBoot) ? preloadInfo.backgroundWarmAfterBoot : []);
    if (!Array.isArray(urls) || urls.length === 0) return;

    // Warm in the background (bounded concurrency so we don't stall current pano decode).
    const conc = slow ? 1 : (isMobile ? 2 : 3);
    const p = (async()=>{
      try { navigator.serviceWorker?.controller?.postMessage({ type: 'precache', urls }); } catch {}
      // Still warm the HTTP cache even if SW isn't active.
      await preloadImagesStreaming(urls, () => {}, conc);
    })().catch(()=>{}).finally(()=>{ try{ _postBootWarmInFlight.delete(expId); }catch{} });
    _postBootWarmInFlight.set(expId, p);
  }catch{}
}

function holdRepeat(el, fn, firstDelay = 230, interval = 45) {
  if (!el) return;
  let timeout = null;
  let repeat = null;
  const start = (event) => {
    if (event.isPrimary === false) return;
    event.preventDefault();
    el.setPointerCapture?.(event.pointerId);
    if (timeout || repeat) return;
    fn();
    timeout = setTimeout(() => {
      repeat = setInterval(fn, interval);
    }, firstDelay);
  };
  const stop = (event) => {
    if (repeat) clearInterval(repeat);
    if (timeout) clearTimeout(timeout);
    repeat = null;
    timeout = null;
    try { el.releasePointerCapture?.(event.pointerId); } catch {}
  };
  el.addEventListener("pointerdown", start, { passive: false });
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("pointerleave", stop);
}

function syncActiveExperience(id, { syncLive = true, syncGate = false } = {}) {
  state.activeExpId = id;
  try {
    if (state._dollhouseOpen && String(id || '') !== 'Indra & Kubera') closeDollhouse();
  } catch {}
  if (syncGate && state.setGateExp) state.setGateExp(id, false);
  if (syncLive && state.setLiveExp) state.setLiveExp(id, false);
  try { setActiveMenuExperience(id); } catch {}
}

function getSelectedExperience() {
  // Prefer the actively running experience (state.activeExpId). `expSelect` is the gate select and
  // may not be kept in sync during live experience switching.
  const id = normaliseExpId(state.activeExpId || expSelectLive?.value || expSelect?.value);
  return state.manifestById.get(id) || { id, label: id };
}

function iconSvgForExperience(expId) {
  const id = String(expId || "").toLowerCase();
  if (id.includes("skywalk")) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2"/><path d="M12 19v2"/><path d="M4.2 6.2l1.4 1.4"/><path d="M18.4 17.4l1.4 1.4"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="M4.2 17.8l1.4-1.4"/><path d="M18.4 6.6l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>`;
  }
  if (id.includes("layout")) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h7v7H4z"/><path d="M13 4h7v7h-7z"/><path d="M13 13h7v7h-7z"/><path d="M4 15h7v5H4z"/></svg>`;
  }
  if (id.includes("villa") || id.includes("club") || id.includes("flat")) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-6 8 6"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4z"/><path d="M13 4h7v7h-7z"/><path d="M4 13h7v7H4z"/><path d="M13 13h7v7h-7z"/></svg>`;
}

function renderExperienceMenu() {
  if (!expMenuGrid) return;
  expMenuGrid.innerHTML = "";
  const activeId = normaliseExpId(state.activeExpId || expSelectLive?.value);
  state.manifest.forEach((exp) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (exp.id === activeId ? " active" : "");
    btn.setAttribute("data-exp-id", exp.id);
    btn.innerHTML = `
      <div class="menu-ico">${iconSvgForExperience(exp.id)}</div>
      <div class="menu-text">${String(exp.label || exp.id)}</div>
    `;
    expMenuGrid.appendChild(btn);
  });

  if (!state.expMenuBound) {
    expMenuGrid.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-exp-id]");
      const expId = btn?.getAttribute?.("data-exp-id");
      if (!expId) return;
      try { state.setLiveExp?.(expId, true); } catch {}
    });
    state.expMenuBound = true;
  }
}

function setActiveMenuExperience(expId) {
  if (!expMenuGrid) return;
  const activeId = normaliseExpId(expId);
  expMenuGrid.querySelectorAll("[data-exp-id]").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-exp-id") === activeId);
  });
}

function getZoneIdFromContext(ctx) {
  try {
    const zones = Array.isArray(ctx?.zones) ? ctx.zones : [];
    const nodes = Array.isArray(ctx?.nodes) ? ctx.nodes : [];
    const curId = ctx?.currentNodeId;
    const curNode = nodes.find((n) => n?.id === curId) || null;
    const zoneId = curNode?.zoneId || null;
    if (zoneId) return String(zoneId);
    const z = zones.find((z) => z?.repNodeId && z.repNodeId === curId) || null;
    return z?.id ? String(z.id) : null;
  } catch {
    return null;
  }
}

function polygonAreaPx2(points) {
  try {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let sum = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = Number(points[i]?.x);
      const yi = Number(points[i]?.y);
      const xj = Number(points[j]?.x);
      const yj = Number(points[j]?.y);
      if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
      sum += (xj * yi) - (xi * yj);
    }
    return Math.abs(sum) / 2;
  } catch {
    return 0;
  }
}

function zoneSqftLabel(zone, floorsById) {
  try {
    const z = zone && typeof zone === 'object' ? zone : null;
    if (!z) return '';
    const floor = floorsById?.get?.(z.floorId) || null;
    const pxPerMeter = Number(floor?.pxPerMeter);
    if (!Number.isFinite(pxPerMeter) || pxPerMeter <= 0) return '';
    const areaPx2 = polygonAreaPx2(z.points);
    if (!(areaPx2 > 0)) return '';
    const areaM2 = areaPx2 / (pxPerMeter * pxPerMeter);
    const areaFt2 = areaM2 * 10.763910416709722;
    if (!Number.isFinite(areaFt2) || areaFt2 <= 0) return '';
    const rounded = Math.max(1, Math.round(areaFt2));
    return `${rounded} sqft.`;
  } catch {
    return '';
  }
}

function updateRoomTitleFromContext(ctx) {
  if (!roomTitleText) return;
  try {
    const zones = Array.isArray(ctx?.zones) ? ctx.zones : [];
    const nodes = Array.isArray(ctx?.nodes) ? ctx.nodes : [];
    const curId = ctx?.currentNodeId;
    const curNode = nodes.find((n) => n?.id === curId) || null;
    const zoneId = curNode?.zoneId || null;
    const zone = zoneId ? zones.find((z) => String(z?.id) === String(zoneId)) : null;
    const label = (zone && typeof zone?.name === 'string' && zone.name.trim())
      ? zone.name.trim()
      : (zoneId ? String(zoneId) : '-');
    roomTitleText.textContent = label || '-';
  } catch {
    roomTitleText.textContent = '-';
  }
}

function filterZonesForUI(expId, zones) {
  const exp = String(expId || "").trim().toLowerCase();
  const list = Array.isArray(zones) ? zones : [];
  if (exp !== "layoutwalkthrough") return list;

  const bannedIds = new Set(["zone-26", "zone-27", "zone-42"]);
  return list.filter((z) => {
    const id = String(z?.id || "").trim();
    if (!id) return false;
    if (bannedIds.has(id)) return false;
    const name = String(z?.name || "").trim();
    if (/balcony|terrace/i.test(name)) return false;
    return true;
  });
}

function updateZoneBarOverflowUI(){
  try{
    if (!zoneBar || !zoneBarList) return;
    const max = Math.max(0, (zoneBarList.scrollWidth || 0) - (zoneBarList.clientWidth || 0));
    const overflow = max > 2;
    zoneBar.setAttribute("data-overflow", overflow ? "1" : "0");
    if (!overflow){
      zoneBar.setAttribute("data-left", "0");
      zoneBar.setAttribute("data-right", "0");
      try { if (zoneBarPrev) zoneBarPrev.disabled = true; } catch {}
      try { if (zoneBarNext) zoneBarNext.disabled = true; } catch {}
      return;
    }
    const left = (zoneBarList.scrollLeft || 0) > 1;
    const right = (zoneBarList.scrollLeft || 0) < (max - 1);
    zoneBar.setAttribute("data-left", left ? "1" : "0");
    zoneBar.setAttribute("data-right", right ? "1" : "0");
    try { if (zoneBarPrev) zoneBarPrev.disabled = !left; } catch {}
    try { if (zoneBarNext) zoneBarNext.disabled = !right; } catch {}
  }catch{}
}

async function refreshZoneBar({ rebuild = false } = {}) {
  if (!zoneBar || !zoneBarList || !state.agentApi?.getContext) return;
  let ctx;
  try { ctx = await state.agentApi.getContext(); } catch { ctx = null; }
  const expId = String(ctx?.exp || "").trim();
  const zoneOrder = await loadZoneOrderForUI(expId);
  const allZones = filterZonesForUI(expId, applyZoneOrderForUI((Array.isArray(ctx?.zones) ? ctx.zones : []), zoneOrder));
  const nodes = Array.isArray(ctx?.nodes) ? ctx.nodes : [];
  const floors = Array.isArray(ctx?.floors) ? ctx.floors : [];
  const floorsById = new Map(floors.map((f) => [String(f?.id || ''), f]));

  const currentNodeId = ctx?.currentNodeId;
  const currentNode = nodes.find((n) => n?.id === currentNodeId) || null;
  const currentFloorId = currentNode?.floorId ? String(currentNode.floorId) : null;
  const showBackToRoadA = expId === "Villas Walkthrough" && currentFloorId && currentFloorId !== "floor-1";

  // Only show zones that belong to the active floor (if known)
  const zones = currentFloorId
    ? allZones.filter((z) => String(z?.floorId || "") === currentFloorId)
    : allZones;
  const zonesKey = (showBackToRoadA ? "__road_a__|" : "") + zones.map((z) => String(z?.id || "")).join("|");
  if (!zones.length) {
    zoneBar.setAttribute("data-show", "0");
    zoneBar.setAttribute("aria-hidden", "true");
    zoneBarList.innerHTML = "";
    state.zoneBarZonesKey = "";
    return;
  }

  if (rebuild || !zoneBarList.children.length || state.zoneBarZonesKey !== zonesKey) {
    zoneBarList.innerHTML = "";
    // Reset scroll so the "starting zones" are visible after experience switches.
    try { zoneBarList.scrollLeft = 0; } catch {}

    if (showBackToRoadA) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zone-chip";
      btn.setAttribute("data-zone-id", "__road_a__");
      btn.innerHTML = `<span class="t">Road A</span><span class="sub">Back to exterior</span>`;
      btn.addEventListener("click", () => {
        if (Date.now() < (state.zoneBarSuppressClickUntil || 0)) return;
        try { state.agentApi?.goToNode?.("pano-6", { broadcast: true }); } catch {}
      });
      zoneBarList.appendChild(btn);
    }

    zones.forEach((z) => {
      const id = String(z?.id || "");
      const name = (typeof z?.name === "string" && z.name.trim()) ? z.name.trim() : id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zone-chip";
      btn.setAttribute("data-zone-id", id);
      btn.innerHTML = `<span class="t">${name}</span>`;
      btn.addEventListener("click", () => {
        if (Date.now() < (state.zoneBarSuppressClickUntil || 0)) return;
        try { state.agentApi?.goToZoneByName?.(id, { broadcast: true }); } catch {}
      });
      zoneBarList.appendChild(btn);
    });
    state.zoneBarZonesKey = zonesKey;
  }

  const activeZoneId = getZoneIdFromContext(ctx);
  zoneBarList.querySelectorAll("[data-zone-id]").forEach((el) => {
    const id = el.getAttribute("data-zone-id");
    el.classList.toggle("active", Boolean(activeZoneId && id === activeZoneId));
  });
  updateRoomTitleFromContext(ctx);
  zoneBar.setAttribute("data-show", "1");
  zoneBar.setAttribute("aria-hidden", "false");

  try{
    // Check if content fits (no scroll needed) - center it; otherwise allow scroll
    requestAnimationFrame(() => {
      try {
        const fits = zoneBarList.scrollWidth <= zoneBarList.clientWidth;
        zoneBar.setAttribute("data-fit", fits ? "true" : "false");
        updateZoneBarOverflowUI();
      } catch {}
    });
  }catch{}

  // Auto-scroll to the active zone only when it changes (or on rebuild), and never while the user is scrolling.
  if (activeZoneId) {
    const esc = (typeof CSS !== "undefined" && typeof CSS.escape === "function")
      ? CSS.escape(activeZoneId)
      : activeZoneId.replace(/"/g, '\\"');
    const activeEl = zoneBarList.querySelector(`[data-zone-id="${esc}"]`);
    try {
      const last = String(state.zoneBarActiveZoneId || "");
      const changed = (last !== String(activeZoneId || ""));
      state.zoneBarActiveZoneId = activeZoneId;
      const userBusy = Date.now() < (state.zoneBarUserScrollUntil || 0);
      const canScroll = zoneBarList.scrollWidth > (zoneBarList.clientWidth + 2);
      if (!canScroll || userBusy) return;
      if (!rebuild && !changed) return;

      // Avoid constantly re-centering the bar; only scroll if the active chip is clipped.
      requestAnimationFrame(() => {
        try {
          if (!activeEl) return;
          const host = zoneBarList;
          const hostR = host.getBoundingClientRect();
          const elR = activeEl.getBoundingClientRect();
          const pad = 18;
          const clippedLeft = elR.left < (hostR.left + pad);
          const clippedRight = elR.right > (hostR.right - pad);
          if (!clippedLeft && !clippedRight) return;
          activeEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: rebuild ? "auto" : "smooth" });
        } catch {}
      });
    } catch {}
  }
}

async function startGuide() {
  if (startGate) startGate.remove();
  setExpDrawer(false);
  const { id } = getSelectedExperience();
  syncActiveExperience(id, { syncGate: true, syncLive: true });
  try{ document.body.setAttribute('data-role','guide'); }catch{}
  try{ document.body.setAttribute('data-ui','new'); }catch{}
  const roomId = roomInput?.value?.trim() || "demo";

  // Use stub to avoid breaking dev if agent.js is unavailable
  const importPromise = import("./engine/agent.js");
  const preloadInfo = await preloadExperience(id); try { (window.unlockAudio && window.unlockAudio()) } catch {}

  gate?.remove();

  // Show finish button
  showFinishButton(id);

  // Engine chunk + init; overlay remains visible from preload until we're fully ready
  const { initAgent } = await importPromise;
  state.agentApi = await initAgent({ roomId, exp: id, experiencesMeta: state.manifest });
  if (!state.boundExperienceListener) {
    addEventListener('agent:experience', (ev) => {
      const nextId = normaliseExpId(ev?.detail?.expId);
      if (!nextId) return;
      syncActiveExperience(nextId, { syncGate: false, syncLive: true });
      setupZoneUI().catch(() => {});
    });
    state.boundExperienceListener = true;
  }
  // Build zone selector (if zones exist)
  try {
    await setupZoneUI();
  } catch {}
  // Build tour controller lazily
  try {
    const { createAutoplayController } = await import('./engine/autoplay.js');
    state.tour = createAutoplayController({ api: state.agentApi, dwellSec: 7, experiencesMeta: state.manifest });
    window.__tour = state.tour; // exposed for autoplay + sync helpers
    // Auto-start tour if enabled
    const AUTOSTART = String(import.meta?.env?.VITE_TOUR_AUTOSTART ?? '0') === '1';
    if (AUTOSTART) { try { await state.tour.start(); } catch (e) { console.warn('[tour] autostart failed', e); } }
  } catch {}
  // If a persisted mirror pitch sign exists (for field calibration), apply it
  try {
    const savedPitch = Number(localStorage.getItem('mirrorPitchSign'));
    if (savedPitch===1||savedPitch===-1) state.agentApi?.setMirrorPitchSign?.(savedPitch);
  } catch {}
  // Apply persisted yaw sign if present
  try {
    const savedYaw = Number(localStorage.getItem('mirrorYawSign'));
    if (savedYaw===1||savedYaw===-1) state.agentApi?.setMirrorYawSign?.(savedYaw);
  } catch {}
  try { refreshHudZones(); syncHudFov(); updateHudPlayState(); } catch {}
  // Now the first frame is ready; hide the loader.
  setExperienceLoaded(true);
  dispatchEvent(new CustomEvent('loading:hide'));
  try { setTimeout(() => schedulePostBootWarm(preloadInfo), 200); } catch {}
  try{
    initPhoneTemplateOnce();
    setTimeout(() => startOnboardingTips({ force: false }), 700);
  }catch{}
}

async function startViewer() {
  if (startGate) startGate.remove();
  try{ document.body.removeAttribute('data-ui'); }catch{}
  const { id } = getSelectedExperience();
  syncActiveExperience(id, { syncGate: true, syncLive: true });
  try{ document.body.setAttribute('data-role','viewer'); }catch{}
  try { setHudPanelOpen(false); } catch {}
  const roomId = roomInput?.value?.trim() || "demo";

  const importPromise = import("./engine/viewer.js");
  const preloadInfo = await preloadExperience(id); try { (window.unlockAudio && window.unlockAudio()) } catch {}

  gate?.remove();

  // Show finish button for viewer too
  showFinishButton(id);

  state.agentApi = null;
  const { initViewer } = await importPromise;
  // In guided viewer mode, follow the guide's look direction so both screens match.
  await initViewer({ roomId, exp: id, experiencesMeta: state.manifest, followGuideYaw: true });
  setExperienceLoaded(true);
  dispatchEvent(new CustomEvent('loading:hide'));
  try { setTimeout(() => schedulePostBootWarm(preloadInfo), 200); } catch {}
  try { setTimeout(() => startOnboardingTips({ force: false }), 700); } catch {}
}

// Zone select wiring (created dynamically so it works on older HTML)
async function setupZoneUI(){
  // Clean up legacy dropdown if it exists
  try { document.getElementById('zoneSelectWrap')?.remove(); } catch {}
  if (!state.agentApi) return;

  await refreshZoneBar({ rebuild: true });
  try{
    if (isPhoneLayout()) initPhoneTemplateOnce();
  }catch{}

  // Enable mouse-wheel horizontal scrolling on desktop/trackpads when overflowed.
  if (!state.zoneBarWheelBound && zoneBarList) {
    try {
      zoneBarList.addEventListener('wheel', (e) => {
        try {
          if (zoneBarList.scrollWidth <= zoneBarList.clientWidth) return;
          const dy = Number(e.deltaY) || 0;
          const dx = Number(e.deltaX) || 0;
          const absX = Math.abs(dx);
          const absY = Math.abs(dy);
          let consumed = false;

          // Trackpads often produce deltaX for horizontal gestures; mouse wheels typically use deltaY.
          if (absX > 0.01) {
            zoneBarList.scrollLeft += dx;
            consumed = true;
          } else if (absY > 0.01) {
            // Shift+wheel should always scroll the zone bar horizontally.
            if (e.shiftKey || absY > absX) {
              zoneBarList.scrollLeft += dy;
              consumed = true;
            }
          }

          if (consumed) {
            try { state.zoneBarUserScrollUntil = Date.now() + 1200; } catch {}
            updateZoneBarOverflowUI();
            e.preventDefault();
          }
        } catch {}
      }, { passive: false });
      state.zoneBarWheelBound = true;
    } catch {}
  }

  // Enable click-drag and touch-drag horizontal scrolling when overflowed.
  if (!state.zoneBarDragBound && zoneBarList) {
    try {
      let isDown = false;
      let startX = 0;
      let startScrollLeft = 0;
      let moved = false;
      let captured = false;
      let activePointerId = null;
      const MOVE_THRESHOLD = 8;

      const onDown = (e) => {
        try {
          if (zoneBarList.scrollWidth <= zoneBarList.clientWidth) return;
          if (e.button !== undefined && e.button !== 0) return;
          state.zoneBarUserScrollUntil = Date.now() + 1500;
          isDown = true;
          moved = false;
          captured = false;
          activePointerId = e.pointerId ?? null;
          startX = Number(e.clientX) || 0;
          startScrollLeft = zoneBarList.scrollLeft;
        } catch {}
      };
      const onMove = (e) => {
        try {
          if (!isDown) return;
          const x = Number(e.clientX) || 0;
          const dx = x - startX;
          if (!moved && Math.abs(dx) < MOVE_THRESHOLD) return;
          moved = true;
          if (!captured) {
            try { if (activePointerId != null) zoneBarList.setPointerCapture?.(activePointerId); } catch {}
            captured = true;
          }
          zoneBarList.scrollLeft = startScrollLeft - dx;
          updateZoneBarOverflowUI();
          // prevent page scroll / rubber-band while dragging chips
          try { e.preventDefault(); } catch {}
        } catch {}
      };
      const onUp = (e) => {
        try {
          if (!isDown) return;
          isDown = false;
          if (captured) {
            try { zoneBarList.releasePointerCapture?.(activePointerId ?? e.pointerId); } catch {}
          }
          captured = false;
          activePointerId = null;
          if (moved) state.zoneBarSuppressClickUntil = Date.now() + 350;
        } catch {}
      };

      zoneBarList.addEventListener('pointerdown', onDown, { passive: true });
      zoneBarList.addEventListener('pointermove', onMove, { passive: false });
      zoneBarList.addEventListener('pointerup', onUp, { passive: true });
      zoneBarList.addEventListener('pointercancel', onUp, { passive: true });

      state.zoneBarDragBound = true;
    } catch {}
  }

  // Track user scrolling so auto-scroll doesn't fight manual scroll.
  if (!state.zoneBarScrollBound && zoneBarList) {
    try {
      const markBusy = () => {
        try { state.zoneBarUserScrollUntil = Date.now() + 1200; } catch {}
        updateZoneBarOverflowUI();
      };
      zoneBarList.addEventListener('wheel', markBusy, { passive: true });
      zoneBarList.addEventListener('scroll', markBusy, { passive: true });
      state.zoneBarScrollBound = true;
    } catch {}
  }

  // Explicit scroll buttons (helps on devices where drag-to-scroll isn't obvious or is intercepted)
  if (!state.zoneBarButtonsBound && zoneBarList && (zoneBarPrev || zoneBarNext)) {
    try {
      const scrollByPages = (dir) => {
        try { state.zoneBarUserScrollUntil = Date.now() + 1200; } catch {}
        const w = zoneBarList.clientWidth || 0;
        const step = Math.max(140, Math.floor(w * 0.75));
        try { zoneBarList.scrollBy({ left: dir * step, behavior: "smooth" }); }
        catch { try { zoneBarList.scrollLeft += dir * step; } catch {} }
        updateZoneBarOverflowUI();
      };
      try { zoneBarPrev?.addEventListener("click", () => scrollByPages(-1)); } catch {}
      try { zoneBarNext?.addEventListener("click", () => scrollByPages(1)); } catch {}
      state.zoneBarButtonsBound = true;
      updateZoneBarOverflowUI();
    } catch {}
  }

  if (state.zoneNavigateListener) {
    try { removeEventListener('agent:navigate', state.zoneNavigateListener); } catch {}
  }
  state.zoneNavigateListener = () => { refreshZoneBar({ rebuild: false }).catch(() => {}); };
  addEventListener('agent:navigate', state.zoneNavigateListener);
}


async function onLiveExperienceChange() {
  const nextId = normaliseExpId(expSelectLive?.value);
  syncActiveExperience(nextId, { syncGate: false, syncLive: true });
  setExpDrawer(false);
  const preloadInfo = await preloadExperience(nextId);
  if (state.agentApi?.switchExperience) {
    try { await state.agentApi.switchExperience(nextId); }
    catch (e) { console.error('[agent] switchExperience failed', e); }
  }
  if (state.tour?.isPlaying && state.tour.isPlaying()) {
    try { state.tour.stop(); } catch {}
  }
  // Rebuild zone UI for the new experience
  try { await setupZoneUI(); } catch {}
  // After switching, hide the loader since textures are already cached
  dispatchEvent(new CustomEvent('loading:hide'));
  try { setTimeout(() => schedulePostBootWarm(preloadInfo), 200); } catch {}
}

async function bootstrap() {
  // Device/orientation flags + fullscreen button wiring
  updateHtmlFlags();
  addEventListener('resize', updateHtmlFlags);
  addEventListener('orientationchange', updateHtmlFlags);
  updateViewportVars();
  addEventListener('resize', updateViewportVars, { passive: true });
  addEventListener('orientationchange', () => setTimeout(updateViewportVars, 50), { passive: true });
  try{
    window.visualViewport?.addEventListener?.('resize', updateViewportVars, { passive: true });
    window.visualViewport?.addEventListener?.('scroll', updateViewportVars, { passive: true });
  }catch{}
  initPhoneTemplateOnce();
  const onFS = () => { 
    try { updateFSButtonVisibility(); } catch {} 
    try { state.agentApi?.refreshOverlays?.(); } catch {} 
    // Ensure UI elements remain visible after fullscreen change
    setTimeout(ensureUIVisible, 100);
    setTimeout(ensureUIVisible, 500);
  };
  document.addEventListener('fullscreenchange', onFS);
  document.addEventListener('webkitfullscreenchange', onFS);
  document.addEventListener('mozfullscreenchange', onFS);
  document.addEventListener('MSFullscreenChange', onFS);
  bindFullscreenButton(exitFSBtn, { exitOnly: true });
  bindFullscreenButton(btnFullscreen);

  // Double-tap/click to toggle fullscreen
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const DOUBLE_TAP_DELAY = 350; // ms
  const DOUBLE_TAP_DISTANCE = 50; // px tolerance

  const handleDoubleTap = (e) => {
    // Ignore if clicking on interactive elements
    const target = e.target;
    if (!target) return;
    const tag = (target.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (target.closest?.('button, a, .zone-chip, .mini-wrap, .hud-pill, #expDrawer, #zoneBar, [role="button"]')) return;

    const now = Date.now();
    const x = e.clientX || (e.touches?.[0]?.clientX) || 0;
    const y = e.clientY || (e.touches?.[0]?.clientY) || 0;
    const dx = Math.abs(x - lastTapX);
    const dy = Math.abs(y - lastTapY);

    if (now - lastTapTime < DOUBLE_TAP_DELAY && dx < DOUBLE_TAP_DISTANCE && dy < DOUBLE_TAP_DISTANCE) {
      // Double tap detected
      e.preventDefault();
      void toggleFullscreenMode();
      lastTapTime = 0; // Reset to prevent triple-tap
    } else {
      lastTapTime = now;
      lastTapX = x;
      lastTapY = y;
    }
  };

  // Use pointerup for better cross-platform support
  document.addEventListener('pointerup', handleDoubleTap, { passive: false });
  document.addEventListener('dblclick', (e) => {
    try {
      // Ignore if clicking on interactive elements
      const target = e.target;
      if (!target) return;
      const tag = (target.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (target.closest?.('button, a, .zone-chip, .mini-wrap, .hud-pill, #expDrawer, #zoneBar, [role="button"]')) return;
      e.preventDefault();
      void toggleFullscreenMode();
    } catch {}
  }, { passive: false });

  setupHudPanel();
  setupAutoplayAudio();

  // Dollhouse UI wiring
  try {
    const iconCube = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 22V12" stroke="currentColor" stroke-width="1.8"/><path d="M21 6.5 12 12 3 6.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>';
    if (dollhouseToggleBtn) {
      const label = String(dollhouseToggleBtn.getAttribute('data-label') || 'Dollhouse');
      dollhouseToggleBtn.innerHTML = `${iconCube}<span class="hud-text">${label}</span>`;
      dollhouseToggleBtn.setAttribute('aria-label', 'Dollhouse');
      dollhouseToggleBtn.setAttribute('title', 'Dollhouse');
    }
    dollhouseToggleBtn?.addEventListener?.('click', (e) => {
      try { e.preventDefault?.(); } catch {}
      if (state._dollhouseOpen) closeDollhouse();
      else void openDollhouse();
    }, { passive: false });

    dollhouseCloseBtn?.addEventListener?.('click', (e) => {
      try { e.preventDefault?.(); e.stopPropagation?.(); } catch {}
      closeDollhouse();
    }, { passive: false });

    dollhouseOverlay?.addEventListener?.('click', (e) => {
      try {
        if (e.target === dollhouseOverlay) closeDollhouse();
      } catch {}
    }, { passive: true });

    // Close with Escape (capture to avoid stopping the tour underneath)
    window.addEventListener('keydown', (e) => {
      try {
        if (!state._dollhouseOpen) return;
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        closeDollhouse();
      } catch {}
    }, { passive: false, capture: true });

    const onResize = () => {
      try {
        if (!state._dollhouseOpen) return;
        state._dollhouse?.resize?.();
      } catch {}
    };
    addEventListener('resize', onResize, { passive: true });
    window.visualViewport?.addEventListener?.('resize', onResize, { passive: true });

    // Open dollhouse from minimap tap (Indra & Kubera only)
    if (!state._minimapDollhouseBound) {
      state._minimapDollhouseBound = true;
      window.addEventListener('minimap:tap', () => {
        try {
          if (document.body.getAttribute('data-experience') !== '1') return;
          const { id } = getSelectedExperience();
          if (id !== 'Indra & Kubera') return;
          if (state._dollhouseOpen) return;
          void openDollhouse();
        } catch {}
      }, { passive: true });
    }
  } catch {}

  // Enhance buttons: larger fullscreen icon and tooltips across controls
  const setTip = (el, text) => { if (el){ el.setAttribute('title', text); el.setAttribute('data-tip', text); } };
  try {
    const fsSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
    const upSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7l-5 5h10z"/></svg>';
    const downSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17l5-5H7z"/></svg>';
    const leftSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12l6-6v12z"/></svg>';
    const rightSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 12l-6 6V6z"/></svg>';

    const fsBtn = document.getElementById('btnFS');
    if (fsBtn) { fsBtn.innerHTML = fsSvg; setTip(fsBtn, 'Fullscreen'); }
    if (btnFullscreen) {
      const tip = (IS_IOS_PHONE && !IS_STANDALONE)
        ? 'Add to Home Screen for full screen'
        : 'Fullscreen';
      setTip(btnFullscreen, tip);
      if (IS_IOS_PHONE) btnFullscreen.setAttribute('aria-label', 'Expand');
    }
    if (btnUp)    { btnUp.innerHTML = upSvg;    setTip(btnUp,    'Look up'); }
    if (btnDown)  { btnDown.innerHTML = downSvg;  setTip(btnDown,  'Look down'); }
    if (btnLeft)  { btnLeft.innerHTML = leftSvg;  setTip(btnLeft,  'Look left'); }
    if (btnRight) { btnRight.innerHTML = rightSvg; setTip(btnRight, 'Look right'); }
    if (btnMini)   setTip(btnMini,   'Toggle minimap');
    if (btnMirror) setTip(btnMirror, 'Switch view');
    if (zoomInLegacy)  setTip(zoomInLegacy,  'Zoom in');
    if (zoomOutLegacy) setTip(zoomOutLegacy, 'Zoom out');

    // Tour buttons: set icons and initial state (Play)
    const iconPlay = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    const iconPause = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>';
    const iconStop = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/></svg>';
    function setToggle(playing){
      try{
        if (!tourToggleBtn) return;
        if (playing){
          const label = String(tourToggleBtn.getAttribute('data-label') || 'AutoPlay');
          tourToggleBtn.innerHTML = `${iconPause}<span class="hud-text">${label}</span>`;
          tourToggleBtn.classList.add('is-active');
          setTip(tourToggleBtn, 'Pause');
          tourToggleBtn.setAttribute('aria-label','Pause');
          // Show stop button when playing
          if (tourStopTop) tourStopTop.style.display = '';
        } else {
          const label = String(tourToggleBtn.getAttribute('data-label') || 'AutoPlay');
          tourToggleBtn.innerHTML = `${iconPlay}<span class="hud-text">${label}</span>`;
          tourToggleBtn.classList.remove('is-active');
          setTip(tourToggleBtn, 'Play');
          tourToggleBtn.setAttribute('aria-label','Play');
          // Hide stop button when not playing
          if (tourStopTop) tourStopTop.style.display = 'none';
        }
      }catch{}
    }
    if (tourToggleBtn) setToggle(false);
    if (tourStopBtn) { try{ tourStopBtn.innerHTML = iconStop; setTip(tourStopBtn, 'Stop'); }catch{} }
    // Wire up stop button click
    tourStopTop?.addEventListener('click', () => {
      try { state.tour?.stop?.(); setToggle(false); } catch {}
    });
    state._setTourToggleUI = setToggle;
  } catch {}
  state.setLiveExp = wireCustomSelect({ wrapId: "expSelectLiveWrap", btnId: "expBtn", listId: "expList", labelId: "expLabel", selectId: "expSelectLive" });
  state.setGateExp = wireCustomSelect({ wrapId: "gateExpWrap", btnId: "gateExpBtn", listId: "gateExpList", labelId: "gateExpLabel", selectId: "expSelect" });

  state.manifest = await loadManifest();
  state.manifestById = new Map(state.manifest.map((exp) => [exp.id, exp]));
  const initialId = normaliseExpId(state.manifest[0]?.id);
  state.activeExpId = initialId;

  populateSelect(expSelect, gateList, state.manifest, initialId);
  populateSelect(expSelectLive, liveList, state.manifest, initialId);

  if (state.setGateExp) state.setGateExp(initialId, false);
  if (state.setLiveExp) state.setLiveExp(initialId, false);
  try { renderExperienceMenu(); } catch {}
  try { setGateRole("guide"); } catch {}

  // Optional cinematic intro + 3D start hub
  // Default: ON. You can disable with ?intro=0 or ?skipIntro=1 or env VITE_INTRO_ENABLED=0
  try {
    const qs = getQS();
    const qsIntro = (qs.get('intro')||'').trim().toLowerCase();
    const skipIntro = qsIntro === '0' || qsIntro === 'false' || qsIntro === 'no' || qs.get('skipIntro') === '1';
    const envOn = String(import.meta?.env?.VITE_INTRO_ENABLED ?? '0') === '1';
    const introEnabled = !skipIntro && (qsIntro === '1' || envOn);
    const introMs = Math.max(0, Number(import.meta?.env?.VITE_INTRO_DURATION_MS) || 5000);
    if (introEnabled) {
      // Hide gate during intro
      if (gate) gate.style.display = 'none';
      if (startGate) startGate.style.display = 'none';
      try { dispatchEvent(new CustomEvent('loading:show', { detail: { label: 'Preparingâ€¦' } })); } catch {}
      try { console.info('[intro] enabled'); } catch {}
      const { runStartHub } = await import('./engine/start-hub.js');
      // Hide overlay before showing teaser + chips so it doesn't block input
      try { dispatchEvent(new CustomEvent('loading:hide')); } catch {}
      const res = await runStartHub({ expId: state.activeExpId, durationMs: introMs });
      const act = (res?.action || '').toLowerCase();
      if (act === 'host' || act === 'solo') {
        await startGuide();
        return;
      }
      // If skipped or invite, show start gate again
      if (startGate) {
        startGate.style.display = '';
        try { startGate.setAttribute('aria-hidden', 'false'); } catch {}
      }
      setExperienceLoaded(false);
    }
  } catch (e) {
    console.warn('[intro] failed', e);
    if (startGate) {
      startGate.style.display = '';
      try { startGate.setAttribute('aria-hidden', 'false'); } catch {}
    }
    setExperienceLoaded(false);
  }

  // Background prefetch of engine code on decent networks to speed first click
  try {
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const slow = /^(2g|slow-2g|3g)$/i.test(conn?.effectiveType || "");
    const save = Boolean(conn?.saveData);
    if (!slow && !save) {
      // Only prefetch viewer to avoid pulling agent bundle when not needed
      setTimeout(() => { import("./engine/viewer.js").catch(()=>{}); }, 600);
    }
  } catch {}

  // auto-start by querystring (iOS needs a user gesture)
  const qs = getQS();
  const wantRole = (qs.get('role')||'').toLowerCase();
  const qsExp = qs.get('exp');
  const qsRoom = qs.get('room');
  const flush = qs.get('flush') === '1';
  if (qsRoom) roomInput.value = qsRoom;
  if (qsExp && state.manifestById.has(qsExp)) {
    state.activeExpId = qsExp; state.setGateExp?.(qsExp,false); state.setLiveExp?.(qsExp,false);
  }
  // Ask SW (if active) to flush pano cache when requested
  if (flush) { try { navigator.serviceWorker?.controller?.postMessage({ type:'flush' }); } catch {} }
  if (wantRole === 'viewer' || wantRole === 'guide') {
    hideStartGate();
    if (gate) gate.style.display = 'none';
    const startFn = wantRole === 'viewer' ? startViewer : startGuide;
    if (IS_IOS) {
      try {
        const orient = document.documentElement.getAttribute('data-orient') || '';
        if (orient === 'portrait') {
          if (rotateOverlay) rotateOverlay.style.display = 'grid';
          if (tapStartBtn) {
            tapStartBtn.style.display = 'inline-block';
            tapStartBtn.onclick = async () => { await startFn(); if (rotateOverlay) rotateOverlay.style.display='none'; };
          }
          // Defer actual start until user taps
          return;
        }
      } catch {}
    }
    await startFn();
    return;
  }

  expSelect?.addEventListener("change", () => {
    const val = normaliseExpId(expSelect.value);
    syncActiveExperience(val, { syncGate: false, syncLive: false });
    if (state.setLiveExp) state.setLiveExp(val, false);
  });

  expSelectLive?.addEventListener("change", () => onLiveExperienceChange().catch(console.error));
  expDrawerToggle?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = expDrawer?.getAttribute("data-open") === "true";
    setExpDrawer(!open);
  });
  expDrawerClose?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setExpDrawer(false);
  });
  menuCloseExperience?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    try { finishExpBtn?.click(); } catch {}
    setExpDrawer(false);
  });
  document.addEventListener("click", (ev) => {
    if (!expDrawer || !expDrawerToggle) return;
    if (expDrawer.contains(ev.target) || expDrawerToggle.contains(ev.target)) return;
    setExpDrawer(false);
  });
  btnSelfExplore?.addEventListener("click", async () => {
    try {
      hideStartGate();
      if (gate) gate.style.display = 'none';
      await startGuide();
    } catch (err) { console.error('[self] start failed', err); }
  });
  btnGuided?.addEventListener("click", () => {
    hideStartGate();
    if (gate) gate.style.display = '';
    try { setGateRole("guide"); } catch {}
    try { roomInput?.focus(); } catch {}
  });
  btnGuide?.addEventListener("click", () => { try { setGateRole("guide"); } catch {} });
  btnViewer?.addEventListener("click", () => { try { setGateRole("viewer"); } catch {} });

  gateClose?.addEventListener("click", () => {
    try { if (gate) gate.style.display = "none"; } catch {}
    showStartGate();
  });

  roomInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    try { gateNext?.click(); } catch {}
  });

  gateNext?.addEventListener("click", async () => {
    try {
      if (getGateRole() === "viewer") {
        await startViewer();
      } else {
        await startGuide();
      }
    } catch (err) {
      console.error("[gate] start failed", err);
    }
  });

  holdRepeat(btnLeft, () => state.agentApi?.nudgeYaw?.(-STEP_YAW));
  holdRepeat(btnRight, () => state.agentApi?.nudgeYaw?.(STEP_YAW));
  holdRepeat(btnUp, () => state.agentApi?.nudgePitch?.(STEP_PITCH));
  holdRepeat(btnDown, () => state.agentApi?.nudgePitch?.(-STEP_PITCH));

  // Zoom (support both new and legacy ids)
  btnZoomIn?.addEventListener("click", () => state.agentApi?.adjustFov?.(-0.05));
  btnZoomOut?.addEventListener("click", () => state.agentApi?.adjustFov?.(0.05));
  zoomInLegacy?.addEventListener("click", () => state.agentApi?.adjustFov?.(-0.05));
  zoomOutLegacy?.addEventListener("click", () => state.agentApi?.adjustFov?.(0.05));

  // Minimap + Mirror + VR
  btnMini?.addEventListener("click", () => state.agentApi?.toggleMinimap?.());
  // Repurpose mirror button to swap primary/secondary views (normal vs mirror)
  btnMirror?.addEventListener("click", () => state.agentApi?.switchView?.());
  // Optional quick keys for mirror calibration in the field:
  //  - Shift+V toggles pitch sign
  //  - Shift+Y toggles yaw sign
  window.addEventListener('keydown', (e)=>{
    if (!e.shiftKey) return;
    if (e.key==='V' || e.key==='v'){
      state.agentApi?.toggleMirrorPitchSign?.();
      try{ const cur=Number(localStorage.getItem('mirrorPitchSign'))||1; localStorage.setItem('mirrorPitchSign', String(-cur)); }catch{}
    }
    if (e.key==='Y' || e.key==='y'){
      state.agentApi?.toggleMirrorYawSign?.();
      try{ const cur=Number(localStorage.getItem('mirrorYawSign'))||1; localStorage.setItem('mirrorYawSign', String(-cur)); }catch{}
    }
  });
  // Fullscreen button wiring is handled during bootstrap.

  // Tour controls
  function tourReady(){ return Boolean(state.tour); }
  async function ensureTour(){
    if (state.tour) return;
    const { createAutoplayController } = await import('./engine/autoplay.js');
    state.tour = createAutoplayController({ api: state.agentApi, dwellSec: 7, experiencesMeta: state.manifest });
    window.__tour = state.tour;
  }
  function updateToggle(){ try{ state._setTourToggleUI?.(Boolean(state.tour?.isPlaying?.() && state.tour.isPlaying())); }catch{} }
  tourToggleBtn?.addEventListener('click', async ()=>{
    try{
      const wasPlaying = Boolean(state.tour?.isPlaying?.() && state.tour.isPlaying());
      if (wasPlaying) { try { state._autoplayAudioStop?.(); } catch {} }
      else { try { state._autoplayAudioStart?.(); } catch {} }
      await ensureTour();
      if (!state.tour) return;
      if (state.tour.isPlaying && state.tour.isPlaying()) {
        state.tour.pause();
        try { state._autoplayAudioStop?.(); } catch {}
      }
      else {
        const idx = (typeof state.tour.getIndex === 'function') ? Number(state.tour.getIndex()) : -1;
        try { state._autoplayAudioStart?.(); } catch {}
        if (idx >= 0) { state.tour.resume(); }
        else { await state.tour.start(); }
      }
      updateToggle();
    } catch(e){ console.error('[tour] toggle failed', e); }
  });
  tourStopBtn?.addEventListener('click', ()=>{ if(tourReady()) try{ state._autoplayAudioStop?.(); state.tour.stop(); updateToggle(); }catch{} });
  addEventListener('tour:start', updateToggle);
  addEventListener('tour:resume', updateToggle);
  addEventListener('tour:pause', updateToggle);
  addEventListener('tour:stop', updateToggle);
  addEventListener('tour:complete', updateToggle);

  // Keyboard shortcuts (when Agent running): Space toggles, Esc stops
  window.addEventListener('keydown', (e)=>{
    if (isEditableTarget(e.target)) return;
    if (!state.agentApi) return;
    if (e.code==='Space') {
      e.preventDefault();
      try{
        if (state.tour?.isPlaying && state.tour.isPlaying()) { try { state._autoplayAudioStop?.(); } catch {} state.tour.pause(); }
        else {
          if (!state.tour) return; const idx = Number(state.tour.getIndex?.()||-1);
          try { state._autoplayAudioStart?.(); } catch {}
          if (idx>=0) state.tour.resume(); else state.tour.start();
        }
      }catch{}
    }
    if (e.key==='Escape'){ try{ state._autoplayAudioStop?.(); state.tour?.stop?.(); }catch{} }
  }, { passive:false });

  updateFSButtonVisibility();

  window.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) return;
    if (!state.agentApi) return;
    if (event.key === "ArrowLeft") state.agentApi.nudgeYaw?.(-STEP_YAW);
    if (event.key === "ArrowRight") state.agentApi.nudgeYaw?.(STEP_YAW);
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.agentApi.nudgePitch?.(STEP_PITCH);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.agentApi.nudgePitch?.(-STEP_PITCH);
    }
  }, { passive: false });
}

bootstrap().catch((err) => console.error("[app] bootstrap failed", err));
















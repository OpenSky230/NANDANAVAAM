/**
 * VR Tour Analytics Module
 * Tracks user behavior: location, time, views, engagement
 * 
 * SESSION-BASED: One row per user visit with all their activity
 * Includes periodic backup for VR/Quest where page unload events may not fire
 */

// Disable analytics on localhost/local IP to avoid rate limits during development
const IS_LOCALHOST = typeof window !== 'undefined' && (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  /^192\.168\./.test(window.location.hostname) ||
  /^10\./.test(window.location.hostname) ||
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(window.location.hostname)
);
const ANALYTICS_URL = String(import.meta?.env?.VITE_ANALYTICS_URL || '').trim();
const ANALYTICS_ENABLED =
  !IS_LOCALHOST &&
  ANALYTICS_URL.length > 0 &&
  String(import.meta?.env?.VITE_ANALYTICS_ENABLED ?? '1') !== '0';
const VR_API_ENABLED =
  !IS_LOCALHOST &&
  String(import.meta?.env?.VITE_VR_API_ENABLED ?? '1') !== '0';
const LOCAL_STORAGE_KEY = 'vr_tour_analytics';
const BACKUP_INTERVAL_MS = 300000; // Backup send every 5 minutes (reduced to avoid rate limits)
const INACTIVITY_TIMEOUT_MS = 600000; // 10 minutes of inactivity = auto-end session
const VR_FUNCTION_BASE = '/.netlify/functions/vr';

// Custom endpoint URL (set `VITE_ANALYTICS_URL` to enable; disabled by default)

class TourAnalytics {
  constructor() {
    this.sessionId = this.generateSessionId();
    this.sessionStart = Date.now();
    this.userId = this.getOrCreateUserId();
    this.userLocation = null;
    this.viewTimes = new Map(); // nodeId -> { enterTime, totalTime }
    this.zoneTimes = new Map(); // zoneId -> { enterTime, totalTime }
    this.experienceTimes = new Map(); // experienceId -> { enterTime, totalTime }
    this.currentNode = null;
    this.currentZone = null;
    this.currentExperience = null;
    this.isXR = false;
    this.xrTime = 0;
    this.xrEnterTime = null;
    const device = this.getDeviceSnapshot();
    this.deviceInfo = device.exact;
    this.deviceType = device.type;
    this.deviceOS = device.os;
    this.browserInfo = device.browser;
    this.projectName = this.getProjectName();
    this.role = this.getRole();
    this.feedback = null;
    this.navigationPath = []; // Track the path user takes
    this.lastSentTime = 0;
    this.sendCount = 0;
    this.rowCreated = false; // Track if initial row was created in sheet
    this.lastActivityTime = Date.now(); // Track last user activity
    this.inactivityTimer = null; // Timer for auto-ending session
    this.retryTimer = null;
    this.retryDelayMs = 0;

    // VR API session tracking (via Netlify function proxy)
    this.vrApiSessionId = null;
    this.vrApiStarted = false;
    this.vrApiCompleted = false;
    this.vrApiStartPromise = null;
    this.vrApiCompletePromise = null;
     
    // Get detailed location
    this.fetchUserLocation();
     
    if (ANALYTICS_ENABLED || VR_API_ENABLED) {
      // Send data when user leaves
      window.addEventListener('beforeunload', () => this.handleSessionEvent('unload'));
      window.addEventListener('pagehide', () => this.handleSessionEvent('pagehide'));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.handleSessionEvent('hidden');
      });

      // Periodic backup for VR/Quest (page unload events unreliable)
      // Only needed for the SheetDB uploader (VR API uses start/complete only).
      if (ANALYTICS_ENABLED) {
        this.backupInterval = setInterval(() => {
          // Only send backup if user has been active (has visited nodes)
          if (this.viewTimes.size > 0) {
            this.handleSessionEvent('backup');
          }
        }, BACKUP_INTERVAL_MS);
      }

      // Setup inactivity detection
      this.setupInactivityTimer();

      // Track user activity to reset inactivity timer
      const resetActivity = () => this.resetInactivityTimer();
      window.addEventListener('mousemove', resetActivity, { passive: true });
      window.addEventListener('keydown', resetActivity, { passive: true });
      window.addEventListener('touchstart', resetActivity, { passive: true });
      window.addEventListener('click', resetActivity, { passive: true });
    }
    
    if (ANALYTICS_ENABLED) {
      console.log('[Analytics] Session started:', this.sessionId, 'Device:', this.deviceInfo);
    } else {
      console.log('[Analytics] DISABLED (localhost/development mode) - Session:', this.sessionId);
    }
  }

  async handleSessionEvent(trigger = 'unknown') {
    const tasks = [];
    if (ANALYTICS_ENABLED) tasks.push(this.sendSessionData(trigger));
    if (VR_API_ENABLED) tasks.push(this.sendVrSessionData(trigger));
    if (tasks.length === 0) return;
    try { await Promise.allSettled(tasks); } catch {}
  }

  normalizeVrDevice() {
    const type = String(this.deviceType || '').toLowerCase();
    if (type.includes('vr')) return 'vr';
    if (type.includes('mobile')) return 'mobile';
    return 'desktop';
  }

  async ensureVrSessionStarted({ keepalive = false } = {}) {
    if (!VR_API_ENABLED) return;
    if (this.vrApiStarted) return;
    if (this.vrApiStartPromise) return this.vrApiStartPromise;

    this.vrApiStartPromise = (async () => {
      const payload = {
        digital_twin_id: this.currentExperience || this.projectName || 'unknown',
        user_id: this.userId,
        device: this.normalizeVrDevice(),
        city: this.userLocation?.area || 'Unknown',
        region: this.userLocation?.region || '',
        country: this.userLocation?.country || '',
      };

      let resp;
      try {
        resp = await fetch(`${VR_FUNCTION_BASE}/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: Boolean(keepalive),
        });
      } catch (e) {
        console.warn('[VR API] Start call failed:', e?.message || e);
        return;
      }

      if (!resp.ok) {
        let bodyText = '';
        try { bodyText = (await resp.text())?.slice(0, 300) || ''; } catch {}
        console.warn('[VR API] Start call non-200:', resp.status, bodyText);
        return;
      }

      let data = null;
      try {
        const json = await resp.json();
        data = json?.data ?? json;
      } catch {
        data = null;
      }

      const sessionId =
        data?.session_id ||
        data?.sessionId ||
        data?.id ||
        null;

      this.vrApiSessionId = sessionId || this.vrApiSessionId || null;
      this.vrApiStarted = true;
      console.log('[VR API] Session started', this.vrApiSessionId ? `(${this.vrApiSessionId})` : '');
    })();

    try {
      await this.vrApiStartPromise;
    } finally {
      this.vrApiStartPromise = null;
    }
  }

  async ensureVrSessionCompleted({ trigger = 'unknown', keepalive = false } = {}) {
    if (!VR_API_ENABLED) return;
    if (!this.vrApiStarted || this.vrApiCompleted) return;
    if (this.vrApiCompletePromise) return this.vrApiCompletePromise;

    this.vrApiCompletePromise = (async () => {
      const now = Date.now();
      const totalDurationSeconds = Math.max(0, Math.round((now - this.sessionStart) / 1000));
      const payload = {
        session_id: this.vrApiSessionId || this.sessionId,
        total_duration: totalDurationSeconds,
        used_vr: Boolean(this.xrTime > 0 || this.isXR),
      };

      try {
        const resp = await fetch(`${VR_FUNCTION_BASE}/session/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: Boolean(keepalive),
        });

        if (!resp.ok) {
          let bodyText = '';
          try { bodyText = (await resp.text())?.slice(0, 300) || ''; } catch {}
          console.warn('[VR API] Complete call non-200:', resp.status, bodyText);
          return;
        }

        this.vrApiCompleted = true;
        console.log(`[VR API] Session completed (${trigger})`);
      } catch (e) {
        console.warn('[VR API] Complete call failed:', e?.message || e);
      }
    })();

    try {
      await this.vrApiCompletePromise;
    } finally {
      this.vrApiCompletePromise = null;
    }
  }

  async sendVrSessionData(trigger = 'unknown') {
    if (!VR_API_ENABLED) return;

    if (trigger === 'session_start') {
      await this.ensureVrSessionStarted({ keepalive: false });
      return;
    }

    const isFinalTrigger =
      trigger === 'unload' ||
      trigger === 'pagehide' ||
      trigger === 'hidden' ||
      trigger === 'finished' ||
      trigger === 'inactivity_timeout';

    if (isFinalTrigger) {
      await this.ensureVrSessionCompleted({ trigger, keepalive: true });
    }
  }
  
  generateSessionId() {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }
  
  getOrCreateUserId() {
    try {
      let visitorNum = localStorage.getItem('vr_tour_visitor_num');
      if (!visitorNum || visitorNum === 'undefined' || visitorNum === 'null') {
        // Generate a robust visitor number
        visitorNum = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('vr_tour_visitor_num', visitorNum);
      }
      return 'visitor_' + visitorNum;
    } catch {
      return 'visitor_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
  }
  
  getDeviceSnapshot() {
    const ua = (navigator.userAgent || '');
    const uaLower = ua.toLowerCase();
    const uaData = navigator.userAgentData;
    const platform = String(uaData?.platform || navigator.platform || '').toLowerCase();
    const isMobile = Boolean(uaData?.mobile) || /mobi|android|iphone|ipad|ipod/.test(uaLower);

    let type = 'Desktop';
    let exact = 'Desktop';

    // VR headsets (be as specific as possible)
    if (/quest|oculus|vive|valve|index|windows mixed reality|xrspace|pico/.test(uaLower)) {
      type = 'VR';
      if (/quest\s*3/.test(uaLower)) exact = 'Meta Quest 3 VR';
      else if (/quest\s*2/.test(uaLower)) exact = 'Meta Quest 2 VR';
      else if (/quest|oculus/.test(uaLower)) exact = 'Meta Quest VR';
      else if (/pico\s*4/.test(uaLower)) exact = 'Pico 4 VR';
      else if (/pico/.test(uaLower)) exact = 'Pico VR';
      else if (/vive/.test(uaLower)) exact = 'HTC Vive VR';
      else if (/valve|index/.test(uaLower)) exact = 'Valve Index VR';
      else if (/windows mixed reality/.test(uaLower)) exact = 'Windows Mixed Reality VR';
      else exact = 'VR Headset';
    } else if (isMobile) {
      type = 'Mobile';
      if (/ipad/.test(uaLower) || (platform.includes('mac') && 'ontouchend' in window)) exact = 'iPad';
      else if (/iphone/.test(uaLower)) exact = 'iPhone';
      else if (/android/.test(uaLower)) {
        exact = /tablet|sm-t|tab|nexus 7|nexus 9/.test(uaLower) ? 'Android Tablet' : 'Android Phone';
      } else {
        exact = 'Mobile Device';
      }
    } else {
      type = 'Desktop';
      if (platform.includes('win')) exact = 'Windows Desktop';
      else if (platform.includes('mac')) exact = 'Mac Desktop';
      else if (platform.includes('linux')) exact = 'Linux Desktop';
      else exact = 'Desktop';
    }

    let os = 'Unknown';
    if (/android/.test(uaLower)) os = 'Android';
    else if (/iphone|ipad|ipod|ios/.test(uaLower)) os = 'iOS';
    else if (platform.includes('win')) os = 'Windows';
    else if (platform.includes('mac')) os = 'macOS';
    else if (platform.includes('linux')) os = 'Linux';

    let browser = 'Unknown';
    if (/edg\//.test(uaLower)) browser = 'Edge';
    else if ((/chrome|crios/.test(uaLower)) && !/edg\//.test(uaLower)) browser = 'Chrome';
    else if (/firefox|fxios/.test(uaLower)) browser = 'Firefox';
    else if (/safari/.test(uaLower) && !/chrome|crios|android/.test(uaLower)) browser = 'Safari';

    return { type, exact, os, browser };
  }

  getProjectName() {
    try {
      const qs = new URLSearchParams(location.search);
      const fromQs =
        qs.get('project') ||
        qs.get('projectName') ||
        qs.get('property') ||
        qs.get('propertyName') ||
        qs.get('digitalTwinName') ||
        qs.get('digitalTwinId') ||
        qs.get('roomId');
      const envName = import.meta?.env?.VITE_PROJECT_NAME;
      const title = document?.title;
      return String(fromQs || envName || title || '').trim() || 'Unknown';
    } catch {
      return String(import.meta?.env?.VITE_PROJECT_NAME || document?.title || 'Unknown').trim();
    }
  }

  getRole() {
    try {
      const role = document?.body?.getAttribute?.('data-role') || '';
      return String(role || '').trim() || 'viewer';
    } catch { return 'viewer'; }
  }

  setupInactivityTimer() {
    this.resetInactivityTimer();
  }

  resetInactivityTimer() {
    this.lastActivityTime = Date.now();

    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    // Set new timer to auto-end session after inactivity
    this.inactivityTimer = setTimeout(() => {
      console.log('[Analytics] Session ended due to inactivity');

      // Clear timers
      if (this.backupInterval) {
        clearInterval(this.backupInterval);
        this.backupInterval = null;
      }

      // Send final update
      this.handleSessionEvent('inactivity_timeout');
    }, INACTIVITY_TIMEOUT_MS);
  }
  
  async fetchUserLocation() {
    // Try browser geolocation first for precise locality
    try {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async (pos) => {
          const { latitude, longitude } = pos.coords;
          // Use Nominatim reverse geocoding for locality (no API key, but rate-limited)
          try {
            const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`;
            const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
            if (resp.ok) {
              const geo = await resp.json();
              this.userLocation = {
                area: geo.address?.suburb || geo.address?.neighbourhood || geo.address?.city || geo.address?.town || geo.address?.village || 'Unknown',
                region: geo.address?.state || '',
                country: geo.address?.country || '',
                postal: geo.address?.postcode || '',
                latitude,
                longitude,
                ip: ''
              };
              console.log('[Analytics] Geolocation (browser):', this.userLocation.area, this.userLocation.region);
              return;
            }
          } catch (e) {
            console.warn('[Analytics] Reverse geocoding failed:', e.message);
          }
        }, (err) => {
          // Fallback to IP-based if denied
          this.fetchUserLocationByIP();
        }, { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
        return;
      }
    } catch (e) {
      console.warn('[Analytics] Geolocation error:', e.message);
    }
    // Fallback to IP-based location
    this.fetchUserLocationByIP();
  }

  // Fallback: IP-based location
  async fetchUserLocationByIP() {
    try {
      const response = await fetch('https://ipapi.co/json/', { 
        method: 'GET',
        cache: 'no-cache'
      });
      if (response.ok) {
        const data = await response.json();
        this.userLocation = {
          area: data.city || 'Unknown',
          region: data.region || '',
          country: data.country_name || '',
          postal: data.postal || '',
          latitude: data.latitude,
          longitude: data.longitude,
          ip: data.ip
        };
        console.log('[Analytics] Location (IP):', this.userLocation.area, this.userLocation.region);
      }
    } catch (e) {
      console.warn('[Analytics] Could not fetch IP location:', e.message);
      this.userLocation = { area: 'Unknown', region: '', country: '' };
    }
  }
  
  // Called when user enters a new panorama node
  enterNode(nodeId, nodeName, zoneId, zoneName) {
    const now = Date.now();

    // Reset inactivity timer - user is active
    this.resetInactivityTimer();

    // Exit previous node
    if (this.currentNode && this.viewTimes.has(this.currentNode)) {
      const prev = this.viewTimes.get(this.currentNode);
      prev.totalTime += now - prev.enterTime;
    }

    // Enter new node
    if (!this.viewTimes.has(nodeId)) {
      this.viewTimes.set(nodeId, {
        nodeId,
        nodeName: nodeName || nodeId,
        zoneId,
        zoneName,
        enterTime: now,
        totalTime: 0,
        visitCount: 0
      });
    }

    const nodeData = this.viewTimes.get(nodeId);
    nodeData.enterTime = now;
    nodeData.visitCount++;
    this.currentNode = nodeId;

    // Track navigation path
    this.navigationPath.push({ node: nodeId, zone: zoneId, time: now });

    // Track zone change
    if (zoneId !== this.currentZone) {
      this.enterZone(zoneId, zoneName);
    }

    // Send initial session data when user enters the first node
    if (this.viewTimes.size === 1 && this.sendCount === 0) {
      // Wait a few seconds to ensure location data has loaded, then send initial update
      setTimeout(() => {
        this.handleSessionEvent('session_start');
      }, 3000);
    }
  }
  
  // Called when user enters a new zone
  enterZone(zoneId, zoneName) {
    const now = Date.now();
    
    // Exit previous zone
    if (this.currentZone && this.zoneTimes.has(this.currentZone)) {
      const prev = this.zoneTimes.get(this.currentZone);
      prev.totalTime += now - prev.enterTime;
    }
    
    // Enter new zone
    if (!this.zoneTimes.has(zoneId)) {
      this.zoneTimes.set(zoneId, {
        zoneId,
        zoneName: zoneName || zoneId,
        enterTime: now,
        totalTime: 0,
        visitCount: 0
      });
    }
    
    const zoneData = this.zoneTimes.get(zoneId);
    zoneData.enterTime = now;
    zoneData.visitCount++;
    this.currentZone = zoneId;
  }
  
  // Called when experience changes
  setExperience(experienceId, experienceName) {
    const now = Date.now();
    
    // Exit previous experience
    if (this.currentExperience && this.experienceTimes.has(this.currentExperience)) {
      const prev = this.experienceTimes.get(this.currentExperience);
      prev.totalTime += now - prev.enterTime;
    }
    
    // Enter new experience
    if (!this.experienceTimes.has(experienceId)) {
      this.experienceTimes.set(experienceId, {
        experienceId,
        experienceName: experienceName || experienceId,
        enterTime: now,
        totalTime: 0
      });
    }
    
    const expData = this.experienceTimes.get(experienceId);
    expData.enterTime = now;
    this.currentExperience = experienceId;
  }
  
  // Called when XR mode changes
  setXRMode(isXR) {
    const now = Date.now();
    if (isXR && !this.isXR) {
      // Entering XR
      this.xrEnterTime = now;
      this.deviceType = 'VR';
      if (this.deviceInfo && !/vr/i.test(this.deviceInfo)) {
        this.deviceInfo = `${this.deviceInfo} (VR)`;
      }
      console.log('[Analytics] Entered VR mode');
    } else if (!isXR && this.isXR && this.xrEnterTime) {
      // Exiting XR - send session data as VR session might be ending
      this.xrTime += now - this.xrEnterTime;
      this.xrEnterTime = null;
      console.log('[Analytics] Exited VR mode, VR time:', this.formatDuration(this.xrTime));
      // Send data when exiting VR as headset removal often doesn't trigger unload
      this.handleSessionEvent('xr_exit');
    }
    this.isXR = isXR;
  }
  
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
  
  // Finalize all timing data
  finalizeTimes() {
    const now = Date.now();
    const sessionEnd = Math.max(now, this.sessionStart);
    // Helper to cap and sanitize time
    function safeAddTime(obj, field, addMs, maxMs) {
      if (!obj) return;
      if (typeof addMs !== 'number' || isNaN(addMs) || addMs < 0) addMs = 0;
      obj[field] = Math.max(0, Math.min((obj[field] || 0) + addMs, maxMs));
    }
    const maxSessionMs = sessionEnd - this.sessionStart;
    // Finalize current node
    if (this.currentNode && this.viewTimes.has(this.currentNode)) {
      const curr = this.viewTimes.get(this.currentNode);
      safeAddTime(curr, 'totalTime', now - curr.enterTime, maxSessionMs);
    }
    // Finalize current zone
    if (this.currentZone && this.zoneTimes.has(this.currentZone)) {
      const curr = this.zoneTimes.get(this.currentZone);
      safeAddTime(curr, 'totalTime', now - curr.enterTime, maxSessionMs);
    }
    // Finalize current experience
    if (this.currentExperience && this.experienceTimes.has(this.currentExperience)) {
      const curr = this.experienceTimes.get(this.currentExperience);
      safeAddTime(curr, 'totalTime', now - curr.enterTime, maxSessionMs);
    }
    // Finalize XR time
    if (this.isXR && this.xrEnterTime) {
      this.xrTime += now - this.xrEnterTime;
      if (this.xrTime > maxSessionMs) this.xrTime = maxSessionMs;
    }
    // Cap all totals to session duration
    for (const v of this.viewTimes.values()) {
      if (v.totalTime > maxSessionMs) v.totalTime = maxSessionMs;
    }
    for (const z of this.zoneTimes.values()) {
      if (z.totalTime > maxSessionMs) z.totalTime = maxSessionMs;
    }
    for (const e of this.experienceTimes.values()) {
      if (e.totalTime > maxSessionMs) e.totalTime = maxSessionMs;
    }
    if (this.xrTime > maxSessionMs) this.xrTime = maxSessionMs;
  }
  
  // Send session data to Google Sheet
  // trigger: 'backup' | 'unload' | 'pagehide' | 'hidden' | 'xr_exit' | 'finished' | 'feedback_submitted'
  async sendSessionData(trigger = 'unknown') {
    if (!ANALYTICS_ENABLED) return;

    const now = Date.now();
    const totalDuration = now - this.sessionStart;

    // Skip if session too short (less than 5 seconds) unless trigger is important
    const allowShortTriggers = new Set([
      'backup', 'session_start', 'xr_exit', 'finished',
      'feedback_submitted', 'unload', 'pagehide', 'hidden', 'inactivity_timeout'
    ]);
    if (totalDuration < 5000 && !allowShortTriggers.has(trigger)) return;

    // For very frequent events, limit send rate to avoid spam (once per 3 minutes max)
    const timeSinceLastSend = now - this.lastSentTime;
    if (trigger === 'backup' && timeSinceLastSend < 180000) {
      console.log('[Analytics] Skipping backup send (too soon since last send)');
      return;
    }
    // Send analytics for all triggers (not just finished/feedback)
    this.lastSentTime = now;
    this.sendCount++;
    this.finalizeTimes();
    
    // Sort zones by time spent
    const zonesByTime = Array.from(this.zoneTimes.values())
      .sort((a, b) => b.totalTime - a.totalTime);
    
    // Sort experiences by time spent
    const experiencesByTime = Array.from(this.experienceTimes.values())
      .sort((a, b) => b.totalTime - a.totalTime);
    
    // Build zone breakdown string: "Zone1 (2m 30s), Zone2 (1m 15s)"
    const zoneBreakdown = zonesByTime
      .map(z => `${z.zoneName} (${this.formatDuration(z.totalTime)})`)
      .join(', ');
    
    // Build experience breakdown string
    const experienceBreakdown = experiencesByTime
      .map(e => `${e.experienceName} (${this.formatDuration(e.totalTime)})`)
      .join(', ');
    
    // List all experiences visited
    const experiencesVisited = Array.from(this.experienceTimes.keys()).join(', ');
    
    // List all zones visited  
    const zonesVisited = Array.from(this.zoneTimes.values())
      .map(z => z.zoneName)
      .join(', ');
    
    // Add readable local timestamp in IST (primary), keep UTC for reference
    const istDate = new Date(this.sessionStart).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const timestampUtc = new Date(this.sessionStart).toISOString();
    const currentExpEntry = this.currentExperience ? this.experienceTimes.get(this.currentExperience) : null;
    const currentExperienceName =
      currentExpEntry?.experienceName ||
      this.currentExperience ||
      experiencesByTime[0]?.experienceName ||
      'unknown';
    const row = {
      timestamp: istDate,
      timestamp_utc: timestampUtc,
      local_time_ist: istDate,
      session_id: this.sessionId,
      user_id: this.userId,
      project_name: this.projectName,
      // Compatibility with Sheets/SheetDB column naming variations
      projectName: this.projectName,
      'project name': this.projectName,
      project: this.projectName,
      role: this.role,
      city: this.userLocation?.area || 'Unknown',
      region: this.userLocation?.region || '',
      country: this.userLocation?.country || '',
      device: this.deviceInfo,
      device_type: this.deviceType,
      device_os: this.deviceOS,
      browser: this.browserInfo,
      total_duration: this.formatDuration(totalDuration),
      current_experience: currentExperienceName,
      experiences_visited: experiencesVisited || 'None',
      experience_times: experienceBreakdown || 'None',
      zones_visited: zonesVisited || 'None',
      zone_times: zoneBreakdown || 'None',
      most_viewed_zone: zonesByTime[0]?.zoneName || 'None',
      most_viewed_time: zonesByTime[0] ? this.formatDuration(zonesByTime[0].totalTime) : '0s',
      total_nodes: this.viewTimes.size,
      used_vr: (this.xrTime > 0 || this.isXR) ? 'Yes' : 'No',
      vr_time: this.formatDuration(this.xrTime),
      trigger: trigger
    };

    // Merge feedback into the same session row when present
    if (this.feedback) {
      row.rating = this.feedback.rating ?? 0;
      row.best_experience = this.feedback.bestExperience || '';
      row.would_visit_in_person = this.feedback.wouldVisitInPerson || '';
      row.feedback_comments = (this.feedback.comments || '').substring(0, 500);
      row.feedback_experience = this.feedback.experienceId || currentExperienceName;
      row.feedback_submitted_at_ist = this.feedback.submittedAtIst || '';
      row.feedback_submitted_at_utc = this.feedback.submittedAtUtc || '';
    }
    
    console.log(`[Analytics] Sending (${trigger}, #${this.sendCount}):`, row);

    // Use keepalive for unload/pagehide/hidden events to ensure data sends even if page closes
    const isFinalEvent = trigger === 'unload' || trigger === 'pagehide' || trigger === 'hidden' || trigger === 'finished' || trigger === 'inactivity_timeout';

    try {
      let response;

      // First send: CREATE row with POST
      // Subsequent sends: UPDATE row with PATCH
      if (!this.rowCreated) {
        // Create new row
        response = await fetch(ANALYTICS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [row] }),
          keepalive: isFinalEvent
        });

        if (response.ok) {
          this.rowCreated = true;
          console.log('[Analytics] ✓ Session row created in sheet');
        }
      } else {
        // Update existing row by session_id
        // SheetDB PATCH endpoint: /api/v1/{id}/session_id/{value}
        const updateUrl = `${ANALYTICS_URL}/session_id/${this.sessionId}`;
        response = await fetch(updateUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: row }),
          keepalive: isFinalEvent
        });

        if (response.ok) {
          console.log('[Analytics] ✓ Session row updated in sheet');
        }
      }

      if (!response.ok) {
        const status = Number(response.status) || 0;
        let bodyText = '';
        try { bodyText = (await response.text())?.slice(0, 300) || ''; } catch {}

        // SheetDB rate limits can return 429; back off and retry later.
        if (status === 429 || (status >= 500 && status <= 599)) {
          try { console.warn('[Analytics] Send rate-limited/server error:', status, bodyText); } catch {}
          this.scheduleRetry(row, trigger, status);
          return;
        }

        console.error('[Analytics] Failed to send:', status, bodyText);
      } else {
        // Successful send: clear retry state
        if (this.retryTimer) { try { clearTimeout(this.retryTimer); } catch {} this.retryTimer = null; }
        this.retryDelayMs = 0;
      }
    } catch (e) {
      console.warn('[Analytics] Send error:', e.message);
      // Save to localStorage as backup
      try {
        const stored = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
        stored.push(row);
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stored.slice(-20)));
      } catch {}
      // Network errors: retry with backoff
      this.scheduleRetry(row, trigger, 0);
    }
  }

  scheduleRetry(row, trigger, status = 0) {
    try {
      // Persist the latest row snapshot so we don't lose analytics.
      const stored = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
      stored.push({ ...row, trigger: `retry_pending:${trigger}`, retry_status: status || '' });
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stored.slice(-20)));
    } catch {}

    // Exponential backoff with cap (avoid spamming SheetDB)
    const base = 30000; // 30s
    const next = this.retryDelayMs ? Math.min(this.retryDelayMs * 2, 10 * 60 * 1000) : base;
    this.retryDelayMs = next;

    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Re-send the latest snapshot (not a new session start)
      try { void this.sendSessionData('retry'); } catch {}
    }, this.retryDelayMs);
  }
  
  // Get summary for console viewing
  getSummary() {
    this.finalizeTimes();
    const now = Date.now();
    
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      projectName: this.projectName,
      role: this.role,
      duration: this.formatDuration(now - this.sessionStart),
      location: this.userLocation,
      device: this.deviceInfo,
      deviceType: this.deviceType,
      deviceOS: this.deviceOS,
      browser: this.browserInfo,
      experiences: Array.from(this.experienceTimes.values()),
      zones: Array.from(this.zoneTimes.values()),
      nodes: Array.from(this.viewTimes.values()),
      vrTime: this.formatDuration(this.xrTime),
      feedback: this.feedback
    };
  }
}

// Singleton instance
let analyticsInstance = null;

export function getAnalytics() {
  if (!analyticsInstance) {
    analyticsInstance = new TourAnalytics();
  }
  return analyticsInstance;
}

export function trackNodeVisit(nodeId, nodeName, zoneId, zoneName) {
  getAnalytics().enterNode(nodeId, nodeName, zoneId, zoneName);
}

export function trackZoneVisit(zoneId, zoneName) {
  getAnalytics().enterZone(zoneId, zoneName);
}

export function trackExperience(experienceId, experienceName) {
  getAnalytics().setExperience(experienceId, experienceName);
}

export function trackXRMode(isXR) {
  getAnalytics().setXRMode(isXR);
}

export function trackHotspot(fromNode, toNode, type) {
  // Not needed for session-based tracking
}

export function trackInteraction(type, details) {
  // Not needed for session-based tracking
}

/**
 * Track feedback submission when user finishes the experience
 * @param {Object} feedbackData - Feedback form data
 * @param {number} feedbackData.rating - Star rating 1-5
 * @param {string} feedbackData.bestExperience - Which experience gave best insights
 * @param {string} feedbackData.wouldVisitInPerson - 'yes' or 'no'
 * @param {string} feedbackData.comments - User's comments on immersive view
 * @param {string} experienceId - The current experience being rated
 */
export function trackFeedback(feedbackData, experienceId) {
  const analytics = getAnalytics();
  analytics.finalizeTimes();
  
  const now = Date.now();
  const totalDuration = now - analytics.sessionStart;
  
  // Handle both old format (rating, comment, expId) and new format (object, expId)
  let rating = 0;
  let bestExperience = '';
  let wouldVisitInPerson = '';
  let comments = '';
  
  if (typeof feedbackData === 'object' && feedbackData !== null) {
    rating = feedbackData.rating || 0;
    bestExperience = feedbackData.bestExperience || '';
    wouldVisitInPerson = feedbackData.wouldVisitInPerson || '';
    comments = feedbackData.comments || '';
  } else {
    // Legacy format: trackFeedback(rating, comment, expId)
    rating = feedbackData || 0;
    comments = experienceId || '';
    experienceId = arguments[2] || '';
  }
  
  // Merge feedback into the current session row (no separate row)
  analytics.feedback = {
    rating,
    bestExperience,
    wouldVisitInPerson,
    comments,
    experienceId: experienceId || analytics.currentExperience || 'unknown',
    submittedAtUtc: new Date().toISOString(),
    submittedAtIst: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
  };

  console.log('[Analytics] Feedback captured (merged into session):', analytics.feedback);
  return analytics.feedback;

  // Get zone breakdown
  const zonesByTime = Array.from(analytics.zoneTimes.values())
    .sort((a, b) => b.totalTime - a.totalTime);
  const zoneBreakdown = zonesByTime
    .map(z => `${z.zoneName} (${analytics.formatDuration(z.totalTime)})`)
    .join(', ');
  const zonesVisited = Array.from(analytics.zoneTimes.values())
    .map(z => z.zoneName)
    .join(', ');
  
  // Get experience breakdown
  const experiencesByTime = Array.from(analytics.experienceTimes.values())
    .sort((a, b) => b.totalTime - a.totalTime);
  const experienceBreakdown = experiencesByTime
    .map(e => `${e.experienceName} (${analytics.formatDuration(e.totalTime)})`)
    .join(', ');
  const experiencesVisited = Array.from(analytics.experienceTimes.keys()).join(', ');
  
  // Build complete feedback row matching the analytics sheet format
  // session_id and current_experience are always included for joinability
  const feedbackRow = {
    // Add readable local timestamp in IST
    timestamp: new Date().toISOString(),
    local_time_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
    session_id: analytics.sessionId,
    user_id: analytics.userId,
    type: 'feedback',
    // Feedback-specific fields
    rating: rating,
    best_experience: bestExperience,
    would_visit_in_person: wouldVisitInPerson,
    feedback_comments: (comments || '').substring(0, 500),
    // Session context
    current_experience: experienceId || analytics.currentExperience || 'unknown',
    city: analytics.userLocation?.area || 'Unknown',
    region: analytics.userLocation?.region || '',
    country: analytics.userLocation?.country || '',
    device: analytics.deviceInfo,
    total_duration: analytics.formatDuration(totalDuration),
    total_duration_seconds: Math.floor(totalDuration / 1000),
    experiences_visited: experiencesVisited || 'None',
    experience_times: experienceBreakdown || 'None',
    zones_visited: zonesVisited || 'None',
    zone_times: zoneBreakdown || 'None',
    most_viewed_zone: zonesByTime[0]?.zoneName || 'None',
    most_viewed_time: zonesByTime[0] ? analytics.formatDuration(zonesByTime[0].totalTime) : '0s',
    total_nodes: analytics.viewTimes.size,
    used_vr: (analytics.xrTime > 0 || analytics.isXR) ? 'Yes' : 'No',
    vr_time: analytics.formatDuration(analytics.xrTime),
    trigger: 'feedback_submitted'
  };
  
  console.log('[Analytics] Feedback submitted:', feedbackRow);
  
  // Send feedback to SheetDB
  if (ANALYTICS_ENABLED && ANALYTICS_URL) {
    try {
      fetch(ANALYTICS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [feedbackRow] }),
        keepalive: true
      }).then(res => {
        if (res.ok) {
          console.log('[Analytics] ✓ Feedback sent successfully');
        } else {
          console.warn('[Analytics] Feedback send failed:', res.status);
        }
      }).catch(err => console.warn('[Analytics] Feedback send error:', err));
    } catch (e) {
      console.warn('[Analytics] Feedback tracking error:', e);
    }
  }
  
  return feedbackRow;
}

/**
 * End the experience and send final analytics
 */
export function endExperience() {
  const analytics = getAnalytics();

  // Clear inactivity timer since user explicitly ended session
  if (analytics.inactivityTimer) {
    clearTimeout(analytics.inactivityTimer);
    analytics.inactivityTimer = null;
  }

  // Clear backup interval
  if (analytics.backupInterval) {
    clearInterval(analytics.backupInterval);
    analytics.backupInterval = null;
  }

  analytics.handleSessionEvent('finished');
  console.log('[Analytics] Experience ended');
}

export function getAnalyticsSummary() {
  return getAnalytics().getSummary();
}

export function exportAnalytics() {
  console.log(getAnalytics().getSummary());
}

// Expose to window for console access
if (typeof window !== 'undefined') {
  window.vrAnalytics = {
    getSummary: () => getAnalytics().getSummary(),
    sendNow: () => getAnalytics().handleSessionEvent('manual'),
    trackFeedback: trackFeedback,
    endExperience: endExperience
  };
}

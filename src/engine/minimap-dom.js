/* -------- minimap-dom.js -------- */

export async function loadWalkthrough(url = "./walkthrough.json") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`walkthrough.json fetch failed: ${r.status} ${r.statusText}`);
  let raw;
  try { raw = await r.json(); } catch { throw new Error("walkthrough.json is not valid JSON"); }

  const candidate = (raw && (raw.data || raw.project)) || raw || {};
  const floors = Array.isArray(candidate.floors) ? candidate.floors : [];
  const nodesIn = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const zonesIn = Array.isArray(candidate.zones) ? candidate.zones : [];

  const nodes = nodesIn.map((n, i) => {
    const id =
      (typeof n.id === "string" && n.id) ||
      (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `node-${i + 1}`);
    const nameRaw =
      (typeof n?.name === "string" && n.name.trim()) ? n.name.trim()
      : ((typeof n?.label === "string" && n.label.trim()) ? n.label.trim()
      : ((typeof n?.title === "string" && n.title.trim()) ? n.title.trim() : ""));
    const hotspots = Array.isArray(n.hotspots)
      ? n.hotspots.map(h => ({
          to: h?.to,
          type: h?.type || "walk",
          // Prefer absolute angles if provided by the authoring tool
          yaw: typeof h?.absYaw === "number" ? h.absYaw : (typeof h?.yaw === "number" ? h.yaw : 0),
          pitch: typeof h?.absPitch === "number" ? h.absPitch : (typeof h?.pitch === "number" ? h.pitch : 0),
          // Preserve authored direction vector for exact placement if available
          dir: Array.isArray(h?.dir) ? h.dir.slice(0,3) : undefined,
          // Keep UV if needed in future for UI hinting (not used for placement)
          uv: Array.isArray(h?.uv) ? h.uv.slice(0,2) : undefined,
        }))
      : [];
    return {
      id,
      file: n?.file ?? "",
      floorId: n?.floorId ?? (floors[0]?.id || "floor-1"),
      x: typeof n?.x === "number" ? n.x : 0,
      y: typeof n?.y === "number" ? n.y : 0,
      z: typeof n?.z === "number" ? n.z : 0,
      yaw: typeof n?.yaw === "number" ? n.yaw : 0,
      zoneId: (typeof n?.zoneId === "string" && n.zoneId) ? n.zoneId : undefined,
      // Optional display names for UI/hotspot labels (e.g., "Wardrobe", "Toilet").
      name: nameRaw || undefined,
      label: (typeof n?.label === "string" && n.label.trim()) ? n.label.trim() : undefined,
      hotspots,
    };
  });

  // Normalize zones (optional)
  const zones = zonesIn.map((z, i) => {
    const id = (typeof z?.id === "string" && z.id) || `zone-${i + 1}`;
    const floorId = z?.floorId ?? (floors[0]?.id || "floor-1");
    const points = Array.isArray(z?.points)
      ? z.points.map(p => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 }))
      : [];

    // Support both repPoint {x,y} and legacy pinX/pinY as the representative
    // hotspot position for this zone on the floorplan/minimap.
    let repPoint = undefined;
    const repX = z && typeof z === "object"
      ? (z.repPoint && Number.isFinite(Number(z.repPoint.x))
          ? Number(z.repPoint.x)
          : Number.isFinite(Number(z.pinX)) ? Number(z.pinX) : null)
      : null;
    const repY = z && typeof z === "object"
      ? (z.repPoint && Number.isFinite(Number(z.repPoint.y))
          ? Number(z.repPoint.y)
          : Number.isFinite(Number(z.pinY)) ? Number(z.pinY) : null)
      : null;
    if (repX !== null && repY !== null) {
      repPoint = { x: repX, y: repY };
    }

    return {
      id,
      name: (typeof z?.name === "string" ? z.name : id),
      floorId,
      repNodeId: (typeof z?.repNodeId === "string" ? z.repNodeId : null),
      points,
      repPoint,
    };
  });

  const nodesById = new Map(nodes.map(n => [n.id, n]));
  let startNodeId = candidate.startNodeId;
  if (!startNodeId || !nodesById.has(startNodeId)) startNodeId = nodes[0]?.id ?? null;

  // Layout Walkthrough: some authoring exports contain duplicate "road" images inside balcony/terrace
  // zones, causing users to "return" onto a different node with missing links. Fix by canonicalizing
  // walk-hotspot targets by pano file so returning always lands on the canonical node for that image.
  try {
    const u = String(url || "").toLowerCase();
    const isLayoutWalkthrough = u.includes("layoutwalkthrough");
    if (isLayoutWalkthrough) {
      const zoneNameById = new Map(zones.map((z) => [String(z?.id || ""), String(z?.name || "")]));
      const isBalconyTerraceZone = (zoneId) => {
        const name = zoneNameById.get(String(zoneId || "")) || "";
        return /balcony|terrace/i.test(name);
      };
      const scoreNode = (n) => {
        const zid = n?.zoneId ? String(n.zoneId) : "";
        const zname = zid ? (zoneNameById.get(zid) || "") : "";
        let score = 0;
        if (zid) score += 10;
        if (/road/i.test(zname)) score += 250;
        if (zid && !isBalconyTerraceZone(zid)) score += 120;
        if (zid && isBalconyTerraceZone(zid)) score -= 200;
        if (!zid) score += 60;
        return score;
      };

      const canonicalIdByFile = new Map(); // file -> nodeId
      const canonicalScoreByFile = new Map(); // file -> score
      for (const n of nodes) {
        const f = String(n?.file || "").trim();
        if (!f) continue;
        const s = scoreNode(n);
        const prevS = canonicalScoreByFile.get(f);
        if (prevS === undefined || s > prevS) {
          canonicalScoreByFile.set(f, s);
          canonicalIdByFile.set(f, n.id);
        }
      }

      for (const n of nodes) {
        const hs = Array.isArray(n.hotspots) ? n.hotspots : [];
        for (const h of hs) {
          const kind = String(h?.type || "walk").toLowerCase();
          if (kind === "zone") continue;
          const toId = typeof h?.to === "string" ? h.to : null;
          if (!toId) continue;
          const target = nodesById.get(toId);
          const targetFile = String(target?.file || "").trim();
          if (!targetFile) continue;
          const canonicalId = canonicalIdByFile.get(targetFile);
          if (canonicalId && canonicalId !== toId && nodesById.has(canonicalId)) {
            h.to = canonicalId;
          }
        }
      }
    }
  } catch {}

  // Some authoring exports duplicate the same pano image into multiple nodes (often across zones),
  // but only one copy has the authored hotspots. Merge hotspots across duplicate panos so
  // navigating into the "other" copy doesn't lose links.
  try {
    const panoKeyFromFile = (file) => {
      const f = String(file || "").trim();
      if (!f) return "";
      const base = f.split(/[\\/]/).pop()?.split("?")?.[0] || f;
      return String(base)
        .trim()
        .toLowerCase()
        .replace(/\.(ktx2|png|jpe?g|webp|avif)$/i, "");
    };

    const byPano = new Map(); // panoKey -> nodes[]
    for (const n of nodes) {
      const k = panoKeyFromFile(n?.file);
      if (!k) continue;
      const arr = byPano.get(k) || [];
      arr.push(n);
      byPano.set(k, arr);
    }

    const r3 = (v) => {
      const x = Number(v);
      if (!Number.isFinite(x)) return 0;
      return Math.round(x * 1000) / 1000;
    };
    const keyForHotspot = (h) => {
      if (!h || typeof h !== "object") return "";
      const type = String(h.type || "walk").toLowerCase();
      const to = typeof h.to === "string" ? h.to : "";
      const yaw = r3(h.yaw);
      const pitch = r3(h.pitch);
      const dir = Array.isArray(h.dir) ? h.dir.slice(0, 3).map(r3).join(",") : "";
      return `${type}|${to}|${yaw}|${pitch}|${dir}`;
    };

    for (const [, group] of byPano) {
      if (!Array.isArray(group) || group.length < 2) continue;
      let union = null;
      let unionKeys = null;

      for (const n of group) {
        const hs = Array.isArray(n?.hotspots) ? n.hotspots : [];
        if (!hs.length) continue;
        if (!union) {
          union = [];
          unionKeys = new Set();
        }
        for (const h of hs) {
          const k = keyForHotspot(h);
          if (!k) continue;
          if (unionKeys.has(k)) continue;
          unionKeys.add(k);
          union.push({ ...h });
        }
      }

      if (!union || !union.length) continue;

      for (const n of group) {
        const hs = Array.isArray(n?.hotspots) ? n.hotspots : [];
        if (hs.length >= union.length) continue;
        const keys = new Set(hs.map(keyForHotspot).filter(Boolean));
        let changed = false;
        for (const h of union) {
          const k = keyForHotspot(h);
          if (!k || keys.has(k)) continue;
          keys.add(k);
          hs.push({ ...h });
          changed = true;
        }
        if (changed) n.hotspots = hs;
      }
    }
  } catch {}

  return { data: { floors, nodes, zones, startNodeId }, nodesById, startNodeId };
}

/* -------- Minimap (uses basePath for ./<exp>/floors/) -------- */
export function buildMinimapDOM({ 
  floors,
  basePath = ".",
  padByFloor,
  coordsMode = "auto",
  mappingMode = "auto",
  edgePadRatio = 0.06,
  ui = "dropdown", 
  // Default width adapts to both portrait and landscape using vw/vh  
  panelWidth = "clamp(240px, min(52vw, 44vh), 520px)",  
  mapHeight = "clamp(220px, 40vh, 520px)",
  floorsPlacement = "inside", // "inside" | "outside" (outside = above the minimap panel)
  position = "top-right",  
  paddingPx = 6,  
  onSelectNode,  
  onFloorChange,  
  container,  
  coordByFloor,  
  originByFloor,  
  // optional: zones overlay per floor [{ id, points:[{x,y}...], label }] 
  zonesByFloor, 
} = {}) { 
  let st = document.getElementById("mini-style-override");
  if (!st) {
    st = document.createElement("style");
    st.id = "mini-style-override";
    document.head.appendChild(st);
  }
  st.textContent = `  
      .mini-wrap{position:fixed; top:max(69px, env(safe-area-inset-top)); z-index:100001; width:var(--mini-width, clamp(150px, min(22vw, 22vh), 220px)); max-width:calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right)); cursor:grab; user-select:none; touch-action:none; display:flex; flex-direction:column; gap:8px; align-items:stretch}  
      .mini-wrap.dragging{cursor:grabbing}  
      .mini-wrap.pos-right{right:max(12px, env(safe-area-inset-right))} .mini-wrap.pos-left{left:max(12px, env(safe-area-inset-left))}  
      .mini-wrap.minimized{width:auto}  
      .mini-wrap.minimized .mini-img-wrap{display:none}  
      .mini-wrap.minimized .mini-bar{display:flex}  
      .mini-wrap.minimized .mini-top{display:none}  
      .mini-bar{display:none; align-items:center; justify-content:center; gap:8px; margin-bottom:0; padding:4px}  
      .mini-img-wrap{position:relative; background:rgba(255, 255, 255, 0.22); border:1px solid rgba(255, 255, 255, 0.42); border-radius:16px; box-shadow:0 10px 28px rgba(0,0,0,0.22); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); overflow:visible; display:flex; flex-direction:column; gap:var(--pad, 6px); padding:var(--pad, 6px)}   
      .mini-top{display:flex; align-items:center; justify-content:center; gap:8px; pointer-events:auto}  
      .mini-wrap[data-floors-placement="outside"] .mini-top{align-self:center; background:rgba(255, 255, 255, 0.22); border:1px solid rgba(255,255,255,0.42); border-radius:999px; padding:6px 8px; box-shadow:0 10px 28px rgba(0,0,0,0.18); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px)}  
      .mini-floors{display:flex; gap:6px; max-width:100%; overflow-x:auto; padding:2px; -webkit-overflow-scrolling:touch; touch-action:pan-x; scrollbar-width:thin}  
      .mini-floors::-webkit-scrollbar{height:4px}  
      .mini-floors::-webkit-scrollbar-track{background:transparent}  
      .mini-floors::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.25); border-radius:2px}  
      .mini-floor-btn{flex:0 0 auto; padding:7px 10px; border-radius:999px; border:1px solid rgba(255, 255, 255, 0.42); background:rgba(255, 255, 255, 0.30); color:rgba(15, 23, 42, 0.92); backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); font:700 12px/1 Inter, ui-sans-serif, system-ui; cursor:pointer; text-align:center; white-space:nowrap; pointer-events:auto; touch-action:manipulation}  
      .mini-floor-btn.active{background:rgba(15, 23, 42, 0.12); color:rgba(15, 23, 42, 0.96)}  
      .mini-content{position:relative; overflow:hidden; border-radius:14px; height:var(--mini-map-h, clamp(220px, 40vh, 520px))}  
      .mini-fit{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)}  
      .mini-img{position:absolute; inset:0; width:100%; height:100%; object-fit:contain; border-radius:14px; filter: saturate(1.02) brightness(1.02)}  
      /* Always show the eye button (touch devices don't keep hover). */ 
      .mini-min{width:28px;height:28px;border-radius:8px;border:1px solid rgba(255, 255, 255, 0.42);background:rgba(20, 27, 33, 0.92);color:rgba(255, 255, 255, 0.98);cursor:pointer;display:grid;place-items:center;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);opacity:1}  
      .mini-min svg{width:14px;height:14px;opacity:0.85} 
      .mini-min-inner{position:absolute; top:8px; right:8px; z-index:6} 
      .mini-zones{position:absolute; inset:0; width:100%; height:100%; pointer-events:none; display:none !important} 
      .mini-zone{display:none !important} 
      .mini-zone.active{display:none !important} 
      .mini-torch{fill:rgba(255,209,102,.18); stroke:rgba(255,209,102,.65); stroke-width:2; vector-effect:non-scaling-stroke} 
      .mini-compass{display:none !important} 
      .mini-position-arrow{position:absolute; width:24px; height:24px; pointer-events:none; z-index:6; transition: left 0.15s ease-out, top 0.15s ease-out, transform 0.12s ease-out; color:#2563eb; filter:drop-shadow(0 2px 6px rgba(0,0,0,0.35)); will-change:left,top,transform} 
      .mini-position-arrow svg{width:100%; height:100%; display:block} 
      /* Hide minimap hotspots/dots (keep the arrow only). */
      .mini-points{position:absolute; inset:0; pointer-events:none; display:none} 
      .mini-zone-labels{pointer-events:none} 
      .mini-point{position:absolute; width:clamp(8px, 1.5vw, 10px); height:clamp(8px, 1.5vw, 10px); margin:calc(clamp(8px, 1.5vw, 10px)/-2) 0 0 calc(clamp(8px, 1.5vw, 10px)/-2); background:#5deaff; border-radius:50%; box-shadow:0 0 0 2px rgba(8,10,15,.65), 0 0 0 4px rgba(93,234,255,.32); pointer-events:auto; cursor:pointer; touch-action:manipulation; z-index:5} 
      .mini-point.active{background:#F3C400; box-shadow:0 0 0 2px rgba(8,10,15,.65), 0 0 0 4px rgba(243,196,0,.35)} 
      .mini-label{position:absolute; transform:translate(-50%, -14px); padding:2px 6px; border-radius:8px; font:600 clamp(9px, 1.6vw, 12px)/1.2 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto; color:#e8eaf0; background:rgba(5,8,16,.72); border:1px solid rgba(93,234,255,.28); pointer-events:none; white-space:nowrap; backdrop-filter:blur(6px)} 

      /* Phone tuning: keep the minimap comfortably inside the viewport. */
      @media (max-width: 480px), (max-height: 640px) {
        .mini-wrap{ top:max(60px, calc(env(safe-area-inset-top) + 56px)); }
        .mini-content{ height:var(--mini-map-h, clamp(190px, 34vh, 420px)); }
        .mini-floor-btn{ padding:6px 9px; font:700 11px/1 Inter, ui-sans-serif, system-ui; }
      }
    `; 

  const wrap = document.createElement("div");
  wrap.className = "mini-wrap " + (position === "top-left" ? "pos-left" : "pos-right");
  wrap.style.setProperty("--mini-width", panelWidth);
  wrap.style.setProperty("--pad", `${paddingPx}px`);
  wrap.style.setProperty("--mini-map-h", mapHeight);
  try { wrap.setAttribute("data-floors-placement", String(floorsPlacement || "inside")); } catch {}

  // Bar only shown when minimized
  const bar = document.createElement("div");
  bar.className = "mini-bar";
  wrap.appendChild(bar);

  // Eye icon SVGs for minimize button
  const eyeOpenSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeClosedSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  const minBtn = document.createElement("button");
  minBtn.className = "mini-min";
  minBtn.type = "button";
  minBtn.setAttribute("aria-label", "Hide map");
  minBtn.innerHTML = eyeOpenSvg;
  bar.appendChild(minBtn);

  const imgWrap = document.createElement("div");
  imgWrap.className = "mini-img-wrap";

  const hasMultipleFloors = floors?.length > 1;

  // For compatibility with existing code that uses selectEl
  const selectEl = { value: floors?.[0]?.id || "" };

  // Two-part minimap panel: top = floors, bottom = minimap
  const topPane = document.createElement("div");
  topPane.className = "mini-top";
  if (!hasMultipleFloors) topPane.style.display = "none";

  const floorsBar = document.createElement("div");
  floorsBar.className = "mini-floors";
  topPane.appendChild(floorsBar);

  (floors || []).forEach((f, idx) => {
    const btn = document.createElement("button");
    btn.className = "mini-floor-btn" + (idx === 0 ? " active" : "");
    btn.type = "button";
    btn.setAttribute("data-value", f.id);
    btn.setAttribute("aria-pressed", idx === 0 ? "true" : "false");
    btn.textContent = f.name || f.id;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectEl.value = f.id;
      if (typeof selectEl.onchange === "function") selectEl.onchange();
    });
    floorsBar.appendChild(btn);
  });

  const content = document.createElement("div");
  content.className = "mini-content";
  const fit = document.createElement("div");
  fit.className = "mini-fit";
 	  const img = document.createElement("img");
 	  img.className = "mini-img";

	  function syncFloorUI(fid) {
	    const floor = (floors || []).find((x) => x.id === fid) || (floors || [])[0];
	    const nextId = floor?.id || fid;
	    selectEl.value = nextId;

	    try {
	      floorsBar.querySelectorAll(".mini-floor-btn").forEach((el) => {
	        const active = el.getAttribute("data-value") === String(nextId);
	        el.classList.toggle("active", active);
	        try { el.setAttribute("aria-pressed", active ? "true" : "false"); } catch {}
	      });
	    } catch {}
	  }

  // Minimize button inside minimap (top-right corner)
  const minBtnInner = document.createElement("button");
  minBtnInner.className = "mini-min mini-min-inner";
  minBtnInner.type = "button";
  minBtnInner.setAttribute("aria-label", "Hide map");
  minBtnInner.innerHTML = eyeOpenSvg;

  // Dynamic position arrow that moves with current node and rotates with view direction
  const positionArrow = document.createElement("div");
  positionArrow.className = "mini-position-arrow";
  positionArrow.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <!-- Arrow head (matches prior compass style) -->
      <polygon points="12,2 20,21 12,17 4,21"
        fill="currentColor"
        stroke="rgba(0,0,0,0.35)"
        stroke-width="1"
        stroke-linejoin="round"/>
    </svg>
  `.trim();
  const zonesSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  zonesSvg.setAttribute("class", "mini-zones");
  const torchPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  torchPath.setAttribute("class", "mini-torch");
  const points = document.createElement("div");
  points.className = "mini-points";
  const zoneLabels = document.createElement("div");
  zoneLabels.className = "mini-zone-labels mini-points";

  fit.appendChild(img);
  fit.appendChild(zonesSvg);
	  fit.appendChild(points);
	  fit.appendChild(zoneLabels);
	  fit.appendChild(positionArrow);
	  content.appendChild(fit);

    const floorsOutside = String(floorsPlacement || "inside") === "outside";
    if (floorsOutside) {
      wrap.appendChild(topPane);
      imgWrap.appendChild(content);
    } else {
      imgWrap.appendChild(topPane);
      imgWrap.appendChild(content);
    }

	  // Keep the minimize button anchored to the map pane (not the whole panel)
	  content.appendChild(minBtnInner);
	  wrap.appendChild(imgWrap);
	  (container || document.body).appendChild(wrap);

  // Toggle minimize from either button
  const toggleMinimize = (ev) => {
    ev.stopPropagation();
    const nowMin = !wrap.classList.contains("minimized");
    wrap.classList.toggle("minimized", nowMin);
    minBtn.innerHTML = nowMin ? eyeClosedSvg : eyeOpenSvg;
    minBtn.setAttribute("aria-label", nowMin ? "Show map" : "Hide map");
  };
  minBtn.addEventListener("click", toggleMinimize);
  minBtnInner.addEventListener("click", toggleMinimize);

  let dragState = null;
  const DRAG_THRESHOLD_PX = 8;
 	  function startDrag(ev) {
 	    if (ev.button && ev.button !== 0) return;
 	    if (ev.target?.closest?.(".mini-top, .mini-floors, .mini-floor-btn, .mini-min, .mini-point, .mini-label")) return;
 	    const rect = wrap.getBoundingClientRect();
      const downOnMap = Boolean(ev.target?.closest?.(".mini-img-wrap, .mini-content, .mini-fit, .mini-img"));
 	    dragState = {
 	      pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
 	      offsetX: ev.clientX - rect.left,
        offsetY: ev.clientY - rect.top,
        rectLeft: rect.left,
        rectTop: rect.top,
        rectW: rect.width,
        rectH: rect.height,
        moved: false,
        downOnMap,
    };
    try { wrap.setPointerCapture?.(ev.pointerId); } catch {}
    ev.preventDefault();

    // Prefer binding to `wrap` since pointer-capture retargets events there; keep `window` as a fallback.
    try { wrap.addEventListener("pointermove", onDragMove); } catch {}
    try { window.addEventListener("pointermove", onDragMove); } catch {}
    try { wrap.addEventListener("pointerup", endDrag, { once: true }); } catch {}
    try { wrap.addEventListener("pointercancel", endDrag, { once: true }); } catch {}
    try { window.addEventListener("pointerup", endDrag, { once: true }); } catch {}
    try { window.addEventListener("pointercancel", endDrag, { once: true }); } catch {}
  }
  function onDragMove(ev) {
    if (!dragState) return;
    if (dragState.pointerId != null && ev.pointerId != null && dragState.pointerId !== ev.pointerId) return;

    const dx = (ev.clientX - dragState.startX);
    const dy = (ev.clientY - dragState.startY);
    if (!dragState.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
      wrap.classList.add("dragging");
      wrap.classList.remove("pos-left", "pos-right");
      wrap.style.left = dragState.rectLeft + "px";
      wrap.style.top = dragState.rectTop + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
    }

    const w = dragState.rectW || wrap.getBoundingClientRect().width;
    const h = dragState.rectH || wrap.getBoundingClientRect().height;
    const maxX = window.innerWidth - w;
    const maxY = window.innerHeight - h;
    const nextLeft = Math.max(8, Math.min(maxX - 8, ev.clientX - dragState.offsetX));
    const nextTop = Math.max(8, Math.min(maxY - 8, ev.clientY - dragState.offsetY));
    wrap.style.left = `${nextLeft}px`;
    wrap.style.top = `${nextTop}px`;
  }
  function endDrag(ev) {
    const shouldTap = Boolean(
      (!ev || ev.type === "pointerup") &&
      dragState &&
      !dragState.moved &&
      dragState.downOnMap &&
      !wrap.classList.contains("minimized")
    );
    try { if (dragState?.pointerId != null) wrap.releasePointerCapture?.(dragState.pointerId); } catch {}
    dragState = null;
    wrap.classList.remove("dragging");
    try { wrap.removeEventListener("pointermove", onDragMove); } catch {}
    try { window.removeEventListener("pointermove", onDragMove); } catch {}

    if (shouldTap) {
      try {
        window.dispatchEvent(new CustomEvent("minimap:tap", { detail: { target: wrap } }));
      } catch {}
    }
  }
  wrap.addEventListener("pointerdown", startDrag);

  const autoSizeByFloor = new Map();
  const isMap = (m) => m && typeof m.get === "function";
  const getPad = (fid) => (isMap(padByFloor) && padByFloor.get(fid)) || { x: 0, y: 0 };
  const getCoordRef = (fid) => (isMap(coordByFloor) && coordByFloor.get(fid)) || null;
  const getOrigin = (fid) => (isMap(originByFloor) && originByFloor.get(fid)) || { x: 0, y: 0 };

  function floorImageCandidates(name){
    const raw = String(name || "").trim();
    if (!raw) return [];
    const out = [raw];
    // DOM <img> can't display KTX2. Many experiences ship a PNG/JPG floorplan alongside KTX2.
    if (/\.ktx2($|\?)/i.test(raw)){
      out.push(raw.replace(/\.ktx2($|\?)/i, '.png$1'));
      out.push(raw.replace(/\.ktx2($|\?)/i, '.jpg$1'));
      out.push(raw.replace(/\.ktx2($|\?)/i, '.jpeg$1'));
    }
    return Array.from(new Set(out));
  }
  function setImgSrcWithFallback(el, candidates){
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    let idx = 0;
    const setNext = ()=>{
      if (idx >= list.length) return;
      const file = list[idx++];
      el.src = `${basePath}/floors/${encodeURI(file)}`;
    };
    // Replace existing handler so we don't stack on repeated floor switches.
    el.onerror = ()=>{ try{ setNext(); }catch{} };
    setNext();
  }

  (floors || []).forEach((f) => { 
    const im = new Image(); 
    im.onload = () => { 
      // Use the real image dimensions for layout to avoid letterboxing when
      // authoring metadata width/height don't match the actual floorplan image.
      const overrideW = Number(f?.width || f?.w || f?.imageWidth || 0) || 0; 
      const overrideH = Number(f?.height || f?.h || f?.imageHeight || 0) || 0; 
      const w = im.naturalWidth || overrideW || 1; 
      const h = im.naturalHeight || overrideH || 1; 
      autoSizeByFloor.set(f.id, { w, h }); 
      if (f.id === currentFloorId) { 
        setWrapAspectFor(autoSizeByFloor.get(f.id)); 
        layoutFit(autoSizeByFloor.get(f.id)); 
        renderPoints(lastNodesForFloor, lastActiveId); 
      } 
    }; 
    setImgSrcWithFallback(im, floorImageCandidates(f.image));
  });

 	  function setWrapAspectFor(sz) {
      try{
        if (!sz) return;
        const cr = content.getBoundingClientRect();
        if (!cr.width) return;

        // Target height so the floorplan fills the map area without letterboxing,
        // keeping the outer panel padding consistent on all sides.
        const desiredH = cr.width * (sz.h / sz.w);

        const wrapRect = wrap.getBoundingClientRect();
        const top = wrapRect?.top ?? 0;
        const floorBarH = (hasMultipleFloors && topPane && topPane.style.display !== "none")
          ? (topPane.getBoundingClientRect().height || 0)
          : 0;

        // Keep within the viewport (panel is draggable, but avoid starting oversized).
        const maxH = Math.max(220, (window.innerHeight || 800) - top - floorBarH - (paddingPx * 5));
        const nextH = Math.max(220, Math.min(desiredH, maxH));
        content.style.height = `${Math.round(nextH)}px`;
      }catch{}
    }
  function layoutFit(sz) {
    if (!sz) return;
    const cr = content.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const s = Math.min(cr.width / sz.w, cr.height / sz.h);
    fit.style.width = `${sz.w * s}px`;
    fit.style.height = `${sz.h * s}px`;
  }

  let currentFloorId = floors?.[0]?.id;
  let lastNodesForFloor = [];
  let lastActiveId = null;
  let lastZonesForFloor = [];
  let lastActiveZoneId = null;
  let lastTorch = { x:0, y:0, yawRad:0, visible:false };
  let lastZoneExtents = null; // {minX,maxX,minY,maxY}

 	  function setActiveFloor(fid, clear = false, notify = false, meta = undefined) {
 	    const f = (floors || []).find((x) => x.id === fid) || (floors || [])[0];
 	    if (!f) return;
 	    currentFloorId = f.id;
 	    syncFloorUI(currentFloorId);
	    const sz = autoSizeByFloor.get(currentFloorId);
	    if (sz) {
	      requestAnimationFrame(() => {
	        layoutFit(sz);
	        renderPoints(lastNodesForFloor, lastActiveId);
 	      });
 	    }
	    setImgSrcWithFallback(img, floorImageCandidates(f.image));
	    if (clear) points.innerHTML = "";
	    if (notify && typeof onFloorChange === "function") onFloorChange(currentFloorId, meta);
	  }

	  img.onload = () => {
	    const sz = autoSizeByFloor.get(currentFloorId);
	    if (sz) {
	      setWrapAspectFor(sz);
	      layoutFit(sz);
	    } else if (img.naturalWidth && img.naturalHeight) {
	      autoSizeByFloor.set(currentFloorId, { w: img.naturalWidth, h: img.naturalHeight });
	      setWrapAspectFor({ w: img.naturalWidth, h: img.naturalHeight });
	      layoutFit({ w: img.naturalWidth, h: img.naturalHeight });
	    }
    renderZones(lastZonesForFloor, lastActiveZoneId);
    renderPoints(lastNodesForFloor, lastActiveId);
    renderTorch();
  };
	  addEventListener("resize", () => {
	    const sz = autoSizeByFloor.get(currentFloorId);
	    if (sz) { setWrapAspectFor(sz); layoutFit(sz); }
	    renderZones(lastZonesForFloor, lastActiveZoneId);
	    renderPoints(lastNodesForFloor, lastActiveId);
	    renderTorch();
	  });

  function chooseMode(nodesForFloor, sz) {
    if (coordsMode !== "auto") return coordsMode;
    if (!nodesForFloor?.length || !sz) return "image";

    // If points look like absolute floorplan pixels (within image bounds), always use image mapping.
    // This prevents "editor" normalization from shifting correctly-authored hotspot positions.
    try{
      const cref = getCoordRef(currentFloorId);
      const boundW = (cref && cref.w) ? cref.w : sz.w;
      const boundH = (cref && cref.h) ? cref.h : sz.h;
      const slack = Math.max(8, Math.min(boundW, boundH) * 0.01);
      const samples = [];
      for (const n of nodesForFloor) {
        const x = Number(n?.x), y = Number(n?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) samples.push({ x, y });
      }
      for (const z of (lastZonesForFloor || [])) {
        const pts = Array.isArray(z?.points) ? z.points : [];
        for (const p of pts) {
          const x = Number(p?.x), y = Number(p?.y);
          if (Number.isFinite(x) && Number.isFinite(y)) samples.push({ x, y });
        }
        if (z && typeof z === "object" && z.repPoint && Number.isFinite(Number(z.repPoint.x)) && Number.isFinite(Number(z.repPoint.y))) {
          samples.push({ x: Number(z.repPoint.x), y: Number(z.repPoint.y) });
        }
      }

      if (samples.length) {
        let inBounds = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const s of samples) {
          if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
          if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
          if (s.x >= -slack && s.y >= -slack && s.x <= boundW + slack && s.y <= boundH + slack) inBounds++;
        }
        const boundsOk = (inBounds / samples.length) >= 0.95;
        const pixelLike = maxX > 4 || maxY > 4; // avoid treating 0..1 normalized data as pixels
        if (boundsOk && pixelLike && minX > -slack && minY > -slack) return "image";
      }
    }catch{}

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodesForFloor) if (typeof n.x === "number" && typeof n.y === "number") {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    }
    // Heuristic: if any coordinate is near 0 or near the image edge, assume absolute image pixels
    const nearEdge = (v, max)=> (v<8 || (max-v)<8);
    const absEdge = nearEdge(minX, sz.w) || nearEdge(minY, sz.h) || nearEdge(maxX, sz.w) || nearEdge(maxY, sz.h);
    if (absEdge) return "image";
    const spanX = maxX - minX, spanY = maxY - minY;
    if (!(spanX > 0 && spanY > 0)) return "image";
    const ratioX = spanX / sz.w, ratioY = spanY / sz.h;
    return ratioX < 0.75 || ratioY < 0.75 ? "editor" : "image";
  }

  const fixedMode = mappingMode && mappingMode !== "auto" ? mappingMode : null;
  const decideMode = (nodesForFloor, sz) => fixedMode || chooseMode(nodesForFloor, sz);

  function mapXY(x, y, mode, sz){
    const drawnW = fit.clientWidth;
    const drawnH = fit.clientHeight;
    if (!drawnW || !drawnH || !sz) return { px: 0, py: 0 };
    if (mode === "editor"){
      // In editor mode, normalize by zone extents when available; fallback to nodes extents
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      if (lastZoneExtents && isFinite(lastZoneExtents.minX)){
        ({minX, maxX, minY, maxY} = lastZoneExtents);
      } else {
        for (const n of lastNodesForFloor) if (typeof n.x === "number" && typeof n.y === "number") {
          if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        }
        if (!isFinite(minX) || !isFinite(minY) || maxX <= minX || maxY <= minY){ minX = 0; maxX = sz.w; minY = 0; maxY = sz.h; }
      }
      // Keep full-bleed mapping so authored coordinates don't shift.
      const insetX = 0;
      const insetY = 0;
      const nx = (x - minX) / (maxX - minX);
      const ny = (y - minY) / (maxY - minY);
      return { px: insetX + nx * (drawnW - 2 * insetX), py: insetY + ny * (drawnH - 2 * insetY) };
    }
    const cref = getCoordRef(currentFloorId);
    const org = getOrigin(currentFloorId);
    const refW = (cref && cref.w) ? cref.w : sz.w;
    const refH = (cref && cref.h) ? cref.h : sz.h;
    const nx = ((x - (org.x || 0)) / refW);
    const ny = ((y - (org.y || 0)) / refH);
    return { px: nx * drawnW, py: ny * drawnH };
  }

  function renderPoints(nodesForFloor, activeId) {
    lastNodesForFloor = nodesForFloor || [];
    lastActiveId = activeId || null;
    points.innerHTML = "";

    // Hotspots/dots are intentionally hidden on the minimap; keep only the position arrow.
    // We still retain `lastNodesForFloor` so mapping mode inference stays stable.
    return;

    const sz = autoSizeByFloor.get(currentFloorId);
    if (!sz || !sz.w || !sz.h) return;

    const drawnW = fit.clientWidth;
    const drawnH = fit.clientHeight;
    if (!drawnW || !drawnH) return;

    const mode = decideMode(lastNodesForFloor, sz);

    const dotEntries = [];
    for (const n of lastNodesForFloor) {
      const { px: px0, py: py0 } = mapXY(n.x, n.y, mode, sz);
      let px = px0, py = py0;

      const nudge = getPad(currentFloorId);
      if (nudge?.x) px += nudge.x;
      if (nudge?.y) py += nudge.y;
      px = Math.max(0, Math.min(drawnW, px));
      py = Math.max(0, Math.min(drawnH, py));

      const dot = document.createElement("div");
      dot.className = "mini-point" + (n.id === activeId ? " active" : "");
      dot.style.left = px + "px";
      dot.style.top = py + "px";
      dot.title = n.label || n.name || n.id;
      dot.onclick = (ev) => { ev.stopPropagation(); onSelectNode?.(n.id); };
      points.appendChild(dot);
      dotEntries.push({ element: dot, px, py });
    }

    // De-clutter dots with light repulsion, capped to small shifts
    if (dotEntries.length > 1){
      const MIN = 22, ITER_MAX = 36;
      for (let iter=0; iter<ITER_MAX; iter++){
        let moved=false;
        for (let i=0;i<dotEntries.length;i++){
          for (let j=i+1;j<dotEntries.length;j++){
            const a=dotEntries[i], b=dotEntries[j];
            const dx=b.px-a.px, dy=b.py-a.py; const d=Math.hypot(dx,dy);
            if (d<MIN){
              const push=(MIN-d)/2; const ang=d>1e-4?Math.atan2(dy,dx):Math.random()*Math.PI*2;
              const ox=Math.cos(ang)*push, oy=Math.sin(ang)*push;
              a.px=Math.max(0, Math.min(drawnW, a.px-ox));
              a.py=Math.max(0, Math.min(drawnH, a.py-oy));
              b.px=Math.max(0, Math.min(drawnW, b.px+ox));
              b.py=Math.max(0, Math.min(drawnH, b.py+oy));
              moved=true;
            }
          }
        }
        if (!moved) break;
      }
      dotEntries.forEach(d=>{ d.element.style.left = d.px + 'px'; d.element.style.top = d.py + 'px'; });
    }
  }

  function renderZones(zonesForFloor, activeZoneId){
    lastZonesForFloor = Array.isArray(zonesForFloor) ? zonesForFloor : [];
    lastActiveZoneId = activeZoneId || null;
    while (zonesSvg.firstChild) zonesSvg.removeChild(zonesSvg.firstChild);
    zoneLabels.innerHTML = "";

    const sz = autoSizeByFloor.get(currentFloorId);
    if (!sz || !sz.w || !sz.h) return;
    const drawnW = fit.clientWidth;
    const drawnH = fit.clientHeight;
    if (!drawnW || !drawnH) return;
    zonesSvg.setAttribute("viewBox", `0 0 ${drawnW} ${drawnH}`);
    zonesSvg.appendChild(torchPath);

    // Mode should follow points mapping
    const mode = decideMode(lastNodesForFloor, sz);

    // Compute and store zone extents for consistent editor mapping across polygons and dots
    if (mode === 'editor'){
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const z of lastZonesForFloor){
        for (const p of (z.points||[])){
          const x = Number(p?.x); const y = Number(p?.y);
          if (!isFinite(x) || !isFinite(y)) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (isFinite(minX) && isFinite(minY) && maxX > minX && maxY > minY){
        lastZoneExtents = { minX, maxX, minY, maxY };
      } else {
        lastZoneExtents = null;
      }
    } else {
      lastZoneExtents = null;
    }

    for (const z of lastZonesForFloor){
      const pts = Array.isArray(z.points) ? z.points : [];
      if (!pts.length) continue;
      const mapped = pts.map(p => mapXY(Number(p.x)||0, Number(p.y)||0, mode, sz));
      const d = mapped.map((p,i)=>`${i? 'L':'M'}${p.px},${p.py}`).join(' ') + ' Z';
      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'mini-zone' + (z.id===lastActiveZoneId ? ' active' : ''));
      path.addEventListener('click', (ev)=>{ ev.stopPropagation(); onSelectNode?.(z.id); });
      zonesSvg.appendChild(path);
    }
  }

  function renderTorch(){
    // Hide torch path (replaced by position arrow)
    torchPath.setAttribute('d','');
    
    // Update position arrow location and rotation
    if (!lastTorch?.visible) {
      positionArrow.style.display = 'none';
      return;
    }
    positionArrow.style.display = '';
    
    const sz = autoSizeByFloor.get(currentFloorId);
    if (!sz || !sz.w || !sz.h) return;
    const mode = decideMode(lastNodesForFloor, sz);
    let { px: cx, py: cy } = mapXY(lastTorch.x, lastTorch.y, mode, sz);
    const nudge = getPad(currentFloorId);
    if (nudge?.x) cx += nudge.x;
    if (nudge?.y) cy += nudge.y;
    const drawnW = fit.clientWidth, drawnH = fit.clientHeight;
    if (!drawnW || !drawnH) return;
    
    cx = Math.max(0, Math.min(drawnW, cx));
    cy = Math.max(0, Math.min(drawnH, cy));

    // Position the arrow at the current location and rotate to match heading.
    positionArrow.style.left = cx + 'px';
    positionArrow.style.top = cy + 'px';
    const deg = (Number(lastTorch.yawRad) || 0) * 180 / Math.PI;
    positionArrow.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
  }

  selectEl.onchange = () => setActiveFloor(selectEl.value, true, true, { source: "user-floor" });

  if (floors?.[0]) {
    setActiveFloor(floors[0].id, true, false);
  }

  return {
    setActiveFloor,
    renderPoints,
    renderZones,
    setTorchPose: ({ floorId, x, y, yawRad = 0, visible = true } = {}) => {
      if (floorId && floorId !== currentFloorId) setActiveFloor(floorId, false, false);
      lastTorch = { x:Number(x)||0, y:Number(y)||0, yawRad:Number(yawRad)||0, visible: !!visible };
      renderTorch();
    },
    getCurrentFloorId: () => currentFloorId,
  };
}

function applyLabelLayout(entries, width, height) {
  if (!Array.isArray(entries) || !entries.length) return;
  const margin = 12;
  const labelHalfWidth = 68;
  const labelHalfHeight = 18;
  const baselineY = -(labelHalfHeight + 8);
  const positions = entries.map(entry => ({
    x: Math.max(margin + labelHalfWidth, Math.min(width - margin - labelHalfWidth, entry.px)),
    y: Math.max(margin + labelHalfHeight, Math.min(height - margin - labelHalfHeight, entry.py + baselineY))
  }));
  const MIN_DIST = 38;
  const ITER_MAX = 48;
  for (let iter = 0; iter < ITER_MAX; iter++) {
    let moved = false;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < MIN_DIST) {
          const push = (MIN_DIST - dist) / 2;
          const angle = dist > 0.0001 ? Math.atan2(dy, dx) : (Math.PI / 2) * (j % 2 ? 1 : -1);
          const offsetX = Math.cos(angle) * push;
          const offsetY = Math.sin(angle) * push;
          a.x = Math.max(margin + labelHalfWidth, Math.min(width - margin - labelHalfWidth, a.x - offsetX));
          a.y = Math.max(margin + labelHalfHeight, Math.min(height - margin - labelHalfHeight, a.y - offsetY));
          b.x = Math.max(margin + labelHalfWidth, Math.min(width - margin - labelHalfWidth, b.x + offsetX));
          b.y = Math.max(margin + labelHalfHeight, Math.min(height - margin - labelHalfHeight, b.y + offsetY));
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  entries.forEach((entry, idx) => {
    entry.labelOffsetX = positions[idx].x - entry.px;
    entry.labelOffsetY = positions[idx].y - entry.py;
  });
}

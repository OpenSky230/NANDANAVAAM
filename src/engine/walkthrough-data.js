/* -------- walkthrough-data.js -------- */

export async function loadWalkthrough(url = "./walkthrough.json") {
  // Use revalidation so edits to walkthrough.json (hotspots, stereo flags, zone ordering) take effect
  // without hard-refresh during development.
  const r = await fetch(url, { cache: "no-cache" });
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
      // Optional: per-node stereo flag (TOP/BOTTOM stereo panos).
      // When absent, experience-level meta.stereo/meta.stereoPanos decide.
      stereo: (typeof n?.stereo === "boolean") ? n.stereo : undefined,
      floorId: n?.floorId ?? (floors[0]?.id || "floor-1"),
      x: typeof n?.x === "number" ? n.x : 0,
      y: typeof n?.y === "number" ? n.y : 0,
      z: typeof n?.z === "number" ? n.z : 0,
      yaw: typeof n?.yaw === "number" ? n.yaw : 0,
      zoneId: (typeof n?.zoneId === "string" && n.zoneId) ? n.zoneId : undefined,
      // Optional display names for UI/hotspot labels (e.g., "Wardrobe", "Toilet").
      name: (typeof nameRaw === "string" && nameRaw) ? nameRaw : undefined,
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

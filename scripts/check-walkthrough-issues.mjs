#!/usr/bin/env node
/**
 * Walkthrough sanity checks:
 * - Duplicate pano keys (same panorama referenced by multiple nodes) with hotspot mismatch
 * - Zones where repNodeId cannot navigate within zone (internal hotspots = 0) but other nodes can
 */
import { promises as fs } from "fs";
import path from "path";

const ROOT = process.cwd();
const EXPERIENCES_DIR = path.join(ROOT, "public", "experiences");

function panoKeyFromFile(file) {
  const f = String(file || "").trim();
  if (!f) return "";
  const base = f.split(/[\\/]/).pop()?.split("?")?.[0] || f;
  return String(base)
    .trim()
    .toLowerCase()
    .replace(/\.(ktx2|png|jpe?g|webp|avif)$/i, "");
}

function kindOf(h) {
  return String(h?.type || "walk").toLowerCase();
}

function hotspotCounts(node, nodesById, zoneId) {
  const hs = Array.isArray(node?.hotspots) ? node.hotspots : [];
  let total = 0;
  let internal = 0;
  for (const h of hs) {
    const k = kindOf(h);
    if (k === "info") continue;
    if (!h?.to) continue;
    total++;
    if (k !== "zone" && zoneId) {
      const toNode = nodesById.get(h.to);
      if (toNode && String(toNode?.zoneId || "") === String(zoneId)) internal++;
    }
  }
  return { total, internal };
}

async function readJson(p) {
  const txt = await fs.readFile(p, "utf8");
  return JSON.parse(txt);
}

async function main() {
  const ents = await fs.readdir(EXPERIENCES_DIR, { withFileTypes: true });
  const exps = ents.filter((e) => e.isDirectory()).map((e) => e.name);

  const report = [];
  for (const exp of exps) {
    const wf = path.join(EXPERIENCES_DIR, exp, "walkthrough.json");
    try {
      await fs.access(wf);
    } catch {
      continue;
    }

    let raw;
    try {
      raw = await readJson(wf);
    } catch {
      report.push({ exp, error: "invalid JSON" });
      continue;
    }

    const data = raw.project || raw.data || raw || {};
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const zones = Array.isArray(data.zones) ? data.zones : [];
    const nodesById = new Map(nodes.map((n) => [String(n?.id || ""), n]));

    // Duplicate pano keys with hotspot mismatch
    const byPano = new Map();
    for (const n of nodes) {
      const k = panoKeyFromFile(n?.file);
      if (!k) continue;
      const arr = byPano.get(k) || [];
      arr.push(n);
      byPano.set(k, arr);
    }
    const dupPanos = [];
    for (const [k, group] of byPano) {
      if (!Array.isArray(group) || group.length < 2) continue;
      const hsCounts = group.map((n) => hotspotCounts(n, nodesById, n?.zoneId).total);
      const min = Math.min(...hsCounts);
      const max = Math.max(...hsCounts);
      if (min !== max) {
        dupPanos.push({ pano: k, count: group.length, hsMin: min, hsMax: max });
      }
    }
    dupPanos.sort((a, b) => (b.count - a.count) || (b.hsMax - a.hsMax));

    // Zones with weak repNodeId
    const weakReps = [];
    for (const z of zones) {
      const zid = String(z?.id || "");
      if (!zid) continue;
      const repId = typeof z?.repNodeId === "string" ? z.repNodeId.trim() : "";
      if (!repId) continue;
      const rep = nodesById.get(repId) || null;
      if (!rep) continue;
      const candidates = nodes.filter((n) => String(n?.zoneId || "") === zid);
      if (!candidates.length) continue;
      const repScore = hotspotCounts(rep, nodesById, zid);
      const bestInternal = Math.max(0, ...candidates.map((n) => hotspotCounts(n, nodesById, zid).internal));
      if (repScore.internal === 0 && bestInternal > 0) {
        weakReps.push({
          zone: zid,
          name: String(z?.name || zid),
          repNodeId: repId,
          repFile: String(rep?.file || ""),
          bestInternal,
        });
      }
    }

    report.push({
      exp,
      nodes: nodes.length,
      zones: zones.length,
      dupPanos,
      weakReps,
    });
  }

  // Print
  for (const r of report) {
    if (r?.error) {
      console.log(`\n[${r.exp}] ERROR: ${r.error}`);
      continue;
    }
    console.log(`\n[${r.exp}] nodes=${r.nodes} zones=${r.zones}`);
    if (r.dupPanos?.length) {
      console.log(`- duplicate panos w/ hotspot mismatch: ${r.dupPanos.length}`);
      for (const d of r.dupPanos.slice(0, 12)) {
        console.log(`  - ${d.pano} x${d.count} hotspots ${d.hsMin}..${d.hsMax}`);
      }
    } else {
      console.log(`- duplicate panos w/ hotspot mismatch: 0`);
    }

    if (r.weakReps?.length) {
      console.log(`- zones with weak repNodeId: ${r.weakReps.length}`);
      for (const z of r.weakReps.slice(0, 12)) {
        console.log(`  - ${z.name} (${z.zone}) rep=${z.repNodeId} file=${z.repFile} bestInternal=${z.bestInternal}`);
      }
    } else {
      console.log(`- zones with weak repNodeId: 0`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


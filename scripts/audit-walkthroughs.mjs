import { promises as fs } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const EXPERIENCES_DIR = path.resolve(PROJECT_ROOT, "public", "experiences");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function countBy(arr) {
  const map = new Map();
  for (const v of arr) map.set(v, (map.get(v) || 0) + 1);
  return map;
}

async function auditExperience(expId) {
  const expDir = path.join(EXPERIENCES_DIR, expId);
  const walkthroughPath = path.join(expDir, "walkthrough.json");
  const floorsDir = path.join(expDir, "floors");
  const panosDir = path.join(expDir, "panos");

  const issues = [];

  if (!(await exists(walkthroughPath))) {
    issues.push({ type: "missing_walkthrough", detail: "walkthrough.json not found" });
    return issues;
  }

  let raw;
  try {
    raw = JSON.parse(await fs.readFile(walkthroughPath, "utf8"));
  } catch (e) {
    issues.push({ type: "invalid_json", detail: `walkthrough.json invalid JSON: ${e?.message || e}` });
    return issues;
  }

  const data = (raw && (raw.data || raw.project)) || raw || {};
  const floors = Array.isArray(data.floors) ? data.floors : [];
  const zones = Array.isArray(data.zones) ? data.zones : [];
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];

  const floorIds = floors.map((f) => String(f?.id || "")).filter(Boolean);
  const zoneIds = zones.map((z) => String(z?.id || "")).filter(Boolean);
  const nodeIds = nodes.map((n) => String(n?.id || "")).filter(Boolean);
  const nodeFiles = nodes.map((n) => String(n?.file || "")).filter(Boolean);

  for (const [id, count] of countBy(nodeIds).entries()) {
    if (count > 1) issues.push({ type: "duplicate_node_id", detail: `${id} x${count}` });
  }
  for (const [file, count] of countBy(nodeFiles).entries()) {
    if (count > 1) issues.push({ type: "duplicate_node_file", detail: `${file} x${count}` });
  }

  const missingFloorImages = [];
  for (const f of floors) {
    const img = String(f?.image || "").trim();
    if (!img) continue;
    const p = path.join(floorsDir, img);
    if (!(await exists(p))) missingFloorImages.push(img);
  }
  if (missingFloorImages.length) {
    issues.push({ type: "missing_floor_images", detail: uniq(missingFloorImages).join(", ") });
  }

  const missingPanos = [];
  for (const file of nodeFiles) {
    const p = path.join(panosDir, file);
    if (await exists(p)) continue;
    const ktx2 = file.replace(/\.(png|jpe?g|webp)$/i, ".ktx2");
    if (ktx2 !== file && (await exists(path.join(panosDir, ktx2)))) continue;
    missingPanos.push(file);
  }
  if (missingPanos.length) {
    issues.push({ type: "missing_panos", detail: uniq(missingPanos).slice(0, 30).join(", ") + (missingPanos.length > 30 ? ` …(+${missingPanos.length - 30})` : "") });
  }

  const badHotspots = [];
  const nodeIdSet = new Set(nodeIds);
  const zoneIdSet = new Set(zoneIds);
  for (const n of nodes) {
    const fromId = String(n?.id || "").trim();
    const hs = Array.isArray(n?.hotspots) ? n.hotspots : [];
    for (const h of hs) {
      const to = String(h?.to || "").trim();
      if (!to) continue;
      if (zoneIdSet.has(to)) continue;
      if (!nodeIdSet.has(to)) badHotspots.push(`${fromId} -> ${to}`);
    }
  }
  if (badHotspots.length) {
    issues.push({ type: "missing_hotspot_targets", detail: uniq(badHotspots).slice(0, 30).join(", ") + (badHotspots.length > 30 ? ` …(+${badHotspots.length - 30})` : "") });
  }

  const missingFloorIds = nodes
    .map((n) => String(n?.floorId || "").trim())
    .filter(Boolean)
    .filter((fid) => !floorIds.includes(fid));
  if (missingFloorIds.length) {
    issues.push({ type: "nodes_with_unknown_floorId", detail: uniq(missingFloorIds).join(", ") });
  }

  return issues;
}

async function main() {
  let entries = [];
  try {
    entries = await fs.readdir(EXPERIENCES_DIR, { withFileTypes: true });
  } catch (e) {
    console.error(`[audit] missing experiences dir: ${EXPERIENCES_DIR}`);
    process.exitCode = 1;
    return;
  }

  const exps = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  let hadIssues = false;

  for (const expId of exps) {
    const issues = await auditExperience(expId);
    if (!issues.length) {
      console.log(`[audit] ${expId}: OK`);
      continue;
    }
    hadIssues = true;
    console.log(`[audit] ${expId}:`);
    for (const i of issues) console.log(`  - ${i.type}: ${i.detail}`);
  }

  if (hadIssues) process.exitCode = 2;
}

main().catch((e) => {
  console.error("[audit] failed:", e);
  process.exitCode = 1;
});

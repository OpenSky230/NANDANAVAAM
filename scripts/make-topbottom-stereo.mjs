#!/usr/bin/env node
/**
 * Convert mono equirect panos into TOP/BOTTOM stereo layout by duplicating
 * the same image for both eyes (no real depth, but VR stereo-compatible).
 *
 * Usage:
 *   node scripts/make-topbottom-stereo.mjs --exp skywalk --from 1 --to 14
 *
 * Notes:
 * - Overwrites the pano JPGs in-place (writes temp then renames).
 * - Sets `stereo:true` on matching nodes in walkthrough.json.
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";

const ROOT = process.cwd();
const EXPERIENCES = path.join(ROOT, "public", "experiences");

function parseArgs(argv) {
  const out = { exp: "", from: 1, to: 14, prefix: "panorama_", ext: "jpg", quality: 90 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exp") out.exp = String(argv[++i] ?? "").trim();
    else if (a === "--from") out.from = Number.parseInt(String(argv[++i] ?? "1"), 10);
    else if (a === "--to") out.to = Number.parseInt(String(argv[++i] ?? "14"), 10);
    else if (a === "--prefix") out.prefix = String(argv[++i] ?? "panorama_");
    else if (a === "--ext") out.ext = String(argv[++i] ?? "jpg").replace(/^\./, "").toLowerCase();
    else if (a === "--quality") out.quality = Number.parseInt(String(argv[++i] ?? "90"), 10);
  }
  return out;
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function coerceWalkthroughCandidate(raw) {
  return (raw && (raw.data || raw.project)) || raw || {};
}

async function makeTopBottomStereoJpg(filePath, { quality = 90 } = {}) {
  const img = sharp(filePath, { failOnError: false });
  const meta = await img.metadata();
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  if (!width || !height) throw new Error(`Invalid image metadata for ${filePath}`);

  // Guard: avoid double-converting images that are already vertically stacked (TB stereo or worse).
  // Mono equirect is typically 2:1 (h/w ≈ 0.5). TB stereo is 1:1 (h/w ≈ 1.0).
  // If we duplicate again, we end up with quad-stacked output (h/w ≈ 2.0).
  const ratioHW = height / width;
  if (ratioHW >= 0.85) {
    return { skipped: true, width, height, ratioHW };
  }

  const buf = await img.toBuffer();
  const outHeight = height * 2;

  const tmp = `${filePath}.tmp`;
  await sharp({
    create: {
      width,
      height: outHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: buf, left: 0, top: 0 },
      { input: buf, left: 0, top: height },
    ])
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toFile(tmp);

  await fs.promises.rename(tmp, filePath);
  return { skipped: false, width, height, outHeight, ratioHW };
}

async function updateWalkthroughStereoFlags(expDir, filesSet) {
  const walkthroughPath = path.join(expDir, "walkthrough.json");
  if (!(await exists(walkthroughPath))) return { updated: false };

  const rawText = await fs.promises.readFile(walkthroughPath, "utf8");
  const raw = JSON.parse(rawText);
  const candidate = coerceWalkthroughCandidate(raw);
  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : null;
  if (!nodes) return { updated: false };

  let changed = false;
  for (const n of nodes) {
    const f = String(n?.file || "").trim();
    if (!filesSet.has(f)) continue;
    if (n.stereo !== true) {
      n.stereo = true;
      changed = true;
    }
  }

  if (!changed) return { updated: false };
  await fs.promises.writeFile(walkthroughPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { updated: true };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.exp) {
    console.error("Missing --exp <experience folder>");
    process.exit(2);
  }

  const expDir = path.join(EXPERIENCES, args.exp);
  const panosDir = path.join(expDir, "panos");
  if (!(await exists(panosDir))) {
    console.error(`[stereo] panos dir not found: ${panosDir}`);
    process.exit(2);
  }

  const from = Number.isFinite(args.from) ? args.from : 1;
  const to = Number.isFinite(args.to) ? args.to : 14;
  const quality = Number.isFinite(args.quality) ? Math.max(60, Math.min(95, args.quality)) : 90;

  const files = [];
  for (let i = from; i <= to; i++) {
    files.push(`${args.prefix}${i}.${args.ext}`);
  }

  let total = 0;
  let converted = 0;
  const filesSet = new Set(files);

  for (const f of files) {
    const p = path.join(panosDir, f);
    if (!(await exists(p))) {
      console.warn(`[stereo] missing: ${path.relative(ROOT, p)}`);
      continue;
    }
    total++;
    try {
      const res = await makeTopBottomStereoJpg(p, { quality });
      if (res?.skipped) {
        console.log(`\n[stereo] skip (already stacked h/w=${Number(res.ratioHW || 0).toFixed(3)}): ${path.relative(ROOT, p)}`);
      } else {
        converted++;
        process.stdout.write(".");
      }
    } catch (e) {
      console.error(`\n[stereo] failed: ${path.relative(ROOT, p)}\n${e?.message || e}`);
    }
  }

  const wt = await updateWalkthroughStereoFlags(expDir, filesSet);
  console.log(`\n[stereo] exp:${args.exp} total:${total} converted:${converted} walkthroughUpdated:${wt.updated ? 1 : 0}`);
})().catch((e) => {
  console.error("[stereo] fatal:", e?.message || e);
  process.exit(1);
});

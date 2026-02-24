#!/usr/bin/env node
/**
 * Fixes "quad-stacked" TOP/BOTTOM stereo panos that were accidentally duplicated again.
 *
 * Example problem:
 * - Correct TB stereo:   w=8192, h=8192  (2 vertical slices)
 * - Quad-stacked stereo: w=8192, h=16384 (4 vertical slices; TB duplicated)
 *
 * This script collapses any pano where `h >= ~1.8*w` by keeping ONLY the top half,
 * resulting in a proper TB stereo image.
 *
 * Usage:
 *   node scripts/fix-quadstack-stereo.mjs --exp skywalk --from 1 --to 14
 *
 * Options:
 *   --exp <folder>     Experience folder under `public/experiences/`
 *   --from <n>         Start panorama number (default 1)
 *   --to <n>           End panorama number (default 14)
 *   --prefix <str>     Filename prefix (default "panorama_")
 *   --ext <jpg|png>    Source extension (default "jpg")
 *   --backup           Copy originals into `backup/quadstack/<exp>/` before overwrite
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";

const ROOT = process.cwd();
const EXPERIENCES = path.join(ROOT, "public", "experiences");

function parseArgs(argv) {
  const out = { exp: "", from: 1, to: 14, prefix: "panorama_", ext: "jpg", backup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exp") out.exp = String(argv[++i] ?? "").trim();
    else if (a === "--from") out.from = Number.parseInt(String(argv[++i] ?? "1"), 10);
    else if (a === "--to") out.to = Number.parseInt(String(argv[++i] ?? "14"), 10);
    else if (a === "--prefix") out.prefix = String(argv[++i] ?? "panorama_");
    else if (a === "--ext") out.ext = String(argv[++i] ?? "jpg").replace(/^\./, "").toLowerCase();
    else if (a === "--backup") out.backup = true;
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

async function copyIfNeeded(src, destRoot) {
  if (!(await exists(src))) return false;
  const dest = path.join(destRoot, path.basename(src));
  if (await exists(dest)) return true;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest);
  return true;
}

async function collapseTopHalf(filePath) {
  const img = sharp(filePath, { failOnError: false });
  const meta = await img.metadata();
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  if (!width || !height) throw new Error(`Invalid image metadata: ${filePath}`);

  // Detect quad-stack (or more generally, "very tall" stacks).
  const ratioHW = height / width;
  const looksQuadStack = ratioHW >= 1.8; // ~2.0 for quad-stacked TB (h ≈ 2w)
  if (!looksQuadStack) return { changed: false, width, height, ratioHW };

  const outHeight = Math.floor(height / 2);
  const tmp = `${filePath}.tmp`;
  await img
    .extract({ left: 0, top: 0, width, height: outHeight })
    .jpeg({ quality: 92, progressive: true, mozjpeg: true })
    .toFile(tmp);
  await fs.promises.rename(tmp, filePath);
  return { changed: true, width, height, ratioHW, outHeight };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.exp) {
    console.error("Missing --exp <experience folder>");
    process.exit(2);
  }
  const from = Number.isFinite(args.from) ? Math.max(1, args.from) : 1;
  const to = Number.isFinite(args.to) ? Math.max(from, args.to) : from;
  const ext = String(args.ext || "jpg").toLowerCase();

  const expDir = path.join(EXPERIENCES, args.exp);
  const panosDir = path.join(expDir, "panos");
  if (!(await exists(panosDir))) {
    console.error(`[fix] panos dir not found: ${panosDir}`);
    process.exit(2);
  }

  const backupDir = path.join(ROOT, "backup", "quadstack", args.exp);
  let inspected = 0;
  let changed = 0;
  let backedUp = 0;

  for (let i = from; i <= to; i++) {
    const file = `${args.prefix}${i}.${ext}`;
    const p = path.join(panosDir, file);
    if (!(await exists(p))) {
      console.warn(`[fix] missing: ${path.relative(ROOT, p)}`);
      continue;
    }
    inspected++;

    try {
      if (args.backup) {
        const ok1 = await copyIfNeeded(p, backupDir);
        const ktx = p.replace(/\.(png|jpe?g)$/i, ".ktx2");
        const ok2 = await copyIfNeeded(ktx, backupDir);
        if (ok1) backedUp++;
        if (ok2) backedUp++;
      }

      const res = await collapseTopHalf(p);
      if (res.changed) {
        changed++;
        console.log(`[fix] collapsed: ${args.exp}/${file} (h/w=${res.ratioHW.toFixed(3)})`);
      } else {
        console.log(`[fix] ok:        ${args.exp}/${file} (h/w=${res.ratioHW.toFixed(3)})`);
      }
    } catch (e) {
      console.error(`[fix] FAILED: ${args.exp}/${file}\n${e?.message || e}`);
    }
  }

  console.log("=".repeat(60));
  console.log(`[fix] inspected: ${inspected}  changed: ${changed}  backups: ${args.backup ? backedUp : 0}`);
  if (args.backup) console.log(`[fix] backup dir: ${path.relative(ROOT, backupDir)}`);
  console.log("=".repeat(60));
  console.log(`[fix] Next: regenerate KTX2 for this experience:\n[fix]   node scripts/compress-panos-ktx2.mjs --exp \"${args.exp}\"`);
})().catch((e) => {
  console.error("[fix] fatal:", e?.message || e);
  process.exit(1);
});


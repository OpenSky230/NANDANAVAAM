#!/usr/bin/env node
/**
 * Generate missing `.jpg` panos from existing `.ktx2` panos.
 *
 * Why:
 * - Some experiences may contain KTX2-only panos (no source .png/.webp/.jpg).
 * - The viewer can fall back to `.jpg` when KTX2 is disabled/unavailable.
 *
 * Behavior:
 * - Scans `public/experiences/<experience>/panos/*.ktx2` (recursively)
 * - For each `*.ktx2` that lacks sibling `*.jpg`, it:
 *   1) `ktx extract` -> temp PNG (OS temp)
 *   2) converts temp PNG -> sibling JPG via `sharp`
 *   3) deletes the temp PNG
 */
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { spawn } from "child_process";

const ROOT = process.cwd();
const EXPERIENCES_DIR = path.join(ROOT, "public", "experiences");
const KTX_BIN = path.join(ROOT, "tools", "ktx", "bin");
const KTX = process.platform === "win32" ? path.join(KTX_BIN, "ktx.exe") : path.join(KTX_BIN, "ktx");

async function* walk(dir) {
  let ents = [];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function isPanoKtx2(filePath) {
  return /[\\/]panos[\\/].+\.ktx2$/i.test(filePath);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${path.basename(cmd)} exited ${code}\n${err || out}`));
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniqueTempPng(stem = "pano") {
  const base = path.join(os.tmpdir(), `nandanavanam-ktx2-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(base, { recursive: true });
  return path.join(base, `${stem}.png`);
}

async function main() {
  if (!(await exists(KTX))) {
    console.error(`[ktx2->jpg] missing KTX tool: ${KTX}`);
    process.exit(2);
  }

  let sharpMod;
  try {
    const m = await import("sharp");
    sharpMod = m?.default || m;
  } catch (e) {
    console.error("[ktx2->jpg] sharp not available:", e?.message || e);
    process.exit(2);
  }
  const sharp = sharpMod;

  let total = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for await (const file of walk(EXPERIENCES_DIR)) {
    if (!isPanoKtx2(file)) continue;
    total++;

    const jpgPath = file.replace(/\.ktx2$/i, ".jpg");
    if (await exists(jpgPath)) {
      skipped++;
      continue;
    }

    const tempPng = await uniqueTempPng(path.parse(file).name);
    try {
      await run(KTX, ["extract", file, tempPng], { cwd: ROOT });
      await fs.mkdir(path.dirname(jpgPath), { recursive: true });
      await sharp(tempPng)
        .flatten({ background: "#000" })
        .jpeg({ quality: 88, progressive: true, mozjpeg: true })
        .toFile(jpgPath);
      created++;
      process.stdout.write(".");
    } catch (e) {
      failed++;
      console.error(`\n[ktx2->jpg] failed for ${file}\n${e?.message || e}`);
    } finally {
      try {
        await fs.unlink(tempPng);
      } catch {}
      try {
        await fs.rmdir(path.dirname(tempPng));
      } catch {}
    }
  }

  console.log(`\n[ktx2->jpg] total:${total} created:${created} skipped:${skipped} failed:${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[ktx2->jpg] fatal:", e?.message || e);
  process.exit(1);
});

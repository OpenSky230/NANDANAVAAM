#!/usr/bin/env node
/**
 * Generates `.ktx2` pano textures for Babylon (Quest-friendly).
 *
 * Default:
 * - Scans `public/experiences/<experience>/panos/*.{png,jpg,jpeg}`
 * - Writes sibling `*.ktx2`
 *
 * Options:
 * - `--exp "<folder name>"` to target one experience (example: "Villas Walkthrough")
 * - `--clevel <0..5>` (default 1)
 * - `--qlevel <1..255>` (default 128)
 * - `--threads <n>` (optional)
 * - `--only-png` (only convert `*.png` inside `panos/`)
 * - `--move-originals` (moves source images into `backup/panos-src/<exp>/`)
 */
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.cwd();
const EXPERIENCES_DIR = path.join(ROOT, "public", "experiences");
const TOOLS_DIR = path.join(ROOT, "tools", "ktx", "bin");
const TOKTX = process.platform === "win32" ? path.join(TOOLS_DIR, "toktx.exe") : path.join(TOOLS_DIR, "toktx");

function parseArgs(argv) {
  const out = { exp: null, clevel: 1, qlevel: 128, threads: null, onlyPng: false, moveOriginals: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exp") out.exp = String(argv[++i] ?? "").trim();
    else if (a === "--clevel") out.clevel = Number.parseInt(String(argv[++i] ?? ""), 10);
    else if (a === "--qlevel") out.qlevel = Number.parseInt(String(argv[++i] ?? ""), 10);
    else if (a === "--threads") out.threads = Number.parseInt(String(argv[++i] ?? ""), 10);
    else if (a === "--only-png") out.onlyPng = true;
    else if (a === "--move-originals") out.moveOriginals = true;
  }
  return out;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

function isPanoImage(file, { onlyPng = false } = {}) {
  if (!/[\\/]panos[\\/]/i.test(file)) return false;
  if (/panos-mobile/i.test(file)) return false;
  if (onlyPng) return /\.png$/i.test(file);
  return /\.(png|jpe?g)$/i.test(file);
}

function toKtx2Path(srcPath) {
  return srcPath.replace(/\.(png|jpe?g)$/i, ".ktx2");
}

function runToktx(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(TOKTX, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`toktx exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function uniqueBackupPath(dest) {
  if (!(await exists(dest))) return dest;
  const parsed = path.parse(dest);
  for (let i = 1; i <= 999; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}__dup${i}${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}__dup${Date.now()}${parsed.ext}`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!(await exists(TOKTX))) {
    console.error(`[ktx2] missing encoder: ${TOKTX}`);
    console.error(`[ktx2] install KTX-Software and place tools in: ${TOOLS_DIR}`);
    process.exit(2);
  }

  const clevel = Number.isFinite(args.clevel) ? Math.max(0, Math.min(5, args.clevel)) : 1;
  const qlevel = Number.isFinite(args.qlevel) ? Math.max(1, Math.min(255, args.qlevel)) : 128;
  const threads = Number.isFinite(args.threads) ? Math.max(1, Math.min(64, args.threads)) : null;

  const exps = [];
  const entries = await fs.readdir(EXPERIENCES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (args.exp && e.name !== args.exp) continue;
    exps.push(e.name);
  }
  if (!exps.length) {
    console.error(args.exp ? `[ktx2] experience not found: ${args.exp}` : "[ktx2] no experiences found");
    process.exit(2);
  }

  const backupRoot = path.join(ROOT, "backup", "panos-src");
  if (args.moveOriginals) await fs.mkdir(backupRoot, { recursive: true });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let moved = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const expId of exps) {
    const expDir = path.join(EXPERIENCES_DIR, expId);
    for await (const file of walk(expDir)) {
      if (!isPanoImage(file, { onlyPng: args.onlyPng })) continue;

      const outFile = toKtx2Path(file);
      if (outFile === file) continue;

      const [srcStat, dstStat] = await Promise.allSettled([fs.stat(file), fs.stat(outFile)]);
      if (srcStat.status !== "fulfilled") continue;
      const srcMtime = +srcStat.value.mtime;
      if (dstStat.status === "fulfilled" && +dstStat.value.mtime >= srcMtime) {
        skipped++;
        bytesIn += srcStat.value.size;
        bytesOut += dstStat.value.size;
        if (args.moveOriginals) {
          const initialDest = path.join(backupRoot, expId, path.basename(file));
          const dest = await uniqueBackupPath(initialDest);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(file, dest);
          moved++;
        }
        continue;
      }

      processed++;
      bytesIn += srcStat.value.size;
      process.stdout.write(`[ktx2] ${expId}: ${path.basename(file)} -> ${path.basename(outFile)}\n`);

      const cmd = [
        "--t2",
        "--encode",
        "etc1s",
        "--clevel",
        String(clevel),
        "--qlevel",
        String(qlevel),
        ...(threads ? ["--threads", String(threads)] : []),
        outFile,
        file,
      ];

      try {
        await fs.mkdir(path.dirname(outFile), { recursive: true });
        await runToktx(cmd, { cwd: ROOT });
        const outStat = await fs.stat(outFile);
        bytesOut += outStat.size;

        if (args.moveOriginals) {
          const initialDest = path.join(backupRoot, expId, path.basename(file));
          const dest = await uniqueBackupPath(initialDest);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(file, dest);
          moved++;
        }
      } catch (e) {
        failed++;
        console.error(`[ktx2] FAILED: ${file}\n${e?.message || e}`);
      }
    }
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log("=".repeat(60));
  console.log(`[ktx2] processed: ${processed}  skipped: ${skipped}  failed: ${failed}  moved: ${moved}`);
  console.log(`[ktx2] in:  ${mb(bytesIn)} MB`);
  console.log(`[ktx2] out: ${mb(bytesOut)} MB`);
  if (bytesIn > 0 && bytesOut > 0) {
    const savings = ((1 - bytesOut / bytesIn) * 100).toFixed(1);
    console.log(`[ktx2] savings: ${savings}%`);
  }
  if (args.moveOriginals) {
    console.log(`[ktx2] originals moved to: ${path.relative(ROOT, backupRoot)}`);
  }
  console.log("=".repeat(60));
})().catch((e) => {
  console.error("[ktx2] fatal:", e?.message || e);
  process.exit(1);
});

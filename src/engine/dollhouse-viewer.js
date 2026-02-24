import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  MeshBuilder,
  HemisphericLight,
  DirectionalLight,
  SceneLoader,
  Color4,
  StandardMaterial,
  Color3,
  PointerEventTypes,
  TransformNode,
  Ray,
  CubeTexture,
  ImageProcessingConfiguration,
} from "@babylonjs/core";
import "@babylonjs/loaders";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
// The dollhouse GLB uses KHR_materials_pbrSpecularGlossiness for its diffuse colors (greens/browns).
// Ensure the extension is registered in tree-shaken builds.
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_pbrSpecularGlossiness";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";

const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");

function safeText(el, text) {
  try {
    if (!el) return;
    el.textContent = String(text || "");
  } catch {}
}

function qsNumber(key, fallback) {
  try {
    const qs = new URLSearchParams(location.search || "");
    const raw = qs.get(key);
    if (raw == null || raw === "") return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function qsString(key, fallback) {
  try {
    const qs = new URLSearchParams(location.search || "");
    const raw = qs.get(key);
    if (raw == null || raw === "") return fallback;
    return String(raw);
  } catch {
    return fallback;
  }
}

function pickUrlCandidates(modelUrl) {
  const raw = String(modelUrl || "").trim();
  if (!raw) return [];
  if (/\.(?:glb|gltf)(?:$|\?)/i.test(raw)) return [raw];
  return [`${raw}.glb`, `${raw}.gltf`];
}

function splitBaseAndFile(url) {
  const u = new URL(String(url), window.location.href);
  const parts = u.pathname.split("/");
  const file = parts.pop() || "";
  const basePath = parts.join("/") + "/";
  const base = `${u.origin}${basePath}`;
  return { base, file };
}

function computeDprCap() {
  try {
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    return Math.min(2, dpr);
  } catch {
    return 1;
  }
}

export function createDollhouseViewer({ canvas, statusEl } = {}) {
  let engine = null;
  let scene = null;
  let camera = null;
  let preferredAlpha = -Math.PI / 2;
  let preferredBeta = Math.PI / 10;
  let preferredRadius = 6;
  let preferredTargetY = 0.8;
  let hotspotRoot = null;
  let hotspotClick = null;
  let lastExtents = null;
  let hotspotScaleEnabled = true;
  let modelRootNode = null;
  let anchorToSceneMatrix = null;
  let modelPickSet = null;
  let disposed = false;
  let rafRunning = false;

  function toV3(p) {
    if (!p) return null;
    const x = Number(p.x), y = Number(p.y), z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return new Vector3(x, y, z);
  }

  function findNodeByName(name) {
    const q = String(name || "").trim();
    if (!q || !scene) return null;
    try {
      const direct = scene.getNodeByName?.(q);
      if (direct) return direct;
    } catch {}
    try {
      const needle = q.toLowerCase();
      const list = []
        .concat(Array.isArray(scene.transformNodes) ? scene.transformNodes : [])
        .concat(Array.isArray(scene.meshes) ? scene.meshes : []);
      return (
        list.find((m) => String(m?.name || "").trim().toLowerCase() === needle) ||
        list.find((m) => String(m?.name || "").trim().toLowerCase() === needle.replace(/\s+/g, "_")) ||
        list.find((m) => String(m?.name || "").trim().toLowerCase() === needle.replace(/\s+/g, "-")) ||
        list.find((m) => String(m?.name || "").trim().toLowerCase().includes(needle)) ||
        null
      );
    } catch {
      return null;
    }
  }

  function pickableMeshesForNode(node) {
    try {
      if (!node) return null;
      const set = new Set();
      try {
        if (node.getChildMeshes) {
          const kids = node.getChildMeshes(true) || [];
          for (const k of kids) set.add(k);
        }
      } catch {}
      // If node is itself a mesh, include it.
      try {
        if (node.getClassName && String(node.getClassName()) === "Mesh") set.add(node);
      } catch {}
      return set.size ? set : null;
    } catch {
      return null;
    }
  }

  function projectToMeshesSurface({ allowed, worldPos, worldNormal }) {
    try {
      if (!scene || !allowed || !worldPos) return null;
      const n = worldNormal && worldNormal.lengthSquared() > 1e-10 ? worldNormal.normalize() : new Vector3(0, 1, 0);
      let offset = 20;
      try {
        const ext = getExtents();
        const min = ext?.min;
        const max = ext?.max;
        if (min && max) {
          const size = max.subtract(min);
          const maxDim = Math.max(0.001, Math.abs(size.x), Math.abs(size.y), Math.abs(size.z));
          offset = Math.max(10, Math.min(300, maxDim * 0.04));
        }
      } catch {}

      const pred = (m) => allowed.has(m);
      const tryRay = (dir) => {
        const origin = worldPos.add(dir.scale(offset));
        const ray = new Ray(origin, dir.scale(-1), offset * 2.2);
        const hit = scene.pickWithRay(ray, pred, false);
        if (hit?.hit && hit.pickedPoint) {
          let normal = null;
          try {
            const nn = hit.getNormal?.(true);
            if (nn && Number.isFinite(nn.x) && Number.isFinite(nn.y) && Number.isFinite(nn.z)) normal = nn.clone();
          } catch {}
          return { point: hit.pickedPoint.clone(), normal };
        }
        return null;
      };
      // Try both directions (normal could be flipped depending on space).
      return tryRay(n) || tryRay(n.scale(-1));
    } catch {
      return null;
    }
  }

  function ensure() {
    if (disposed) throw new Error("Dollhouse viewer is disposed");
    if (!canvas) throw new Error("Missing canvas");
    if (engine && scene && camera) return;

    engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      premultipliedAlpha: false,
    });
    try {
      engine.setHardwareScalingLevel(1 / computeDprCap());
    } catch {}

    scene = new Scene(engine);
    // Opaque dark background (matches typical glTF viewers, e.g. #191919).
    const bg = Math.max(0, Math.min(1, qsNumber("dhBg", 0.098)));
    scene.clearColor = new Color4(bg, bg, bg, 1);

    preferredAlpha = qsNumber("dhAlpha", -Math.PI / 2);
    // ArcRotateCamera beta is the polar angle from the Y axis (0 = top-down).
    // Default to a top-down view so the plan is readable.
    preferredBeta = qsNumber("dhBeta", Math.PI / 10);
    preferredRadius = qsNumber("dhRadius", 6);
    preferredTargetY = qsNumber("dhTargetY", 0.8);

    camera = new ArcRotateCamera(
      "dollhouseCam",
      preferredAlpha,
      preferredBeta,
      preferredRadius,
      new Vector3(0, preferredTargetY, 0),
      scene
    );
    camera.attachControl(canvas, true);
    camera.allowUpsideDown = false;
    camera.panningSensibility = 0;
    camera.lowerBetaLimit = 0.05;
    camera.upperBetaLimit = Math.PI / 2.02;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = Math.max(0, qsNumber("dhAmbient", 0.32));
    const dir = new DirectionalLight("dir", new Vector3(-0.35, -1, -0.55), scene);
    // Slightly lower than glTF Viewer defaults to avoid washing out flat top-facing surfaces.
    dir.intensity = Math.max(0, qsNumber("dhDirect", 1.85));
    const dir2 = new DirectionalLight("dirFill", new Vector3(0.55, -0.8, 0.25), scene);
    dir2.intensity = Math.max(0, qsNumber("dhFill", 0.15));

    // Add an environment (HDRI-like reflections) + tone mapping so the GLB doesn't look flat.
    try {
      const envUrl = (BASE_URL + "environments/environmentSpecular.env").replace(/\/{2,}/g, "/");
      const envTex = CubeTexture.CreateFromPrefilteredData(envUrl, scene);
      scene.environmentTexture = envTex;
      scene.environmentIntensity = Math.max(0, qsNumber("dhEnv", 1.0));
      // Image processing: a bit more pop without blowing out highlights.
      const ip = scene.imageProcessingConfiguration;
      ip.toneMappingEnabled = true;
      // Default to "neutral" (like <model-viewer tone-mapping="neutral">) to preserve color in highlights.
      const tone = String(qsString("dhTone", "neutral")).trim().toLowerCase();
      if (tone === "off" || tone === "none" || tone === "linear") {
        ip.toneMappingEnabled = false;
      } else {
        ip.toneMappingEnabled = true;
        ip.toneMappingType =
          (tone === "aces") ? ImageProcessingConfiguration.TONEMAPPING_ACES :
          (tone === "standard") ? ImageProcessingConfiguration.TONEMAPPING_STANDARD :
          ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
      }
      ip.exposure = Math.max(0.1, qsNumber("dhExposure", 1.0));
      ip.contrast = Math.max(0, qsNumber("dhContrast", 1.0));
      try {
        const dither = Math.max(0, Math.min(2, qsNumber("dhDither", 0)));
        ip.ditheringEnabled = dither > 0.001;
        ip.ditheringIntensity = dither;
      } catch {}

      // Slight saturation boost (helps match glTF viewer rendering on unlit textures too).
      const sat = qsNumber("dhSat", 28); // slider-style [-100..100]
      ip.colorCurvesEnabled = true;
      const cc = new ColorCurves();
      cc.globalSaturation = Math.max(-100, Math.min(100, sat));
      ip.colorCurves = cc;

      // Subtle vignette like many viewers.
      const vig = Math.max(0, qsNumber("dhVig", 0));
      ip.vignetteEnabled = vig > 0.001;
      if (ip.vignetteEnabled) {
        ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
        ip.vignetteColor = new Color4(0, 0, 0, 1);
        ip.vignetteWeight = vig;
        ip.vignetteStretch = 0.1;
      }
    } catch {}

    hotspotRoot = new TransformNode("hotspotRoot", scene);
    hotspotRoot.metadata = hotspotRoot.metadata || {};

    // Hotspot picking without breaking ArcRotateCamera controls.
    // We detect "click" on pointerup with small movement, then do a pick restricted to hotspots.
    try {
      let downX = 0;
      let downY = 0;
      let downAt = 0;
      const MOVE_PX = 7;
      const CLICK_MS = 450;
      const pred = (m) => {
        try {
          const md = m?.metadata || m?.parent?.metadata || null;
          return Boolean(md && md.dollhouseHotspot === true);
        } catch {
          return false;
        }
      };
      const pickHotspot = () => {
        try {
          const hit = scene.pick(scene.pointerX, scene.pointerY, pred, false, camera);
          const md = hit?.pickedMesh?.metadata || hit?.pickedMesh?.parent?.metadata || null;
          return md && md.dollhouseHotspot === true ? md : null;
        } catch {
          return null;
        }
      };

      scene.onPointerObservable.add((poi) => {
        try {
          if (!poi) return;
          if (poi.type === PointerEventTypes.POINTERDOWN) {
            downX = Number(scene.pointerX) || 0;
            downY = Number(scene.pointerY) || 0;
            downAt = Date.now();
            return;
          }
          if (poi.type === PointerEventTypes.POINTERMOVE) {
            // Only do hover-pick when hotspots exist.
            const hasHotspots = (hotspotRoot?.getChildren?.()?.length || 0) > 0;
            if (!hasHotspots) return;
            const md = pickHotspot();
            try { canvas.style.cursor = md ? "pointer" : "grab"; } catch {}
            return;
          }
          if (poi.type === PointerEventTypes.POINTERUP) {
            const dx = Math.abs((Number(scene.pointerX) || 0) - downX);
            const dy = Math.abs((Number(scene.pointerY) || 0) - downY);
            const dt = Date.now() - downAt;
            if (dx > MOVE_PX || dy > MOVE_PX || dt > CLICK_MS) return;
            const md = pickHotspot();
            if (md && typeof hotspotClick === "function") hotspotClick(md);
          }
        } catch {}
      });
    } catch {}

    // Keep hotspots a roughly constant screen size for usability.
    try {
      scene.onBeforeRenderObservable.add(() => {
        try {
          if (!hotspotScaleEnabled) return;
          if (!hotspotRoot || !camera || !engine) return;
          const children = hotspotRoot.getChildren?.() || [];
          if (!children.length) return;

          const height = Math.max(1, Number(engine.getRenderHeight?.(true) || engine.getRenderHeight?.() || 0) || 1);
          const fov = Math.max(0.2, Number(camera.fov) || 1.0);
          const px = 30; // target size in screen pixels
          const tan = Math.tan(fov / 2);
          for (const n of children) {
            if (!n || typeof n.getAbsolutePosition !== "function") continue;
            const md = n.metadata || {};
            const bp = md?.basePos;
            const base =
              bp && Number.isFinite(Number(bp.x)) && Number.isFinite(Number(bp.y)) && Number.isFinite(Number(bp.z))
                ? new Vector3(Number(bp.x), Number(bp.y), Number(bp.z))
                : n.getAbsolutePosition();

            const p = base;
            const dist = Vector3.Distance(camera.position, p);
            // World size that subtends `px` pixels vertically at distance `dist`.
            const worldSize = (2 * dist * tan * px) / height;
            const s = Math.max(0.03, Math.min(80, worldSize / 2)); // disc diameter is 2 (radius 1)
            n.scaling.set(s, s, s);

            // Hover slightly above the surface so it's visible without moving the anchor.
            const lift = Math.max(0.02, Math.min(10, s * 0.85));
            const nn = md?.normal;
            const hasN = nn && Number.isFinite(Number(nn.x)) && Number.isFinite(Number(nn.y)) && Number.isFinite(Number(nn.z));
            if (hasN) {
              const v = new Vector3(Number(nn.x), Number(nn.y), Number(nn.z));
              if (v.lengthSquared() > 1e-8) v.normalize();
              n.position.copyFrom(base.add(v.scale(lift)));
            } else {
              n.position.copyFrom(base.add(new Vector3(0, lift, 0)));
            }
          }
        } catch {}
      });
    } catch {}

    if (!rafRunning) {
      rafRunning = true;
      engine.runRenderLoop(() => {
        try {
          if (!scene) return;
          scene.render();
        } catch {}
      });
    }
  }

  function clearSceneMeshes() {
    if (!scene) return;
    try {
      const meshes = scene.meshes.slice();
      meshes.forEach((m) => {
        if (!m) return;
        try {
          m.dispose(false, true);
        } catch {}
      });
    } catch {}
  }

  async function loadModel(modelUrl) {
    ensure();
    safeText(statusEl, "Loading 3D model…");

    clearSceneMeshes();
    clearHotspots();
    modelRootNode = null;
    anchorToSceneMatrix = null;
    modelPickSet = null;

    const candidates = pickUrlCandidates(modelUrl);
    let lastErr = null;
    for (const url of candidates) {
      try {
        const { base, file } = splitBaseAndFile(url);
        const res = await SceneLoader.ImportMeshAsync(null, base, file, scene);
        // Babylon glTF loader often creates a root node/mesh (e.g. "__root__") with transforms
        // (handedness conversion, scaling). Anchors exported in "model space" must be transformed
        // by this root matrix to line up with the rendered model.
        try {
          const tns = Array.isArray(res?.transformNodes) ? res.transformNodes : [];
          const rootTN =
            tns.find((n) => typeof n?.name === "string" && n.name === "__root__") ||
            tns.find((n) => typeof n?.name === "string" && n.name.startsWith("__root__")) ||
            null;
          const root = rootTN || null;
          if (root) {
            modelRootNode = root;
            try { root.computeWorldMatrix?.(true); } catch {}
            try { anchorToSceneMatrix = root.getWorldMatrix?.().clone?.() || root.getWorldMatrix?.() || null; } catch { anchorToSceneMatrix = null; }
          } else {
            // Fallback: if no transform root was returned, use first parent-less mesh.
            const meshes = Array.isArray(res?.meshes) ? res.meshes : [];
            const m0 = meshes.find((m) => m && !m.parent) || null;
            if (m0) {
              modelRootNode = m0;
              try { m0.computeWorldMatrix?.(true); } catch {}
              try { anchorToSceneMatrix = m0.getWorldMatrix?.().clone?.() || m0.getWorldMatrix?.() || null; } catch { anchorToSceneMatrix = null; }
            }
          }
        } catch {}

        // Ensure imported meshes are pickable (authoring tool used picking to place anchors).
        try {
          const meshes = Array.isArray(res?.meshes) ? res.meshes : [];
          modelPickSet = new Set();
          for (const m of meshes) {
            try {
              if (!m) continue;
              m.isPickable = true;
              // Ignore placeholder root meshes and any future hotspot meshes.
              const nm = String(m.name || "");
              if (nm.startsWith("hs_") || nm.startsWith("chip_")) continue;
              modelPickSet.add(m);
            } catch {}
          }
          if (!modelPickSet.size) modelPickSet = null;
        } catch {}

        // Make the dollhouse model look less flat: boost env reflections a bit (PBR only).
        try {
          const meshes = Array.isArray(res?.meshes) ? res.meshes : [];
          const mats = new Set();
          for (const m of meshes) {
            const mat = m?.material || null;
            if (mat) mats.add(mat);
          }
          const specScale = Math.max(0, Math.min(1, qsNumber("dhSpec", 0.22)));
          const microMax = Math.max(0.05, Math.min(1, qsNumber("dhMicro", 0.72)));
          for (const mat of mats) {
            try {
              const cls = typeof mat?.getClassName === "function" ? String(mat.getClassName() || "") : "";
              const isPbr = /PBR/i.test(cls);
              if (!isPbr) continue;
              // Ensure albedo/diffuse textures are treated as sRGB (brings back expected colors).
              try {
                const t = mat.albedoTexture || mat.diffuseTexture || null;
                if (t) t.gammaSpace = true;
              } catch {}
              // Reduce specular/gloss so top-down views don't wash out to white.
              try {
                if (mat.reflectivityColor && typeof mat.reflectivityColor.scaleInPlace === "function") {
                  mat.reflectivityColor.scaleInPlace(specScale);
                } else if (mat.reflectivityColor && typeof mat.reflectivityColor.scale === "function") {
                  mat.reflectivityColor = mat.reflectivityColor.scale(specScale);
                }
              } catch {}
              try {
                if (typeof mat.microSurface === "number") {
                  mat.microSurface = Math.min(mat.microSurface, microMax);
                }
              } catch {}
              try {
                if (typeof mat.specularIntensity === "number") {
                  mat.specularIntensity = Math.min(mat.specularIntensity, Math.max(0, specScale));
                }
              } catch {}
              if (typeof mat.environmentIntensity === "number") mat.environmentIntensity = Math.max(mat.environmentIntensity, 1.35);
              if (typeof mat.roughness === "number") mat.roughness = Math.min(0.92, Math.max(0.15, mat.roughness));
            } catch {}
          }
        } catch {}

        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      safeText(statusEl, "Model not found (add dollhouse/model.glb).");
      throw lastErr;
    }

    try {
      const ext = scene.getWorldExtends();
      lastExtents = ext || null;
      const min = ext?.min;
      const max = ext?.max;
      const center = min && max ? min.add(max).scale(0.5) : Vector3.Zero();
      const size = min && max ? max.subtract(min) : new Vector3(2, 2, 2);
      const maxDim = Math.max(0.001, Math.abs(size.x), Math.abs(size.y), Math.abs(size.z));
      const radius = Math.max(2.5, maxDim * 1.35);
      camera.setTarget(center);
      camera.radius = radius;
      camera.lowerRadiusLimit = Math.max(1.2, radius * 0.25);
      camera.upperRadiusLimit = Math.max(radius * 5, radius + 10);
      camera.wheelPrecision = Math.max(40, 120 / (radius || 1));
      // Re-apply the preferred view angle after fitting to extents.
      // (alpha/beta are not touched by setTarget/radius.)
      try {
        const a = preferredAlpha;
        const b = preferredBeta;
        camera.alpha = Number.isFinite(a) ? a : camera.alpha;
        if (Number.isFinite(b)) camera.beta = Math.max(camera.lowerBetaLimit ?? 0, Math.min(camera.upperBetaLimit ?? Math.PI, b));
      } catch {}
    } catch {}

    safeText(statusEl, "");
    try {
      engine.resize();
    } catch {}
  }

  function clearHotspots() {
    try {
      const children = hotspotRoot?.getChildren?.() || [];
      for (const n of children) {
        try { n?.dispose?.(false, true); } catch {}
      }
    } catch {}
  }

  function setHotspots(items = [], { onPick, flipZ = false, flipX = false, autoFit = false, anchorScale = 1 } = {}) {
    ensure();
    clearHotspots();
    hotspotClick = typeof onPick === "function" ? onPick : null;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) return;

    const ext = getExtents();
    const extMin = ext?.min || null;
    const extMax = ext?.max || null;
    const extCenter =
      extMin && extMax
        ? extMin.add(extMax).scale(0.5)
        : null;
    const modelRangeX = extMin && extMax ? (extMax.x - extMin.x) : 0;
    const modelRangeZ = extMin && extMax ? (extMax.z - extMin.z) : 0;
    const scoreOutside = (p) => {
      try {
        if (!p || !extMin || !extMax) return 0;
        const dx = p.x < extMin.x ? (extMin.x - p.x) : (p.x > extMax.x ? (p.x - extMax.x) : 0);
        const dy = p.y < extMin.y ? (extMin.y - p.y) : (p.y > extMax.y ? (p.y - extMax.y) : 0);
        const dz = p.z < extMin.z ? (extMin.z - p.z) : (p.z > extMax.z ? (p.z - extMax.z) : 0);
        return dx * dx + dy * dy + dz * dz;
      } catch {
        return 0;
      }
    };

    // First pass: resolve anchor coordinate space (as-is/root-local/node-local) per hotspot.
    // We optionally do a second-pass auto-fit to correct global scale/offset mismatches.
    const prepared = [];
    const allowedForSurfaceGlobal = modelPickSet || null;
    for (const it of list) {
      const id = String(it?.id || "").trim();
      if (!id) continue;
      const label = typeof it?.label === "string" ? it.label : id;

      const nodeName = typeof it?.meshName === "string" ? it.meshName : null;
      const node = nodeName ? findNodeByName(nodeName) : null;
      const nodePickSet = node ? pickableMeshesForNode(node) : null;

      const srcPos = toV3(it?.position);
      if (!srcPos) continue;
      const srcNormal = toV3(it?.normal);

      let best = { kind: "as-is", pos: srcPos.clone(), normal: srcNormal ? srcNormal.clone() : null };
      let bestScore = Number.POSITIVE_INFINITY;
      const candidates = [];
      candidates.push({ kind: "as-is", pos: srcPos.clone(), normal: srcNormal ? srcNormal.clone() : null });
      try {
        if (anchorToSceneMatrix) {
          candidates.push({
            kind: "root-local",
            pos: Vector3.TransformCoordinates(srcPos, anchorToSceneMatrix),
            normal: srcNormal ? Vector3.TransformNormal(srcNormal, anchorToSceneMatrix) : null,
          });
        }
      } catch {}
      try {
        if (node) {
          node.computeWorldMatrix?.(true);
          const wm = node.getWorldMatrix?.();
          if (wm) {
            candidates.push({
              kind: "node-local",
              pos: Vector3.TransformCoordinates(srcPos, wm),
              normal: srcNormal ? Vector3.TransformNormal(srcNormal, wm) : null,
            });
          }
        }
      } catch {}

      const allowedForSurface = nodePickSet || allowedForSurfaceGlobal;
      for (const c of candidates) {
        if (!c?.pos || !Number.isFinite(c.pos.x) || !Number.isFinite(c.pos.y) || !Number.isFinite(c.pos.z)) continue;
        let score = 0;
        score += scoreOutside(c.pos);
        try {
          const nrm = c.normal && c.normal.lengthSquared() > 1e-10 ? c.normal.clone() : new Vector3(0, 1, 0);
          const proj = allowedForSurface ? projectToMeshesSurface({ allowed: allowedForSurface, worldPos: c.pos, worldNormal: nrm }) : null;
          if (proj?.point) {
            const d = Vector3.Distance(c.pos, proj.point);
            score += d * d;
          } else {
            score += 1e12;
          }
        } catch {
          score += 1e12;
        }
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }

      prepared.push({
        id,
        label,
        kind: best.kind,
        pos: best.pos.clone(),
        normal: best.normal ? best.normal.clone() : null,
      });
    }

    // Optional global auto-fit: align the prepared hotspot cloud to the model extents in X/Z.
    // This helps when anchors were captured from a differently-scaled/transformed GLB than the dollhouse model.
    let fit = null;
    try {
      if (autoFit && extCenter && prepared.length >= 3 && Number.isFinite(modelRangeX) && Number.isFinite(modelRangeZ)) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of prepared) {
          const v = p?.pos;
          if (!v) continue;
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.z < minZ) minZ = v.z;
          if (v.z > maxZ) maxZ = v.z;
        }
        const rawRangeX = maxX - minX;
        const rawRangeZ = maxZ - minZ;
        if (Number.isFinite(rawRangeX) && Number.isFinite(rawRangeZ) && rawRangeX > 1e-6 && rawRangeZ > 1e-6) {
          const sx = modelRangeX > 1e-6 ? (modelRangeX / rawRangeX) : 1;
          const sz = modelRangeZ > 1e-6 ? (modelRangeZ / rawRangeZ) : 1;
          let s = Math.sqrt(Math.abs(sx * sz));
          if (!Number.isFinite(s) || s <= 0) s = 1;
          s = Math.max(0.15, Math.min(8, s));
          fit = {
            s,
            rawCenter: new Vector3((minX + maxX) * 0.5, 0, (minZ + maxZ) * 0.5),
            modelCenter: extCenter.clone(),
          };
        }
      }
    } catch {}

    const mat = new StandardMaterial("hotspotMat", scene);
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(1.0, 0.82, 0.12);
    mat.alpha = 0.95;
    // Keep hotspots visible even when they overlap the model surface.
    try { mat.disableDepthWrite = true; } catch {}
    try { mat.zOffset = -2; } catch {}

    const ringMat = new StandardMaterial("hotspotRingMat", scene);
    ringMat.disableLighting = true;
    ringMat.emissiveColor = new Color3(1.0, 0.92, 0.28);
    ringMat.alpha = 0.55;
    try { ringMat.disableDepthWrite = true; } catch {}
    try { ringMat.zOffset = -2; } catch {}

    const manualScale = (() => {
      const s = Number(anchorScale);
      if (!Number.isFinite(s) || s <= 0) return 1;
      return Math.max(0.05, Math.min(20, s));
    })();

    for (const p of prepared) {
      const id = p.id;
      const label = p.label;
      let kind = p.kind;
      let basePosition = p.pos.clone();
      const srcNormal = p.normal ? p.normal.clone() : null;
      let worldNormal = srcNormal ? srcNormal.clone() : null;

      // Auto-fit scale+center (X/Z only) to align anchor cloud to model extents.
      if (fit) {
        try {
          basePosition.x = fit.modelCenter.x + (basePosition.x - fit.rawCenter.x) * fit.s;
          basePosition.z = fit.modelCenter.z + (basePosition.z - fit.rawCenter.z) * fit.s;
          kind = `${kind}+fit`;
        } catch {}
      }

      let normalUnit = null;
      try {
        const n = worldNormal || srcNormal;
        if (n && n.lengthSquared() > 1e-8) normalUnit = n.normalize();
      } catch {}

      // Optional global flips to align dollhouse zones with expected map orientation.
      // Flips are applied around the model bounds center so positions remain within the layout.
      if (extCenter && (flipZ || flipX)) {
        try {
          if (flipZ) {
            basePosition.z = (2 * extCenter.z) - basePosition.z;
            if (normalUnit) normalUnit.z = -normalUnit.z;
            kind = `${kind}+flipZ`;
          }
          if (flipX) {
            basePosition.x = (2 * extCenter.x) - basePosition.x;
            if (normalUnit) normalUnit.x = -normalUnit.x;
            kind = `${kind}+flipX`;
          }
        } catch {}
      }

      // Manual scale tweak (X/Z only) around model center for fine alignment.
      if (extCenter && manualScale !== 1) {
        try {
          basePosition.x = extCenter.x + (basePosition.x - extCenter.x) * manualScale;
          basePosition.z = extCenter.z + (basePosition.z - extCenter.z) * manualScale;
          kind = `${kind}+scale(${manualScale.toFixed(3)})`;
        } catch {}
      }

      // Keep anchor exact; hover offset is applied per-frame in onBeforeRender.
      const root = new TransformNode(`hs_${id}`, scene);
      root.parent = hotspotRoot;
      root.position.copyFrom(basePosition);
      root.metadata = {
        dollhouseHotspot: true,
        id,
        label,
        _debugKind: kind,
        basePos: { x: basePosition.x, y: basePosition.y, z: basePosition.z },
        ...(normalUnit ? { normal: { x: normalUnit.x, y: normalUnit.y, z: normalUnit.z } } : {}),
      };

      const disc = MeshBuilder.CreateDisc(`hs_disc_${id}`, { radius: 1, tessellation: 48, sideOrientation: 2 }, scene);
      disc.parent = root;
      disc.position.y = 0;
      disc.material = mat;
      disc.isPickable = true;
      disc.billboardMode = 7;
      disc.renderingGroupId = 3;
      // Put metadata on pickable meshes so predicates/picks work reliably.
      disc.metadata = root.metadata;

      const ring = MeshBuilder.CreateTorus(`hs_ring_${id}`, { diameter: 2.35, thickness: 0.18, tessellation: 64 }, scene);
      ring.parent = root;
      ring.rotation.x = Math.PI / 2;
      ring.material = ringMat;
      ring.isPickable = true;
      ring.renderingGroupId = 3;
      ring.metadata = root.metadata;

      const pin = MeshBuilder.CreateCylinder(`hs_pin_${id}`, { height: 1.05, diameterTop: 0.14, diameterBottom: 0.22, tessellation: 16 }, scene);
      pin.parent = root;
      pin.position.y = -0.52;
      pin.material = ringMat;
      pin.isPickable = false;
      pin.renderingGroupId = 3;
    }
  }

  function getExtents() {
    try {
      if (lastExtents?.min && lastExtents?.max) return lastExtents;
      return scene?.getWorldExtends?.() || null;
    } catch {
      return null;
    }
  }

  function findAnchorPosition(names = []) {
    try {
      const list = Array.isArray(names) ? names : [names];
      for (const n of list) {
        const q = String(n || "").trim();
        if (!q) continue;
        const node =
          scene?.getNodeByName?.(q) ||
          scene?.getNodeByName?.(q.replace(/\s+/g, "_")) ||
          scene?.getNodeByName?.(q.replace(/\s+/g, "-"));
        const pos = node?.getAbsolutePosition?.();
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
          return new Vector3(pos.x, pos.y, pos.z);
        }
      }
    } catch {}
    return null;
  }

  function resize() {
    try {
      engine?.resize?.();
    } catch {}
  }

  function dispose() {
    disposed = true;
    try {
      if (engine) engine.stopRenderLoop();
    } catch {}
    rafRunning = false;
    try {
      scene?.dispose?.();
    } catch {}
    try {
      engine?.dispose?.();
    } catch {}
    engine = null;
    scene = null;
    camera = null;
  }

  return {
    loadModel,
    setHotspots,
    clearHotspots,
    getExtents,
    findAnchorPosition,
    resize,
    dispose,
  };
}

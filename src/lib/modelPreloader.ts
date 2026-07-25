// Native-backed face detection bridge.
//
// The actual camera capture and landmark detection both run natively in
// Kotlin (NativeFaceDetector.kt, via CameraX + MediaPipe's on-device
// Android Face Landmarker SDK) - real device testing (here and
// independently via Codex with live ADB access) showed the same class of
// "X is not a function" failure across both the legacy MediaPipe
// Solutions runtime AND the current Tasks Vision WASM runtime, in the
// same WebView, so detection itself no longer runs in JS/WASM at all.
//
// This file's only job is to bridge native-pushed landmark results into
// the exact same {detector, fallback, fallbackActive} / estimateFaces()
// shape the rest of the app already expects, so FaceSecurityEngine.tsx's
// liveness engine, temporal consensus buffer, dual-metric matching, and
// multi-pose enrollment logic need zero changes - they still call
// model.estimateFaces(video) on the same schedule as before, they just
// receive native-sourced landmarks instead of WASM-sourced ones.
//
// Deliberately does NOT touch the WebView's own getUserMedia camera
// access, the visible <video> preview, or the pixel-analysis anti-
// spoofing layer (rPPG, moire/replay/texture checks) in
// FaceSecurityEngine.tsx - none of that ever depended on MediaPipe/WASM,
// none of it was broken, so none of it changes. Native runs as a second,
// independent camera consumer purely for landmark detection, started and
// stopped at the exact same points the app already starts/stops its own
// camera stream (see startNativeDetection/stopNativeDetection below) -
// NOT eagerly during preload, matching the original app's behavior of
// never opening the camera before the user actually needs it.

interface AdaptedFace {
  keypoints: { x: number; y: number; z?: number }[];
  box?: { xMin: number; yMin: number; width: number; height: number };
}

interface FaceModel {
  estimateFaces(video: HTMLVideoElement): Promise<AdaptedFace[]>;
}

let latestFaces: AdaptedFace[] = [];
let latestError: string | null = null;

// Registered once, globally - the App.tsx-owned Window.Android interface
// declaration already types window.Android; this file just needs the two
// native-bridge methods added there (startNativeFaceDetection,
// stopNativeFaceDetection) rather than declaring a competing/conflicting
// global interface of its own.
window.__nativeFaceResult = (json: string) => {
  let parsed: { type?: string; faces?: unknown; message?: string };
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.error('Failed to parse native face result JSON:', e, json);
    return;
  }

  if (parsed.type === 'faces') {
    const rawFaces = Array.isArray(parsed.faces) ? parsed.faces : [];
    latestFaces = rawFaces.map((face) => ({
      keypoints: Array.isArray(face)
        ? face.map((p: { x: number; y: number; z?: number }) => ({ x: p.x, y: p.y, z: p.z }))
        : [],
    }));
    latestError = null;
  } else if (parsed.type === 'error') {
    latestError = parsed.message || 'Unknown native face detector error';
    console.error('Native face detector reported an error:', latestError);
  }
};

const nativeFaceModel: FaceModel = {
  // The video parameter is part of the shared FaceModel interface (the
  // old WASM-backed implementation needed it; this one doesn't, since
  // native has its own independent camera frames) - intentionally
  // unused here.
  async estimateFaces(_video: HTMLVideoElement): Promise<AdaptedFace[]> {
    if (latestError) {
      throw new Error(latestError);
    }
    return latestFaces;
  },
};

let preloadingPromise: Promise<{ detector: FaceModel | null; fallback: FaceModel | null; fallbackActive: boolean }> | null = null;
let loadStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let nativeDetectionActive = false;

export function getModelLoadStatus(): 'idle' | 'loading' | 'ready' | 'error' {
  return loadStatus;
}

/**
 * Confirms the native detection bridge is available. Deliberately does
 * NOT start the camera - the model itself already loads eagerly on the
 * Kotlin side (NativeFaceDetector.setup(), called from
 * MainActivity.onCreate()) independent of anything JS does, so there's
 * no real async "model loading" left to wait for here the way the old
 * WASM version had. Camera access stays deferred to
 * startNativeDetection(), called from the exact same places the app
 * already starts its own getUserMedia stream.
 */
export function preloadModels(): Promise<{ detector: FaceModel | null; fallback: FaceModel | null; fallbackActive: boolean }> {
  if (preloadingPromise) return preloadingPromise;

  loadStatus = 'loading';
  preloadingPromise = (async () => {
    try {
      if (!window.Android?.startNativeFaceDetection) {
        throw new Error('Native face detection bridge unavailable (window.Android.startNativeFaceDetection missing) - are you running outside the Android app?');
      }
      loadStatus = 'ready';
      return { detector: nativeFaceModel, fallback: null, fallbackActive: false };
    } catch (err) {
      loadStatus = 'error';
      console.error('Native face detector preload check failed:', err);
      // Don't let a single failed attempt permanently poison every future
      // call for the rest of the app's process lifetime - reset the cache
      // so the next call gets a genuine fresh attempt.
      preloadingPromise = null;
      throw err;
    }
  })();

  return preloadingPromise;
}

export function getDetector(): FaceModel | null {
  return loadStatus === 'ready' ? nativeFaceModel : null;
}

export function getFallbackDetector(): FaceModel | null {
  // No JS-side fallback anymore - native's own FaceLandmarker-then-
  // FaceDetector fallback (see NativeFaceDetector.kt's setup()) happens
  // entirely on the Kotlin side and is transparent to this layer.
  return null;
}

export function isUsingFallback(): boolean {
  return false;
}

/**
 * Starts (or resumes) native camera detection. Idempotent - safe to call
 * even if already active. Call at the exact same points the app already
 * starts its own getUserMedia camera stream (session becoming active,
 * registration starting), so the native camera consumer's lifecycle
 * mirrors the WebView's own stream instead of opening early/eagerly.
 */
export function startNativeDetection(): void {
  if (nativeDetectionActive) return;
  const token = window.Android?.getSessionToken?.() ?? '';
  window.Android?.startNativeFaceDetection?.(token);
  nativeDetectionActive = true;
}

/**
 * Stops native camera detection, releasing that camera consumer. Call at
 * the exact same points the app already releases its own camera track,
 * so native doesn't hold the camera open longer than needed.
 */
export function stopNativeDetection(): void {
  if (!nativeDetectionActive) return;
  window.Android?.stopNativeFaceDetection?.();
  nativeDetectionActive = false;
}

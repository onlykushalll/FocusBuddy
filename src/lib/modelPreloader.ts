// Dynamic import() again — NOT reverting the actual fix, just relocating it.
// Root cause of "T is not a function", confirmed by reading the actual
// package source: an unconditional, top-level
// `import { loadGraphModel as T } from "@tensorflow/tfjs-converter"` inside
// face-landmarks-detection's own module, executed regardless of which
// runtime ('mediapipe' vs 'tfjs') actually gets selected. A dynamic import()
// boundary that cuts this dependency graph into MULTIPLE separate chunks is
// what breaks Rollup's resolution of that binding.
//
// The actual fix now lives in vite.config.ts's manualChunks: it forces the
// ENTIRE TF.js/face-detection/mediapipe dependency group into ONE chunk
// file, so Rollup resolves everything within that single file with no
// boundary cutting through it. That's what makes it safe to go back to a
// dynamic import() here — this only controls whether that one chunk loads
// eagerly (bundled into the main app chunk, which static import here
// caused, blocking initial parse/render) or lazily in the background, which
// is what the splash-screen parallel-loading design needs.
// Keep these imports static. The Android WebView evaluates their circular TF.js
// exports correctly only when the complete graph is initialized up front.
import * as faceLandmarks from '@tensorflow-models/face-landmarks-detection';
import * as faceDetection from '@tensorflow-models/face-detection';

let preloadingPromise: Promise<{ detector: any; fallback: any; fallbackActive: boolean }> | null = null;
let detectorInstance: any = null;
let fallbackInstance: any = null;
let usingFallback = false;
let loadStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';

export function getModelLoadStatus(): 'idle' | 'loading' | 'ready' | 'error' {
  return loadStatus;
}

export function preloadModels(): Promise<{ detector: any; fallback: any; fallbackActive: boolean }> {
  if (preloadingPromise) return preloadingPromise;

  loadStatus = 'loading';
  preloadingPromise = (async () => {
    try {
      // runtime: 'mediapipe' below uses Google's own MediaPipe WASM Solutions
      // engine — a completely separate execution path from TensorFlow.js's
      // backend system. The previous tf.setBackend('webgl')/tf.ready() calls
      // here set up a TF.js backend that this runtime mode never touches —
      // pure dead weight, and an extra WebGL context creation that competes
      // with whatever context budget the MediaPipe WASM runtime itself needs,
      // on exactly the kind of mobile GPU/WebView combos where that budget
      // is smallest and least consistent. Removed entirely.

      // Try FaceMesh
      try {
        detectorInstance = await faceLandmarks.createDetector(
          faceLandmarks.SupportedModels.MediaPipeFaceMesh,
          {
            runtime: 'mediapipe',
            refineLandmarks: true,
            maxFaces: 4,
            solutionPath: '/mediapipe',
          }
        );
        usingFallback = false;
        console.log("FaceMesh loaded successfully via preloader");
      } catch (meshErr) {
        console.error("FaceMesh load failed during preloading, trying BlazeFace:", meshErr);
        usingFallback = true;
        fallbackInstance = await faceDetection.createDetector(
          faceDetection.SupportedModels.MediaPipeFaceDetector,
          {
            runtime: 'mediapipe',
            maxFaces: 4,
            solutionPath: '/mediapipe'
          }
        );
        console.log("BlazeFace loaded successfully via preloader (fallback)");
      }

      loadStatus = 'ready';
      return {
        detector: detectorInstance,
        fallback: fallbackInstance,
        fallbackActive: usingFallback
      };
    } catch (err) {
      loadStatus = 'error';
      console.error("Preloading models failed:", err);
      // Don't let a single failed attempt (e.g. a transient WASM/network
      // hiccup on a cold start) permanently poison every future call for
      // the rest of the app's process lifetime. Reset the cache so the
      // next call — whether from a user retry, a component remount, or
      // the splash screen's own retry logic — gets a genuine fresh attempt
      // instead of instantly replaying this same stale rejection forever.
      preloadingPromise = null;
      throw err;
    }
  })();

  return preloadingPromise;
}

export function getDetector() {
  return detectorInstance;
}

export function getFallbackDetector() {
  return fallbackInstance;
}

export function isUsingFallback(): boolean {
  return usingFallback;
}

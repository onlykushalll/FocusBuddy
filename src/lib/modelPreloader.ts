import * as tf from '@tensorflow/tfjs';

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
      // Prefer WebGL; fallback to CPU
      try {
        await import('@tensorflow/tfjs-backend-webgl');
        await tf.setBackend('webgl');
      } catch (e) {
        console.warn("WebGL backend failed, using CPU:", e);
        await import('@tensorflow/tfjs-backend-cpu');
        await tf.setBackend('cpu');
      }
      await tf.ready();

      // Try FaceMesh
      try {
        const faceLandmarks = await import('@tensorflow-models/face-landmarks-detection');
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
        const faceDetection = await import('@tensorflow-models/face-detection');
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

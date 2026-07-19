// Migrated off the legacy MediaPipe "Solutions" web runtime
// (@tensorflow-models/face-landmarks-detection + face-detection, both
// running via runtime: 'mediapipe') onto MediaPipe's current, actively
// maintained Tasks Vision API (@mediapipe/tasks-vision: FaceLandmarker +
// FaceDetector).
//
// Why: extensive real on-device testing (both here and independently via
// Codex with live ADB access to the same phone) ruled out bundling,
// chunking, minification, and dynamic-vs-static imports as the cause of
// "X is not a function" during model load. The failure reproduced
// identically across every one of those variants, inside a single merged
// chunk, in both the primary (FaceMesh) and fallback (BlazeFace) code
// paths - strong evidence the legacy Solutions runtime itself has a real
// incompatibility with this WebView, not something fixable at the bundler
// layer. Tasks Vision is a different underlying loading mechanism
// entirely (no dependency on TF.js at all), not just another bundling
// variant of the same code.
//
// Everything downstream of this file - the liveness engine, temporal
// consensus buffer, dual-metric identity matching, multi-pose enrollment -
// is UNCHANGED. Those all operate on the same Kps = {x,y,z}[] shape,
// indexed positionally (LM.NOSE_TIP etc.) against MediaPipe's canonical
// 478-point face mesh topology, which Tasks Vision preserves exactly. The
// two estimateFaces() adapters below exist specifically so none of that
// code has to know anything changed.
import {
  FilesetResolver,
  FaceLandmarker,
  FaceDetector,
} from '@mediapipe/tasks-vision';

interface AdaptedFace {
  keypoints: { x: number; y: number; z?: number }[];
  box?: { xMin: number; yMin: number; width: number; height: number };
}

interface FaceModel {
  estimateFaces(video: HTMLVideoElement): Promise<AdaptedFace[]>;
}

// The old API returned keypoints in pixel space (matching the video's
// native dimensions), not normalized [0,1]. Tasks Vision's landmarks are
// normalized. Converting back to pixel space keeps every downstream
// consumer - descriptor math (scale-invariant, so this wouldn't have
// mattered), HUD box rendering (which does need real pixel coordinates) -
// working exactly as before, with no behavioral difference to account for.
function toPixelSpace(l: { x: number; y: number; z?: number }, video: HTMLVideoElement) {
  return { x: l.x * video.videoWidth, y: l.y * video.videoHeight, z: (l.z ?? 0) * video.videoWidth };
}

function wrapLandmarker(landmarker: FaceLandmarker): FaceModel {
  return {
    async estimateFaces(video: HTMLVideoElement): Promise<AdaptedFace[]> {
      const result = landmarker.detectForVideo(video, performance.now());
      return (result.faceLandmarks || []).map((landmarks): AdaptedFace => {
        const keypoints = landmarks.map(l => toPixelSpace(l, video));
        // Tasks Vision doesn't hand back a bounding box for FaceLandmarker
        // (only for FaceDetector) - deriving one from landmark extents is
        // a faithful equivalent for the HUD overlay, which is all the old
        // box field was ever used for.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of keypoints) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        return { keypoints, box: { xMin: minX, yMin: minY, width: maxX - minX, height: maxY - minY } };
      });
    },
  };
}

function wrapDetector(detector: FaceDetector): FaceModel {
  return {
    async estimateFaces(video: HTMLVideoElement): Promise<AdaptedFace[]> {
      const result = detector.detectForVideo(video, performance.now());
      return (result.detections || []).map((d): AdaptedFace => {
        const keypoints = (d.keypoints || []).map(k => toPixelSpace({ x: k.x, y: k.y, z: 0 }, video));
        const bb = d.boundingBox;
        return {
          keypoints,
          box: bb ? { xMin: bb.originX, yMin: bb.originY, width: bb.width, height: bb.height } : undefined,
        };
      });
    },
  };
}

let preloadingPromise: Promise<{ detector: FaceModel | null; fallback: FaceModel | null; fallbackActive: boolean }> | null = null;
let detectorInstance: FaceModel | null = null;
let fallbackInstance: FaceModel | null = null;
let usingFallback = false;
let loadStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';

export function getModelLoadStatus(): 'idle' | 'loading' | 'ready' | 'error' {
  return loadStatus;
}

export function preloadModels(): Promise<{ detector: FaceModel | null; fallback: FaceModel | null; fallbackActive: boolean }> {
  if (preloadingPromise) return preloadingPromise;

  loadStatus = 'loading';
  preloadingPromise = (async () => {
    try {
      // Both models share one WASM fileset - resolved once, reused for both.
      // Bundled offline at /mediapipe (same WebViewAssetLoader path prefix
      // that already serves these files correctly - no native/Kotlin
      // changes needed).
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');

      try {
        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/mediapipe/face_landmarker.task',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numFaces: 4,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
        detectorInstance = wrapLandmarker(faceLandmarker);
        usingFallback = false;
        console.log('FaceLandmarker loaded successfully via preloader');
      } catch (meshErr) {
        console.error('FaceLandmarker load failed during preloading, trying FaceDetector:', meshErr);
        usingFallback = true;
        const faceDetector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/mediapipe/blaze_face_short_range.tflite',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
        });
        fallbackInstance = wrapDetector(faceDetector);
        console.log('FaceDetector loaded successfully via preloader (fallback)');
      }

      loadStatus = 'ready';
      return { detector: detectorInstance, fallback: fallbackInstance, fallbackActive: usingFallback };
    } catch (err) {
      loadStatus = 'error';
      console.error('Preloading models failed:', err);
      // Don't let a single failed attempt permanently poison every future
      // call for the rest of the app's process lifetime - reset the cache
      // so the next call gets a genuine fresh attempt.
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

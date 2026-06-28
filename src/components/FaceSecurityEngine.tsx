/**
 * FaceSecurityEngine.tsx
 *
 * 100% on-device face security engine for Focus Buddy.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SESSION LOCK LOGIC                                             │
 * │  ─────────────────────────────────────────────────────────────  │
 * │  Buddy visible (alone)          → LOCKED   (focus mode ON)     │
 * │  Buddy + Stranger visible       → LOCKED   (focus mode ON)     │
 * │  Stranger only (no buddy)       → PAUSED   (phone returned)    │
 * │  Nobody / dark / covered        → LOCKED   (anti-escape)       │
 * │  Screen asleep                  → RESERVE  (0.5 FPS polling)   │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Liveness layers:
 *   1. Blink detection     (20 s window, EAR threshold)
 *   2. Head-pose challenge (yaw/pitch delta, nod if static)
 *   3. Iris depth heuristic(left/right iris asymmetry → real vs photo)
 *   4. Darkness guard      (avg brightness < 15 → camera covered → LOCKED)
 *
 * Models (TF.js / MediaPipe):
 *   Primary  → face-landmarks-detection  (FaceMesh, 478 pts incl. iris)
 *   Fallback → face-detection            (BlazeFace, basic bbox + 6 pts)
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// §1  TYPES & CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export type SessionState =
  | 'INITIALIZING'   // models loading
  | 'REGISTERING'    // first-run: capture buddy descriptor
  | 'LOCKED'         // buddy confirmed → focus mode active
  | 'PAUSED'         // stranger only   → phone access restored
  | 'RESERVE'        // screen off      → low-power polling
  | 'IDLE';          // session inactive

export type LivenessChallenge = 'BLINK' | 'NOD' | null;

export interface VerificationFrame {
  buddyPresent: boolean;
  strangerPresent: boolean;
  faceCount: number;
  verificationScore: number;     // 0.0 – 1.0
  livenessScore: number;         // 0.0 – 1.0
  isDark: boolean;
  fps: number;
  challenge: LivenessChallenge;
  livenessLayers?: Record<string, number>;
}

export interface FaceSecurityEngineRef {
  startRegistration: () => void;
  stopSession: () => void;
  getLastFrame: () => VerificationFrame | null;
}

export interface FaceSecurityEngineProps {
  /** Whether a focus session is currently active */
  isSessionActive: boolean;
  /** JSON-serialised descriptor from a previous registration (localStorage) */
  storedDescriptor?: string | null;
  /** Run as invisible overlay — camera active but no visible UI */
  ghostMode?: boolean;
  /** Show the scanning HUD even in ghost mode */
  showHUD?: boolean;

  onBuddyLocked?: () => void;       // buddy seen → lock focus
  onStrangerPaused?: () => void;    // stranger only → pause focus
  onBuddyReturned?: () => void;     // buddy re-appears after pause
  onStrangerDetected?: () => void;  // any non-buddy face
  onMultipleFaces?: () => void;     // >1 face in frame
  onCameraBlocked?: () => void;     // total darkness
  onLivenessChallenge?: (type: LivenessChallenge) => void;
  onRegistrationComplete?: (descriptorJson: string, faceSnapshot: string) => void;
  onEngineError?: (err: string) => void;
}

// ─── Landmark indices (MediaPipe FaceMesh 478-point model) ───────────────────

const LM = {
  // Eyes — EAR blink detection
  L_EYE_P1: 33, L_EYE_P2: 160, L_EYE_P3: 158,
  L_EYE_P4: 133, L_EYE_P5: 153, L_EYE_P6: 144,
  R_EYE_P1: 263, R_EYE_P2: 387, R_EYE_P3: 385,
  R_EYE_P4: 362, R_EYE_P5: 380, R_EYE_P6: 373,
  // Iris centres (refineLandmarks = true)
  L_IRIS: 468, R_IRIS: 473,
  // Iris ring points for radius
  L_IRIS_TOP: 469, L_IRIS_BOT: 471,
  R_IRIS_TOP: 474, R_IRIS_BOT: 476,
  // Face geometry
  NOSE_TIP: 1, NOSE_BASE: 6,
  FOREHEAD: 10, CHIN: 152,
  L_CHEEK: 234, R_CHEEK: 454,
  L_MOUTH: 61, R_MOUTH: 291,
  MOUTH_TOP: 13, MOUTH_BOT: 14,
  L_JAW: 172, R_JAW: 397,
  L_BROW_IN: 107, R_BROW_IN: 336,
  L_EYE_OUT: 33, R_EYE_OUT: 263,
  L_EYE_IN: 133, R_EYE_IN: 362,
} as const;

// Identity descriptor key-points — 16 pts → 120 pairwise distances
const DESCRIPTOR_POINTS = [
  LM.L_EYE_IN, LM.L_EYE_OUT, LM.R_EYE_IN, LM.R_EYE_OUT,
  LM.NOSE_TIP, LM.NOSE_BASE,
  LM.L_MOUTH, LM.R_MOUTH, LM.MOUTH_TOP, LM.MOUTH_BOT,
  LM.L_CHEEK, LM.R_CHEEK,
  LM.CHIN, LM.FOREHEAD,
  LM.L_JAW, LM.R_JAW,
];

// ─── Engine constants ─────────────────────────────────────────────────────────

const FPS_HIGH       = 24;    // active scan / stranger detected
const FPS_LOW        = 2;     // buddy confirmed, stable
const FPS_RESERVE    = 0.5;   // screen asleep
const FPS_CHALLENGE  = 24;    // liveness challenge mode

const EAR_BLINK_THRESHOLD    = 0.21;   // below → eye closed
const EAR_BLINK_FRAMES       = 2;      // min consecutive closed frames = blink
const BLINK_WINDOW_MS        = 20_000; // must blink within 20 s
const DARKNESS_THRESHOLD     = 15;     // avg pixel 0-255
const DARKNESS_FRAMES        = 3;      // consecutive dark frames → blocked
const STRANGER_MISS_FRAMES   = 3;      // no buddy for N frames → check
const LIVENESS_PHOTO_IRIS_SYM= 0.04;  // below = suspiciously symmetric → photo
const PHOTO_SUSPICION_FRAMES = 6;      // consecutive suspicious frames → challenge
const SCORE_LOCK_THRESHOLD   = 0.85;   // verificationScore minimum
const BUDDY_MATCH_THRESHOLD  = 0.82;   // cosine similarity for identity
const BUDDY_EUCLIDEAN_THRESHOLD = 0.25; // Euclidean distance for identity (closer is better)
const MOTION_VAR_THRESHOLD   = 400;    // pixel variance → adaptive FPS trigger
const REGISTRATION_SAMPLES   = 12;     // 4 center, 4 left, 4 right
// ─────────────────────────────────────────────────────────────────────────────
// §2  GEOMETRY & DESCRIPTOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number; z?: number };
type Kps = Pt[];

export interface MultiPoseDescriptor {
  center: number[];
  left?: number[];
  right?: number[];
}

function dist(a: Pt, b: Pt): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Eye Aspect Ratio — <0.21 = closed */
function eyeAR(kps: Kps, p1: number, p2: number, p3: number,
               p4: number, p5: number, p6: number): number {
  if (!kps[p1] || !kps[p4]) return 0.3;
  const A = dist(kps[p2], kps[p6]);
  const B = dist(kps[p3], kps[p5]);
  const C = dist(kps[p1], kps[p4]);
  return C < 0.001 ? 0.3 : (A + B) / (2 * C);
}

/**
 * Compute a 120-dimensional identity descriptor from 16 key landmarks.
 * All pairwise L2 distances normalised by face diagonal (scale-invariant).
 */
function computeDescriptor(kps: Kps): number[] | null {
  // Check all key points exist
  for (const idx of DESCRIPTOR_POINTS) {
    if (!kps[idx]) return null;
  }
  const faceDiag = dist(kps[LM.FOREHEAD], kps[LM.CHIN]) || 1;
  const vec: number[] = [];
  for (let i = 0; i < DESCRIPTOR_POINTS.length; i++) {
    for (let j = i + 1; j < DESCRIPTOR_POINTS.length; j++) {
      vec.push(dist(kps[DESCRIPTOR_POINTS[i]], kps[DESCRIPTOR_POINTS[j]]) / faceDiag);
    }
  }
  return vec;
}

/** Cosine similarity between two equal-length vectors */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-10 ? 0 : dot / denom;
}

/** Euclidean distance between two equal-length vectors */
function euclideanDist(a: number[], b: number[]): number {
  if (a.length !== b.length) return 999;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/** Average N descriptor arrays component-wise */
function avgDescriptors(samples: number[][]): number[] {
  if (!samples.length) return [];
  const len = samples[0].length;
  const out = new Array(len).fill(0);
  for (const s of samples) for (let i = 0; i < len; i++) out[i] += s[i];
  return out.map(v => v / samples.length);
}

/** Compute the yaw of a face relative to standard camera coordinate space */
function getFaceYaw(kps: Kps): number {
  if (!kps[LM.NOSE_TIP] || !kps[LM.L_CHEEK] || !kps[LM.R_CHEEK]) return 0;
  const faceWidth = dist(kps[LM.L_CHEEK], kps[LM.R_CHEEK]) || 1;
  const faceCenterX = (kps[LM.L_CHEEK].x + kps[LM.R_CHEEK].x) / 2;
  return (kps[LM.NOSE_TIP].x - faceCenterX) / faceWidth;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  LIVENESS ENGINE
// ─────────────────────────────────────────────────────────────────────────────

class LivenessEngine {
  // Blink state
  private blinkCount = 0;
  private blinkWindowStart = Date.now();
  private earClosedFrames = 0;
  private blinkSatisfied = false;

  // Head pose state
  private lastYaw = 0;
  private lastPitch = 0;
  private poseStaticFrames = 0;
  private nodSatisfied = false;

  // Iris depth state
  private photoSuspicionFrames = 0;

  // Circular buffers for passive liveness layers
  private greenHistory: number[] = [];
  private depthGeoHistory: number[] = [];
  private glareHistory: number[] = [];
  private colorVarHistory: number[] = [];
  private moireHistory: number[] = [];
  private histStabilityHistory: number[] = [];
  private irisMoveHistory: { x: number; y: number }[] = [];

  // Overall
  private challengeActive: LivenessChallenge = null;
  private score = 1.0;

  // Diagnostics / details of each layer to show on HUD or debug
  public layersScore: Record<string, number> = {
    temporalBlink: 1.0,
    poseChallenge: 1.0,
    irisAsymmetry: 1.0,
    rppgBloodFlow: 1.0,
    depth3DGeometry: 1.0,
    specularReflection: 1.0,
    colorSpaceSkin: 1.0,
    moireFrequency: 1.0,
    histogramConsistency: 1.0,
    attentionGaze: 1.0,
  };

  reset(): void {
    this.blinkCount = 0;
    this.blinkWindowStart = Date.now();
    this.earClosedFrames = 0;
    this.blinkSatisfied = false;
    this.nodSatisfied = false;
    this.poseStaticFrames = 0;
    this.photoSuspicionFrames = 0;
    this.challengeActive = null;
    this.score = 1.0;

    this.greenHistory = [];
    this.depthGeoHistory = [];
    this.glareHistory = [];
    this.colorVarHistory = [];
    this.moireHistory = [];
    this.histStabilityHistory = [];
    this.irisMoveHistory = [];

    this.layersScore = {
      temporalBlink: 1.0,
      poseChallenge: 1.0,
      irisAsymmetry: 1.0,
      rppgBloodFlow: 1.0,
      depth3DGeometry: 1.0,
      specularReflection: 1.0,
      colorSpaceSkin: 1.0,
      moireFrequency: 1.0,
      histogramConsistency: 1.0,
      attentionGaze: 1.0,
    };
  }

  /** Call once per detection frame with the landmarks of the primary face and video stream */
  update(kps: Kps, video?: HTMLVideoElement | null): { score: number; challenge: LivenessChallenge } {
    this._updateBlink(kps);
    this._updateHeadPose(kps);
    this._updateIrisDepth(kps);
    
    // Run the passive 2D and 3D layers
    this._updatePassiveLayers(kps, video);

    this._updateScore();
    return { score: this.score, challenge: this.challengeActive };
  }

  private _updatePassiveLayers(kps: Kps, video?: HTMLVideoElement | null): void {
    // 1. 3D Depth Geometry check (using FaceMesh depth z-coordinates)
    this._update3DDepthGeometry(kps);

    // 2. Attention/Gaze micro-movements
    this._updateGazeAttention(kps);

    if (!video || video.readyState < 2) return;

    // Extract forehead/cheek skin ROI pixels
    const imgData = this._extractSkinROI(video, kps);
    if (!imgData) return;

    // 3. rPPG Green Channel Blood Flow tracking
    this._updateRPPGBloodFlow(imgData);

    // 4. Specular Reflection check
    this._updateSpecularReflection(imgData);

    // 5. Color Space Chromaticity Check
    this._updateColorSpace(imgData);

    // 6. Moiré Scanline Frequency check
    this._updateMoireFrequency(imgData);

    // 7. Histogram Stability Consistency check
    this._updateHistogramConsistency(imgData);
  }

  private _extractSkinROI(video: HTMLVideoElement, kps: Kps, width = 48, height = 48): ImageData | null {
    const forehead = kps[LM.FOREHEAD];
    const nose = kps[LM.NOSE_TIP];
    if (!forehead || !nose) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const cx = forehead.x;
    const cy = forehead.y;
    const faceWidth = dist(kps[LM.L_CHEEK], kps[LM.R_CHEEK]) || 50;
    const sampleSize = faceWidth * 0.25;

    const srcX = cx - sampleSize / 2;
    const srcY = cy - sampleSize / 2;

    try {
      ctx.drawImage(
        video,
        srcX, srcY, sampleSize, sampleSize,
        0, 0, width, height
      );
      return ctx.getImageData(0, 0, width, height);
    } catch (e) {
      return null;
    }
  }

  // ── Passive Layer: 3D Depth Geometry ─────────────────────────────────────────

  private _update3DDepthGeometry(kps: Kps): void {
    const nose = kps[LM.NOSE_TIP];
    const lCheek = kps[LM.L_CHEEK];
    const rCheek = kps[LM.R_CHEEK];
    if (!nose || !lCheek || !rCheek) return;

    // Measure protrusion of nose tip relative to cheek plane
    const noseZ = nose.z ?? 0;
    const cheekZ = ((lCheek.z ?? 0) + (rCheek.z ?? 0)) / 2;
    const depthDelta = Math.abs(noseZ - cheekZ);

    const faceWidth = dist(lCheek, rCheek) || 1;
    const normalizedDepth = depthDelta / faceWidth;

    this.depthGeoHistory.push(normalizedDepth);
    if (this.depthGeoHistory.length > 40) this.depthGeoHistory.shift();

    if (this.depthGeoHistory.length >= 20) {
      const mean = this.depthGeoHistory.reduce((a, b) => a + b, 0) / this.depthGeoHistory.length;
      const variance = this.depthGeoHistory.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / this.depthGeoHistory.length;
      const std = Math.sqrt(variance);

      // On 2D screens or photos, estimated depths are either perfectly flat or 100% static
      if (mean < 0.04 || std < 0.001) {
        this.layersScore.depth3DGeometry = 0.20; // flat spoof
      } else if (mean < 0.07) {
        this.layersScore.depth3DGeometry = 0.65; // suspicious low depth depth profile
      } else {
        this.layersScore.depth3DGeometry = 1.0;
      }
    }
  }

  // ── Passive Layer: Iris Attention Gaze ───────────────────────────────────────

  private _updateGazeAttention(kps: Kps): void {
    const lIris = kps[LM.L_IRIS];
    const lInner = kps[LM.L_EYE_IN];
    const lOuter = kps[LM.L_EYE_OUT];
    if (!lIris || !lInner || !lOuter) return;

    const eyeW = dist(lInner, lOuter) || 1;
    const relX = (lIris.x - lInner.x) / eyeW;
    const relY = (lIris.y - lInner.y) / eyeW;

    this.irisMoveHistory.push({ x: relX, y: relY });
    if (this.irisMoveHistory.length > 50) this.irisMoveHistory.shift();

    if (this.irisMoveHistory.length >= 20) {
      let sumX = 0, sumY = 0;
      for (const pt of this.irisMoveHistory) {
        sumX += pt.x;
        sumY += pt.y;
      }
      const avgX = sumX / this.irisMoveHistory.length;
      const avgY = sumY / this.irisMoveHistory.length;
      let varSum = 0;
      for (const pt of this.irisMoveHistory) {
        const dx = pt.x - avgX;
        const dy = pt.y - avgY;
        varSum += dx * dx + dy * dy;
      }
      const std = Math.sqrt(varSum / this.irisMoveHistory.length);

      // Printout or frozen stream has exactly 0.0 micro-variability in iris coordinates!
      if (std < 0.0004) {
        this.layersScore.attentionGaze = 0.30;
      } else if (std < 0.001) {
        this.layersScore.attentionGaze = 0.75;
      } else {
        this.layersScore.attentionGaze = 1.0;
      }
    }
  }

  // ── Passive Layer: rPPG Blood Flow ──────────────────────────────────────────

  private _updateRPPGBloodFlow(imgData: ImageData): void {
    const pixels = imgData.data;
    const len = imgData.width * imgData.height;
    let greenSum = 0;
    for (let i = 0; i < len; i++) {
      greenSum += pixels[i * 4 + 1]; // Green channel is most sensitive to blood oxygenation fluctuations
    }
    const avgGreen = greenSum / len;

    this.greenHistory.push(avgGreen);
    if (this.greenHistory.length > 90) this.greenHistory.shift();

    if (this.greenHistory.length >= 45) {
      const mean = this.greenHistory.reduce((a, b) => a + b, 0) / this.greenHistory.length;
      const variance = this.greenHistory.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / this.greenHistory.length;
      const std = Math.sqrt(variance);

      // Static image/feed std is ~0. Real skin fluctuates slightly (std typically between 0.1 and 3.0)
      if (std < 0.015) {
        this.layersScore.rppgBloodFlow = 0.15; // static/dead feed
      } else if (std < 0.06) {
        this.layersScore.rppgBloodFlow = 0.50; // highly suspicious flat feed
      } else {
        // Human heartbeat (48–180 BPM) generates periodic oscillations. Count zero-crossings
        let crossings = 0;
        for (let i = 1; i < this.greenHistory.length; i++) {
          const prev = this.greenHistory[i - 1] - mean;
          const curr = this.greenHistory[i] - mean;
          if (prev * curr < 0) crossings++;
        }
        
        if (crossings >= 3 && crossings <= 22) {
          this.layersScore.rppgBloodFlow = 1.0; // pulse validated
        } else if (crossings === 0) {
          this.layersScore.rppgBloodFlow = 0.40;
        } else {
          this.layersScore.rppgBloodFlow = 0.85; // high-frequency noise
        }
      }
    }
  }

  // ── Passive Layer: Specular Reflection ────────────────────────────────────────

  private _updateSpecularReflection(imgData: ImageData): void {
    const pixels = imgData.data;
    const len = imgData.width * imgData.height;
    let glarePixels = 0;
    for (let i = 0; i < len; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      if (r > 240 && g > 240 && b > 240) {
        glarePixels++;
      }
    }
    const glareFraction = glarePixels / len;
    this.glareHistory.push(glareFraction);
    if (this.glareHistory.length > 30) this.glareHistory.shift();

    const avgGlare = this.glareHistory.reduce((a, b) => a + b, 0) / this.glareHistory.length;
    if (avgGlare > 0.15) {
      this.layersScore.specularReflection = 0.40; // heavy screen reflection / photo glare
    } else if (avgGlare > 0.05) {
      this.layersScore.specularReflection = 0.75;
    } else {
      this.layersScore.specularReflection = 1.0;
    }
  }

  // ── Passive Layer: Color Space Chromaticity ──────────────────────────────────

  private _updateColorSpace(imgData: ImageData): void {
    const pixels = imgData.data;
    const len = imgData.width * imgData.height;
    
    let totalChromDiff = 0;
    for (let i = 0; i < len; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const avg = (r + g + b) / 3;
      totalChromDiff += Math.abs(r - avg) + Math.abs(g - avg) + Math.abs(b - avg);
    }
    const avgChromVar = totalChromDiff / len;

    this.colorVarHistory.push(avgChromVar);
    if (this.colorVarHistory.length > 30) this.colorVarHistory.shift();

    const meanChrom = this.colorVarHistory.reduce((a, b) => a + b, 0) / this.colorVarHistory.length;
    if (meanChrom < 6.0) {
      this.layersScore.colorSpaceSkin = 0.15; // monochromatic printout spoof
    } else if (meanChrom < 12.0) {
      this.layersScore.colorSpaceSkin = 0.65; // unnaturally washed-out color palette
    } else {
      this.layersScore.colorSpaceSkin = 1.0;
    }
  }

  // ── Passive Layer: Moiré Grid Frequency ───────────────────────────────────────

  private _updateMoireFrequency(imgData: ImageData): void {
    const pixels = imgData.data;
    const width = imgData.width;
    const height = imgData.height;
    
    const rowIdx = Math.floor(height / 2);
    let alternations = 0;
    let lastDiffSign = 0;
    
    const rowGrays: number[] = [];
    for (let col = 0; col < width; col++) {
      const idx = (rowIdx * width + col) * 4;
      rowGrays.push(0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2]);
    }

    for (let col = 1; col < width; col++) {
      const diff = rowGrays[col] - rowGrays[col - 1];
      if (Math.abs(diff) > 4.0) {
        const sign = Math.sign(diff);
        if (sign !== lastDiffSign && lastDiffSign !== 0) {
          alternations++;
        }
        lastDiffSign = sign;
      }
    }

    this.moireHistory.push(alternations);
    if (this.moireHistory.length > 30) this.moireHistory.shift();

    const avgAlternations = this.moireHistory.reduce((a, b) => a + b, 0) / this.moireHistory.length;
    if (avgAlternations > 18) {
      this.layersScore.moireFrequency = 0.35; // screen moire scanline patterns detected
    } else if (avgAlternations > 12) {
      this.layersScore.moireFrequency = 0.70;
    } else {
      this.layersScore.moireFrequency = 1.0;
    }
  }

  // ── Passive Layer: Histogram Stability ───────────────────────────────────────

  private _updateHistogramConsistency(imgData: ImageData): void {
    const pixels = imgData.data;
    const len = imgData.width * imgData.height;
    
    const bins = new Array(8).fill(0);
    for (let i = 0; i < len; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const gray = Math.floor((0.299 * r + 0.587 * g + 0.114 * b) / 32);
      bins[Math.min(gray, 7)]++;
    }

    const normBins = bins.map(v => v / len);
    
    if (this.histStabilityHistory.length > 0) {
      const prev = this.histStabilityHistory;
      let diff = 0;
      for (let i = 0; i < 8; i++) {
        diff += Math.abs(normBins[i] - prev[i]);
      }
      
      // If color histogram remains 100% frozen/identical across frames, it is a frozen mock loop or printout
      if (diff < 0.0001) {
        this.layersScore.histogramConsistency = Math.max(0.20, (this.layersScore.histogramConsistency ?? 1.0) - 0.15);
      } else {
        this.layersScore.histogramConsistency = Math.min(1.0, (this.layersScore.histogramConsistency ?? 1.0) + 0.10);
      }
    }
    this.histStabilityHistory = normBins;
  }

  // ── Blink ───────────────────────────────────────────────────────────────────

  private _updateBlink(kps: Kps): void {
    const leftEAR  = eyeAR(kps, LM.L_EYE_P1, LM.L_EYE_P2, LM.L_EYE_P3,
                                LM.L_EYE_P4, LM.L_EYE_P5, LM.L_EYE_P6);
    const rightEAR = eyeAR(kps, LM.R_EYE_P1, LM.R_EYE_P2, LM.R_EYE_P3,
                                LM.R_EYE_P4, LM.R_EYE_P5, LM.R_EYE_P6);
    const avgEAR = (leftEAR + rightEAR) / 2;

    if (avgEAR < EAR_BLINK_THRESHOLD) {
      this.earClosedFrames++;
    } else {
      if (this.earClosedFrames >= EAR_BLINK_FRAMES) {
        this.blinkCount++;
        if (!this.blinkSatisfied) this.blinkSatisfied = true;
      }
      this.earClosedFrames = 0;
    }

    // Reset 20-second window
    if (Date.now() - this.blinkWindowStart > BLINK_WINDOW_MS) {
      if (this.blinkCount === 0) {
        this.blinkSatisfied = false;
        if (this.challengeActive === null) this.challengeActive = 'BLINK';
      }
      this.blinkCount = 0;
      this.blinkWindowStart = Date.now();
    }
  }

  // ── Head Pose ───────────────────────────────────────────────────────────────

  private _updateHeadPose(kps: Kps): void {
    if (!kps[LM.NOSE_TIP] || !kps[LM.L_CHEEK] || !kps[LM.R_CHEEK]) return;

    const faceWidth = dist(kps[LM.L_CHEEK], kps[LM.R_CHEEK]) || 1;
    const faceCenterX = (kps[LM.L_CHEEK].x + kps[LM.R_CHEEK].x) / 2;

    const yaw   = (kps[LM.NOSE_TIP].x - faceCenterX) / faceWidth;
    const pitch = kps[LM.NOSE_TIP].z !== undefined
      ? (kps[LM.NOSE_TIP].z - (kps[LM.FOREHEAD]?.z ?? 0)) / faceWidth
      : 0;

    const yawDelta   = Math.abs(yaw   - this.lastYaw);
    const pitchDelta = Math.abs(pitch - this.lastPitch);

    if (yawDelta < 0.01 && pitchDelta < 0.01) {
      this.poseStaticFrames++;
    } else {
      this.poseStaticFrames = 0;
      if (this.challengeActive === 'NOD') {
        this.nodSatisfied = true;
        this.challengeActive = null;
      }
    }

    if (this.poseStaticFrames > 360 && !this.nodSatisfied) {
      this.challengeActive = 'NOD';
    }

    this.lastYaw   = yaw;
    this.lastPitch = pitch;
  }

  // ── Iris Depth Heuristic ────────────────────────────────────────────────────

  private _updateIrisDepth(kps: Kps): void {
    if (!kps[LM.L_IRIS] || !kps[LM.R_IRIS] ||
        !kps[LM.L_IRIS_TOP] || !kps[LM.L_IRIS_BOT] ||
        !kps[LM.R_IRIS_TOP] || !kps[LM.R_IRIS_BOT]) return;

    const lSocketW = dist(kps[LM.L_EYE_P1], kps[LM.L_EYE_P4]) || 1;
    const rSocketW = dist(kps[LM.R_EYE_P1], kps[LM.R_EYE_P4]) || 1;

    const lIrisR = dist(kps[LM.L_IRIS], kps[LM.L_IRIS_TOP]);
    const rIrisR = dist(kps[LM.R_IRIS], kps[LM.R_IRIS_TOP]);

    const lRatio = lIrisR / lSocketW;
    const rRatio = rIrisR / rSocketW;

    const asymmetry = Math.abs(lRatio - rRatio) / (Math.max(lRatio, rRatio) || 1);

    if (asymmetry < LIVENESS_PHOTO_IRIS_SYM) {
      this.photoSuspicionFrames++;
    } else {
      this.photoSuspicionFrames = Math.max(0, this.photoSuspicionFrames - 1);
    }

    if (this.photoSuspicionFrames >= PHOTO_SUSPICION_FRAMES) {
      if (this.challengeActive === null) this.challengeActive = 'NOD';
    }
  }

  // ── Score ────────────────────────────────────────────────────────────────────

  private _updateScore(): void {
    let s = 1.0;
    if (!this.blinkSatisfied)       s -= 0.10;
    if (this.poseStaticFrames > 180) s -= 0.05 * Math.min((this.poseStaticFrames - 180) / 180, 1);
    if (this.photoSuspicionFrames >= PHOTO_SUSPICION_FRAMES) s -= 0.15;
    if (this.challengeActive !== null) s -= 0.15;

    // Sub-layer penalty multipliers
    s -= (1.0 - this.layersScore.depth3DGeometry) * 0.15;
    s -= (1.0 - this.layersScore.attentionGaze) * 0.10;
    s -= (1.0 - this.layersScore.rppgBloodFlow) * 0.20;
    s -= (1.0 - this.layersScore.specularReflection) * 0.12;
    s -= (1.0 - this.layersScore.colorSpaceSkin) * 0.18;
    s -= (1.0 - this.layersScore.moireFrequency) * 0.15;
    s -= (1.0 - this.layersScore.histogramConsistency) * 0.10;

    this.score = Math.max(0.01, Math.min(1.0, s));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  DARKNESS / BRIGHTNESS GUARD
// ─────────────────────────────────────────────────────────────────────────────

function sampleBrightness(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  sampleCount = 200
): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || video.readyState < 2) return 128;

  canvas.width  = 64;
  canvas.height = 48;
  ctx.drawImage(video, 0, 0, 64, 48);

  const data = ctx.getImageData(0, 0, 64, 48).data;
  let total = 0;
  const step = Math.floor(data.length / (sampleCount * 4)) * 4 || 4;
  let count  = 0;
  for (let i = 0; i < data.length; i += step) {
    // Luminance approximation
    total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count++;
  }
  return count > 0 ? total / count : 128;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  MOTION DETECTION (for adaptive FPS)
// ─────────────────────────────────────────────────────────────────────────────

function computeFrameVariance(
  canvas: HTMLCanvasElement,
  prevDataRef: React.MutableRefObject<Uint8ClampedArray | null>
): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, 64, 48);
  const prev = prevDataRef.current;
  if (!prev || prev.length !== data.length) {
    prevDataRef.current = new Uint8ClampedArray(data);
    return 0;
  }
  let variance = 0;
  for (let i = 0; i < data.length; i += 16) {
    const d = data[i] - prev[i];
    variance += d * d;
  }
  prevDataRef.current = new Uint8ClampedArray(data);
  return variance / (data.length / 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// §6  MAIN HOOK  useFaceSecurityEngine
// ─────────────────────────────────────────────────────────────────────────────

interface HookState {
  sessionState: SessionState;
  lastFrame: VerificationFrame | null;
  isModelReady: boolean;
  registrationProgress: number;   // 0–100
  registrationPrompt: string;     // Added for multi-pose guidance
  challenge: LivenessChallenge;
  fps: number;
  landmarks: Pt[] | null;         // for HUD rendering
  faceBox: { x: number; y: number; w: number; h: number } | null;
}

export function useFaceSecurityEngine(
  videoRef: React.RefObject<HTMLVideoElement>,
  props: FaceSecurityEngineProps
) {
  const {
    isSessionActive, storedDescriptor, ghostMode = false,
    onBuddyLocked, onStrangerPaused, onBuddyReturned,
    onStrangerDetected, onMultipleFaces, onCameraBlocked,
    onLivenessChallenge, onRegistrationComplete, onEngineError,
  } = props;

  const [state, setState] = useState<HookState>({
    sessionState: 'IDLE',
    lastFrame: null,
    isModelReady: false,
    registrationProgress: 0,
    registrationPrompt: 'LOOK CENTER',
    challenge: null,
    fps: FPS_LOW,
    landmarks: null,
    faceBox: null,
  });

  // ── Refs (persist across renders without causing re-renders) ─────────────

  const detectorRef   = useRef<any>(null);   // face-landmarks-detection model
  const fallbackRef   = useRef<any>(null);   // blazeface fallback
  const usingFallback = useRef(false);

  const livenessRef   = useRef(new LivenessEngine());
  const buddyDescRef  = useRef<number[] | MultiPoseDescriptor | null>(null);
  const identityBufferRef = useRef<boolean[]>([]); // temporal consensus buffer
  const lastChallengeRef = useRef<LivenessChallenge>(null); // decouple challenge from RAF dependencies

  const rafIdRef      = useRef<number>(0);
  const timeoutIdRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunningRef  = useRef(false);
  const isHiddenRef   = useRef(document.hidden);

  const canvasRef         = useRef<HTMLCanvasElement | null>(null);
  const prevFrameDataRef  = useRef<Uint8ClampedArray | null>(null);

  const sessionStateRef   = useRef<SessionState>('IDLE');
  const currentFpsRef     = useRef(FPS_LOW);
  const darkFrameCount    = useRef(0);
  const buddyMissFrames   = useRef(0);
  const prevStateRef      = useRef<SessionState>('IDLE');
  const registrationBuf   = useRef<number[][]>([]);
  const isRegistering     = useRef(false);

  // ── Load persisted descriptor ─────────────────────────────────────────────

  useEffect(() => {
    if (storedDescriptor) {
      try {
        const d = JSON.parse(storedDescriptor);
        if (Array.isArray(d) && d.length > 0) {
          buddyDescRef.current = d;
        } else if (d && (d.center || d.left || d.right)) {
          buddyDescRef.current = d as MultiPoseDescriptor;
        }
      } catch { /* ignore */ }
    }
  }, [storedDescriptor]);

  // ── Model initialisation ──────────────────────────────────────────────────

  const initModels = useCallback(async () => {
    try {
      // Lazy-load TF.js + models to avoid blocking initial render
      const tf = await import('@tensorflow/tfjs');

      // Prefer WebGL for GPU acceleration; fall back to CPU for older WebViews
      try {
        await import('@tensorflow/tfjs-backend-webgl');
        await tf.setBackend('webgl');
      } catch {
        await import('@tensorflow/tfjs-backend-cpu');
        await tf.setBackend('cpu');
      }
      await tf.ready();

      // Try FaceMesh (full liveness capability)
      try {
        const faceLandmarks = await import('@tensorflow-models/face-landmarks-detection');
        detectorRef.current = await faceLandmarks.createDetector(
          faceLandmarks.SupportedModels.MediaPipeFaceMesh,
          {
            runtime: 'tfjs',
            refineLandmarks: true,   // iris landmarks 468–477
            maxFaces: 4,
          }
        );
      } catch {
        // Fall back to BlazeFace (no iris, limited liveness)
        usingFallback.current = true;
        const faceDetection = await import('@tensorflow-models/face-detection');
        fallbackRef.current = await faceDetection.createDetector(
          faceDetection.SupportedModels.MediaPipeFaceDetector,
          { runtime: 'tfjs', maxFaces: 4 }
        );
      }

      setState(s => ({ ...s, isModelReady: true }));
    } catch (err) {
      onEngineError?.(`Model load failed: ${(err as Error).message}`);
    }
  }, [onEngineError]);

  useEffect(() => { initModels(); }, [initModels]);

  // ── Camera stream ─────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    } catch (err) {
      onEngineError?.(`Camera error: ${(err as Error).message}`);
    }
  }, [videoRef, onEngineError]);

  // ── Core detection frame ──────────────────────────────────────────────────

  const processFrame = useCallback(async () => {
    const video   = videoRef.current;
    const canvas  = canvasRef.current;
    const model   = detectorRef.current ?? fallbackRef.current;

    if (!video || !canvas || !model || video.readyState < 2) return;
    if (!isSessionActive && !isRegistering.current) return;

    // ── Darkness guard ─────────────────────────────────────────────────────

    const brightness = sampleBrightness(canvas, video);
    const isDark = brightness < DARKNESS_THRESHOLD;

    if (isDark) {
      darkFrameCount.current++;
      if (darkFrameCount.current >= DARKNESS_FRAMES) {
        onCameraBlocked?.();
        // Camera covered → stay LOCKED (anti-escape rule)
        _setSessionState('LOCKED');
        _setFps(FPS_LOW);
      }
    } else {
      darkFrameCount.current = 0;
    }

    // ── Adaptive motion-based FPS ──────────────────────────────────────────

    const motionVariance = computeFrameVariance(canvas, prevFrameDataRef);
    if (motionVariance > MOTION_VAR_THRESHOLD &&
        sessionStateRef.current === 'LOCKED' &&
        currentFpsRef.current < FPS_HIGH) {
      _setFps(FPS_HIGH);
    }

    // ── Run face detection ─────────────────────────────────────────────────

    let detectedFaces: any[] = [];
    try {
      detectedFaces = await model.estimateFaces(video);
    } catch {
      return;
    }

    const faceCount = detectedFaces.length;

    // ── Registration mode ─────────────────────────────────────────────────

    if (isRegistering.current) {
      if (faceCount === 1 && !usingFallback.current) {
        const kps: Kps = detectedFaces[0].keypoints;
        const desc = computeDescriptor(kps);
        if (desc) {
          const yaw = getFaceYaw(kps);
          const currentCount = registrationBuf.current.length;
          
          let validPose = false;
          let prompt = 'LOOK CENTER';
          
          if (currentCount < 4) {
            // Need Center pose
            if (Math.abs(yaw) <= 0.08) {
              validPose = true;
            }
            prompt = 'LOOK CENTER';
          } else if (currentCount < 8) {
            // Need Left pose
            if (yaw >= 0.06) {
              validPose = true;
            }
            prompt = 'TURN SLIGHTLY LEFT';
          } else {
            // Need Right pose
            if (yaw <= -0.06) {
              validPose = true;
            }
            prompt = 'TURN SLIGHTLY RIGHT';
          }
          
          if (validPose) {
            registrationBuf.current.push(desc);
            const progress = Math.round(
              (registrationBuf.current.length / REGISTRATION_SAMPLES) * 100
            );
            
            // Recompute prompt for next frame
            const nextCount = registrationBuf.current.length;
            let nextPrompt = prompt;
            if (nextCount >= 4 && nextCount < 8) {
              nextPrompt = 'TURN SLIGHTLY LEFT';
            } else if (nextCount >= 8 && nextCount < 12) {
              nextPrompt = 'TURN SLIGHTLY RIGHT';
            } else if (nextCount >= 12) {
              nextPrompt = 'PROCESSING...';
            }
            
            setState(s => ({ 
              ...s, 
              registrationProgress: progress,
              registrationPrompt: nextPrompt
            }));

            if (registrationBuf.current.length >= REGISTRATION_SAMPLES) {
              const centerSamples = registrationBuf.current.slice(0, 4);
              const leftSamples = registrationBuf.current.slice(4, 8);
              const rightSamples = registrationBuf.current.slice(8, 12);
              
              const centerDesc = avgDescriptors(centerSamples);
              const leftDesc = avgDescriptors(leftSamples);
              const rightDesc = avgDescriptors(rightSamples);
              
              const finalMultiPose: MultiPoseDescriptor = {
                center: centerDesc,
                left: leftDesc,
                right: rightDesc
              };
              
              buddyDescRef.current = finalMultiPose;
              isRegistering.current = false;
              registrationBuf.current = [];
              
              let faceSnapshot = '';
              try {
                const snapCanvas = document.createElement('canvas');
                snapCanvas.width = video.videoWidth || 320;
                snapCanvas.height = video.videoHeight || 240;
                const snapCtx = snapCanvas.getContext('2d');
                if (snapCtx) {
                  snapCtx.translate(snapCanvas.width, 0);
                  snapCtx.scale(-1, 1);
                  snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
                  faceSnapshot = snapCanvas.toDataURL('image/jpeg', 0.85);
                }
              } catch (e) {
                console.error('Failed to capture registration snapshot:', e);
              }
              
              onRegistrationComplete?.(JSON.stringify(finalMultiPose), faceSnapshot);
              _setSessionState('IDLE');
            }
          } else {
            // Keep instructing the user
            setState(s => ({ ...s, registrationPrompt: prompt }));
          }
        }
      }
      return;   // don't run session logic during registration
    }

    if (!isSessionActive) return;

    // ── Session logic ──────────────────────────────────────────────────────

    let frameBuddyPresent    = false;
    let frameStrangerPresent = false;
    let primaryKps: Kps | null = null;
    let primaryBox: { x: number; y: number; w: number; h: number } | null = null;

    if (faceCount > 0) {
      for (const face of detectedFaces) {
        const kps: Kps = face.keypoints ?? [];
        const isBuddy  = _identifyAsBuddy(kps);

        if (isBuddy) {
          frameBuddyPresent = true;
          primaryKps   = kps;
          // Store bounding box for HUD
          if (face.box) {
            primaryBox = {
              x: face.box.xMin, y: face.box.yMin,
              w: face.box.width, h: face.box.height,
            };
          }
        } else {
          frameStrangerPresent = true;
        }
      }
    }

    // Push the frame-level buddy presence into the circular buffer
    identityBufferRef.current.push(frameBuddyPresent);
    if (identityBufferRef.current.length > 10) {
      identityBufferRef.current.shift();
    }

    const totalInBuf = identityBufferRef.current.length;
    const buddyCountInBuf = identityBufferRef.current.filter(x => x).length;

    let buddyPresent = frameBuddyPresent;
    let strangerPresent = frameStrangerPresent;

    // Temporal consensus decision
    if (totalInBuf >= 5) {
      if (sessionStateRef.current === 'LOCKED') {
        // If LOCKED, transition to PAUSED only when <= 30% of frames say buddy (>=70% say NOT buddy)
        if (buddyCountInBuf <= Math.floor(0.3 * totalInBuf)) {
          buddyPresent = false;
        } else {
          buddyPresent = true; // stay locked
        }
      } else {
        // If PAUSED/IDLE/etc, transition to LOCKED only when >= 70% of frames say buddy
        if (buddyCountInBuf >= Math.ceil(0.7 * totalInBuf)) {
          buddyPresent = true;
        } else {
          buddyPresent = false; // stay paused
        }
      }
    }

    if (faceCount === 0) {
      // Nobody → LOCKED (anti-escape)
      buddyMissFrames.current++;
      if (buddyMissFrames.current > STRANGER_MISS_FRAMES) {
        if (sessionStateRef.current === 'PAUSED') {
          // Previously paused (stranger had phone) → re-lock on empty
          _setSessionState('LOCKED');
          onBuddyLocked?.();
        }
      }
    } else {
      buddyMissFrames.current = 0;
      if (faceCount > 1) onMultipleFaces?.();
      if (strangerPresent) onStrangerDetected?.();

      // ── Session state machine ────────────────────────────────────────────

      if (buddyPresent) {
        // Buddy visible (alone or with others) → LOCKED
        if (sessionStateRef.current === 'PAUSED') onBuddyReturned?.();
        _setSessionState('LOCKED');
        _setFps(FPS_LOW);
      } else {
        // No buddy, but ≥1 stranger → PAUSED
        if (sessionStateRef.current !== 'PAUSED') {
          _setSessionState('PAUSED');
          onStrangerPaused?.();
          _setFps(FPS_HIGH);   // keep scanning to detect buddy's return
        }
      }
    }

    // ── Liveness check (only when buddy is in frame) ─────────────────────

    let livenessScore  = 1.0;
    let challenge: LivenessChallenge = null;

    if (buddyPresent && primaryKps && !usingFallback.current) {
      const liveness = livenessRef.current.update(primaryKps, video);
      livenessScore  = liveness.score;
      challenge      = liveness.challenge;

      if (challenge && challenge !== lastChallengeRef.current) {
        lastChallengeRef.current = challenge;
        onLivenessChallenge?.(challenge);
        _setFps(FPS_CHALLENGE);
      } else if (!challenge) {
        lastChallengeRef.current = null;
      }
    }

    // ── Verification score ────────────────────────────────────────────────

    const identityScore = buddyPresent ? 1.0 : 0.0;
    const verificationScore = (identityScore * 0.65) + (livenessScore * 0.35);

    if (verificationScore < SCORE_LOCK_THRESHOLD && buddyPresent) {
      // Score degraded even with buddy present — re-challenge
      _setFps(FPS_CHALLENGE);
    }

    // ── Update state ──────────────────────────────────────────────────────

    const frame: VerificationFrame = {
      buddyPresent, strangerPresent, faceCount,
      verificationScore, livenessScore, isDark,
      fps: currentFpsRef.current, challenge,
      livenessLayers: livenessRef.current.layersScore,
    };

    setState(s => ({
      ...s,
      lastFrame: frame,
      challenge,
      fps: currentFpsRef.current,
      landmarks: primaryKps,
      faceBox: primaryBox,
    }));
  }, [
    isSessionActive, videoRef,
    onBuddyLocked, onStrangerPaused, onBuddyReturned,
    onStrangerDetected, onMultipleFaces, onCameraBlocked, onLivenessChallenge,
  ]);

  // ── Identity check ────────────────────────────────────────────────────────

  function _identifyAsBuddy(kps: Kps): boolean {
    const stored = buddyDescRef.current;
    if (!stored) {
      // No registered face → fail-closed (secure)
      return false;
    }
    const faceDesc = computeDescriptor(kps);
    if (!faceDesc) return false;

    // Helper to match single pose
    const matchPose = (storedDesc: number[], thresholdHysteresis = 0) => {
      const threshold = BUDDY_MATCH_THRESHOLD - thresholdHysteresis;
      const sim = cosineSim(faceDesc, storedDesc);
      const euc = euclideanDist(faceDesc, storedDesc);
      // Dual metric: Sim matches and Euclidean distance is low
      return sim >= threshold && euc <= (BUDDY_EUCLIDEAN_THRESHOLD + thresholdHysteresis * 0.5);
    };

    // Hysteresis: if already LOCKED, use slightly more lenient threshold
    const isCurrentlyLocked = sessionStateRef.current === 'LOCKED';
    const hysteresis = isCurrentlyLocked ? 0.04 : 0.0; // 0.82 -> 0.78 for cosine match

    if (Array.isArray(stored)) {
      return matchPose(stored, hysteresis);
    } else {
      // It is a MultiPoseDescriptor
      let matched = false;
      if (stored.center) matched = matched || matchPose(stored.center, hysteresis);
      if (stored.left)   matched = matched || matchPose(stored.left, hysteresis);
      if (stored.right)  matched = matched || matchPose(stored.right, hysteresis);
      return matched;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _setSessionState(s: SessionState) {
    if (sessionStateRef.current === s) return;
    prevStateRef.current    = sessionStateRef.current;
    sessionStateRef.current = s;
    setState(prev => ({ ...prev, sessionState: s }));
  }

  function _setFps(fps: number) {
    if (currentFpsRef.current === fps) return;
    currentFpsRef.current = fps;
    setState(prev => ({ ...prev, fps }));
  }

  // ── RAF / setTimeout loop ─────────────────────────────────────────────────

  const lastFrameTimeRef = useRef(0);

  const tick = useCallback(async (timestamp: number) => {
    if (!isRunningRef.current) return;

    const interval = 1000 / currentFpsRef.current;
    if (timestamp - lastFrameTimeRef.current >= interval) {
      lastFrameTimeRef.current = timestamp;
      await processFrame();
    }

    rafIdRef.current = requestAnimationFrame(tick);
  }, [processFrame]);

  const startTimeoutLoop = useCallback(() => {
    const runTimeout = async () => {
      if (!isRunningRef.current || !isHiddenRef.current) return;
      await processFrame();
      timeoutIdRef.current = setTimeout(runTimeout, 1000 / FPS_RESERVE);
    };
    timeoutIdRef.current = setTimeout(runTimeout, 1000 / FPS_RESERVE);
  }, [processFrame]);

  // ── Visibility change — switch between RAF and setTimeout ─────────────────

  useEffect(() => {
    const onVisibilityChange = () => {
      isHiddenRef.current = document.hidden;
      if (document.hidden) {
        cancelAnimationFrame(rafIdRef.current);
        if (isRunningRef.current) {
          _setSessionState('RESERVE');
          _setFps(FPS_RESERVE);
          startTimeoutLoop();
        }
      } else {
        if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
        if (isRunningRef.current) {
          _setSessionState(isSessionActive ? 'LOCKED' : 'IDLE');
          _setFps(FPS_HIGH);
          rafIdRef.current = requestAnimationFrame(tick);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isSessionActive, tick, startTimeoutLoop]);

  // ── Session start / stop ──────────────────────────────────────────────────

  useEffect(() => {
    if (!state.isModelReady) return;

    if (isSessionActive) {
      livenessRef.current.reset();
      buddyMissFrames.current = 0;
      darkFrameCount.current  = 0;
      isRunningRef.current    = true;
      _setSessionState('LOCKED');
      _setFps(FPS_HIGH);
      startCamera().then(() => {
        rafIdRef.current = requestAnimationFrame(tick);
      });
    } else {
      isRunningRef.current = false;
      cancelAnimationFrame(rafIdRef.current);
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      _setSessionState('IDLE');

      // Release camera track
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(t => t.stop());
        videoRef.current.srcObject = null;
      }
    }

    return () => {
      cancelAnimationFrame(rafIdRef.current);
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSessionActive, state.isModelReady]);

  // ── Registration API ──────────────────────────────────────────────────────

  const startRegistration = useCallback(() => {
    registrationBuf.current  = [];
    isRegistering.current    = true;
    isRunningRef.current     = true;
    _setSessionState('REGISTERING');
    _setFps(FPS_HIGH);
    startCamera().then(() => {
      rafIdRef.current = requestAnimationFrame(tick);
    });
  }, [startCamera, tick]);

  const stopSession = useCallback(() => {
    isRunningRef.current     = false;
    isRegistering.current    = false;
    cancelAnimationFrame(rafIdRef.current);
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    _setSessionState('IDLE');
  }, []);

  return {
    ...state,
    canvasRef,
    startRegistration,
    stopSession,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7  SECURITY OVERLAY HUD
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayProps {
  sessionState: SessionState;
  faceBox: { x: number; y: number; w: number; h: number } | null;
  verificationScore: number;
  livenessScore: number;
  fps: number;
  challenge: LivenessChallenge;
  videoWidth: number;
  videoHeight: number;
  ghostMode: boolean;
  livenessLayers?: Record<string, number>;
}

const SecurityOverlay: React.FC<OverlayProps> = ({
  sessionState, faceBox, verificationScore, livenessScore,
  fps, challenge, videoWidth, videoHeight, ghostMode, livenessLayers,
}) => {
  const scanLineRef = useRef<HTMLDivElement>(null);

  // Scan line animation
  useEffect(() => {
    if (!scanLineRef.current) return;
    let pos = 0;
    let dir = 1;
    const interval = setInterval(() => {
      if (!scanLineRef.current) return;
      pos += dir * 1.2;
      if (pos >= 100) dir = -1;
      if (pos <= 0)   dir = 1;
      scanLineRef.current.style.top = `${pos}%`;
    }, 16);
    return () => clearInterval(interval);
  }, []);

  const stateColor: Record<SessionState, string> = {
    LOCKED:      '#00ff88',
    PAUSED:      '#ff9500',
    REGISTERING: '#00d4ff',
    RESERVE:     '#666688',
    INITIALIZING:'#888899',
    IDLE:        '#444455',
  };

  const stateLabel: Record<SessionState, string> = {
    LOCKED:      'FOCUS LOCKED',
    PAUSED:      'SESSION PAUSED',
    REGISTERING: 'SCANNING',
    RESERVE:     'RESERVE',
    INITIALIZING:'INITIALIZING',
    IDLE:        'IDLE',
  };

  const col = stateColor[sessionState] ?? '#888899';

  // Compute face box in % coordinates
  const box = faceBox && videoWidth > 0 ? {
    left:   `${(faceBox.x / videoWidth)  * 100}%`,
    top:    `${(faceBox.y / videoHeight) * 100}%`,
    width:  `${(faceBox.w / videoWidth)  * 100}%`,
    height: `${(faceBox.h / videoHeight) * 100}%`,
  } : null;

  return (
    <div
      className="absolute inset-0 pointer-events-none select-none overflow-hidden"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
    >
      {/* ── Scan line ──────────────────────────────────────────────────── */}
      <div
        ref={scanLineRef}
        className="absolute left-0 right-0 h-px opacity-30"
        style={{
          background: `linear-gradient(to right, transparent 0%, ${col} 30%, ${col} 70%, transparent 100%)`,
          transition: 'top 0.016s linear',
        }}
      />

      {/* ── Corner brackets (full frame) ─────────────────────────────── */}
      {(['tl','tr','bl','br'] as const).map(pos => (
        <div
          key={pos}
          className="absolute"
          style={{
            ...(pos.startsWith('t') ? { top: 8 } : { bottom: 8 }),
            ...(pos.endsWith('l')   ? { left: 8 } : { right: 8 }),
            width: 20, height: 20,
            borderColor: col,
            borderStyle: 'solid',
            opacity: 0.7,
            borderWidth: 0,
            ...(pos === 'tl' && { borderTopWidth: 2, borderLeftWidth: 2 }),
            ...(pos === 'tr' && { borderTopWidth: 2, borderRightWidth: 2 }),
            ...(pos === 'bl' && { borderBottomWidth: 2, borderLeftWidth: 2 }),
            ...(pos === 'br' && { borderBottomWidth: 2, borderRightWidth: 2 }),
          }}
        />
      ))}

      {/* ── Face bounding box with corner brackets ────────────────────── */}
      {box && (
        <div
          className="absolute"
          style={{ ...box, transition: 'all 0.15s ease-out' }}
        >
          {(['tl','tr','bl','br'] as const).map(pos => (
            <div
              key={pos}
              className="absolute"
              style={{
                ...(pos.startsWith('t') ? { top: -1 } : { bottom: -1 }),
                ...(pos.endsWith('l')   ? { left: -1 } : { right: -1 }),
                width: 12, height: 12,
                borderColor: col,
                borderStyle: 'solid',
                opacity: 0.9,
                borderWidth: 0,
                ...(pos === 'tl' && { borderTopWidth: 2, borderLeftWidth: 2 }),
                ...(pos === 'tr' && { borderTopWidth: 2, borderRightWidth: 2 }),
                ...(pos === 'bl' && { borderBottomWidth: 2, borderLeftWidth: 2 }),
                ...(pos === 'br' && { borderBottomWidth: 2, borderRightWidth: 2 }),
              }}
            />
          ))}
          {/* Centre crosshair dot */}
          <div
            className="absolute rounded-full"
            style={{
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 4, height: 4,
              background: col, opacity: 0.8,
            }}
          />
        </div>
      )}

      {/* ── Status bar ────────────────────────────────────────────────── */}
      {!ghostMode && (
        <div
          className="absolute bottom-0 left-0 right-0 px-3 py-2"
          style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)',
          }}
        >
          {/* State label */}
          <div className="flex items-center justify-between mb-1">
            <span
              className="text-[9px] font-bold tracking-[0.3em] uppercase"
              style={{ color: col }}
            >
              {stateLabel[sessionState]}
            </span>
            <span
              className="text-[8px] opacity-50"
              style={{ color: col }}
            >
              {fps.toFixed(0)} fps
            </span>
          </div>

          {/* Score bar */}
          <div className="flex gap-1 items-center">
            <span className="text-[7px] opacity-50 text-gray-400 w-6">VRF</span>
            <div className="flex-1 h-0.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${verificationScore * 100}%`,
                  background: verificationScore >= SCORE_LOCK_THRESHOLD
                    ? col : '#ff4444',
                }}
              />
            </div>
            <span className="text-[7px] opacity-40 text-gray-400 w-8 text-right">
              {(verificationScore * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex gap-1 items-center mt-0.5">
            <span className="text-[7px] opacity-50 text-gray-400 w-6">LVN</span>
            <div className="flex-1 h-0.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${livenessScore * 100}%`,
                  background: livenessScore >= 0.8 ? col : '#ff9500',
                }}
              />
            </div>
            <span className="text-[7px] opacity-40 text-gray-400 w-8 text-right">
              {(livenessScore * 100).toFixed(0)}%
            </span>
          </div>

          {/* Challenge prompt */}
          {challenge && (
            <div
              className="mt-1.5 text-center text-[9px] font-bold tracking-widest uppercase animate-pulse"
              style={{ color: '#ffd700' }}
            >
              {challenge === 'BLINK' ? '● BLINK TO VERIFY' : '↕ NOD TO VERIFY'}
            </div>
          )}
        </div>
      )}

      {/* ── Biometric multi-layer sub-scores (HUD) ── */}
      {livenessLayers && !ghostMode && (
        <div className="absolute top-12 left-3 flex flex-col gap-1 opacity-85 pointer-events-none transition-all">
          {Object.entries(livenessLayers).map(([layerName, score]) => {
            const shortNames: Record<string, string> = {
              temporalBlink: 'TMP-BLK',
              poseChallenge: 'H-POSE',
              irisAsymmetry: 'IRIS-D',
              rppgBloodFlow: 'PPG-PLS',
              depth3DGeometry: 'GEO-3D',
              specularReflection: 'SPEC-R',
              colorSpaceSkin: 'CLR-SKN',
              moireFrequency: 'MOI-GRD',
              histogramConsistency: 'HIST-C',
              attentionGaze: 'ATN-GZE',
            };
            const label = shortNames[layerName] ?? layerName.toUpperCase().slice(0, 7);
            const scoreNum = score as number;
            const isOk = scoreNum >= 0.75;
            const isFail = scoreNum < 0.40;
            const statusColor = isFail ? '#ff4444' : isOk ? '#00ff88' : '#ffd700';
            return (
              <div
                key={layerName}
                className="text-[6.5px] px-1 py-0.5 rounded-[2px] bg-black/60 border border-white/10 flex items-center gap-1 animate-fade-in"
                style={{ borderColor: `${statusColor}25`, fontFamily: 'monospace' }}
              >
                <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: statusColor }} />
                <span className="text-white/60 w-[42px]">{label}</span>
                <span style={{ color: statusColor, width: '16px', textAlign: 'right' }}>{(scoreNum * 100).toFixed(0)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// §8  MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const FaceSecurityEngine = forwardRef<FaceSecurityEngineRef, FaceSecurityEngineProps>(
  (props, ref) => {
    const { ghostMode = false, showHUD = false } = props;

    const videoRef = useRef<HTMLVideoElement>(null);

    const {
      sessionState, lastFrame, isModelReady, registrationProgress, registrationPrompt,
      challenge, fps, faceBox, canvasRef,
      startRegistration, stopSession,
    } = useFaceSecurityEngine(videoRef, props);

    // Expose imperative API to parent
    useImperativeHandle(ref, () => ({
      startRegistration,
      stopSession,
      getLastFrame: () => lastFrame,
    }));

    // In ghost mode with showHUD=false: completely invisible
    // In ghost mode with showHUD=true:  tiny floating indicator
    // In normal mode:                   full camera preview + HUD

    if (ghostMode && !showHUD) {
      return (
        <>
          <video ref={videoRef} muted playsInline className="hidden" aria-hidden />
          <canvas ref={canvasRef} className="hidden" aria-hidden />
        </>
      );
    }

    const videoW = videoRef.current?.videoWidth  ?? 320;
    const videoH = videoRef.current?.videoHeight ?? 240;

    return (
      <div
        className={
          ghostMode
            ? 'fixed bottom-4 right-4 z-50 w-24 h-24 rounded-2xl overflow-hidden shadow-2xl'
            : 'relative w-full h-full rounded-2xl overflow-hidden bg-black'
        }
        style={{ aspectRatio: ghostMode ? '1/1' : '4/3' }}
      >
        {/* Video feed */}
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: 'scaleX(-1)' }}  // mirror effect
          aria-label="Face security camera feed"
        />

        {/* Off-screen canvas for brightness + motion sampling (never displayed) */}
        <canvas ref={canvasRef} className="hidden" aria-hidden />

        {/* HUD overlay */}
        {isModelReady && (
          <SecurityOverlay
            sessionState={sessionState}
            faceBox={faceBox}
            verificationScore={lastFrame?.verificationScore ?? 0}
            livenessScore={lastFrame?.livenessScore ?? 0}
            fps={fps}
            challenge={challenge}
            videoWidth={videoW}
            videoHeight={videoH}
            ghostMode={ghostMode}
            livenessLayers={lastFrame?.livenessLayers}
          />
        )}

        {/* Loading state */}
        {!isModelReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
            <div
              className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mb-2"
              style={{ borderColor: '#00ff88', borderTopColor: 'transparent' }}
            />
            <span
              className="text-[9px] tracking-widest uppercase opacity-60"
              style={{ color: '#00ff88', fontFamily: 'monospace' }}
            >
              LOADING ENGINE
            </span>
          </div>
        )}

        {/* Registration progress bar */}
        {sessionState === 'REGISTERING' && !ghostMode && (
          <div className="absolute top-3 left-3 right-3">
            <div className="h-0.5 w-full bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{
                  width: `${registrationProgress}%`,
                  background: '#00d4ff',
                  boxShadow: '0 0 8px #00d4ff',
                }}
              />
            </div>
            <p
              className="text-[8px] tracking-[0.4em] uppercase text-center mt-1 opacity-70"
              style={{ color: '#00d4ff', fontFamily: 'monospace' }}
            >
              {registrationPrompt} {registrationProgress}%
            </p>
          </div>
        )}
      </div>
    );
  }
);

FaceSecurityEngine.displayName = 'FaceSecurityEngine';
export default FaceSecurityEngine;

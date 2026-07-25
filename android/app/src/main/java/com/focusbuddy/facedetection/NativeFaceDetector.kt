package com.focusbuddy.facedetection

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Native replacement for the WebView/WASM-based MediaPipe Tasks Vision
 * detection pipeline. Runs MediaPipe's on-device Android Face Landmarker
 * (same .task model family and 478-point landmark topology as the web
 * version) directly against a CameraX feed, and pushes results to the
 * WebView via evaluateJavascript instead of running inference inside the
 * WebView's JS/WASM engine at all.
 *
 * Why: real device testing (both here and independently via Codex, with
 * live ADB access) showed the same class of failure across both the
 * legacy MediaPipe Solutions runtime AND the current Tasks Vision WASM
 * runtime, in the same WebView. This sidesteps that execution
 * environment entirely for the detection step.
 *
 * Deliberately does NOT touch the WebView's own camera access at all -
 * the existing getUserMedia video feed and its entire pixel-analysis
 * layer (rPPG liveness, moire/replay/texture anti-spoofing checks, the
 * visible registration preview) never depended on MediaPipe/WASM and was
 * never broken, so it stays completely untouched. This class only adds a
 * second, independent camera consumer purely for landmark detection,
 * running alongside it. If simultaneous access to the same camera isn't
 * supported on a given device, bindCamera()'s existing error handling
 * surfaces that clearly rather than corrupting either feed.
 */
class NativeFaceDetector(
    private val context: Context,
    private val onResult: (String) -> Unit,
) {
    private var faceLandmarker: FaceLandmarker? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var imageAnalysis: ImageAnalysis? = null
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var isSetup = false

    fun setup() {
        try {
            val baseOptions = BaseOptions.builder()
                .setDelegate(Delegate.CPU)
                .setModelAssetPath("native_face/face_landmarker.task")
                .build()

            val options = FaceLandmarker.FaceLandmarkerOptions.builder()
                .setBaseOptions(baseOptions)
                .setMinFaceDetectionConfidence(0.5f)
                .setMinTrackingConfidence(0.5f)
                .setMinFacePresenceConfidence(0.5f)
                .setNumFaces(4)
                .setOutputFaceBlendshapes(false)
                .setOutputFacialTransformationMatrixes(false)
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setResultListener(this::onLandmarkerResult)
                .setErrorListener(this::onLandmarkerError)
                .build()

            faceLandmarker = FaceLandmarker.createFromOptions(context, options)
            isSetup = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize native FaceLandmarker", e)
            onResult(errorJson("Native face landmarker init failed: ${e.message}"))
        }
    }

    /**
     * Binds ImageAnalysis (only - no Preview use case, see class doc) to
     * the given lifecycle, front camera, matching the exact CameraX
     * pattern already proven working elsewhere in this app
     * (FaceAnalyzerService's background security-check pipeline) rather
     * than inventing a new one.
     */
    fun bindCamera(lifecycleOwner: LifecycleOwner) {
        if (!isSetup) {
            Log.e(TAG, "bindCamera called before setup() succeeded")
            return
        }
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        cameraProviderFuture.addListener({
            try {
                val provider = cameraProviderFuture.get()
                cameraProvider = provider
                provider.unbindAll()

                val cameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .build()
                analysis.setAnalyzer(analysisExecutor) { imageProxy ->
                    analyzeFrame(imageProxy)
                }
                imageAnalysis = analysis

                try {
                    provider.bindToLifecycle(lifecycleOwner, cameraSelector, analysis)
                    Log.d(TAG, "Native face detector camera bound successfully")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to bind native face detector camera use case", e)
                    onResult(errorJson("Camera bind failed: ${e.message}"))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to get ProcessCameraProvider", e)
                onResult(errorJson("Camera provider failed: ${e.message}"))
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun analyzeFrame(imageProxy: ImageProxy) {
        val landmarker = faceLandmarker
        if (landmarker == null) {
            imageProxy.close()
            return
        }
        try {
            val frameTimeMs = SystemClock.uptimeMillis()
            val rotatedBitmap = imageProxyToOrientedBitmap(imageProxy)
            val mpImage = BitmapImageBuilder(rotatedBitmap).build()
            landmarker.detectAsync(mpImage, frameTimeMs)
        } catch (e: Exception) {
            Log.e(TAG, "Frame analysis failed", e)
        } finally {
            imageProxy.close()
        }
    }

    /**
     * Converts a CameraX ImageProxy to a correctly rotated AND mirrored
     * Bitmap. Mirroring matters for correctness, not just cosmetics: the
     * existing yaw-based pose logic (POSE_HINT "turn left/right" etc.)
     * and the whole descriptor/consensus math were tuned against the web
     * version's camera frames, where getUserMedia on a front camera is
     * conventionally auto-mirrored by the browser. Skipping the mirror
     * here would flip the sense of left/right between the old and new
     * pipelines - a subtle correctness regression, not just a visual one.
     */
    private fun imageProxyToOrientedBitmap(imageProxy: ImageProxy): Bitmap {
        val bitmapBuffer = Bitmap.createBitmap(
            imageProxy.width, imageProxy.height, Bitmap.Config.ARGB_8888
        )
        bitmapBuffer.copyPixelsFromBuffer(imageProxy.planes[0].buffer)

        val matrix = Matrix().apply {
            postRotate(imageProxy.imageInfo.rotationDegrees.toFloat())
            postScale(-1f, 1f, imageProxy.width.toFloat(), imageProxy.height.toFloat())
        }
        return Bitmap.createBitmap(
            bitmapBuffer, 0, 0, bitmapBuffer.width, bitmapBuffer.height, matrix, true
        )
    }

    /**
     * Converts the MediaPipe result into the same JSON shape the web
     * migration's estimateFaces() adapter already produces, so the
     * JS-side receiver can feed it into the existing pipeline with no
     * changes to any downstream consumer: an array of faces, each an
     * array of {x, y, z} points in PIXEL space (matching Kps = Pt[]).
     * Only the first (highest-confidence) face is meaningful downstream
     * today, but all detected faces are included - this preserves the
     * option to use face count for the buddy+stranger anti-exploitation
     * check without a second round-trip later.
     */
    private fun onLandmarkerResult(result: FaceLandmarkerResult, input: MPImage) {
        try {
            val facesJson = JSONArray()
            for (face in result.faceLandmarks()) {
                val keypoints = JSONArray()
                for (landmark in face) {
                    val point = JSONObject()
                    point.put("x", landmark.x() * input.width)
                    point.put("y", landmark.y() * input.height)
                    point.put("z", landmark.z() * input.width)
                    keypoints.put(point)
                }
                facesJson.put(keypoints)
            }
            val json = JSONObject()
            json.put("type", "faces")
            json.put("faces", facesJson)
            onResult(json.toString())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to serialize landmarker result", e)
        }
    }

    private fun onLandmarkerError(error: RuntimeException) {
        Log.e(TAG, "Native face landmarker error", error)
        onResult(errorJson(error.message ?: "Unknown native landmarker error (${error.javaClass.simpleName})"))
    }

    private fun errorJson(message: String): String {
        val json = JSONObject()
        json.put("type", "error")
        json.put("message", message)
        return json.toString()
    }

    /** Releases just the camera binding, keeping the (already-loaded) landmarker warm for a fast restart. */
    fun unbindCamera() {
        try {
            cameraProvider?.unbindAll()
        } catch (e: Exception) {
            Log.w(TAG, "Error unbinding camera", e)
        }
    }

    /** Releases the camera binding, the landmarker, and the executor. Safe to call multiple times. */
    fun close() {
        try {
            cameraProvider?.unbindAll()
        } catch (e: Exception) {
            Log.w(TAG, "Error unbinding camera", e)
        }
        try {
            faceLandmarker?.close()
        } catch (e: Exception) {
            Log.w(TAG, "Error closing face landmarker", e)
        }
        faceLandmarker = null
        cameraProvider = null
        imageAnalysis = null
        analysisExecutor.shutdown()
    }

    companion object {
        private const val TAG = "FocusBuddy/NativeFace"
    }
}

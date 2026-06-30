package com.focusbuddy.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.focusbuddy.GlobalState
import com.focusbuddy.MainActivity
import com.focusbuddy.security.SecurityChecker
import com.google.firebase.firestore.FirebaseFirestore
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.util.concurrent.atomic.AtomicReference

class FaceAnalyzerService : Service(), LifecycleOwner {

    companion object {
        private const val TAG = "FaceAnalyzer"
        private const val CHECK_INTERVAL_MS = 10_000L  // 10 seconds for device security checkers
        private const val CHANNEL_ID = "FocusBuddy_Face"
        private const val NOTIFICATION_ID = 101
        
        const val ACTION_START_CAMERA = "ACTION_START_CAMERA"
        const val ACTION_STOP_CAMERA = "ACTION_STOP_CAMERA"
    }

    private val lifecycleRegistry = LifecycleRegistry(this)
    override fun getLifecycle(): Lifecycle = lifecycleRegistry

    private val handler = Handler(Looper.getMainLooper())
    private val db = FirebaseFirestore.getInstance()
    private val sessionIdRef = AtomicReference<String?>(null)
    private val buddyIdRef = AtomicReference<String?>(null)

    private var cameraProvider: ProcessCameraProvider? = null
    private var faceDetector: FaceDetector? = null
    private var isCameraActive = false

    private val securityCheckRunnable = object : Runnable {
        override fun run() {
            performSecurityCheck()
            handler.postDelayed(this, CHECK_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        lifecycleRegistry.currentState = Lifecycle.State.CREATED
        createNotificationChannel()

        // Init ML Kit face detector
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
            .build()
        faceDetector = FaceDetection.getClient(options)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lifecycleRegistry.currentState = Lifecycle.State.STARTED

        val intentSessionId = intent?.getStringExtra("sessionId")
        val intentBuddyId = intent?.getStringExtra("buddyId")

        val sId = if (!intentSessionId.isNullOrEmpty()) intentSessionId else GlobalState.sessionId
        val bId = if (!intentBuddyId.isNullOrEmpty()) intentBuddyId else GlobalState.buddyId

        sessionIdRef.set(sId)
        buddyIdRef.set(bId)

        // Notification is required for foreground service
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Focus Buddy")
            .setContentText("Security monitoring active")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)

        // Start device integrity checks
        handler.removeCallbacks(securityCheckRunnable)
        handler.post(securityCheckRunnable)

        // Handle Camera state action
        val action = intent?.action
        Log.d(TAG, "onStartCommand action: $action, sessionId: $sId, buddyId: $bId")
        if (action == ACTION_START_CAMERA) {
            startCameraAnalysis()
        } else if (action == ACTION_STOP_CAMERA) {
            stopCameraAnalysis()
        }

        return START_STICKY
    }

    private fun startCameraAnalysis() {
        if (isCameraActive) return
        isCameraActive = true
        Log.i(TAG, "Starting CameraX background analysis...")
        
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            try {
                cameraProvider = cameraProviderFuture.get()
                bindCameraUseCases()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to get ProcessCameraProvider", e)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun bindCameraUseCases() {
        val provider = cameraProvider ?: return
        val detector = faceDetector ?: return
        
        provider.unbindAll()

        val cameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA
        val imageAnalysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()

        var consecutiveNoFaceFrames = 0
        val maxAllowedNoFaceFrames = 6  // ~1.2s at 5fps

        imageAnalysis.setAnalyzer(ContextCompat.getMainExecutor(this)) { imageProxy ->
            val mediaImage = imageProxy.image
            if (mediaImage != null) {
                val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
                detector.process(image)
                    .addOnSuccessListener { faces ->
                        val faceCount = faces.size
                        Log.d(TAG, "Background native faces detected: $faceCount")
                        
                        if (faceCount == 0 || faceCount > 1) {
                            consecutiveNoFaceFrames++
                            if (consecutiveNoFaceFrames >= maxAllowedNoFaceFrames) {
                                handleFaceViolation(faceCount)
                            }
                        } else {
                            consecutiveNoFaceFrames = 0
                        }
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "Background ML Kit Face detection failure", e)
                    }
                    .addOnCompleteListener {
                        imageProxy.close()
                    }
            } else {
                imageProxy.close()
            }
        }

        try {
            provider.bindToLifecycle(this, cameraSelector, imageAnalysis)
            Log.d(TAG, "Bound camera analysis use case successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to bind camera use cases to service lifecycle", e)
        }
    }

    private fun handleFaceViolation(faceCount: Int) {
        if (!GlobalState.isSessionActive) return
        val sessionId = sessionIdRef.get() ?: return
        val buddyId = buddyIdRef.get() ?: return

        val updates = hashMapOf<String, Any>(
            "pausedByFace" to true,
            "lastFaceMatch" to false
        )
        if (faceCount > 1) {
            updates["securityAlert"] = "STRANGER_DETECTED"
        } else {
            updates["securityAlert"] = "CAMERA_BLOCKED_OR_NO_FACE"
        }

        db.collection("sessions").document(sessionId)
            .collection("buddies").document(buddyId)
            .update(updates)
            .addOnSuccessListener {
                Log.w(TAG, "Reported Native Face Violation: $faceCount faces")
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to report native face violation", e)
            }
    }

    private fun stopCameraAnalysis() {
        if (!isCameraActive) return
        isCameraActive = false
        Log.i(TAG, "Stopping CameraX background analysis...")
        cameraProvider?.unbindAll()
    }

    private fun performSecurityCheck() {
        val sessionId = sessionIdRef.get()
        val buddyId = buddyIdRef.get()
        if (sessionId.isNullOrEmpty() || buddyId.isNullOrEmpty()) {
            Log.w(TAG, "Cannot perform security check: sessionId or buddyId is empty")
            return
        }

        // Watchdog: Force-bring MainActivity to the front if focus session is active
        if (GlobalState.isSessionActive) {
            val intent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            startActivity(intent)
        }

        val report = SecurityChecker.checkAll(this)

        if (report.hasAnyThreat) {
            Log.w(TAG, "SECURITY THREAT DETECTED: $report")
        }

        val updates = hashMapOf<String, Any>(
            "securityThreats" to mapOf(
                "rooted" to report.isRooted,
                "frida" to report.isFridaPresent,
                "xposed" to report.isXposedPresent,
                "emulator" to report.isEmulator,
                "debugger" to report.isDebuggerAttached,
                "safeMode" to report.isSafeMode,
                "adbEnabled" to report.isAdbEnabled,
                "devOptions" to report.isDevOptionsEnabled,
                "accessibilityDisabled" to report.isAccessibilityDisabled,
                "appDebuggable" to report.isAppDebuggable,
                "timestamp" to System.currentTimeMillis()
            )
        )

        db.collection("sessions").document(sessionId)
            .collection("buddies").document(buddyId)
            .update(updates)
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to report security threats", e)
            }

        if (report.isRooted || report.isFridaPresent || report.isXposedPresent || 
            report.isAccessibilityDisabled || report.isSafeMode) {
            db.collection("sessions").document(sessionId)
                .collection("buddies").document(buddyId)
                .update("securityAlert", "CRITICAL_THREAT_DETECTED")
                .addOnFailureListener { e ->
                    Log.e(TAG, "Failed to send critical alert", e)
                }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        handler.removeCallbacks(securityCheckRunnable)
        cameraProvider?.unbindAll()
        faceDetector?.close()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Security Monitoring",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Continuous security monitoring during focus sessions"
            setShowBadge(false)
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(channel)
    }
}

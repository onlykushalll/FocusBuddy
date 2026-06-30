# ── FocusBuddy ProGuard Rules ──────────────────────────────────

# General optimization
-repackageclasses ''
-allowaccessmodification
-overloadaggressively

# Remove debug logging in release
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
}

# Keep Firebase model classes (reflection-based)
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-keep class com.google.mlkit.** { *; }
-keep class com.google.firebase.firestore.** { *; }
-keep class com.google.firebase.auth.** { *; }

# Keep model classes used by reflection
-keep class com.focusbuddy.GlobalState { *; }
-keep class com.focusbuddy.managers.** { *; }

# Keep JavascriptInterface methods (called by reflection from WebView)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep data classes used by Firestore
-keep class com.focusbuddy.models.** { *; }
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes EnclosingMethod
-keepattributes InnerClasses

# Remove stack traces in release
-assumenosideeffects class java.lang.Throwable {
    public void printStackTrace();
    public native synchronized java.lang.Throwable fillInStackTrace();
}

# Kotlin metadata
-keep class kotlin.Metadata { *; }
-keepattributes KotlinMetadata

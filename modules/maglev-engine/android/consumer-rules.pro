# ProGuard / R8 rules for Maglev Engine
-keep class com.maglev.engine.** { *; }
-keepclassmembers class * {
    native <methods>;
}
-keepclassmembers class com.maglev.engine.MaglevEngineModule$Companion {
    public static void onTelemetryUpdate(java.lang.String);
    public static void onPauseAllRequested();
}

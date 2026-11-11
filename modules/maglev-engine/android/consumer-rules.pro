# ProGuard / R8 rules for Maglev Engine
# JNI: Rust looks these classes and methods up by name.
-keep class com.maglev.engine.NativeCore { *; }
-keepclassmembers class * {
    native <methods>;
}
-keep class com.maglev.engine.MaglevEngineModule { *; }
-keep class com.maglev.engine.service.MaglevTorrentService { *; }
-keep class com.maglev.engine.storage.MaglevFileProvider { *; }

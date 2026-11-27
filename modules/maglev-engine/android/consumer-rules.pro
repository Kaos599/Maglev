# ProGuard / R8 rules for Maglev Engine
# JNI: Rust looks these classes and methods up by name.
-keep class com.maglev.engine.NativeCore { *; }
-keepclassmembers class * {
    native <methods>;
}
-keep class com.maglev.engine.MaglevEngineModule { *; }
-keep class com.maglev.engine.service.MaglevTorrentService { *; }
-keep class com.maglev.engine.storage.MaglevFileProvider { *; }

# Video sites (youtubedl-android). commons-compress registers its zip extra-field classes by
# reflection in a static block (ExtraFieldUtils.register -> newInstance); R8 sees no direct use,
# strips the constructors, and unpacking the Python bundle fails with "class X is not a concrete
# class". The library and Jackson also look classes up by name.
-keep class com.yausername.** { *; }
-keep class org.apache.commons.compress.archivers.zip.** { *; }
-keep class com.fasterxml.jackson.databind.** { *; }
-keep class com.fasterxml.jackson.core.** { *; }
-dontwarn org.apache.commons.compress.**
-dontwarn com.fasterxml.jackson.**

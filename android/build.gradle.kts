plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
}

// Keep build output out of OneDrive.
System.getenv("LOCALAPPDATA")?.let { local ->
    allprojects { layout.buildDirectory.set(File(local, "nflpicks-build/$name")) }
}

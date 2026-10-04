import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

fun props(name: String) = Properties().apply {
    rootProject.file(name).takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

// The Firebase project's Android app config, kept out of source control in
// firebase.properties. Without it the app builds and runs, just without push.
// Read by hand (FirebaseOptions) rather than through the google-services
// plugin, which fails the build when google-services.json is missing.
val firebase = props("firebase.properties")
val keyProps = props("keystore.properties")
// SHA-256 of the admin key (the worker's NOTIFY_SECRET): Admin Settings opens only
// for a key that hashes to it. The hash is safe to ship; the key is not in the APK.
val admin = props("admin.properties")

fun quoted(value: String?) = "\"${value ?: ""}\""

android {
    namespace = "com.sfrut.nflpicks"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sfrut.nflpicks"
        minSdk = 26
        targetSdk = 34
        versionCode = 6
        versionName = "1.5"
        buildConfigField("String", "FIREBASE_API_KEY", quoted(firebase.getProperty("apiKey")))
        buildConfigField("String", "FIREBASE_APP_ID", quoted(firebase.getProperty("appId")))
        buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(firebase.getProperty("projectId")))
        buildConfigField("String", "FIREBASE_SENDER_ID", quoted(firebase.getProperty("senderId")))
        buildConfigField("String", "ADMIN_KEY_SHA256", quoted(admin.getProperty("adminKeySha256")))
    }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file(keyProps.getProperty("storeFile", "release.jks"))
            storePassword = keyProps.getProperty("storePassword")
            keyAlias = keyProps.getProperty("keyAlias")
            keyPassword = keyProps.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    lint { checkReleaseBuilds = false }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")

    implementation(platform("androidx.compose:compose-bom:2024.09.03"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")

    implementation(platform("com.google.firebase:firebase-bom:33.4.0"))
    implementation("com.google.firebase:firebase-messaging")
}

import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing details live outside the repository, in android/key.properties
// (gitignored) or in the environment on CI. Absent, the release build falls back
// to the debug key so `flutter run --release` still works locally — but a
// debug-signed bundle is rejected by Play, so `verifyReleaseSigning` below fails
// the build rather than letting one reach an upload.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) {
        file.inputStream().use { load(it) }
    }
}

fun signingDetail(key: String, environmentVariable: String): String? =
    keystoreProperties.getProperty(key) ?: System.getenv(environmentVariable)

val storeFilePath = signingDetail("storeFile", "ANDROID_KEYSTORE_PATH")
val hasReleaseSigning = storeFilePath != null && rootProject.file(storeFilePath).exists()

android {
    namespace = "dev.huelin.quotesjournal"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Permanent once published: Play identifies the app by this forever.
        applicationId = "dev.huelin.quotesjournal"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(storeFilePath!!)
                storePassword = signingDetail("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingDetail("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingDetail("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

/**
 * Guards the one mistake that is easy to make and expensive to discover: building
 * an app bundle with the debug key and only finding out when Play refuses the
 * upload. Run as part of `bundleRelease`, so a store build cannot skip it.
 */
tasks.register("verifyReleaseSigning") {
    doLast {
        if (!hasReleaseSigning) {
            throw GradleException(
                "Release signing is not configured, so this build would be signed with the debug key " +
                    "and rejected by Play. Create android/key.properties (see key.properties.example) " +
                    "or set ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and " +
                    "ANDROID_KEY_PASSWORD.",
            )
        }
    }
}

tasks.matching { it.name == "bundleRelease" }.configureEach {
    dependsOn("verifyReleaseSigning")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

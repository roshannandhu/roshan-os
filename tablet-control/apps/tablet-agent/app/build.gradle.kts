plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseStorePath = System.getenv("ROSHANOS_KEYSTORE_PATH")
val releaseStorePassword = System.getenv("ROSHANOS_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ROSHANOS_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ROSHANOS_KEY_PASSWORD")
val controllerPublicUrl = System.getenv("ROSHANOS_CONTROLLER_URL") ?: ""
val releaseSigningReady =
    !releaseStorePath.isNullOrBlank() &&
        !releaseStorePassword.isNullOrBlank() &&
        !releaseKeyAlias.isNullOrBlank() &&
        !releaseKeyPassword.isNullOrBlank() &&
        file(releaseStorePath).isFile

android {
    namespace = "com.tabletcontrol.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tabletcontrol.companion"
        minSdk = 30
        targetSdk = 34
        versionCode = 3
        versionName = "3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Runtime credentials are managed dynamically by CredentialStore.
        // No tokens or PIN hashes are compiled into the APK or BuildConfig.
        buildConfigField("int", "COMPANION_PORT", "8765")
        buildConfigField("int", "CAMERA_PORT", "8081")
        // Controller URL for recovery-only Tailscale re-enrollment. Set via
        // ROSHANOS_CONTROLLER_URL environment variable at build time.
        // Empty string disables the recovery endpoint. Not used during normal boot.
        buildConfigField("String", "CONTROLLER_PUBLIC_URL", "\"$controllerPublicUrl\"")
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("roshanRelease") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        getByName("release") {
            isDebuggable = false
            isMinifyEnabled = false
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("roshanRelease")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-ui:1.3.1")
    implementation("androidx.media3:media3-common:1.3.1")

    implementation("androidx.camera:camera-core:1.3.1")
    implementation("androidx.camera:camera-camera2:1.3.1")
    implementation("androidx.camera:camera-lifecycle:1.3.1")
    implementation("androidx.camera:camera-view:1.3.1")
    implementation("androidx.lifecycle:lifecycle-service:2.6.2")
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
}

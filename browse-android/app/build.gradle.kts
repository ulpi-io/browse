plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "io.ulpi.browse.driver"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.ulpi.browse.driver"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // Instrumentation test runner
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Port the on-device HTTP service listens on (forwarded via adb forward)
        buildConfigField("int", "DRIVER_PORT", "7779")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    // Instrumentation tests live here — no regular app sources needed
    sourceSets {
        getByName("androidTest") {
            java.srcDirs("src/androidTest/java")
        }
    }
}

dependencies {
    // Instrumentation test runner + rules
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.ext.junit)

    // UiAutomator for accessibility tree traversal
    androidTestImplementation(libs.androidx.uiautomator)

    // Kotlin coroutines (for the HTTP service inside the driver)
    androidTestImplementation(libs.kotlinx.coroutines.android)

    // Minimal HTTP server (NanoHTTPD) — no Play Services required
    androidTestImplementation(libs.nanohttpd)
}

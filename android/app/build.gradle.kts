plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val vName = (project.findProperty("versionName") as String?) ?: "2.1.0"
val vCode = ((project.findProperty("versionCode") as String?) ?: "1").toInt()

android {
    namespace = "com.switchboard.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.switchboard.app"
        minSdk = 26
        targetSdk = 35
        versionCode = vCode
        versionName = vName
    }

    signingConfigs {
        create("release") {
            // Note: this key is stored in the repo so every GitHub build installs as an update over the last.
            storeFile = rootProject.file("switchboard.jks")
            storePassword = "switchboard-android"
            keyAlias = "switchboard"
            keyPassword = "switchboard-android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

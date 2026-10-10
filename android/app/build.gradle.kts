plugins {
    id("com.android.application")
}

android {
    namespace = "dev.denmercs.jarvis"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.denmercs.jarvis"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

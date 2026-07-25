// Aqua Desk Android — 독립 Gradle 빌드 (모노레포의 npm 워크스페이스와 분리).
// 빌드: apps/android 에서 ./gradlew assembleDebug (JDK 17, ANDROID_HOME 필요)
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "aqua-desk-android"
include(":app")

"""After Android prebuild, give the debug APK a separate install id and the local Metro entry."""
from pathlib import Path

app = Path(__file__).resolve().parents[2] / "android/app"
gradle = app / "build.gradle"
before = gradle.read_text()
marker = 'applicationIdSuffix ".pushcheck"'
if marker not in before:
    anchor = "    buildTypes {\n        debug {"
    assert before.count(anchor) == 1
    gradle.write_text(before.replace(anchor, anchor + "\n            " + marker))

application, = (app / "src/main/java").rglob("MainApplication.kt")
before = application.read_text()
entry = 'jsMainModulePath = if (BuildConfig.DEBUG) "app/e2e-native/push/entry" else ".expo/.virtual-metro-entry",'
if entry not in before:
    anchor = "      context = applicationContext,"
    assert before.count(anchor) == 1
    application.write_text(before.replace(anchor, anchor + "\n      " + entry))

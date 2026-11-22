"""Check the generated iOS target graph and Android Release manifest after both builds."""
import json
import pathlib
import plistlib
import subprocess
import xml.etree.ElementTree as ET

app = pathlib.Path(__file__).resolve().parents[1] / "app"
ios = app / "ios"
pbx = ios / "HSNS5.xcodeproj/project.pbxproj"
objects = json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", pbx]))["objects"]
targets = {v["name"]: v for v in objects.values() if v.get("isa") == "PBXNativeTarget"}
ext = targets["HsnPushExtension"]
assert ext["productType"] == "com.apple.product-type.app-extension"


def files(target, phase_type):
    """Resolve target phase entries through build-file and file-reference IDs."""
    return [objects[objects[entry]["fileRef"]]["path"]
            for phase_id in target["buildPhases"]
            for phase in [objects[phase_id]] if phase["isa"] == phase_type
            for entry in phase["files"]]


assert files(ext, "PBXSourcesBuildPhase") == ["NotificationService.swift"]
assert set(files(ext, "PBXResourcesBuildPhase")) == {"common.json", "push-words.json"}
assert files(targets["HSNS5"], "PBXCopyFilesBuildPhase").count("HsnPushExtension.appex") == 1
assert not any(path.endswith("NotificationService.swift") for path in files(targets["HSNS5"], "PBXSourcesBuildPhase"))
for target in ("HSNS5", "HsnPushExtension"):
    entitlements = plistlib.loads((ios / target / (target + ".entitlements")).read_bytes())
    assert entitlements["com.apple.security.application-groups"] == ["group.invalid.hsn.app.s5spike"]
    assert "com.apple.developer.usernotifications.critical-alerts" not in entitlements
    if target == "HSNS5":
        assert entitlements["com.apple.developer.usernotifications.time-sensitive"]

manifest = app / "android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml"
application = ET.parse(manifest).getroot().find("application")
ns = "{http://schemas.android.com/apk/res/android}"
priorities = {service.get(ns + "name"): int(intent.get(ns + "priority", "0"))
              for service in application.findall("service")
              for intent in service.findall("intent-filter")
              if any(a.get(ns + "name") == "com.google.firebase.MESSAGING_EVENT" for a in intent.findall("action"))}
assert priorities["expo.modules.hsnpush.HsnMessagingService"] == 0
assert priorities["expo.modules.notifications.service.ExpoFirebaseMessagingService"] == -1
assert application.find(f"receiver[@{ns}name='expo.modules.hsnpush.StandInFcmReceiver']").get(ns + "permission") == "android.permission.DUMP"
print("iOS extension embedded once with two resources; Android messaging priorities:", priorities)

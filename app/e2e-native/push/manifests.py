"""Check the app manifests produced by process{Debug,Release}MainManifest after prebuild."""
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2] / "android/app/build/intermediates/merged_manifest"
ns = "{http://schemas.android.com/apk/res/android}"
for variant in ("debug", "release"):
    path = root / variant / f"process{variant.title()}MainManifest/AndroidManifest.xml"
    manifest = ET.parse(path)
    services = {s.get(ns + "name"): s for s in manifest.findall(".//service")}
    own = services["app.hsn.push.MessagingService"]
    assert own.get(ns + "exported") == "false"
    assert own.find(f".//action[@{ns}name='com.google.firebase.MESSAGING_EVENT']") is not None
    local = manifest.find(f".//receiver[@{ns}name='app.hsn.push.LocalDelivery']")
    assert (local is not None) == (variant == "debug")
    if local is not None:
        assert local.get(ns + "permission") == "android.permission.DUMP"
    print(f"{variant}: messaging service present, debug injector {'present and shell-protected' if local is not None else 'absent'}")

"""Read the spike's iOS 27 delivery records. Print only fields needed for S5."""
import datetime
import pathlib
import plistlib
import sys

device = pathlib.Path.home() / "Library/Developer/CoreSimulator/Devices" / sys.argv[1]
bundle = "invalid.hsn.app.s5spike"
records = []
for archive in (device / "data/Library/UserNotifications").glob("*/DeliveredNotifications.plist"):
    data = archive.read_bytes()
    if bundle.encode() not in data:
        continue
    keyed = plistlib.loads(data)
    objects = keyed["$objects"]
    root = objects[keyed["$top"]["root"].data]
    for ref in root["NS.objects"]:
        row = objects[ref.data]
        fields = {objects[k.data]: objects[v.data] for k, v in zip(row["NS.keys"], row["NS.objects"])}
        date = datetime.datetime.fromtimestamp(
            978307200 + fields["AppNotificationCreationDate"]["NS.time"], datetime.timezone.utc
        )
        records.append((date.isoformat(), fields.get("AppNotificationMessage", ""),
                        fields["InterruptionLevel"], fields["CriticalAlertSound"]))
for row in sorted(records):
    print(*row, sep=" | ")

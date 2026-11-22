"""Check one Android action trial from the spike's two JSONL journals.
Pass the phone's new journal lines for this trial and the scene's log as arguments.
"""
import json
import pathlib
import sys


def events(path):
    """Read the two newline-delimited measurement streams."""
    return [json.loads(line) for line in pathlib.Path(path).read_text().splitlines()]


phone, scene = map(events, sys.argv[1:])
tap, = [row for row in phone if row["event"] == "android.disarm.action"]
sequence = ["js.disarm.start", "js.socketOpen", "js.message2", "js.companionSent",
            "js.reply", "app.disarm.outcome"]
steps = [row for row in phone if row["atMs"] >= tap["atMs"]
         and row["pid"] == tap["pid"] and row["event"] in sequence]
assert [row["event"] for row in steps] == sequence, "missing or out-of-order session events"
assert steps[0]["state"].startswith("background"), "JavaScript ran in the foreground"
reply = steps[-2]
disarmed = reply["disarmed"]
if isinstance(disarmed, str):
    disarmed = json.loads(disarmed)
assert reply["ok"] and tap["device"] in disarmed and steps[-1]["ok"], "wrong Disarm outcome"
states = [sensor["arm"] for row in scene if row["event"] == "hub.arming"
          for sensor in row["body"]["sensors"] if sensor["sensor"] == tap["device"]]
assert "armed" in states and states[-1] == "disarmed", "observer did not see the sensor disarm"
for row in steps:
    print(row["event"], row["atMs"] - tap["tapMs"], "ms from action receiver")

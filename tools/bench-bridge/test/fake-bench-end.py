"""The bench's end of one network link, for the bridge's tests: a pseudo-terminal whose far end
the bridge opens. It prints `path <tty>` first, then `open` and `closed` as the far end opens and
closes the terminal, and `data <hex>` for the bytes it writes; a line `write <hex>` on standard
input is written to the terminal. The terminal is left as a new one is: the bridge must set it."""
import os
import pty
import select
import sys
import time

master, slave = pty.openpty()
print("path " + os.ttyname(slave), flush=True)
# The bench holds only its own end: the far end being open is what "up" means.
os.close(slave)
state = "closed"
pending = b""


def say(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


while True:
    ready, _, _ = select.select([master, 0], [], [], 0.02)
    now = state
    if master in ready:
        try:
            data = os.read(master, 4096)
        except OSError:
            data = b""
        if data:
            now = "open"
        else:
            now = "closed"
    else:
        # No hang-up reported within the wait: the far end holds the terminal.
        now = "open"
    if now != state:
        state = now
        say(state)
    if master in ready and data:
        say("data " + data.hex())
    if state == "closed" and master in ready:
        time.sleep(0.02)
    if 0 in ready:
        chunk = os.read(0, 65536)
        if not chunk:
            break
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            words = line.decode().split()
            if len(words) == 2 and words[0] == "write":
                try:
                    os.write(master, bytes.fromhex(words[1]))
                except OSError:
                    pass

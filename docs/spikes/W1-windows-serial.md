# W1: USB serial under Bun on Windows

The Windows adapter implements option (a) in M2 section 9. It opens the device exclusively as `\\.\COMn`, reads the existing settings, sets the DCB and reads it back, then sets the timeouts and purges both queues. The adapter keeps the current baud rate and uses 8 data bits, one stop bit, binary mode, no parity, no flow control and no byte translation. DTR and RTS are both disabled. A Bun worker makes the blocking reads and writes. An idle read returns within the configured 500 ms. Closing signals the worker, and the hub releases the handle when the worker exits. macOS and Linux still use termios. [DCB layout](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-dcb) · [COMMTIMEOUTS](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-commtimeouts)

A second worker watches `HKLM\HARDWARE\DEVICEMAP` with `RegNotifyChangeKeyValue`. Watching the parent covers creation of `SERIALCOMM` when the first port appears. The hub scans at registration and on change notifications. A 500 ms wait on the worker lets it check for shutdown without enumerating devices. Enumeration and USB vendor matching use the existing `serialport` listing, whose Windows binding already uses SetupAPI. [Registry change notifications](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regnotifychangekeyvalue)

## What was tried

| Where | Check | Result |
| --- | --- | --- |
| Mac, Win32 doubles | Exact DCB and timeout bytes, call order, read-back refusal, single- and two-digit COM names, access denied, missing and busy ports, configuration errors, unplug-like read error, partial and failed writes, pending read and double close | Passed in `hub/test/unit/safe/serial-windows.test.ts` |
| Mac, real Bun worker with doubled reads and writes | Each of the 256 values reaches the other thread unchanged in both directions | Passed in the same test |
| Hosted Windows, Bun 1.4.2 | Compare available Windows ports with `serialport` | Both listed COM2 in Check run 44325023242 |
| Hosted Windows, native COM2 | Production adapter opens, verifies the DCB, starts the worker, closes and reopens the port. The system tool inspects the released port | Both opens passed, and `mode.exe` agreed on 8N1, flow control, DTR and RTS in Check run 44336777947 |
| Hosted Windows, installed service | Find and start the worker bundled in the executable, register the Windows registry watch and check the log for the old `/dev` error | Watcher registered, no `watch /dev` error in Installers run 44330936578 |

The runner has no USB board. The logs cannot establish USB CDC behaviour, vendor identification of an attached board, reset behaviour, physical unplug and replug, sustained traffic or the 0.5% idle CPU budget on the owner's hardware.

## Checklist on the owner's Windows PC

Use an Olimex ESP32-S3 gateway on development firmware and a disarmed test installation. Run these commands from an elevated PowerShell window.

1. With the board unplugged, run `Get-Service HSNHub` and `hsn status`. Expect a running service and a status reply. Run `Get-Content "$env:ProgramData\HSN Hub\logs\HSNHub.err.log" -Tail 40` and look for `watching Windows serial ports`.
2. Plug in the gateway. Run `Get-PnpDevice -PresentOnly -Class Ports` to identify its COM number. Run `hsn usb list`. Expect the same COM number and the gateway's Identity without a service restart. Note how long the board takes to appear.
3. For a spare unpaired gateway, run `hsn usb add COM10 --name "W1 gateway" --role gateway`, substituting the listed port. Pairing intentionally restarts the board. After it returns, run `hsn status` and look for the named gateway, a session and a COM link. Open and close a paired sensor's door and run `hsn status` after each change. Expect both door states to arrive through the gateway.
4. Unplug the gateway. Run `hsn status` and check that its COM link disappears. Replug it and check that the link and fresh sensor readings return. Run `Restart-Service HSNHub` with the board already connected and confirm that the gateway comes back.
5. Watch the gateway's boot indication or a firmware uptime counter. Keep the board powered independently if it supports that. Run `Stop-Service HSNHub`, then `mode COM10` using the actual port. Expect `mode` to open the released port. Run `Start-Service HSNHub` and verify that the gateway reconnects. Neither closing nor opening the handle should reset the board. Repeat with a two-digit COM number if the first test used one digit.

W1's physical measurements are still due. In particular, time the release and unplug detection against 1 s and new-port detection against 2 s, measure idle CPU, and run a byte and frame transfer soak on the real board.

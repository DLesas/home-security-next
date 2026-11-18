# W1: USB serial under Bun on Windows

The Windows adapter implements option (a) in M2 section 9. It opens `\\.\COMn` exclusively with `FILE_FLAG_OVERLAPPED`, configures the DCB, reads it back, sets the timeouts and purges both queues. It keeps the current baud rate, using 8N1, binary mode, no flow control and no byte translation. Read-back checks the named fields and reports the first mismatch with the actual and expected values. Reserved bits and the inactive XOFF continuation policy are ignored. [DCB layout](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-dcb)

One Bun worker keeps a `ReadFileEx` request pending and waits for its completion, a queued write or a stop. `WriteFileEx` starts as soon as the write event wakes the worker, even if the read is still pending. Both calls report completion through callbacks. This avoids depending on a separate FFI call to `GetLastError` to tell pending I/O from a failed submission. The error slot can be overwritten between FFI calls, so those values are diagnostic only. The read and write driver timeouts stay at 500 ms. A stop wakes the worker, which cancels and drains pending I/O before giving the handle back. [Overlapped operations](https://learn.microsoft.com/en-us/windows/win32/devio/overlapped-operations) · [COMMTIMEOUTS](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-commtimeouts)

A short or failed write closes the link after reporting `sendFailed` for that frame and each queued frame. After handle release the hub immediately tries the port once, with a new link and a zero delimiter before its first frame to end any leftover partial frame at the board. The old queue is discarded. A valid inbound frame restores the allowance for one reopen. If reopening fails or the new link fails to write before receiving a frame, the port waits for device discovery or a hub restart.

A second worker watches `HKLM\HARDWARE\DEVICEMAP` with `RegNotifyChangeKeyValue`. Watching the parent covers creation of `SERIALCOMM` when the first port appears. The hub scans at registration and on change notifications. A 500 ms wait lets the watcher check for shutdown without enumerating devices. Enumeration and USB vendor matching use the existing SetupAPI-backed `serialport` listing. [Registry change notifications](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regnotifychangekeyvalue)

## What was tried

| Where | Check |
| --- | --- |
| Mac, Win32 doubles | Check DCB, timeout and x64 `OVERLAPPED` bytes, diagnostic read-back refusal, COM names, native call order and error handling. Send all 256 byte values both ways through an actual Bun worker. |
| Mac, held-open read doubles | Measure write through completion and close through handle release, with a 10 ms bound to allow local worker scheduling around a 5 ms target. Cover writes during a pending read, just before and after a read, successive writes, a write racing a close and late data after stop. |
| Mac, framed link over the worker doubles | Check the failed send references, handle release, one reopen, delimiter and fresh traffic. A second failure before a received frame leaves the port closed until discovery. |
| Hosted Windows | Windows and Bun both listed virtual COM2. The native probe checks overlapped open and DCB read-back, observes a pending kernel read at the write call and when cancelling on a fresh open, and times completion and release. `mode.exe` independently checks the released port. |
| Hosted Windows, installed service | Check that the embedded worker starts the registry watcher, instead of attempting to watch `/dev`. |

## What is not shown

A virtual COM port proves kernel I/O submission, completion and handle release. It cannot show receipt by a USB device. Physical USB CDC, vendor matching, unplug and replug timing, sustained traffic and the idle CPU budget remain to be measured.

Windows defaults to DTR and RTS disabled. macOS and Linux assert both on open. These are provisional board settings. If USB CDC needs DTR, the board may never answer Identify with DTR off. An auto-reset circuit can reset the board on open or close with the wrong DTR/RTS transition. Check both symptoms before choosing the board's setting.

## Checklist on the owner's Windows PC

Use an Olimex ESP32-S3 gateway on development firmware and a disarmed test installation. Run from an elevated PowerShell window, with Bun 1.4.2 and the checkout dependencies available.

1. With the board unplugged, run `Get-Service HSNHub` and `hsn status`. Expect a running service and a status reply. Run `Get-Content "$env:ProgramData\HSN Hub\logs\HSNHub.err.log" -Tail 40` and look for `watching Windows serial ports`.
2. Plug in the gateway and find its port with `Get-PnpDevice -PresentOnly -Class Ports`. Run `hsn usb list`. Expect the COM number and the gateway's Identity without a service restart. Time discovery against 2 s.
3. Free the port with `Stop-Service HSNHub`. From the checkout root, run these commands with the actual COM number in place of `COM10`. No hub rebuild is needed. Watch the board's boot indication or firmware uptime during each open and close. Record which settings receive Identity and whether any setting resets the board.
   - `bun hub/test/windows/serial-probe.ts COM10 off off --identify`
   - `bun hub/test/windows/serial-probe.ts COM10 on on --identify`
   - `bun hub/test/windows/serial-probe.ts COM10 on off --identify`
   - `bun hub/test/windows/serial-probe.ts COM10 off on --identify`
4. Run `mode COM10` with the actual port. Expect it to open the released port. Run `Start-Service HSNHub`. If the default setting passed the direct probe, expect Identity again in `hsn usb list`.
5. For a spare unpaired gateway, run `hsn usb add COM10 --name "W1 gateway" --role gateway`. Pairing intentionally restarts the board. Afterwards run `hsn status` and look for the named gateway, a session and a COM link. Open and close a paired sensor's door and verify both states. Unplug the gateway and verify within 1 s that its link disappears. Replug, and verify that the link and fresh sensor readings return. Run `Restart-Service HSNHub` with the board connected, then check for reconnection.
6. Repeat with a two-digit COM number if the first trial used one digit. Measure idle CPU and run the 24-hour byte and frame soak with the board.

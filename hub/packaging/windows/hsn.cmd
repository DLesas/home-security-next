@echo off
rem `hsn` (hub-design.md section 9), for administrators: from an elevated prompt (m2-design.md
rem section 9, W2). An ordinary prompt is refused by the control socket's folder.
setlocal
set "HSN_DATA_DIR=%ProgramData%\HSN Hub"
"%ProgramFiles%\HSN Hub\current\bin\hsn-hub.exe" cli %*
exit /b %ERRORLEVEL%

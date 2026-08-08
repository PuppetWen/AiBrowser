@echo off
setlocal
chcp 65001 >nul

rem Everything is derived from this script's directory so the whole folder can
rem be moved to another drive, another directory, or another Windows PC.
set "OPENBROWSER_PROJECT_ROOT=%~dp0"
set "OPENBROWSER_PORTABLE=1"
set "OPENBROWSER_CACHE=%~dp0.cache"
set "OPENBROWSER_USER_DATA=%~dp0browser-data"
set "OPENBROWSER_RUNTIME_ROOT=%~dp0.runtime"
set "OPENBROWSER_API_PORT=60725"

rem Keep package downloads, Electron files, Wayfern settings, logs and temp
rem files beside the project instead of resolving them from the current user.
set "npm_config_cache=%OPENBROWSER_CACHE%\npm"
set "ELECTRON_CACHE=%OPENBROWSER_CACHE%\electron"
set "ELECTRON_BUILDER_CACHE=%OPENBROWSER_CACHE%\electron-builder"
set "APPDATA=%OPENBROWSER_USER_DATA%\appdata"
set "LOCALAPPDATA=%OPENBROWSER_USER_DATA%\localappdata"
set "TEMP=%OPENBROWSER_CACHE%\temp"
set "TMP=%TEMP%"

set "OPENBROWSER_LAUNCH_LOG=%OPENBROWSER_USER_DATA%\launcher.log"

for %%D in (
  "%npm_config_cache%"
  "%ELECTRON_CACHE%"
  "%ELECTRON_BUILDER_CACHE%"
  "%OPENBROWSER_USER_DATA%"
  "%APPDATA%"
  "%LOCALAPPDATA%"
  "%TEMP%"
) do (
  if not exist "%%~D" mkdir "%%~D"
)

set "NODE_EXE=%OPENBROWSER_RUNTIME_ROOT%\node\node.exe"
if not exist "%NODE_EXE%" (
  for %%N in (node.exe) do set "NODE_EXE=%%~$PATH:N"
)
if not defined NODE_EXE (
  set "FAIL_MSG=Node runtime missing. Expected: %OPENBROWSER_RUNTIME_ROOT%\node\node.exe"
  goto :fail
)
if not exist "%NODE_EXE%" (
  set "FAIL_MSG=Node runtime missing. Expected: %OPENBROWSER_RUNTIME_ROOT%\node\node.exe"
  goto :fail
)

cd /d "%~dp0Browserapp"
if errorlevel 1 (
  set "FAIL_MSG=Failed to enter the Browserapp directory."
  goto :fail
)

call :log "start (node=%NODE_EXE%)"
"%NODE_EXE%" "%~dp0Browserapp\scripts\run-app.js"
if errorlevel 1 (
  set "FAIL_MSG=AiBrowser exited with an error. See the lines above in this log."
  goto :fail
)
call :log "exit ok"
exit /b 0

rem --------------------------------------------------------------------------
rem AiBrowser-Launcher.exe runs this with a hidden console, so a bare `pause`
rem there would block forever on a window nobody can see and leave an orphan
rem cmd.exe behind. Always write the reason to a log; only pause when a human
rem is actually looking at a console.
rem --------------------------------------------------------------------------
:fail
echo %FAIL_MSG%
call :log "FAIL: %FAIL_MSG%"
if not defined OPENBROWSER_LAUNCHED_BY pause
exit /b 1

:log
>>"%OPENBROWSER_LAUNCH_LOG%" echo [%DATE% %TIME%] %~1
exit /b 0

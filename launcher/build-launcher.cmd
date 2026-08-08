@echo off
setlocal
set "ROOT=%~dp0.."
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Microsoft C# compiler was not found.
  exit /b 1
)

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ ^
  /reference:System.dll /reference:System.Windows.Forms.dll ^
  /win32icon:"%ROOT%\Browserapp\assets\logo.ico" ^
  /win32manifest:"%~dp0AiBrowserLauncher.manifest" ^
  /out:"%ROOT%\AiBrowser.exe" ^
  "%~dp0AiBrowserLauncher.cs"

if errorlevel 1 exit /b 1
copy /y "%ROOT%\AiBrowser.exe" "%ROOT%\AiBrowser-Launcher.exe" >nul
if errorlevel 1 exit /b 1
echo Created: %ROOT%\AiBrowser.exe
echo Created: %ROOT%\AiBrowser-Launcher.exe

@echo off
REM Outpeek — full Tauri dev app on this PC, local UI (no LAN server).
REM
REM `bun run dev` alone fails with "linker `link.exe` not found" unless
REM the MSVC environment is loaded first: the linker lives inside Visual Studio
REM and is not on PATH. vcvars64.bat puts it there, then the app starts.
setlocal
cd /d "%~dp0"

echo [recon] pulling latest from origin
git pull --ff-only
if errorlevel 1 echo [recon] WARNING: git pull failed - running the local checkout as-is
echo.

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VCVARS="
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
  )
)
if not defined VCVARS set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"

if exist "%VCVARS%" (
  echo [recon] loading MSVC environment
  call "%VCVARS%" >nul
) else (
  echo [recon] WARNING: Visual Studio C++ tools not found. Install "Desktop development with C++".
)

where link >nul 2>&1 && echo [recon] linker ready
echo [recon] starting tauri dev (local UI)
bun run dev

if errorlevel 1 (
  echo.
  echo [recon] the build failed - the error is above. Press any key to close.
  pause >nul
)

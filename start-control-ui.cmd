@echo off
rem Soc_brain Control UI — double-click launcher (Issue #132).
rem Approach A (cwd-independent): every path is ABSOLUTE, resolved from %~dp0
rem (this file's own folder = the canonical repo root). node is never called
rem with a relative script path and this script never changes directory.
rem No fallback to UI v1: the guarded launcher file IS the one that runs.
setlocal
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "REPO=duongpdddic-droid/Soc_brain"
set "LAUNCHER=%SCRIPT_DIR%\packages\control-ui\launcher.mjs"
set "HELPER=%TEMP%\soc-ui-launch-helper-%RANDOM%.ps1"

if not exist "%LAUNCHER%" (
  echo ERROR: CONTROL_UI_LAUNCHER_NOT_FOUND
  echo Expected launcher at: %LAUNCHER%
  echo Fix the checkout, then run this file again.
  pause
  exit /b 1
)

> "%HELPER%" (
  echo $ErrorActionPreference = 'Stop'
  echo $node = Get-Command node.exe -ErrorAction SilentlyContinue
  echo if (-not $node^) { Write-Host '[start-control-ui] NODE_NOT_FOUND: node.exe khong co trong PATH.'; exit 3 }
  echo $out = ^& node.exe '%LAUNCHER%' --repo '%REPO%' --port 3117 2^>^&1
  echo $code = $LASTEXITCODE
  echo Write-Host $out
  echo if ($code -ne 0^) { exit $code }
  echo $m = [regex]::Match(($out -join ' '^), 'http://127\.0\.0\.1:\d+/'^)
  echo if (-not $m.Success^) { Write-Host '[start-control-ui] URL_NOT_DETECTED.'; exit 4 }
  echo Write-Host ('[start-control-ui] OPENING ' + $m.Value^)
  echo Start-Process $m.Value
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%"
set "RC=%ERRORLEVEL%"
del "%HELPER%" >nul 2>&1

if not "%RC%"=="0" (
  echo.
  echo [start-control-ui] FAILED exit code %RC%. Reason shown above.
  if "%RC%"=="3" echo Reason: node.exe not found in PATH.
  if "%RC%"=="4" echo Reason: server started but no URL was reported.
  echo Close this window or press a key to exit.
  pause
  exit /b %RC%
)
endlocal

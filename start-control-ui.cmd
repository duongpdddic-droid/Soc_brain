@echo off
rem Soc_brain Control UI launcher v0 — double-click to start (loopback only).
rem Spawns a detached server on 127.0.0.1:3117 and opens the default browser.
node "%~dp0packages\control-ui\launcher.mjs" --repo duongpdddic-droid/Soc_brain --port 3117
if errorlevel 1 (
  echo.
  echo [launcher] Fix the problem shown above, then double-click this file again.
  pause
)

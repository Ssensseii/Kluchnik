@echo off
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0klyuchnik-server.mjs" --open
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Use the Windows installer or install Node.js 22 or later.
    pause
    exit /b 1
  )
  node "%~dp0klyuchnik-server.mjs" --open
)
if errorlevel 1 pause

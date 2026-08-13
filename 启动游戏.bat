@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please reopen this file after installing Node.js.
  echo https://nodejs.org/
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":8765 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 8765 is already in use by an older server.
  echo Close the old "SixGo Local Server" window, then run this file again.
  pause
  exit /b 1
)

if exist "%~dp0cloudflared.exe" (
  set "CF_CMD=%~dp0cloudflared.exe"
) else if exist "%~dp0cloudflared-windows-amd64.exe" (
  set "CF_CMD=%~dp0cloudflared-windows-amd64.exe"
) else if exist "%~dp0cloudflared-windows-386.exe" (
  set "CF_CMD=%~dp0cloudflared-windows-386.exe"
) else (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo cloudflared.exe was not found.
    echo Put cloudflared.exe in this game folder and try again.
    pause
    exit /b 1
  )
  set "CF_CMD=cloudflared"
)

start "SixGo Local Server" /D "%~dp0" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "http://localhost:8765"

echo ============================================================
echo Cloudflare Tunnel is starting...
echo Share the https://xxxx.trycloudflare.com address shown below.
echo Keep both terminal windows open while playing.
echo Press Ctrl+C to stop the public tunnel.
echo ============================================================
echo.
"%CF_CMD%" tunnel --url http://localhost:8765

echo.
echo Cloudflare Tunnel has stopped.
pause
endlocal

@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Aurora Squawk Designator - starting...
echo ============================================
echo.
echo Reminder: Aurora must have "3rd Party Software
echo Access" enabled (PVD -^> Settings/F7 -^> Other)
echo and Aurora should already be running.
echo The server auto-reconnects, so start order
echo between this script and Aurora doesn't matter.
echo.

if not exist "node_modules" (
    echo [setup] Installing root dependencies...
    call npm install
)
if not exist "server\node_modules" (
    echo [setup] Installing server dependencies...
    call npm install --prefix server
)
if not exist "client\node_modules" (
    echo [setup] Installing client dependencies...
    call npm install --prefix client
)

echo.
echo [start] Launching server + client dev stack...
echo [start] UI will be at http://localhost:5173
echo [start] Press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:5173"

call npm run dev

endlocal

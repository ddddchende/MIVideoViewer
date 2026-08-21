@echo off
cd /d "%~dp0"

echo ==================================================
echo   MI Video Viewer - Electron secure launcher
echo ==================================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js first: https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo Starting in Electron mode (encrypted credentials)...
echo If dependencies are missing, run: npm install
echo Press Ctrl+C to stop
echo --------------------------------------------------
call npm start

echo.
echo Program exited.
pause
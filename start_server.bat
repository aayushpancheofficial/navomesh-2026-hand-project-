@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Project Python environment not found.
    echo Create it with: py -m venv .venv
    echo Then install dependencies with: .venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)

if not defined ARDUINO_PORT set "ARDUINO_PORT=COM3"
echo Arduino port: %ARDUINO_PORT%
echo Starting NAVONMESH. Keep this window open while using the website.
echo Preview: http://localhost:5000
echo Press Ctrl+C to stop the server.
".venv\Scripts\python.exe" app.py
pause

@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title HELPING HAND - AI Prosthetic Hand Control System

echo =======================================================
echo     HELPING HAND - AI PROSTHETIC HAND CONTROL SYSTEM
echo =======================================================
echo.

if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Creating .env from .env.example...
        copy /Y ".env.example" ".env" >nul
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo [SETUP] Virtual environment not found. Setting up for first run...
    
    where py >nul 2>nul
    if %errorlevel% equ 0 (
        set "PY_CMD=py"
    ) else (
        where python >nul 2>nul
        if %errorlevel% equ 0 (
            set "PY_CMD=python"
        ) else (
            echo [ERROR] Python was not found in your system PATH.
            echo Please install Python 3.10, 3.11, 3.12, 3.13 or 3.14 from https://python.org
            echo Make sure to check 'Add Python to PATH' during installation.
            pause
            exit /b 1
        )
    )

    echo [SETUP] Creating Python virtual environment in .venv...
    %PY_CMD% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )

    echo [SETUP] Installing project dependencies from requirements.txt...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Dependency installation encountered issues.
        pause
        exit /b 1
    )
    echo [SETUP] Virtual environment setup complete!
    echo.
)

if not exist "yolov8n.pt" (
    echo [WARNING] YOLO weights file 'yolov8n.pt' not found in root directory.
    echo The Ultralytics engine will attempt to auto-download it upon first camera start.
)

echo Starting HELPING HAND Server...
echo Web Dashboard Link: http://localhost:5000
echo Press Ctrl+C in this console window to stop the server.
echo.

".venv\Scripts\python.exe" app.py
pause

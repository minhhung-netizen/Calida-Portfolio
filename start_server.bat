@echo off
cd /d "%~dp0"
chcp 65001 >nul
if exist .venv\Scripts\python.exe set PYTHON_BIN=%~dp0.venv\Scripts\python.exe
if not exist server\node_modules (cd server && npm install && cd ..)
if not exist web\data\dashboard.json call run_pipeline.bat --build-only
start "" http://localhost:8080
node server\index.js
pause

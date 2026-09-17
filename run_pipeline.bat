@echo off
cd /d "%~dp0"
chcp 65001 >nul
if not exist .venv (
  python -m venv .venv
  call .venv\Scripts\activate
  pip install -r pipeline\requirements.txt
) else (
  call .venv\Scripts\activate
)
python pipeline\run.py %*
pause

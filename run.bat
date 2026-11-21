@echo off
REM MuGo launcher for Windows. Double-click this file.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
if not exist .venv (
  echo First run: setting up MuGo...
  %PY% -m venv .venv || (echo Python 3 is required: https://www.python.org/downloads/ & pause & exit /b 1)
)
call .venv\Scripts\activate.bat
pip install -q --disable-pip-version-check -U -r requirements.txt 2>nul || echo (offline - skipping updates)
where ffmpeg >nul 2>nul || echo WARNING: ffmpeg not found. Install it with:  winget install ffmpeg
python -m mugo.server %*
pause

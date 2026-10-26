@echo off
title Moodle Hub
cd /d "%~dp0"
where py >nul 2>nul && (py -3 hub.py & goto :end)
where python >nul 2>nul && (python hub.py & goto :end)
echo Python 3 is not installed. Get it from https://www.python.org/downloads/
echo (tick "Add python.exe to PATH" in the installer), then run this again.
:end
pause

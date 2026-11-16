@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\one-click.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%

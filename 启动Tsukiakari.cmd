@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0启动网站.cmd" --chat --app %*
exit /b %ERRORLEVEL%

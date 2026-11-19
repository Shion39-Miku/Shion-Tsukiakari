@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "MOONLIT_NODE="
if not defined MOONLIT_NODE call :try_node "%~dp0runtime\node.exe"
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined MOONLIT_NODE call :try_node "%%N"
if not defined MOONLIT_NODE call :try_node "%ProgramFiles%\nodejs\node.exe"
if not defined MOONLIT_NODE call :try_node "%LocalAppData%\Programs\nodejs\node.exe"
if not defined MOONLIT_NODE call :try_node "%UserProfile%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined MOONLIT_NODE (
  echo 请安装 Node.js 24.10 或更新的 24.x 版本，再双击此文件。
  pause
  exit /b 1
)

"%MOONLIT_NODE%" --disable-warning=ExperimentalWarning "%~dp0scripts\start-local.mjs" %*
set "MOONLIT_EXIT=%ERRORLEVEL%"
if not "%MOONLIT_EXIT%"=="0" pause
exit /b %MOONLIT_EXIT%

:try_node
if not exist "%~1" exit /b 0
"%~1" -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major === 24 && minor >= 10 ? 0 : 1);" >nul 2>&1
if errorlevel 1 exit /b 0
set "MOONLIT_NODE=%~1"
exit /b 0

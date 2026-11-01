@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本：https://nodejs.org/
  pause
  popd
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo 此项目需要 Node.js 22 或更新版本，请更新后重试。
  pause
  popd
  exit /b 1
)
echo 游戏将在此窗口运行。请保留窗口，按 Ctrl+C 停止。
node server.mjs %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
popd
exit /b %result%

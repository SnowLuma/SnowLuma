@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

if not defined SNOWLUMA_WEBUI_PORT set "SNOWLUMA_WEBUI_PORT=5290"
if not defined SNOWLUMA_CONFIG_DIR set "SNOWLUMA_CONFIG_DIR=config-dev"
if not defined SNOWLUMA_LOG_DIR set "SNOWLUMA_LOG_DIR=logs-dev"
if not defined SNOWLUMA_ONEBOT_HTTP_PORT set "SNOWLUMA_ONEBOT_HTTP_PORT=5300"
if not defined SNOWLUMA_ONEBOT_WS_PORT set "SNOWLUMA_ONEBOT_WS_PORT=5301"

echo [SnowLuma] Working directory: %CD%
echo [SnowLuma] Dev profile: WebUI=%SNOWLUMA_WEBUI_PORT% Config=%SNOWLUMA_CONFIG_DIR% Logs=%SNOWLUMA_LOG_DIR% OneBot=%SNOWLUMA_ONEBOT_HTTP_PORT%/%SNOWLUMA_ONEBOT_WS_PORT%

where node >nul 2>&1
if errorlevel 1 (
  echo [SnowLuma] Node.js was not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

node -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major>=22?0:1)" >nul 2>&1
if errorlevel 1 (
  echo [SnowLuma] Node.js 22 or newer is required.
  node -v
  pause
  exit /b 1
)

set "NEEDS_BUILD=0"

if not exist "dist\index.mjs" (
  set "NEEDS_BUILD=1"
) else if exist "package.json" (
  findstr /c:"if (true) try" "dist\index.mjs" >nul 2>&1
  if errorlevel 1 (
    set "NEEDS_BUILD=1"
    echo [SnowLuma] Existing dist was built without bundled WebUI.
  )
  if "%NEEDS_BUILD%"=="0" (
    findstr /c:"SNOWLUMA_CONFIG_DIR" "dist\index.mjs" >nul 2>&1
    if errorlevel 1 (
      set "NEEDS_BUILD=1"
      echo [SnowLuma] Existing dist was built without isolated dev config support.
    )
  )
)

if "%NEEDS_BUILD%"=="0" (
  echo [SnowLuma] Found ready dist\index.mjs.
  echo [SnowLuma] Starting... WebUI: http://127.0.0.1:%SNOWLUMA_WEBUI_PORT%
  node "dist\index.mjs"
  goto done
)

echo [SnowLuma] Preparing source workspace...

set "PNPM_EXE="
set "PNPM_ARGS="

where pnpm >nul 2>&1
if not errorlevel 1 (
  set "PNPM_EXE=pnpm"
) else (
  where corepack >nul 2>&1
  if not errorlevel 1 (
    echo [SnowLuma] pnpm was not found. Trying corepack pnpm...
    corepack pnpm --version >nul 2>&1
    if not errorlevel 1 (
      set "PNPM_EXE=corepack"
      set "PNPM_ARGS=pnpm"
    )
  )
)

if not defined PNPM_EXE (
  if exist "%LOCALAPPDATA%\node\corepack\v1\pnpm.cmd" (
    set "PNPM_EXE=%LOCALAPPDATA%\node\corepack\v1\pnpm.cmd"
  )
)

if not defined PNPM_EXE (
  if exist "%LOCALAPPDATA%\node\corepack\v1\pnpm" (
    for /f "delims=" %%V in ('dir /b /ad /o:-n "%LOCALAPPDATA%\node\corepack\v1\pnpm" 2^>nul') do (
      if not defined PNPM_EXE if exist "%LOCALAPPDATA%\node\corepack\v1\pnpm\%%V\bin\pnpm.cjs" (
        set "PNPM_EXE=node"
        set "PNPM_ARGS="%LOCALAPPDATA%\node\corepack\v1\pnpm\%%V\bin\pnpm.cjs""
      )
    )
  )
)

if not defined PNPM_EXE (
  echo [SnowLuma] pnpm was not found. Trying to enable it with corepack...
  where corepack >nul 2>&1
  if errorlevel 1 (
    echo [SnowLuma] corepack was not found in PATH.
    echo [SnowLuma] Please install pnpm or add corepack/pnpm to PATH, then run this file again.
    pause
    exit /b 1
  )
  corepack enable >nul 2>&1
  where pnpm >nul 2>&1
  if not errorlevel 1 (
    set "PNPM_EXE=pnpm"
  ) else (
    echo [SnowLuma] pnpm is still unavailable after enabling corepack.
    pause
    exit /b 1
  )
)

echo [SnowLuma] Using pnpm: %PNPM_EXE% %PNPM_ARGS%

if not exist "node_modules" (
  echo [SnowLuma] Installing dependencies...
  call "%PNPM_EXE%" %PNPM_ARGS% install
  if errorlevel 1 (
    echo [SnowLuma] Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.mjs" (
  set "NEEDS_BUILD=1"
)

if "%NEEDS_BUILD%"=="1" (
  echo [SnowLuma] Building full project with bundled WebUI...
  call "%PNPM_EXE%" %PNPM_ARGS% build:all
  if errorlevel 1 (
    echo [SnowLuma] Build failed. Please check the messages above.
    pause
    exit /b 1
  )
)

if not exist "dist\index.mjs" (
  echo [SnowLuma] Build finished, but dist\index.mjs was not created.
  echo [SnowLuma] Please make sure this is a complete SnowLuma source tree or use a release package.
  pause
  exit /b 1
)

echo [SnowLuma] Starting...
echo [SnowLuma] WebUI: http://127.0.0.1:%SNOWLUMA_WEBUI_PORT%
call "%PNPM_EXE%" %PNPM_ARGS% start

:done
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo [SnowLuma] Process exited with code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

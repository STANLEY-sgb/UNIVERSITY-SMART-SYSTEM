@echo off
REM Starts the whole KIU-USCAS demo (database, API, admin console, student wallet, reader) with one double-click.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies - first run only...
  call pnpm install
)
call pnpm demo
pause

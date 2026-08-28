@echo off
setlocal
set "PI_PORTABLE_HOME=%~dp0"
"%~dp0runtime\node.exe" "%~dp0src\launcher.mjs" %*

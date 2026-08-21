@echo off
setlocal
set "PROJECT_DIR=%~dp0.."
set "LAUNCHER=%PROJECT_DIR%\tools\ea-launcher\OutPackage\EA.exe"

if not exist "%LAUNCHER%" (
    echo EA launcher was not found: %LAUNCHER%
    exit /b 1
)

start "" "%LAUNCHER%" --background --project-dir "%PROJECT_DIR%"
exit /b 0

@echo off
cd /d "%~dp0"
set "EA_DESKTOP_TIP_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$root=$env:EA_DESKTOP_TIP_ROOT; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $root 'desktop-tip-client.ps1')) -WorkingDirectory $root -WindowStyle Hidden"

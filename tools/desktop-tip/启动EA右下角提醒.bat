@echo off
cd /d "%~dp0"
set "EA_DESKTOP_TIP_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$root=$env:EA_DESKTOP_TIP_ROOT; $launcherName=(-join (@(69,65,26700,38754,25552,37266) | ForEach-Object { [char]$_ })) + '.exe'; $launcher=Join-Path $root $launcherName; if(Test-Path -LiteralPath $launcher){ Start-Process -FilePath $launcher -WorkingDirectory $root -WindowStyle Hidden } else { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $root 'desktop-tip-client.ps1')) -WorkingDirectory $root -WindowStyle Hidden }"

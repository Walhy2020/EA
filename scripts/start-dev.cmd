@echo off
setlocal
cd /d "%~dp0.."
set EAZYGAME_ENV=dev
node src\main.js

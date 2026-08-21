param(
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$toolDir = Split-Path -Parent $PSCommandPath
$outDir = Join-Path $toolDir "OutPackage"
$sourcePath = Join-Path $toolDir "DesktopTipLauncher.cs"
$asciiOutputPath = Join-Path $toolDir "EA-Desktop-Tip.build.exe"
$launcherFileName = (-join (@(69,65,26700,38754,25552,37266) | ForEach-Object { [char]$_ })) + ".exe"
$outputPath = Join-Path $toolDir $launcherFileName
$outPackagePath = Join-Path $outDir $launcherFileName

$frameworkRoots = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319")
)
$compilerPath = $frameworkRoots |
  ForEach-Object { Join-Path $_ "csc.exe" } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1

if (-not $compilerPath) {
  throw "The .NET Framework C# compiler was not found."
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Desktop tip launcher source was not found: $sourcePath"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Remove-Item -LiteralPath $asciiOutputPath -Force -ErrorAction SilentlyContinue

& $compilerPath `
  /nologo `
  /target:winexe `
  /optimize+ `
  /platform:anycpu `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Windows.Forms.dll `
  "/out:$asciiOutputPath" `
  $sourcePath

if ($LASTEXITCODE -ne 0) {
  throw "Desktop tip launcher compilation failed with exit code $LASTEXITCODE."
}

Move-Item -LiteralPath $asciiOutputPath -Destination $outputPath -Force
Copy-Item -LiteralPath $outputPath -Destination $outPackagePath -Force

$item = Get-Item -LiteralPath $outputPath
[pscustomobject]@{
  ok = $true
  version = "0.5.0"
  configuration = $Configuration
  output = $item.FullName
  outPackage = $outPackagePath
  size = $item.Length
} | ConvertTo-Json -Depth 4

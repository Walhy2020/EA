param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$toolDir = Split-Path -Parent $PSCommandPath
$projectDir = Split-Path -Parent (Split-Path -Parent $toolDir)
$outputDir = Join-Path $toolDir "OutPackage"
$sourcePath = Join-Path $toolDir "EaLauncher.cs"
$configPath = Join-Path $toolDir "ea-launcher.config.json"
$readmePath = Join-Path $toolDir "README.md"
$outputPath = Join-Path $outputDir "EA.exe"
$legacyOutputPath = Join-Path $outputDir "EA-Launcher.exe"

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
    throw "Launcher source was not found: $sourcePath"
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Remove-Item -LiteralPath $legacyOutputPath -Force -ErrorAction SilentlyContinue

& $compilerPath `
    /nologo `
    /target:winexe `
    /optimize+ `
    /platform:anycpu `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Management.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.Windows.Forms.dll `
    "/out:$outputPath" `
    $sourcePath

if ($LASTEXITCODE -ne 0) {
    throw "EA launcher compilation failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath $configPath -Destination (Join-Path $outputDir "ea-launcher.config.json") -Force
Copy-Item -LiteralPath $readmePath -Destination (Join-Path $outputDir "README.md") -Force

$item = Get-Item -LiteralPath $outputPath
[pscustomobject]@{
    ok = $true
    version = "0.1.0"
    configuration = $Configuration
    projectDir = $projectDir
    output = $item.FullName
    size = $item.Length
} | ConvertTo-Json -Depth 4

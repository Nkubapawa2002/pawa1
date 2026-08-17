# Headless Android SDK setup for building the Capacitor app (no Android Studio).
# Installs to %LOCALAPPDATA%\Android\Sdk. Requires a JDK (17+) on PATH.
#   powershell -ExecutionPolicy Bypass -File scripts\setup_android_sdk.ps1
$ErrorActionPreference = "Stop"

$Sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$ToolsUrl = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
$Zip = Join-Path $env:TEMP "android-cmdline-tools.zip"

if (-not (Test-Path (Join-Path $Sdk "cmdline-tools\latest\bin\sdkmanager.bat"))) {
  Write-Host "Downloading Android command-line tools..."
  Invoke-WebRequest -Uri $ToolsUrl -OutFile $Zip -UseBasicParsing
  $Tmp = Join-Path $env:TEMP "android-cmdline-tools-extract"
  if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
  Expand-Archive -Path $Zip -DestinationPath $Tmp
  New-Item -ItemType Directory -Force (Join-Path $Sdk "cmdline-tools") | Out-Null
  Move-Item (Join-Path $Tmp "cmdline-tools") (Join-Path $Sdk "cmdline-tools\latest")
  Remove-Item $Zip -Force; Remove-Item $Tmp -Recurse -Force
  Write-Host "Command-line tools installed."
} else {
  Write-Host "Command-line tools already present."
}

$SdkManager = Join-Path $Sdk "cmdline-tools\latest\bin\sdkmanager.bat"

# Accept all licenses (pipe a stream of "y" answers).
$Yes = Join-Path $env:TEMP "android-yes.txt"
("y`n" * 40) | Set-Content -Path $Yes -Encoding ascii
Write-Host "Accepting licenses..."
Get-Content $Yes | & $SdkManager --sdk_root=$Sdk --licenses | Out-Null

Write-Host "Installing platform-tools, android-36, build-tools 36.0.0 (large download)..."
Get-Content $Yes | & $SdkManager --sdk_root=$Sdk "platform-tools" "platforms;android-36" "build-tools;36.0.0"

# Point the Capacitor android project at this SDK.
$Repo = Split-Path $PSScriptRoot -Parent
$LocalProps = Join-Path $Repo "android\local.properties"
"sdk.dir=$($Sdk -replace '\\','\\\\')" | Set-Content -Path $LocalProps -Encoding ascii
Write-Host "Wrote $LocalProps"
Write-Host "Android SDK ready at $Sdk"

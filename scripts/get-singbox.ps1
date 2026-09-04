$ErrorActionPreference = "Stop"
$zip = Join-Path $env:TEMP "sb-1.14.0.zip"
$dest = Join-Path $env:TEMP "sb-1.14.0"
Invoke-WebRequest "https://github.com/SagerNet/sing-box/releases/download/v1.14.0/sing-box-1.14.0-windows-amd64.zip" -OutFile $zip
New-Item -ItemType Directory -Force "bin" | Out-Null
Expand-Archive $zip -DestinationPath $dest -Force
Copy-Item (Join-Path $dest "sing-box-1.14.0-windows-amd64/sing-box.exe") "bin/sing-box.exe" -Force
& ./bin/sing-box.exe version

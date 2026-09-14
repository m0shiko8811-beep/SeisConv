# scripts/install-latest.ps1 - put a SeisConv release installer on the Desktop, verify it against
# the SHA-256 digest GitHub publishes for the asset, and install it silently.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-latest.ps1 [-Version X] [-NoInstall]
#
# It never stops a running SeisConv: closing the app is left to the person at the desk.
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 does not offer TLS 1.2 by default, and GitHub refuses anything older.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# The 5.1 progress bar slows Invoke-WebRequest down badly on large downloads.
$ProgressPreference = 'SilentlyContinue'

$repo = 'm0shiko8811-beep/SeisConv'
$agent = 'SeisConv-install-latest'

if ($Version) {
  $Version = $Version.TrimStart('v')
  $apiUrl = "https://api.github.com/repos/$repo/releases/tags/v$Version"
} else {
  $apiUrl = "https://api.github.com/repos/$repo/releases/latest"
}

try {
  $release = Invoke-RestMethod -Uri $apiUrl -UserAgent $agent -UseBasicParsing
} catch {
  Write-Host "Could not read the release from GitHub. $($_.Exception.Message)"
  exit 1
}

$tagVersion = ([string]$release.tag_name).TrimStart('v')
if ($Version -and $tagVersion -ne $Version) {
  Write-Host "GitHub answered with release $($release.tag_name), not v$Version."
  exit 1
}
$Version = $tagVersion
$assetName = "SeisConv-Setup-$Version.exe"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
  Write-Host "Release v$Version has no asset named $assetName."
  exit 1
}
# GitHub publishes the digest as "sha256:<hex>". No digest means nothing to verify against.
if ([string]$asset.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') {
  Write-Host "GitHub publishes no SHA-256 digest for $assetName, so the download cannot be verified."
  exit 1
}
$expected = $Matches[1].ToLowerInvariant()

# A OneDrive for Business redirected Desktop is where the user actually looks.
$desktop = $null
if ($env:OneDriveCommercial -and (Test-Path -LiteralPath (Join-Path $env:OneDriveCommercial 'Desktop'))) {
  $desktop = Join-Path $env:OneDriveCommercial 'Desktop'
} else {
  $desktop = [Environment]::GetFolderPath('Desktop')
}
$dest = Join-Path $desktop $assetName

Write-Host "Downloading $assetName ($([math]::Round($asset.size / 1MB, 1)) MB) to the Desktop"
try {
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -UserAgent $agent -UseBasicParsing
} catch {
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
  Write-Host "Download failed. $($_.Exception.Message)"
  exit 1
}

$actual = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  Remove-Item -LiteralPath $dest -Force
  Write-Host "SHA-256 mismatch for $assetName (expected $expected, got $actual). The download was deleted."
  exit 1
}
Write-Host "SHA-256 verified against the GitHub digest"

# Remove older installers only; a newer one stays when an older -Version was asked for.
$newVer = $null
$newParsed = [version]::TryParse($Version, [ref]$newVer)
foreach ($f in Get-ChildItem -LiteralPath $desktop -Filter 'SeisConv-Setup-*.exe' -File) {
  if ($f.Name -eq $assetName) { continue }
  $isOlder = $true
  $oldVer = $null
  if ($newParsed -and $f.Name -match '^SeisConv-Setup-(.+)\.exe$' -and [version]::TryParse($Matches[1], [ref]$oldVer)) {
    $isOlder = $oldVer -lt $newVer
  }
  if ($isOlder) {
    Remove-Item -LiteralPath $f.FullName -Force
    Write-Host "Removed older installer $($f.Name)"
  } else {
    Write-Host "Kept $($f.Name), it is not older than $Version"
  }
}

if ($NoInstall) {
  Write-Host ''
  Write-Host "SeisConv $Version installer is on the Desktop, verified, not installed (-NoInstall)."
  exit 0
}

$running = Get-Process -Name 'SeisConv' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "SeisConv is running (PID $(($running | ForEach-Object { $_.Id }) -join ', ')). Close it and run this again; it is never stopped for you."
  exit 1
}

# Kept in its own variable so tooling does not read the switch as a path.
$silent = '/S'
Write-Host "Installing $assetName silently"
$proc = Start-Process -FilePath $dest -ArgumentList $silent -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  Write-Host "The installer exited with code $($proc.ExitCode)."
  exit 1
}

$uninstallKeys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$entries = @(Get-ItemProperty -Path $uninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'SeisConv*' })
$match = $entries | Where-Object { $_.DisplayVersion -eq $Version } | Select-Object -First 1
if (-not $match) {
  $seen = ($entries | ForEach-Object { $_.DisplayVersion }) -join ', '
  if (-not $seen) { $seen = 'none' }
  Write-Host "No uninstall entry says SeisConv $Version (found: $seen)."
  exit 1
}

$exe = $null
$candidates = @()
if ($match.InstallLocation) { $candidates += (Join-Path ([string]$match.InstallLocation).Trim('"') 'SeisConv.exe') }
$candidates += (Join-Path $env:ProgramFiles 'SeisConv\SeisConv.exe')
$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\SeisConv\SeisConv.exe')
foreach ($p in $candidates) {
  if (Test-Path -LiteralPath $p) { $exe = $p; break }
}
if (-not $exe) {
  Write-Host 'The uninstall entry is there, but SeisConv.exe was not found where the installer puts it.'
  exit 1
}
$productVersion = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
if (-not $productVersion.StartsWith($Version)) {
  Write-Host "SeisConv.exe reports ProductVersion $productVersion, expected $Version."
  exit 1
}

Write-Host ''
Write-Host "SeisConv $Version installed"
Write-Host "  installer       Desktop\$assetName, SHA-256 $actual"
Write-Host "  uninstall entry $($match.DisplayName), DisplayVersion $($match.DisplayVersion)"
Write-Host "  SeisConv.exe    ProductVersion $productVersion"
exit 0

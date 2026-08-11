[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputPath = (Join-Path $PSScriptRoot "..\src\assets\deck-case-off.png"),

  [ValidateRange(0, 100)]
  [double]$FuzzPercent = 8
)

$magick = Get-Command magick -ErrorAction SilentlyContinue
if (-not $magick) {
  throw "ImageMagick (magick) is required to prepare the transparent deck-case-off.png asset."
}

$source = [System.IO.Path]::GetFullPath($InputPath)
$destination = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Input image was not found: $source"
}

$destinationDirectory = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

& $magick.Source $source -alpha on -fuzz "$FuzzPercent%" -transparent white $destination
if ($LASTEXITCODE -ne 0) {
  throw "ImageMagick failed while writing: $destination"
}

Write-Output "Wrote transparent deck case: $destination"

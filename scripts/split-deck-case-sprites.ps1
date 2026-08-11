[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sourcePath = [System.IO.Path]::GetFullPath($InputPath)
$OutputDirectory = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $PSScriptRoot "..\src\assets" }
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Input image was not found: $sourcePath"
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$source = [System.Drawing.Bitmap]::FromFile($sourcePath)
try {
  if ($source.Width % 3 -ne 0 -or $source.Height % 2 -ne 0) {
    throw "The source image must be an even 3x2 grid: $($source.Width)x$($source.Height)"
  }

  $tileWidth = [int]($source.Width / 3)
  $tileHeight = [int]($source.Height / 2)
  $names = @(
    "deck-case-0.png",
    "deck-case-1.png",
    "deck-case-2.png",
    "deck-case-3.png",
    "deck-case-4.png",
    "deck-case-5.png"
  )

  function Test-WhiteBackground([System.Drawing.Color]$color) {
    return $color.R -ge 245 -and $color.G -ge 245 -and $color.B -ge 245 -and
      ([Math]::Max($color.R, [Math]::Max($color.G, $color.B)) - [Math]::Min($color.R, [Math]::Min($color.G, $color.B)) -le 18)
  }

  for ($index = 0; $index -lt $names.Count; $index++) {
    $column = $index % 3
    $row = [int][Math]::Floor($index / 3)
    $originX = $column * $tileWidth
    $originY = $row * $tileHeight
    $tile = New-Object System.Drawing.Bitmap($tileWidth, $tileHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    try {
      $background = New-Object 'bool[,]' $tileWidth, $tileHeight
      $queue = New-Object 'System.Collections.Generic.Queue[int]'
      $offsetX = @(-1, 1, 0, 0)
      $offsetY = @(0, 0, -1, 1)

      for ($y = 0; $y -lt $tileHeight; $y++) {
        for ($x = 0; $x -lt $tileWidth; $x++) {
          $color = $source.GetPixel($originX + $x, $originY + $y)
          $tile.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $color.R, $color.G, $color.B))
          if (($x -eq 0 -or $x -eq $tileWidth - 1 -or $y -eq 0 -or $y -eq $tileHeight - 1) -and (Test-WhiteBackground $color)) {
            $background[$x, $y] = $true
            $queue.Enqueue($y * $tileWidth + $x)
          }
        }
      }

      while ($queue.Count -gt 0) {
        $position = $queue.Dequeue()
        $x = $position % $tileWidth
        $y = [int][Math]::Floor($position / $tileWidth)
        for ($direction = 0; $direction -lt 4; $direction++) {
          $nextX = $x + $offsetX[$direction]
          $nextY = $y + $offsetY[$direction]
          if ($nextX -lt 0 -or $nextX -ge $tileWidth -or $nextY -lt 0 -or $nextY -ge $tileHeight -or $background[$nextX, $nextY]) {
            continue
          }
          $neighborColor = $tile.GetPixel($nextX, $nextY)
          if (Test-WhiteBackground $neighborColor) {
            $background[$nextX, $nextY] = $true
            $queue.Enqueue($nextY * $tileWidth + $nextX)
          }
        }
      }

      for ($y = 0; $y -lt $tileHeight; $y++) {
        for ($x = 0; $x -lt $tileWidth; $x++) {
          if ($background[$x, $y]) {
            $tile.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
            continue
          }

          $color = $tile.GetPixel($x, $y)
          $nearBackground = $false
          for ($direction = 0; $direction -lt 4; $direction++) {
            $nextX = $x + $offsetX[$direction]
            $nextY = $y + $offsetY[$direction]
            if ($nextX -ge 0 -and $nextX -lt $tileWidth -and $nextY -ge 0 -and $nextY -lt $tileHeight -and $background[$nextX, $nextY]) {
              $nearBackground = $true
              break
            }
          }

          if ($nearBackground -and (Test-WhiteBackground $color)) {
            $whiteness = [Math]::Min($color.R, [Math]::Min($color.G, $color.B))
            $alpha = [Math]::Max(0, [Math]::Min(255, (255 - $whiteness) * 4))
            if ($alpha -eq 0) {
              $tile.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
            } else {
              $tile.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B))
            }
          }
        }
      }

      $destination = Join-Path $outputPath $names[$index]
      $tile.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("Wrote {0} ({1}x{2})" -f $destination, $tileWidth, $tileHeight)
    } finally {
      $tile.Dispose()
    }
  }
} finally {
  $source.Dispose()
}

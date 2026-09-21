# Render the SVG's filled M/L/C/Z paths without third-party dependencies.
# Run from any directory: powershell -File design/render-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../extension/icons'))
[xml]$svg = Get-Content -LiteralPath (Join-Path $iconDir 'ebook-auto.svg') -Raw

function New-IconBitmap([int]$size) {
    $scale = 8
    $large = [Drawing.Bitmap]::new($size * $scale, $size * $scale)
    $graphics = [Drawing.Graphics]::FromImage($large)
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.ScaleTransform($size * $scale / 64.0, $size * $scale / 64.0)
        foreach ($element in $svg.svg.path) {
            $tokens = [regex]::Matches($element.d, '[MLCZ]|-?\d+(?:\.\d+)?')
            $path = [Drawing.Drawing2D.GraphicsPath]::new()
            $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($element.fill))
            try {
                $i = 0
                $x = 0.0; $y = 0.0
                while ($i -lt $tokens.Count) {
                    $command = $tokens[$i++].Value
                    switch ($command) {
                        'M' {
                            $x = [single]::Parse($tokens[$i++].Value, [Globalization.CultureInfo]::InvariantCulture)
                            $y = [single]::Parse($tokens[$i++].Value, [Globalization.CultureInfo]::InvariantCulture)
                            $path.StartFigure()
                        }
                        'L' {
                            $nextX = [single]::Parse($tokens[$i++].Value, [Globalization.CultureInfo]::InvariantCulture)
                            $nextY = [single]::Parse($tokens[$i++].Value, [Globalization.CultureInfo]::InvariantCulture)
                            $path.AddLine([single]$x, [single]$y, $nextX, $nextY)
                            $x = $nextX; $y = $nextY
                        }
                        'C' {
                            $values = @()
                            for ($n = 0; $n -lt 6; $n++) {
                                $values += [single]::Parse($tokens[$i++].Value, [Globalization.CultureInfo]::InvariantCulture)
                            }
                            $path.AddBezier([single]$x, [single]$y, $values[0], $values[1], $values[2], $values[3], $values[4], $values[5])
                            $x = $values[4]; $y = $values[5]
                        }
                        'Z' { $path.CloseFigure() }
                        default { throw "Unsupported SVG command: $command" }
                    }
                }
                $graphics.FillPath($brush, $path)
            } finally { $brush.Dispose(); $path.Dispose() }
        }
        $result = [Drawing.Bitmap]::new($size, $size)
        $output = [Drawing.Graphics]::FromImage($result)
        try {
            $output.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $output.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $output.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $output.DrawImage($large, [Drawing.Rectangle]::new(0, 0, $size, $size), 0, 0, $large.Width, $large.Height, [Drawing.GraphicsUnit]::Pixel)
        } finally { $output.Dispose() }
        return ,$result
    } finally { $graphics.Dispose(); $large.Dispose() }
}

foreach ($size in @(16, 32, 48, 128)) {
    $bitmap = New-IconBitmap $size
    try { $bitmap.Save((Join-Path $iconDir "icon-$size.png"), [Drawing.Imaging.ImageFormat]::Png) }
    finally { $bitmap.Dispose() }
    Write-Output "Rendered icon-$size.png"
}

# Native-size checks on light and dark toolbar surfaces.
$preview = [Drawing.Bitmap]::new(520, 156)
$canvas = [Drawing.Graphics]::FromImage($preview)
try {
    $canvas.Clear([Drawing.ColorTranslator]::FromHtml('#F3F4F6'))
    $dark = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#121A27'))
    try { $canvas.FillRectangle($dark, 0, 78, 520, 78) } finally { $dark.Dispose() }
    foreach ($row in @(0, 78)) {
        $x = 20
        foreach ($size in @(16, 32, 48)) {
            $bitmap = New-IconBitmap $size
            try { $canvas.DrawImageUnscaled($bitmap, $x, $row + [int]((78 - $size) / 2)) }
            finally { $bitmap.Dispose() }
            $x += 76
        }
    }
    $largeIcon = New-IconBitmap 128
    try { $canvas.DrawImageUnscaled($largeIcon, 348, 14) } finally { $largeIcon.Dispose() }
    $preview.Save((Join-Path $PSScriptRoot 'icon-preview.png'), [Drawing.Imaging.ImageFormat]::Png)
} finally { $canvas.Dispose(); $preview.Dispose() }

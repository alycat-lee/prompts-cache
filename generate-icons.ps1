Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$sizes = @(16, 32, 48, 128)
$bg = [System.Drawing.Color]::FromArgb(37, 99, 235)
$fg = [System.Drawing.Color]::White

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $radius = [Math]::Max(2, [int]($s * 0.22))
    $d = $radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($s - $d, 0, $d, $d, 270, 90)
    $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
    $path.AddArc(0, $s - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $bgBrush = New-Object System.Drawing.SolidBrush($bg)
    $g.FillPath($bgBrush, $path)
    $bgBrush.Dispose()
    $path.Dispose()

    $strokeW = [Math]::Max(1.2, $s * 0.09)
    $pen = New-Object System.Drawing.Pen($fg, $strokeW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $x1 = $s * 0.25
    $x2 = $s * 0.75
    $x3 = $s * 0.58
    $y1 = $s * 0.34
    $y2 = $s * 0.50
    $y3 = $s * 0.66

    $g.DrawLine($pen, $x1, $y1, $x2, $y1)
    $g.DrawLine($pen, $x1, $y2, $x2, $y2)
    $g.DrawLine($pen, $x1, $y3, $x3, $y3)
    $pen.Dispose()

    $outPath = Join-Path $outDir "icon$s.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()

    Write-Host "Generated $outPath"
}

Write-Host "Done. Go back to chrome://extensions and click the refresh button."
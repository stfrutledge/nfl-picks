# Renders the Android app's icons from the NFL shield - the same asset as the
# site's favicon and its link preview (scripts/make-og-image.ps1).
#
#   powershell -ExecutionPolicy Bypass -File android/make-icon.ps1
#
# Writes, for every screen density:
#   mipmap-*/ic_launcher_foreground.png  the shield, on transparent
#   mipmap-*/ic_launcher_monochrome.png  its silhouette, for Android 13 themed icons
#   drawable-*/ic_notification.png       white shield, stars and letters cut out
#
# The launcher background is a drawable (ic_launcher_background.xml): the link
# preview's white-to-grey fall-off. The shield takes 48% of the 108dp canvas,
# which keeps its corners inside the 66dp circle every launcher mask shows.

Add-Type -AssemblyName System.Drawing

$ShieldUrl = 'https://static.www.nfl.com/image/upload/f_png,h_1024/v1554321393/league/nvfr7ogywskqrfaiu38m.png'
$res = Join-Path $PSScriptRoot 'app\src\main\res'
$tmp = Join-Path $env:TEMP 'nfl-shield-1024.png'

Write-Output "fetching the shield..."
try {
    Invoke-WebRequest -Uri $ShieldUrl -OutFile $tmp -UseBasicParsing -ErrorAction Stop
} catch {
    Write-Output "FAILED to fetch the shield: $_"
    exit 1
}
$shield = [System.Drawing.Bitmap]::FromFile($tmp)

function New-Canvas($size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    return @($bmp, $g)
}

# The shield drawn centred on a square canvas, its height a share of the canvas.
function Draw-Shield($size, $share) {
    $bmp, $g = New-Canvas $size
    $h = $size * $share
    $w = $shield.Width * ($h / $shield.Height)
    $g.DrawImage($shield, [single](($size - $w) / 2), [single](($size - $h) / 2), [single]$w, [single]$h)
    $g.Dispose()
    return $bmp
}

# Recolour every pixel white, keeping a computed alpha.
#   'shape': the whole shield (its own alpha)
#   'cutout': only the navy and red - the white stars, football and letters drop out
function Convert-White($bmp, $mode) {
    for ($y = 0; $y -lt $bmp.Height; $y++) {
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            $p = $bmp.GetPixel($x, $y)
            if ($p.A -eq 0) { continue }
            $a = $p.A
            if ($mode -eq 'cutout') {
                # White inside the shield is near (255,255,255); navy and red are
                # far from it. Fade by how close to white the pixel is.
                $whiteness = [Math]::Min($p.R, [Math]::Min($p.G, $p.B)) / 255.0
                $a = [int]($p.A * [Math]::Max(0, [Math]::Min(1, (1 - $whiteness) * 1.6)))
            }
            $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, 255, 255, 255))
        }
    }
    return $bmp
}

$densities = [ordered]@{ mdpi = 1.0; hdpi = 1.5; xhdpi = 2.0; xxhdpi = 3.0; xxxhdpi = 4.0 }

foreach ($d in $densities.Keys) {
    $scale = $densities[$d]
    $mipmap = Join-Path $res "mipmap-$d"
    $drawable = Join-Path $res "drawable-$d"
    New-Item -ItemType Directory -Force $mipmap, $drawable | Out-Null

    $icon = [int](108 * $scale)
    $fg = Draw-Shield $icon 0.48
    $fg.Save((Join-Path $mipmap 'ic_launcher_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $fg.Dispose()

    $mono = Convert-White (Draw-Shield $icon 0.48) 'shape'
    $mono.Save((Join-Path $mipmap 'ic_launcher_monochrome.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $mono.Dispose()

    # Notification icons are 24dp, and must be white on transparent: Android
    # draws only the alpha. The shield fills nearly the full height here.
    $note = Convert-White (Draw-Shield ([int](24 * $scale)) 0.92) 'cutout'
    $note.Save((Join-Path $drawable 'ic_notification.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $note.Dispose()

    Write-Output "  $d  launcher ${icon}px, notification $([int](24 * $scale))px"
}

# The shield on its own, for the Settings header (52dp wide, like the site's).
$nodpi = Join-Path $res 'drawable-nodpi'
New-Item -ItemType Directory -Force $nodpi | Out-Null
$hh = 260
$hw = [int]($shield.Width * ($hh / $shield.Height))
$header = New-Object System.Drawing.Bitmap $hw, $hh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($header)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($shield, 0, 0, $hw, $hh)
$g.Dispose()
$header.Save((Join-Path $nodpi 'nfl_shield.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$header.Dispose()
Write-Output "  header shield ${hw}x${hh}px"

$shield.Dispose()
Write-Output "done"

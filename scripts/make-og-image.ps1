# Renders og-image.png, the link preview shown when the site is shared.
#
#   powershell -ExecutionPolicy Bypass -File scripts/make-og-image.ps1
#
# 1200x630 is the standard Open Graph ratio and gets WhatsApp to show a large
# banner rather than a small square thumbnail. Keep the file well under 300KB
# or WhatsApp may skip the image entirely.
#
# The image is just the NFL shield on a light field. No text: WhatsApp already
# renders og:title and og:description as text next to the image, so words here
# would only be repeated. No season or year either - the site rolls over every
# July, and a baked-in "2026" would quietly go stale.
#
# The background is deliberately light. The shield's body is NFL navy, the same
# colour as the site's own brand, so a navy background would swallow it.

Add-Type -AssemblyName System.Drawing

$W = 1200
$H = 630

# Same asset the site uses as its favicon, via the Cloudinary transform that
# hands back a raster PNG with transparency - OG scrapers do not take SVG.
$ShieldUrl = 'https://static.www.nfl.com/image/upload/f_png,h_460/v1554321393/league/nvfr7ogywskqrfaiu38m.png'

$root = Split-Path $PSScriptRoot -Parent
$tmp = Join-Path $env:TEMP 'nfl-shield-source.png'

Write-Output "fetching the shield..."
try {
    Invoke-WebRequest -Uri $ShieldUrl -OutFile $tmp -UseBasicParsing -ErrorAction Stop
} catch {
    Write-Output "FAILED to fetch the shield: $_"
    Write-Output "og-image.png is committed, so the existing one still works."
    exit 1
}

$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# --- Background: white with a faint grey fall-off, so it reads as designed ---
$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 255),
    [System.Drawing.Color]::FromArgb(233, 236, 241),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillRectangle($bg, $rect)

# --- Shield, centred --------------------------------------------------------
$shield = [System.Drawing.Image]::FromFile($tmp)

# Fit to 62% of the canvas height, keeping the aspect ratio.
$targetH = [int]($H * 0.62)
$scale = $targetH / $shield.Height
$targetW = [int]($shield.Width * $scale)
$x = [int](($W - $targetW) / 2)
$y = [int](($H - $targetH) / 2) - 10   # nudge up, the red bar sits below

$g.DrawImage($shield, $x, $y, $targetW, $targetH)

# --- A single NFL-red bar along the bottom ----------------------------------
$red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(213, 10, 10))
$g.FillRectangle($red, 0, ($H - 12), $W, 12)

# --- Save -------------------------------------------------------------------
$out = Join-Path $root 'og-image.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$shield.Dispose()
$g.Dispose()
$bmp.Dispose()

$bytes = (Get-Item $out).Length
$size = [Math]::Round($bytes / 1KB, 1)
Write-Output "wrote $out  (${W}x${H}, ${size} KB)"
if ($bytes -gt 300KB) {
    Write-Output "WARNING: over 300KB - WhatsApp may skip the preview image"
}

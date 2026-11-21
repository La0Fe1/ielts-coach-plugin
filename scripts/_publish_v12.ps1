# Publish v1.2.0: create the release, replace assets, upload the six files.
$ErrorActionPreference = 'Stop'
Set-Location 'E:\雅思口语插件开发'
$env:GIT_TERMINAL_PROMPT = '0'
$dist = 'E:\雅思口语插件开发\dist'
$tmp = 'E:\雅思口语插件开发\scripts\_rel.json'

$cred = ("protocol=https" + [char]10 + "host=github.com" + [char]10 + [char]10 | git credential fill 2>$null)
$token = ($cred | Select-String '^password=').Line -replace '^password=', ''
if (-not $token) { Write-Output 'NO TOKEN'; exit 1 }

$repo = 'La0Fe1/ielts-coach-plugin'
$api = "https://api.github.com/repos/$repo"

$notes = [System.IO.File]::ReadAllText('E:\雅思口语插件开发\docs\RELEASE_NOTES_v1.2.0.md', [System.Text.UTF8Encoding]::new($false))
$payload = @{ tag_name = 'v1.2.0'; name = 'IELTS 口语教练 v1.2.0'; body = $notes; draft = $false; prerelease = $false } | ConvertTo-Json -Depth 3
$bodyFile = 'E:\雅思口语插件开发\scripts\_rel_body.json'
[System.IO.File]::WriteAllText($bodyFile, $payload, [System.Text.UTF8Encoding]::new($false))

$code = & curl.exe -sS -m 120 -X POST -H "Authorization: token $token" -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json; charset=utf-8' --data-binary "@$bodyFile" -o $tmp -w '%{http_code}' "$api/releases"
Write-Output "create release -> $code"
if ($code -eq '422') {
    & curl.exe -sS -m 60 -H "Authorization: token $token" -H 'Accept: application/vnd.github+json' -o $tmp "$api/releases/tags/v1.2.0"
}
$rel = Get-Content $tmp -Raw -Encoding utf8 | ConvertFrom-Json
Write-Output ("release id: " + $rel.id + " | existing assets: " + $rel.assets.Count)
$uploadBase = "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets"

foreach ($a in $rel.assets) {
    $c = & curl.exe -sS -m 120 -X DELETE -H "Authorization: token $token" -H 'Accept: application/vnd.github+json' -o NUL -w '%{http_code}' "$api/releases/assets/$($a.id)"
    Write-Output ("removed old " + $a.name + " -> " + $c)
}

$files = @(
    'IELTS-Coach-full.zip.001',
    'IELTS-Coach-full.zip.002',
    'merge-and-extract.bat',
    'IELTS-Coach-portable-win64.zip',
    'IELTS-Coach-app.zip',
    'IELTS-Coach-models-large.zip'
)
foreach ($name in $files) {
    $path = Join-Path $dist $name
    if (-not (Test-Path $path)) { Write-Output ("MISSING " + $name); continue }
    $size = [math]::Round((Get-Item $path).Length / 1MB, 0)
    $assetUrl = $uploadBase + '?name=' + $name
    Write-Output ("uploading " + $name + " (" + $size + " MB) ...")
    $c = & curl.exe -sS --max-time 7200 -X POST -T $path -H "Authorization: token $token" -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/octet-stream' -o NUL -w '%{http_code}' $assetUrl
    Write-Output ("  -> http " + $c)
}

& curl.exe -sS -m 60 -H "Authorization: token $token" -H 'Accept: application/vnd.github+json' -o $tmp "$api/releases/tags/v1.2.0"
$rel = Get-Content $tmp -Raw -Encoding utf8 | ConvertFrom-Json
Write-Output ("final assets: " + $rel.assets.Count)
foreach ($a in $rel.assets) { Write-Output ("  " + $a.name + " | " + $a.size + " B | " + $a.state) }
Remove-Item $bodyFile, $tmp -Force -ErrorAction SilentlyContinue

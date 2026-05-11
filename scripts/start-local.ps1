$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node"
$nodePath = Join-Path $runtimeRoot "bin\node.exe"
$nodeModules = Join-Path $runtimeRoot "node_modules"
$localEnvPath = Join-Path $projectRoot ".local.env"

if (-not (Test-Path $nodePath)) {
  Write-Error "Node runtime bundled non trovato in $nodePath"
  exit 1
}

if (Test-Path $localEnvPath) {
  Get-Content $localEnvPath | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') {
      return
    }

    $parts = $_.Split('=', 2)
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()

    if ($name) {
      [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

$env:NODE_PATH = $nodeModules
Set-Location $projectRoot
& $nodePath ".\src\server.js"

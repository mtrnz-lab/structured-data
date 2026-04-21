$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node"
$nodePath = Join-Path $runtimeRoot "bin\node.exe"
$nodeModules = Join-Path $runtimeRoot "node_modules"

if (-not (Test-Path $nodePath)) {
  Write-Error "Node runtime bundled non trovato in $nodePath"
  exit 1
}

$env:NODE_PATH = $nodeModules
Set-Location $projectRoot
& $nodePath ".\src\server.js"

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    npm run deploy:cloudflare
    if ($LASTEXITCODE -ne 0) { throw 'Pickle Street deployment failed.' }
} finally {
    Pop-Location
}

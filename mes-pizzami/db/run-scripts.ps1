# Esegue gli script SQL in ordine con sqlcmd (installato con SSMS o con "ODBC + Command Line Utilities").
# Uso:  .\run-scripts.ps1                          -> Docker (localhost,1433, utente sa)
#       .\run-scripts.ps1 -Server "localhost\SQLEXPRESS" -WindowsAuth
#       .\run-scripts.ps1 -Test                    -> esegue anche i test della macchina a stati
param(
    [string]$Server = "localhost,1433",
    [string]$User = "sa",
    [string]$Password = $(if ($env:MSSQL_SA_PASSWORD) { $env:MSSQL_SA_PASSWORD } else { "Pizzami!Demo2026" }),
    [switch]$WindowsAuth,
    [switch]$Test
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$auth = if ($WindowsAuth) { @("-E") } else { @("-U", $User, "-P", $Password) }
$common = @("-S", $Server) + $auth + @("-C", "-b")

$files = @("00_database.sql", "01_schema.sql", "02_procedures.sql", "03_seed.sql")
if ($Test) { $files += "..\test\state-machine.test.sql" }

foreach ($f in $files) {
    Write-Host "==> $f"
    & sqlcmd @common -i $f
    if ($LASTEXITCODE -ne 0) { throw "Errore in $f" }
}
Write-Host "Fatto."

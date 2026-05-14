param(
  [Parameter(Mandatory = $true)] [string]$SubscriptionId,
  [Parameter(Mandatory = $true)] [string]$ResourceGroup,
  [Parameter(Mandatory = $true)] [string]$FunctionAppName,
  [string]$LocalSettingsPath = ".\backend\llm-proxy-function\local.settings.json",
  [string[]]$ExcludeKeys = @("AzureWebJobsStorage"),
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI (az) is not installed or not in PATH."
}

if (-not (Test-Path $LocalSettingsPath)) {
  throw "File not found: $LocalSettingsPath"
}

Write-Host "Loading local settings from: $LocalSettingsPath"
$localJson = Get-Content $LocalSettingsPath -Raw | ConvertFrom-Json

if (-not $localJson.Values) {
  throw "local.settings.json does not contain a 'Values' object."
}

$localValues = @{}
$localJson.Values.PSObject.Properties | ForEach-Object {
  $localValues[$_.Name] = [string]$_.Value
}

Write-Host "Reading existing app settings from Azure Function..."
$existingList = az functionapp config appsettings list `
  --subscription $SubscriptionId `
  --resource-group $ResourceGroup `
  --name $FunctionAppName `
  --output json | ConvertFrom-Json

$existingKeys = @{}
$existingList | ForEach-Object { $existingKeys[$_.name] = $true }

$toAdd = @()
foreach ($k in $localValues.Keys) {
  if ($ExcludeKeys -contains $k) { continue }
  if ($existingKeys.ContainsKey($k)) {
    Write-Host "Skip (exists): $k"
    continue
  }
  $toAdd += "$k=$($localValues[$k])"
}

if ($toAdd.Count -eq 0) {
  Write-Host "No missing settings to add."
  exit 0
}

Write-Host "Will add $($toAdd.Count) setting(s):"
$toAdd | ForEach-Object { Write-Host "  + $($_.Split('=')[0])" }

if ($DryRun) {
  Write-Host "DryRun enabled. No changes were made."
  exit 0
}

az functionapp config appsettings set `
  --subscription $SubscriptionId `
  --resource-group $ResourceGroup `
  --name $FunctionAppName `
  --settings $toAdd `
  --output table | Out-Null
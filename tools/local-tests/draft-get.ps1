$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir/common.ps1"

Invoke-FunctionRequest `
  -Method "GET" `
  -Path "/api/workitem-assistant/items/{workItemId}/draft" `
  -ConfigPath "$scriptDir/draft.config.ps1"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir/common.ps1"

Invoke-FunctionRequest `
  -Method "GET" `
  -Path "/api/workitem-assistant/items/{workItemId}/messages" `
  -ConfigPath "$scriptDir/messages.config.ps1"

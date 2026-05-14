$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir/common.ps1"
. "$scriptDir/messages.config.ps1"

Invoke-FunctionRequest `
  -Method "POST" `
  -Path "/api/workitem-assistant/items/{workItemId}/messages" `
  -ConfigPath "$scriptDir/messages.config.ps1" `
  -BodyObject @{ message = $PostMessage }

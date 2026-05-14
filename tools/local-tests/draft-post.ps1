$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir/common.ps1"
. "$scriptDir/draft.config.ps1"

Invoke-FunctionRequest `
  -Method "POST" `
  -Path "/api/workitem-assistant/items/{workItemId}/draft" `
  -ConfigPath "$scriptDir/draft.config.ps1" `
  -BodyObject $DraftBody

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir/messages.config.ps1"

$DraftBody = @{}

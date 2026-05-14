$BaseUrl = "http://localhost:7071"
$WorkItemId = 8222

$Headers = @{
  "Content-Type" = "application/json"
  "x-ado-user-id" = "local-debug-user"
  "x-ado-project-id" = "<ado_project_guid>"
  "x-ado-user-name" = "Local Debugger"
  "x-ado-work-item-type" = "Feature"
}

$PostMessage = "test"


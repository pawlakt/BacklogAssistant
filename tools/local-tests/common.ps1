function Enable-Utf8Console {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $global:OutputEncoding = $utf8
}

Enable-Utf8Console

function Format-ResponseBody {
  param(
    [Parameter(Mandatory = $false)]
    [string]$Body
  )

  if ([string]::IsNullOrWhiteSpace($Body)) {
    return ""
  }

  try {
    return ($Body | ConvertFrom-Json | ConvertTo-Json -Depth 100)
  }
  catch {
    return $Body
  }
}

function Invoke-FunctionRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [object]$BodyObject
  )

  . $ConfigPath

  $resolvedPath = $Path.Replace("{workItemId}", [string]$WorkItemId)
  $uri = "$BaseUrl$resolvedPath"
  $jsonBody = if ($null -ne $BodyObject) { $BodyObject | ConvertTo-Json -Depth 20 } else { $null }

  try {
    $response = Invoke-WebRequest -Method $Method -Uri $uri -Headers $Headers -Body $jsonBody -ErrorAction Stop
    Write-Output "Status: $([int]$response.StatusCode)"
    Write-Output "Headers:"
    $response.Headers | Format-List | Out-String | Write-Output
    Write-Output "Body:"
    Write-Output (Format-ResponseBody -Body $response.Content)
  }
  catch {
    $errorResponse = $_.Exception.Response
    if (-not $errorResponse) {
      throw
    }

    Write-Output "Status: $([int]$errorResponse.StatusCode)"
    Write-Output "Headers:"
    $errorResponse.Headers | Format-List | Out-String | Write-Output
    $reader = New-Object System.IO.StreamReader($errorResponse.GetResponseStream())
    $body = $reader.ReadToEnd()
    Write-Output "Body:"
    Write-Output (Format-ResponseBody -Body $body)
  }
}

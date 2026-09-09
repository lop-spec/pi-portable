param(
  [ValidateSet('save','read')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$Serial,
  [ValidateSet('pin','password')][string]$Kind = 'pin',
  [switch]$Interactive
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Plain($secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
try {
  if ($Action -eq 'read') {
    $record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.serial -ne $Serial) { throw 'Credential device mismatch' }
    $secure = ConvertTo-SecureString $record.secret
    @{ serial=$record.serial; kind=$record.kind; secret=(Plain $secure) } | ConvertTo-Json -Compress
    $secure.Dispose()
  } else {
    if ($Interactive) {
      $secure = Read-Host 'Phone lock credential (hidden)' -AsSecureString
      $confirm = Read-Host 'Repeat credential (hidden)' -AsSecureString
      if ((Plain $secure) -cne (Plain $confirm)) { throw 'Credentials do not match' }
      $confirm.Dispose()
    } else {
      $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
      $secure = ConvertTo-SecureString -String $request.secret -AsPlainText -Force
      $request = $null
    }
    $value = Plain $secure
    if ($Kind -eq 'pin' -and $value -notmatch '^\d{4,16}$') { throw 'PIN must be 4-16 digits' }
    if ($Kind -eq 'password' -and ($value.Length -lt 4 -or $value.Length -gt 64 -or $value -notmatch '^[\x21-\x7e]+$' -or $value.Contains('%s'))) { throw 'Password supports 4-64 printable ASCII characters without spaces or literal %s' }
    $value = $null
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $parent -AclObject $acl
    @{ version=1; serial=$Serial; kind=$Kind; secret=(ConvertFrom-SecureString $secure) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Path -Encoding UTF8
    $fileAcl = New-Object Security.AccessControl.FileSecurity
    $fileAcl.SetOwner($sid)
    $fileAcl.SetAccessRuleProtection($true, $false)
    $fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $fileAcl
    $readback = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $check = ConvertTo-SecureString $readback.secret
    if ((Plain $check) -cne (Plain $secure)) { throw 'Credential readback mismatch' }
    $check.Dispose(); $secure.Dispose()
    $access = (Get-Acl -LiteralPath $Path).Access
    if (@($access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value }).Count -ne 0) { throw 'Unexpected credential ACL' }
    Write-Output 'Credential encrypted with Windows DPAPI; readback and current-user-only ACL verified.'
  }
} catch {
  [Console]::Error.WriteLine('Credential operation failed: ' + $_.Exception.Message)
  exit 1
}

param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
# Only new, empty private/staging directories may be secured by this helper.
$item = Get-Item -LiteralPath $Directory -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'acl-directory-invalid' }
if (@(Get-ChildItem -LiteralPath $Directory -Force).Count -ne 0) { throw 'acl-directory-not-empty' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Directory -AclObject $acl
$actual = Get-Acl -LiteralPath $Directory
$rules = @($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'acl-readback-failed' }
Write-Output 'ACL_OK_CURRENT_USER_ONLY'

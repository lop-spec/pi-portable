$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

# Emit P/Invoke declarations in memory: Add-Type invokes a compiler, which is
# not available in every workstation session. No console or extra child is started.
$asmName=New-Object System.Reflection.AssemblyName('PiWebFolderForeground')
$asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly($asmName,[System.Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$asm.DefineDynamicModule('PiWebFolderForeground')
$type=$module.DefineType('PiWebFolderForeground.Native',[System.Reflection.TypeAttributes]'Public,Class,Abstract,Sealed')
$attrs=[System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl'
function Define-Native($name,$dll,$returnType,[Type[]]$arguments){
 $method=$type.DefinePInvokeMethod($name,$dll,$attrs,[System.Reflection.CallingConventions]::Standard,$returnType,$arguments,[System.Runtime.InteropServices.CallingConvention]::Winapi,[System.Runtime.InteropServices.CharSet]::Auto)
 $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
}
Define-Native 'GetForegroundWindow' 'user32.dll' ([IntPtr]) ([Type[]]@())
Define-Native 'GetWindowThreadProcessId' 'user32.dll' ([UInt32]) ([Type[]]@([IntPtr],[IntPtr]))
Define-Native 'GetCurrentThreadId' 'kernel32.dll' ([UInt32]) ([Type[]]@())
Define-Native 'AttachThreadInput' 'user32.dll' ([Boolean]) ([Type[]]@([UInt32],[UInt32],[Boolean]))
Define-Native 'IsIconic' 'user32.dll' ([Boolean]) ([Type[]]@([IntPtr]))
Define-Native 'ShowWindowAsync' 'user32.dll' ([Boolean]) ([Type[]]@([IntPtr],[Int32]))
Define-Native 'BringWindowToTop' 'user32.dll' ([Boolean]) ([Type[]]@([IntPtr]))
Define-Native 'SetForegroundWindow' 'user32.dll' ([Boolean]) ([Type[]]@([IntPtr]))
$native=$type.CreateType()

$target=[IO.Path]::GetFullPath($env:PIWEB_LOCAL_OPEN_TARGET)
$wanted=$target.TrimEnd('\')
$shell=New-Object -ComObject Shell.Application
function Find-FolderWindow {
 foreach($window in @($shell.Windows())){
  try{
   if($window.FullName -like '*explorer.exe' -and [IO.Path]::GetFullPath($window.Document.Folder.Self.Path).TrimEnd('\') -eq $wanted){
    $handle=[IntPtr]([long]$window.HWND)
    if($handle -ne [IntPtr]::Zero){return $handle}
   }
  }catch{}
 }
 return [IntPtr]::Zero
}
$hwnd=Find-FolderWindow
if($hwnd -eq [IntPtr]::Zero){
 $launch=New-Object System.Diagnostics.ProcessStartInfo
 $launch.FileName=$target
 $launch.UseShellExecute=$true
 [System.Diagnostics.Process]::Start($launch)|Out-Null
 for($i=0;$i -lt 40 -and $hwnd -eq [IntPtr]::Zero;$i++){
  Start-Sleep -Milliseconds 125
  $hwnd=Find-FolderWindow
 }
}
if($hwnd -eq [IntPtr]::Zero){throw 'PIWEB_EXPLORER_WINDOW_NOT_FOUND'}

# Attach briefly to the already-foreground input queue, then release it even on
# failure. Only the exact Explorer HWND for this folder is ever activated.
$before=$native::GetForegroundWindow()
$currentThread=$native::GetCurrentThreadId()
$foregroundThread=$native::GetWindowThreadProcessId($before,[IntPtr]::Zero)
$attached=$false
try{
 if($currentThread -ne $foregroundThread -and $foregroundThread -ne 0){$attached=$native::AttachThreadInput($currentThread,$foregroundThread,$true)}
 if($native::IsIconic($hwnd)){$null=$native::ShowWindowAsync($hwnd,9);Start-Sleep -Milliseconds 100}
 $null=$native::BringWindowToTop($hwnd)
 $null=$native::SetForegroundWindow($hwnd)
}finally{
 if($attached){$null=$native::AttachThreadInput($currentThread,$foregroundThread,$false)}
}
Start-Sleep -Milliseconds 100
if($native::GetForegroundWindow() -ne $hwnd){throw 'PIWEB_EXPLORER_NOT_FOREGROUND'}

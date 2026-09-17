Option Explicit
Dim shell, command, result
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
command = Chr(34) & WScript.Arguments(0) & Chr(34) & " " & Chr(34) & WScript.Arguments(1) & Chr(34) & " --profile " & WScript.Arguments(2)
result = shell.Run(command, 0, True)
WScript.Quit result

Option Explicit
Dim shell, command, result, i
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
command = ""
For i = 0 To 1
  command = command & Chr(34) & WScript.Arguments(i) & Chr(34) & " "
Next
command = command & "--data-root " & Chr(34) & WScript.Arguments(2) & Chr(34)
result = shell.Run(command, 0, True)
WScript.Quit result

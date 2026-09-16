Option Explicit
Dim shell, args, cmd, result
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count <> 3 Then WScript.Quit 2
cmd = Chr(34) & args(0) & Chr(34) & " " & Chr(34) & args(1) & Chr(34) & " watch --data-root " & Chr(34) & args(2) & Chr(34)
result = shell.Run(cmd, 0, True)
WScript.Quit result

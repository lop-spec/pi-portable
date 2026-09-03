using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowProbe
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maximum);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maximum);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private sealed class WindowInfo
    {
        public long Handle;
        public uint ProcessId;
        public string ClassName = "";
        public string Title = "";
    }

    private static string Json(string value)
    {
        if (value == null) return "null";
        var output = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': output.Append("\\\\"); break;
                case '"': output.Append("\\\""); break;
                case '\r': output.Append("\\r"); break;
                case '\n': output.Append("\\n"); break;
                case '\t': output.Append("\\t"); break;
                default:
                    if (character < 32) output.Append("\\u").Append(((int)character).ToString("x4"));
                    else output.Append(character);
                    break;
            }
        }
        return output.Append('"').ToString();
    }

    private static HashSet<uint> Descendants(uint rootPid)
    {
        var result = new HashSet<uint>();
        if (rootPid == 0) return result;
        result.Add(rootPid);
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == InvalidHandleValue) return result;
        try
        {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snapshot, ref entry))
            {
                do { parents[entry.th32ProcessID] = entry.th32ParentProcessID; }
                while (Process32Next(snapshot, ref entry));
            }
        }
        finally { CloseHandle(snapshot); }

        bool changed;
        do
        {
            changed = false;
            foreach (var item in parents)
            {
                if (!result.Contains(item.Key) && result.Contains(item.Value))
                {
                    result.Add(item.Key);
                    changed = true;
                }
            }
        } while (changed);
        return result;
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        uint rootPid = 0;
        if (args.Length > 0) UInt32.TryParse(args[0], out rootPid);
        var processIds = Descendants(rootPid);
        var windows = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr ignored)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (!processIds.Contains(pid) || !IsWindowVisible(hWnd)) return true;
            var title = new StringBuilder(2048);
            var className = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            GetClassName(hWnd, className, className.Capacity);
            windows.Add(new WindowInfo {
                Handle = hWnd.ToInt64(),
                ProcessId = pid,
                ClassName = className.ToString(),
                Title = title.ToString(),
            });
            return true;
        }, IntPtr.Zero);

        var output = new StringBuilder();
        output.Append("{\"foregroundHandle\":").Append(Json("0x" + GetForegroundWindow().ToInt64().ToString("x")));
        output.Append(",\"rootPid\":").Append(rootPid);
        output.Append(",\"processIds\":[");
        bool first = true;
        foreach (uint pid in processIds)
        {
            if (!first) output.Append(',');
            first = false;
            output.Append(pid);
        }
        output.Append("],\"visibleWindows\":[");
        for (int index = 0; index < windows.Count; index++)
        {
            if (index > 0) output.Append(',');
            WindowInfo window = windows[index];
            output.Append("{\"handle\":").Append(Json("0x" + window.Handle.ToString("x")));
            output.Append(",\"processId\":").Append(window.ProcessId);
            output.Append(",\"className\":").Append(Json(window.ClassName));
            output.Append(",\"title\":").Append(Json(window.Title)).Append('}');
        }
        output.Append("]}");
        Console.Write(output.ToString());
        return 0;
    }
}

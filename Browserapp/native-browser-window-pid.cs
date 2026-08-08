using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class BrowserWindowPid
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    public static int Main(string[] args)
    {
        int rootPid;
        if (args.Length < 1 || !Int32.TryParse(args[0], out rootPid) || rootPid <= 0) return 2;
        int timeout = 15000;
        if (args.Length > 1) Int32.TryParse(args[1], out timeout);
        int deadline = Environment.TickCount + Math.Max(500, Math.Min(30000, timeout));
        do
        {
            HashSet<int> family = ProcessFamily(rootPid);
            int pid = FindWindowOwner(family);
            if (pid > 0) { Console.WriteLine(pid); return 0; }
            Thread.Sleep(80);
        }
        while (unchecked(deadline - Environment.TickCount) > 0);
        return 3;
    }

    private static HashSet<int> ProcessFamily(int rootPid)
    {
        Dictionary<int, int> parents = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == InvalidHandle) return new HashSet<int> { rootPid };
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snapshot, ref entry))
            {
                do { parents[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID; }
                while (Process32Next(snapshot, ref entry));
            }
        }
        finally { CloseHandle(snapshot); }
        HashSet<int> family = new HashSet<int> { rootPid };
        bool changed;
        do
        {
            changed = false;
            foreach (KeyValuePair<int, int> item in parents)
                if (!family.Contains(item.Key) && family.Contains(item.Value)) { family.Add(item.Key); changed = true; }
        }
        while (changed);
        return family;
    }

    private static int FindWindowOwner(HashSet<int> family)
    {
        int result = 0; long largest = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (!family.Contains((int)owner)) return true;
            StringBuilder value = new StringBuilder(128); GetClassName(window, value, value.Capacity);
            string name = value.ToString();
            if (!name.StartsWith("Chrome_WidgetWin_") && !name.Equals("MozillaWindowClass", StringComparison.OrdinalIgnoreCase)) return true;
            RECT rect; if (!GetWindowRect(window, out rect)) return true;
            long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
            if (area > largest) { largest = area; result = (int)owner; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
}

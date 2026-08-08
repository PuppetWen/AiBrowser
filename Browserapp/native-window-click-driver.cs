using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class NativeWindowClickDriver
{
    private const uint INPUT_MOUSE = 0;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SW_RESTORE = 9;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;

    public static int Main(string[] args)
    {
        if (args.Length < 2) return 2;
        int masterPid = int.Parse(args[0]);
        IntPtr master = FindBrowserWindow(masterPid);
        if (master == IntPtr.Zero) return 3;
        IntPtr[] slaves = new IntPtr[args.Length - 1];
        for (int index = 1; index < args.Length; index++) slaves[index - 1] = FindBrowserWindow(int.Parse(args[index]));
        if (Array.Exists(slaves, delegate(IntPtr value) { return value == IntPtr.Zero; })) return 4;
        Focus(master);
        RECT rectangle; if (!GetWindowRect(master, out rectangle)) return 5;
        int x = rectangle.Left + (rectangle.Right - rectangle.Left) / 2;
        int y = rectangle.Top + (int)Math.Round((rectangle.Bottom - rectangle.Top) * 0.65);
        SetWindowPos(master, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        MoveAndClick(x, y);
        Thread.Sleep(250);
        SetWindowPos(master, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        Thread.Sleep(1600);
        Console.WriteLine("MASTER_TITLE=" + ReadTitle(master));
        for (int index = 0; index < slaves.Length; index++) Console.WriteLine("SLAVE_" + (index + 1) + "_TITLE=" + ReadTitle(slaves[index]));
        Console.WriteLine("FOREGROUND=" + GetForegroundWindow().ToInt64());
        return 0;
    }

    private static void MoveAndClick(int x, int y)
    {
        INPUT move = MouseInput(x, y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
        INPUT down = MouseInput(x, y, MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE);
        INPUT up = MouseInput(x, y, MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE);
        SendInput(3, new[] { move, down, up }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static INPUT MouseInput(int x, int y, uint flags)
    {
        INPUT input = new INPUT(); input.type = INPUT_MOUSE;
        input.U.mi.dx = (int)Math.Round(x * 65535.0 / Math.Max(1, GetSystemMetrics(SM_CXSCREEN) - 1));
        input.U.mi.dy = (int)Math.Round(y * 65535.0 / Math.Max(1, GetSystemMetrics(SM_CYSCREEN) - 1));
        input.U.mi.dwFlags = flags;
        return input;
    }

    private static string ReadTitle(IntPtr window)
    {
        StringBuilder value = new StringBuilder(512); GetWindowText(window, value, value.Capacity); return value.ToString();
    }

    private static void Focus(IntPtr window)
    {
        uint targetPid; uint targetThread = GetWindowThreadProcessId(window, out targetPid);
        for (int attempt = 0; attempt < 8; attempt++)
        {
            IntPtr foreground = GetForegroundWindow(); uint foregroundPid;
            uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out foregroundPid);
            uint currentThread = GetCurrentThreadId();
            if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
            if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
            if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
            BringWindowToTop(window); SetForegroundWindow(window); SetFocus(window);
            if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
            if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
            Thread.Sleep(150);
            uint activePid; GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
            if (activePid == targetPid) return;
            SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(window); SetForegroundWindow(window); Thread.Sleep(150);
            SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
            if (activePid == targetPid) return;
        }
        throw new InvalidOperationException("Unable to activate master browser before native click");
    }

    private static IntPtr FindBrowserWindow(int pid)
    {
        IntPtr result = IntPtr.Zero; long largestArea = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner; GetWindowThreadProcessId(window, out owner); if (owner != (uint)pid) return true;
            StringBuilder className = new StringBuilder(128); GetClassName(window, className, className.Capacity);
            string value = className.ToString();
            if (!value.StartsWith("Chrome_WidgetWin_") && !value.Equals("MozillaWindowClass", StringComparison.OrdinalIgnoreCase)) return true;
            RECT rectangle; if (!GetWindowRect(window, out rectangle)) return true;
            long area = Math.Max(0, rectangle.Right - rectangle.Left) * (long)Math.Max(0, rectangle.Bottom - rectangle.Top);
            if (area > largestArea) { largestArea = area; result = window; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}

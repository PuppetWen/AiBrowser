using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class NativeWindowBounds
{
    private const int SW_MINIMIZE = 6;
    private const int SW_MAXIMIZE = 3;
    private const int SW_RESTORE = 9;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    public static int Main(string[] args)
    {
        int statePid;
        if (args.Length == 2 && int.TryParse(args[0], out statePid) && statePid > 0)
        {
            IntPtr stateWindow = FindBrowserWindow(statePid);
            if (stateWindow == IntPtr.Zero) return 3;
            int command;
            switch ((args[1] ?? "").Trim().ToLowerInvariant())
            {
                case "minimized": command = SW_MINIMIZE; break;
                case "maximized": command = SW_MAXIMIZE; break;
                case "normal": command = SW_RESTORE; break;
                default: return 2;
            }
            return ShowWindowAsync(stateWindow, command) ? 0 : 4;
        }

        int pid, left, top, width, height;
        if (args.Length != 5
            || !int.TryParse(args[0], out pid)
            || !int.TryParse(args[1], out left)
            || !int.TryParse(args[2], out top)
            || !int.TryParse(args[3], out width)
            || !int.TryParse(args[4], out height)
            || pid <= 0 || width < 200 || height < 150) return 2;
        IntPtr window = FindBrowserWindow(pid);
        if (window == IntPtr.Zero) return 3;
        ShowWindowAsync(window, SW_RESTORE);
        return SetWindowPos(window, IntPtr.Zero, left, top, width, height, SWP_NOZORDER | SWP_NOACTIVATE) ? 0 : 4;
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
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
}

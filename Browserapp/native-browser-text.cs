using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// One-shot text writer for browser chrome editors (Chromium/Firefox address bars).
// Web-page editors are handled through CDP/Marionette; this helper is only the
// fallback when no focused DOM editor exists.
internal static class NativeBrowserText
{
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_NOACTIVATE = 0x08000000L;
    private const uint SWP_REFRESH = 0x00000237;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const int VK_CONTROL = 0x11;
    private const int VK_L = 0x4C;
    private const int VK_A = 0x41;
    private const int VK_BACK = 0x08;
    private const int SW_RESTORE = 9;

    public static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        string action = Convert.ToString(args[0] ?? "").ToLowerInvariant();
        if (action != "insert" && action != "clear") return 2;
        string value;
        try { value = action == "clear" ? String.Empty : Encoding.UTF8.GetString(Convert.FromBase64String(args[1] ?? "")); }
        catch { return 2; }

        IntPtr originalForeground = GetForegroundWindow();
        List<uint> controlledPids = new List<uint>();
        for (int i = 2; i < args.Length; i++)
        {
            int pid;
            if (Int32.TryParse(args[i], out pid) && pid > 0) controlledPids.Add((uint)pid);
        }
        if (controlledPids.Count == 0) return 2;

        bool success = true;
        foreach (uint pid in controlledPids)
        {
            IntPtr window = FindBrowserWindow(pid);
            AutomationElement editor = FindTopEditor(window);
            bool written = editor != null && WriteNoActivate(window, editor, value, originalForeground, controlledPids);
            if (!written) written = WriteWithTemporaryFocus(window, value, originalForeground, controlledPids);
            Console.WriteLine((written ? "OK=" : "FAILED=") + pid);
            success = success && written;
        }
        RestoreForeground(originalForeground, controlledPids);
        return success ? 0 : 4;
    }

    private static bool WriteNoActivate(IntPtr window, AutomationElement editor, string value, IntPtr originalForeground, List<uint> controlledPids)
    {
        IntPtr originalStyle = GetWindowLongPtr(window, GWL_EXSTYLE);
        SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(originalStyle.ToInt64() | WS_EX_NOACTIVATE));
        SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_REFRESH);
        try
        {
            object pattern;
            if (!editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return false;
            ValuePattern writable = (ValuePattern)pattern;
            if (writable.Current.IsReadOnly) return false;
            writable.SetValue(value);
            for (int attempt = 0; attempt < 8; attempt++)
            {
                if (String.Equals(writable.Current.Value, value, StringComparison.Ordinal)) return true;
                Thread.Sleep(25);
            }
            return false;
        }
        catch { return false; }
        finally
        {
            SetWindowLongPtr(window, GWL_EXSTYLE, originalStyle);
            SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_REFRESH);
            RestoreForeground(originalForeground, controlledPids);
        }
    }

    private static AutomationElement FindTopEditor(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        RECT bounds;
        if (!GetWindowRect(window, out bounds)) return null;
        try
        {
            AutomationElement root = AutomationElement.FromHandle(window);
            AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            AutomationElement best = null;
            double bestWidth = 0;
            foreach (AutomationElement edit in edits)
            {
                try
                {
                    System.Windows.Rect rectangle = edit.Current.BoundingRectangle;
                    double top = rectangle.Top - bounds.Top;
                    if (top < 0 || top > 180 || rectangle.Width < 180 || !edit.Current.IsEnabled || rectangle.Width <= bestWidth) continue;
                    object pattern;
                    if (!edit.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly) continue;
                    best = edit;
                    bestWidth = rectangle.Width;
                }
                catch { }
            }
            return best;
        }
        catch { return null; }
    }

    private static bool WriteWithTemporaryFocus(IntPtr window, string value, IntPtr originalForeground, List<uint> controlledPids)
    {
        if (window == IntPtr.Zero) return false;
        try
        {
            FocusWindow(window);
            Chord(VK_CONTROL, VK_L);
            Chord(VK_CONTROL, VK_A);
            Key(VK_BACK, false);
            Key(VK_BACK, true);
            if (value.Length > 0 && !TypeUnicode(value)) return false;
            Thread.Sleep(80);
            return true;
        }
        catch { return false; }
        finally { RestoreForeground(originalForeground, controlledPids); }
    }

    private static void FocusWindow(IntPtr window)
    {
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
        uint targetThread = GetWindowThreadProcessId(window, out ignored);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        SetForegroundWindow(window);
        SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
        Thread.Sleep(100);
    }

    private static void Chord(int modifier, int key)
    {
        Key(modifier, false);
        Key(key, false);
        Key(key, true);
        Key(modifier, true);
        Thread.Sleep(35);
    }

    private static void Key(int key, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = (ushort)key;
        input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static bool TypeUnicode(string value)
    {
        foreach (char character in value)
        {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki.wScan = character;
            down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            INPUT up = down;
            up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            if (SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) return false;
        }
        return true;
    }

    private static IntPtr FindBrowserWindow(uint pid)
    {
        IntPtr result = IntPtr.Zero;
        long largestArea = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid) return true;
            StringBuilder className = new StringBuilder(128);
            GetClassName(window, className, className.Capacity);
            string value = className.ToString();
            if (!value.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal) && !value.Equals("MozillaWindowClass", StringComparison.OrdinalIgnoreCase)) return true;
            RECT rectangle;
            if (!GetWindowRect(window, out rectangle)) return true;
            long area = Math.Max(0, rectangle.Right - rectangle.Left) * (long)Math.Max(0, rectangle.Bottom - rectangle.Top);
            if (area > largestArea) { largestArea = area; result = window; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static void RestoreForeground(IntPtr original, List<uint> controlledPids)
    {
        if (original == IntPtr.Zero || GetForegroundWindow() == original) return;
        IntPtr current = GetForegroundWindow();
        uint currentPid;
        GetWindowThreadProcessId(current, out currentPid);
        if (!controlledPids.Contains(currentPid)) return;
        uint ignored;
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = current == IntPtr.Zero ? 0 : GetWindowThreadProcessId(current, out ignored);
        uint originalThread = GetWindowThreadProcessId(original, out ignored);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (originalThread != 0) AttachThreadInput(currentThread, originalThread, true);
        SetForegroundWindow(original);
        SetFocus(original);
        if (originalThread != 0) AttachThreadInput(currentThread, originalThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit, Size = 32)] private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
}

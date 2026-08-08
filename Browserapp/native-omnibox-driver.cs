using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Automation;

internal static class OmniboxDriver
{
    private static int sent;
    private static int sendFailures;
    private static volatile bool sampleForeground;
    private static int foregroundViolations;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint KEYEVENTF_KEYUP = 2;
    private const uint KEYEVENTF_UNICODE = 4;
    private const int SW_RESTORE = 9;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const int VK_L = 0x4C;
    private const int VK_C = 0x43;
    private const int VK_V = 0x56;
    private const int VK_F6 = 0x75;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        int masterPid = int.Parse(args[0]);
        string expected = args[1];
        IntPtr master = FindBrowserWindow(masterPid);
        IntPtr[] slaves = new IntPtr[args.Length - 2];
        for (int i = 2; i < args.Length; i++) slaves[i - 2] = FindBrowserWindow(int.Parse(args[i]));
        if (master == IntPtr.Zero || Array.Exists(slaves, delegate(IntPtr value) { return value == IntPtr.Zero; })) return 3;
        uint[] slaveOwners = new uint[slaves.Length];
        for (int i = 0; i < slaves.Length; i++) GetWindowThreadProcessId(slaves[i], out slaveOwners[i]);

        if (String.Equals(Environment.GetEnvironmentVariable("OPENBROWSER_TEST_READ_ONLY"), "1", StringComparison.OrdinalIgnoreCase))
        {
            string masterValue = CopyOmnibox(master);
            string[] slaveValues = Array.ConvertAll(slaves, CopyOmnibox);
            Console.WriteLine("MASTER=" + masterValue);
            for (int i = 0; i < slaveValues.Length; i++) Console.WriteLine("SLAVE_" + (i + 1) + "=" + slaveValues[i]);
            Console.WriteLine("EXPECTED=" + expected);
            return masterValue == expected && Array.TrueForAll(slaveValues, delegate(string item) { return item == expected; }) ? 0 : 4;
        }

        string savedClipboard = string.Empty;
        savedClipboard = ReadClipboard(false);
        SetClipboard(expected);
        Focus(master);
        sampleForeground = true;
        Thread sampler = new Thread(delegate()
        {
            while (sampleForeground)
            {
                IntPtr foreground = GetForegroundWindow();

                uint foregroundPid;

                GetWindowThreadProcessId(foreground, out foregroundPid);

                if (Array.IndexOf(slaveOwners, foregroundPid) >= 0) Interlocked.Increment(ref foregroundViolations);
                Thread.Sleep(2);
            }
        }) { IsBackground = true };
        sampler.Start();
        Chord(VK_CONTROL, VK_L);
        Thread.Sleep(180);
        // A busy multi-browser test run can activate an unrelated top-level window
        // after the initial focus check. Reacquire the master and reselect the omnibox
        // immediately before the actual text input so input never lands elsewhere.
        Focus(master);
        Chord(VK_CONTROL, VK_L);
        if (String.Equals(Environment.GetEnvironmentVariable("OPENBROWSER_TEST_UNICODE_INPUT"), "1", StringComparison.OrdinalIgnoreCase)) { Focus(master); TypeUnicode(expected); }
        else Chord(VK_CONTROL, VK_V);
        if (String.Equals(Environment.GetEnvironmentVariable("OPENBROWSER_TEST_PRESS_ENTER"), "1", StringComparison.OrdinalIgnoreCase)) Key(0x0D, false);
        if (String.Equals(Environment.GetEnvironmentVariable("OPENBROWSER_TEST_PRESS_ENTER"), "1", StringComparison.OrdinalIgnoreCase)) Key(0x0D, true);
        Thread.Sleep(1800);

        Console.WriteLine("MASTER_HWND=" + master.ToInt64());
        Console.WriteLine("MASTER_EDITOR_HWND=" + ReadTopEditorNativeHandle(master).ToInt64());
        for (int i = 0; i < slaves.Length; i++) Console.WriteLine("SLAVE_" + (i + 1) + "_HWND=" + slaves[i].ToInt64());
        for (int i = 0; i < slaves.Length; i++) Console.WriteLine("SLAVE_" + (i + 1) + "_EDITOR_HWND=" + ReadTopEditorNativeHandle(slaves[i]).ToInt64());
        Console.WriteLine("FOREGROUND_AFTER_TYPE=" + GetForegroundWindow().ToInt64());
        sampleForeground = false; sampler.Join(300);
        string masterText = CopyOmnibox(master);
        string[] slaveTexts = Array.ConvertAll(slaves, CopyOmnibox);
        Console.WriteLine("MASTER=" + masterText);
        for (int i = 0; i < slaveTexts.Length; i++) Console.WriteLine("SLAVE_" + (i + 1) + "=" + slaveTexts[i]);
        string copied = string.Empty;
        for (int copyAttempt = 0; copyAttempt < 5; copyAttempt++)
        {
            string sentinel = "__copy_sentinel_" + Guid.NewGuid().ToString("N") + "__";
            SetClipboard(sentinel);
            Focus(master);
            ClickAddressBar(master);
            if (copyAttempt < 3) Chord(VK_CONTROL, VK_L);
            else { Key(VK_F6, false); Key(VK_F6, true); }
            Thread.Sleep(120);
            Chord(VK_CONTROL, VK_C);
            for (int poll = 0; poll < 20; poll++)
            {
                Thread.Sleep(80);
                copied = ReadClipboard(true);
                if (copied != sentinel) break;
            }
            if (copied != sentinel) break;
        }
        Console.WriteLine("COPIED=" + copied);
        Console.WriteLine("EXPECTED=" + expected);
        Console.WriteLine("SEND_CALLS=" + sent);
        Console.WriteLine("SEND_FAILURES=" + sendFailures);
        Console.WriteLine("FOREGROUND_FINAL=" + GetForegroundWindow().ToInt64());
        Console.WriteLine("FOREGROUND_VIOLATIONS=" + foregroundViolations);
        SetClipboard(savedClipboard);
        bool allowSlaveFocus = String.Equals(Environment.GetEnvironmentVariable("OPENBROWSER_TEST_ALLOW_SLAVE_FOCUS"), "1", StringComparison.OrdinalIgnoreCase);
        bool masterOnly = String.Equals(Environment.GetEnvironmentVariable("OPENBROWSER_TEST_MASTER_ONLY"), "1", StringComparison.OrdinalIgnoreCase);
        return masterText == expected && copied == expected && (allowSlaveFocus || foregroundViolations <= 8) && (masterOnly || Array.TrueForAll(slaveTexts, delegate(string value) { return value == expected; })) ? 0 : 4;
    }

    private static string ReadTopEditor(IntPtr window)
    {
        RECT bounds; if (!GetWindowRect(window, out bounds)) return string.Empty;
        AutomationElement root = AutomationElement.FromHandle(window);
        AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        AutomationElement best = null; double bestWidth = 0;
        foreach (AutomationElement edit in edits)
        {
            try
            {
                System.Windows.Rect rectangle = edit.Current.BoundingRectangle;
                if (rectangle.Top - bounds.Top < 0 || rectangle.Top - bounds.Top > 170 || rectangle.Width < 180 || rectangle.Width <= bestWidth) continue;
                best = edit; bestWidth = rectangle.Width;
            }
            catch { }
        }
        if (best == null) return string.Empty;
        object pattern; return best.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ? ((ValuePattern)pattern).Current.Value : string.Empty;
    }

    private static IntPtr ReadTopEditorNativeHandle(IntPtr window)
    {
        RECT bounds; if (!GetWindowRect(window, out bounds)) return IntPtr.Zero;
        AutomationElement root = AutomationElement.FromHandle(window);
        AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        AutomationElement best = null; double bestWidth = 0;
        foreach (AutomationElement edit in edits)
        {
            try
            {
                System.Windows.Rect rectangle = edit.Current.BoundingRectangle;
                if (rectangle.Top - bounds.Top < 0 || rectangle.Top - bounds.Top > 170 || rectangle.Width < 180 || rectangle.Width <= bestWidth) continue;
                best = edit; bestWidth = rectangle.Width;
            }
            catch { }
        }
        if (best == null) return IntPtr.Zero;
        try { return new IntPtr(best.Current.NativeWindowHandle); } catch { return IntPtr.Zero; }
    }

    private static string ReadClipboard(bool requireValue)
    {
        for (int attempt = 0; attempt < 25; attempt++)
        {
            try
            {
                string value = Clipboard.GetText(TextDataFormat.UnicodeText);
                if (!requireValue || !string.IsNullOrEmpty(value)) return value;
            }
            catch { }
            Thread.Sleep(80);
        }
        return string.Empty;
    }

    private static void SetClipboard(string value)
    {
        for (int attempt = 0; attempt < 10; attempt++)
        {
            try { Clipboard.SetText(value ?? string.Empty); return; } catch { Thread.Sleep(60); }
        }
    }

    private static string CopyOmnibox(IntPtr window)
    {
        // Reading the accessibility value does not activate the window. Prefer it for
        // controlled/background browsers; foreground clipboard verification is only a
        // fallback for providers that do not expose ValuePattern.
        for (int attempt = 0; attempt < 8; attempt++)
        {
            string direct = ReadTopEditor(window);
            if (!string.IsNullOrEmpty(direct)) return direct;
            Thread.Sleep(80);
        }
        string lastSentinel = string.Empty;
        for (int copyAttempt = 0; copyAttempt < 5; copyAttempt++)
        {
            string sentinel = "__read_sentinel_" + Guid.NewGuid().ToString("N") + "__";
            lastSentinel = sentinel;
            SetClipboard(sentinel);
            Focus(window);
            if (copyAttempt < 3) Chord(VK_CONTROL, VK_L);
            else { Key(VK_F6, false); Key(VK_F6, true); }
            Thread.Sleep(120);
            Chord(VK_CONTROL, VK_C);
            for (int attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    string value = Clipboard.GetText(TextDataFormat.UnicodeText);
                    if (value != sentinel) return value;
                }
                catch { }
                Thread.Sleep(80);
            }
        }
        return lastSentinel;
    }

    private static void TypeCharacter(char value)
    {
        short mapped = VkKeyScan(value);
        if (mapped == -1) return;
        byte virtualKey = (byte)(mapped & 0xff);
        byte modifiers = (byte)((mapped >> 8) & 0xff);
        if ((modifiers & 1) != 0) Key(0x10, false);
        Key(virtualKey, false);
        Key(virtualKey, true);
        if ((modifiers & 1) != 0) Key(0x10, true);
    }

    private static void TypeUnicode(string value)
    {
        foreach (char character in value)
        {
            INPUT down = new INPUT(); down.type = INPUT_KEYBOARD; down.U.ki.wScan = character; down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            INPUT up = down; up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            sent += 2; if (SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) sendFailures++;
        }
        Thread.Sleep(120);
    }

    private static void Chord(int modifier, int key)
    {
        Key(modifier, false); Key(key, false); Key(key, true); Key(modifier, true); Thread.Sleep(80);
    }

    private static void Key(int key, bool up)
    {
        INPUT input = new INPUT(); input.type = INPUT_KEYBOARD; input.U.ki.wVk = (ushort)key; input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        sent++; if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) sendFailures++;
    }

    private static void ClickAddressBar(IntPtr window)
    {
        RECT bounds;
        if (!GetWindowRect(window, out bounds)) return;
        SetCursorPos(bounds.Left + Math.Max(100, (bounds.Right - bounds.Left) / 2), bounds.Top + 52);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(35);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(90);
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
            Key(VK_MENU, false);
            BringWindowToTop(window); SetForegroundWindow(window); SetFocus(window);
            Key(VK_MENU, true);
            if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
            if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
            Thread.Sleep(120);
            uint activePid; GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
            if (activePid == targetPid) return;
            RECT bounds;
            if (GetWindowRect(window, out bounds))
            {
                SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                SetCursorPos(bounds.Left + Math.Max(80, (bounds.Right - bounds.Left) / 3), bounds.Top + Math.Max(140, (bounds.Bottom - bounds.Top) / 3));
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(35);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Thread.Sleep(120);
                GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
                if (activePid == targetPid) return;
            }
        }
        throw new InvalidOperationException("Unable to activate browser window before native input");
    }

    private static IntPtr FindBrowserWindow(int pid)
    {
        IntPtr result = IntPtr.Zero; long largestArea = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner; GetWindowThreadProcessId(window, out owner); if (owner != (uint)pid) return true;
            StringBuilder className = new StringBuilder(128); GetClassName(window, className, className.Capacity);
            string browserClass = className.ToString();
            if (!browserClass.StartsWith("Chrome_WidgetWin_") && !browserClass.Equals("MozillaWindowClass", StringComparison.OrdinalIgnoreCase)) return true;
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
    [StructLayout(LayoutKind.Explicit, Size = 32)] private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern short VkKeyScan(char character);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
}

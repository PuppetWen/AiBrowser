using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class NativeInputMirror
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int HC_ACTION = 0;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const int WM_ACTIVATE = 0x0006;
    private const int WM_SETFOCUS = 0x0007;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_COMMAND = 0x0111;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int VK_CONTROL = 0x11;
    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_L = 0x4C;
    private const int VK_C = 0x43;
    private const int VK_X = 0x58;
    private const int VK_F6 = 0x75;
    private const int VK_F12 = 0x7B;
    private const int IDC_DEV_TOOLS = 40004;
    private const int VK_RETURN = 0x0D;
    private const int VK_BACK = 0x08;
    private const int VK_SPACE = 0x20;
    private const int VK_DELETE = 0x2E;
    private const int VK_PROCESSKEY = 0xE5;
    private const int VK_PACKET = 0xE7;
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SW_RESTORE = 9;
    private const uint GA_ROOT = 2;
    private const uint CWP_SKIPINVISIBLE = 0x0001;
    private const uint CWP_SKIPDISABLED = 0x0002;
    private const uint CWP_SKIPTRANSPARENT = 0x0004;
    private const long OwnInjectionMarker = 0x42524F575345524F;

    private static int masterPid;
    private static readonly List<int> slavePids = new List<int>();
    private static readonly HashSet<int> fullWindowSlavePids = new HashSet<int>();
    private static bool fullWindowMaster;
    private static readonly BlockingCollection<MirrorEvent> queue = new BlockingCollection<MirrorEvent>(new ConcurrentQueue<MirrorEvent>(), 1024);
    private static readonly LowLevelProc keyboardProc = KeyboardHook;
    private static readonly LowLevelProc mouseProc = MouseHook;
    private static readonly WinEventProc foregroundProc = ForegroundChanged;
    private static IntPtr keyboardHook;
    private static IntPtr mouseHook;
    private static IntPtr foregroundHook;
    private static volatile int focusGuardUntil;
    private static volatile bool chromeUiMode;
    private static volatile bool devToolsMode;
    private static bool syncKeyboard = true, syncClick = true, syncScroll = true, syncTrack = true, syncAddressText, delayClick, delayInput;
    private static int inputMinMs = 300, inputMaxMs = 300, clickMinMs = 100, clickMaxMs = 300;
    private static readonly Random delayRandom = new Random();
    private static int editorSnapshotQueued;
    private static volatile int lastEditorActionAt;
    private static volatile int imeCommitRequestedAt;
    private static volatile bool running = true;
    private static readonly Dictionary<IntPtr, AutomationElement> editorCache = new Dictionary<IntPtr, AutomationElement>();
    private static readonly object editorCacheLock = new object();
    private const int EditorSettleMs = 420;

    private sealed class MirrorEvent
    {
        public bool Keyboard;
        public int Message;
        public uint VirtualKey;
        public uint ScanCode;
        public uint KeyboardFlags;
        public POINT Point;
        public int MouseData;
        public bool SlavesOnly;
        public bool BootstrapControl;
        public bool Control;
        public bool Shift;
        public bool Alt;
        public int DelayMs;
        public bool ApplyEditorSnapshot;
        public bool PostMessageOnly;
        public bool SourcePopup;
        public bool FullWindowOnly;
        public RECT SourceRect;
    }

    private static bool ReadBoolSetting(string name, bool fallback)
    {
        string value = Environment.GetEnvironmentVariable(name);
        if (String.IsNullOrWhiteSpace(value)) return fallback;
        return value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    private static int ReadIntSetting(string name, int fallback)
    {
        int value; return int.TryParse(Environment.GetEnvironmentVariable(name), out value) ? Math.Max(0, Math.Min(5000, value)) : fallback;
    }

    public static int Main(string[] args)
    {
        if (args.Length < 2 || !int.TryParse(args[0], out masterPid)) return 2;
        for (int i = 1; i < args.Length; i++) { int pid; if (int.TryParse(args[i], out pid) && pid > 0) slavePids.Add(pid); }
        if (slavePids.Count == 0) return 3;
        fullWindowMaster = ReadBoolSetting("OPENBROWSER_FULL_WINDOW_MASTER", false);
        string fullWindowPids = Environment.GetEnvironmentVariable("OPENBROWSER_FULL_WINDOW_SLAVE_PIDS") ?? "";
        foreach (string part in fullWindowPids.Split(',')) { int pid; if (int.TryParse(part.Trim(), out pid) && slavePids.Contains(pid)) fullWindowSlavePids.Add(pid); }
        syncKeyboard = ReadBoolSetting("OPENBROWSER_SYNC_KEYBOARD", true); syncClick = ReadBoolSetting("OPENBROWSER_SYNC_CLICK", true);
        syncScroll = ReadBoolSetting("OPENBROWSER_SYNC_SCROLL", true); syncTrack = ReadBoolSetting("OPENBROWSER_SYNC_TRACK", true);
        syncAddressText = ReadBoolSetting("OPENBROWSER_SYNC_ADDRESS_TEXT", false);
        delayClick = ReadBoolSetting("OPENBROWSER_DELAY_CLICK", false); delayInput = ReadBoolSetting("OPENBROWSER_DELAY_INPUT", false);
        inputMinMs = ReadIntSetting("OPENBROWSER_INPUT_MIN_MS", 300); inputMaxMs = Math.Max(inputMinMs, ReadIntSetting("OPENBROWSER_INPUT_MAX_MS", inputMinMs));
        clickMinMs = ReadIntSetting("OPENBROWSER_CLICK_MIN_MS", 100); clickMaxMs = Math.Max(clickMinMs, ReadIntSetting("OPENBROWSER_CLICK_MAX_MS", clickMinMs));

        try { SetProcessDPIAware(); } catch { }
        AppDomain.CurrentDomain.ProcessExit += delegate { running = false; queue.CompleteAdding(); Unhook(); };
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; queue.CompleteAdding(); PostQuitMessage(0); };

        Thread worker = new Thread(WorkerLoop) { IsBackground = true, Name = "AiBrowser input mirror" };
        worker.Start();
        if (syncAddressText && ReadBoolSetting("OPENBROWSER_UIA_POLL", false))
        {
            Thread automation = new Thread(UiAutomationLoop) { IsBackground = true, Name = "AiBrowser address editor mirror" };
            automation.SetApartmentState(ApartmentState.STA);
            automation.Start();
        }
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, GetModuleHandle(null), 0);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
        foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, foregroundProc, 0, 0, WINEVENT_OUTOFCONTEXT);
        if (keyboardHook == IntPtr.Zero || mouseHook == IntPtr.Zero) return 4;
        Console.WriteLine("READY");

        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        queue.CompleteAdding();
        Unhook();
        return 0;
    }

    private static void Unhook()
    {
        if (keyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(keyboardHook); keyboardHook = IntPtr.Zero; }
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (foregroundHook != IntPtr.Zero) { UnhookWinEvent(foregroundHook); foregroundHook = IntPtr.Zero; }
    }

    private static void Enqueue(MirrorEvent item)
    {
        if (!queue.IsAddingCompleted) queue.TryAdd(item);
    }

    private static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code != HC_ACTION || !syncKeyboard) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        KBDLLHOOKSTRUCT data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        if (data.dwExtraInfo.ToInt64() == OwnInjectionMarker) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        IntPtr master = FindBrowserWindow(masterPid);
        if (master == IntPtr.Zero || !IsProcessForeground(masterPid)) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        IntPtr sourceWindow = GetForegroundWindow();
        RECT sourceRect = new RECT();
        bool sourcePopup = sourceWindow != IntPtr.Zero && sourceWindow != master && IsChromeWidgetForPid(sourceWindow, masterPid) && GetWindowRect(sourceWindow, out sourceRect);
        if (!sourcePopup && !GetWindowRect(master, out sourceRect)) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        // Extension popup documents are mirrored through their own CDP target. Posting keyboard
        // messages to the popup's top-level widget misses its focused DOM editor and can also
        // duplicate input after the DOM bridge is attached.
        if (sourcePopup) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        int message = wParam.ToInt32(); bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN; bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
        bool control = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0; bool alt = (GetAsyncKeyState(0x12) & 0x8000) != 0;
        bool devToolsKey = data.vkCode == VK_F12;
        if (down && devToolsKey)
        {
            devToolsMode = !devToolsMode;
            chromeUiMode = devToolsMode;
            Console.WriteLine("DEVTOOLS_MODE=" + (devToolsMode ? "1" : "0"));
            Console.Out.Flush();
        }
        if (devToolsKey)
        {
            if (down) Enqueue(new MirrorEvent { Keyboard = true, Message = WM_KEYDOWN, VirtualKey = VK_F12, ScanCode = data.scanCode, KeyboardFlags = data.flags, SlavesOnly = true, DelayMs = 180, PostMessageOnly = true, SourceRect = sourceRect });
            return CallNextHookEx(keyboardHook, code, wParam, lParam);
        }
        if (down && ((control && data.vkCode == VK_L) || data.vkCode == VK_F6)) chromeUiMode = true;
        if (devToolsMode) chromeUiMode = true;
        bool fullWindowEvent = fullWindowMaster || (!chromeUiMode && fullWindowSlavePids.Count > 0);
        if (!chromeUiMode && !fullWindowEvent) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        bool modifier = data.vkCode == 0x10 || data.vkCode == VK_CONTROL || data.vkCode == VK_LCONTROL || data.vkCode == VK_RCONTROL || data.vkCode == 0x12 || data.vkCode == 0xA4 || data.vkCode == 0xA5;
        // Background WM_KEY messages are the primary path; UI Automation is a delayed no-activate correction.
        // Never write Chrome UI through UI Automation: Chromium activates the target top-level window.
        bool clipboardRead = control && (data.vkCode == VK_C || data.vkCode == VK_X);
        // Chromium's address editor owns the IME composition state. Forwarding its raw
        // A-Z key messages to a background browser creates literal pinyin (for example
        // "nih") and UIA correction can steal focus before the composition is committed.
        // Mirror editor values semantically after composition settles instead.
        bool semanticEditorKey = syncAddressText && chromeUiMode && IsAddressTextMutation(data.vkCode, control, alt);
        if (!clipboardRead && !semanticEditorKey)
        {
            Enqueue(new MirrorEvent
            {
                Keyboard = true,
                Message = message,
                VirtualKey = data.vkCode,
                ScanCode = data.scanCode,
                KeyboardFlags = data.flags,
                SlavesOnly = true,
                BootstrapControl = down && control && data.vkCode == VK_L,
                Control = control,
                Shift = shift,
                Alt = alt,
                // Never activate a controlled browser. Foreground SendInput caused every
                // key/mouse event to bounce focus master -> slave -> master, which both
                // flickered the windows and made fast input land in the wrong process.
                PostMessageOnly = true,
                SourcePopup = sourcePopup,
                FullWindowOnly = fullWindowEvent,
                SourceRect = sourceRect
            });
        }
        // Chromium does not deliver composed/clipboard omnibox text through background
        // WM_KEY messages. Read the final editor value and apply it with a no-activate
        // guard; navigation after Enter is still mirrored independently through CDP.
        bool imeKeyboardActive = syncAddressText && chromeUiMode && IsImeKeyboardActive(master);
        bool imeCommitKey = IsImeCommitKey(data.vkCode, control, alt);
        if (syncAddressText && down && chromeUiMode && IsEditorMutation(data.vkCode, control, alt)
            && (!imeKeyboardActive || imeCommitKey))
        {
            if (imeKeyboardActive) imeCommitRequestedAt = Environment.TickCount;
            QueueEditorSnapshot();
        }
        if (syncAddressText && down && chromeUiMode && imeKeyboardActive && data.vkCode == VK_RETURN)
        {
            imeCommitRequestedAt = Environment.TickCount;
            QueueEditorSnapshot();
        }
        if (!devToolsMode && data.vkCode == VK_RETURN && up) chromeUiMode = false;
        return CallNextHookEx(keyboardHook, code, wParam, lParam);
    }

    private static bool IsEditorMutation(uint key, bool control, bool alt)
    {
        if (alt) return false;
        if (control) return key == 0x56 || key == VK_X || key == VK_BACK || key == VK_DELETE;
        return IsAddressTextMutation(key, false, false);
    }

    private static bool IsAddressTextMutation(uint key, bool control, bool alt)
    {
        if (alt) return false;
        if (control) return key == 0x56 || key == VK_X || key == VK_BACK || key == VK_DELETE;
        if ((key >= 0x30 && key <= 0x5A) || (key >= 0x60 && key <= 0x6F)) return true;
        if (key >= 0xBA && key <= 0xE2) return true;
        return key == VK_BACK || key == VK_DELETE || key == VK_SPACE || key == VK_PROCESSKEY || key == VK_PACKET;
    }

    private static bool IsImeCommitKey(uint key, bool control, bool alt)
    {
        if (alt) return false;
        if (control) return key == 0x56 || key == VK_X || key == VK_BACK || key == VK_DELETE;
        if (key == VK_SPACE || key == VK_RETURN || key == 0x09) return true;
        if (key >= 0x30 && key <= 0x39) return true;
        return key >= 0xBA && key <= 0xE2;
    }

    private static bool IsImeKeyboardActive(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        uint ignoredPid;
        uint threadId = GetWindowThreadProcessId(window, out ignoredPid);
        IntPtr layout = GetKeyboardLayout(threadId);
        int language = unchecked((int)(layout.ToInt64() & 0xffff));
        int primaryLanguage = language & 0x03ff;
        return ImmIsIME(layout) || primaryLanguage == 0x04 || primaryLanguage == 0x11 || primaryLanguage == 0x12;
    }

    private static void QueueEditorSnapshot()
    {
        lastEditorActionAt = Environment.TickCount;
        if (Interlocked.CompareExchange(ref editorSnapshotQueued, 1, 0) == 0) Enqueue(new MirrorEvent { ApplyEditorSnapshot = true });
    }

    private static void ApplyEditorSnapshotEffect()
    {
        while (unchecked(Environment.TickCount - lastEditorActionAt) < EditorSettleMs) Thread.Sleep(20);
        IntPtr master = FindBrowserWindow(masterPid); AutomationElement masterEditor = CachedTopEditor(master);
        if (IsImeComposing(master))
        {
            Interlocked.Exchange(ref editorSnapshotQueued, 0);
            return;
        }
        string value = masterEditor == null ? null : ReadEditorValue(masterEditor);
        bool focusedMainEditor = false;
        try { focusedMainEditor = GetForegroundWindow() == master && masterEditor != null && masterEditor.Current.HasKeyboardFocus; } catch { }
        if (masterEditor == null || !IsProcessForeground(masterPid) || value == null || (value.Length == 0 && !focusedMainEditor))
        {
            Interlocked.Exchange(ref editorSnapshotQueued, 0);
            return;
        }
        if (value != null)
        {
            foreach (int pid in slavePids)
            {
                IntPtr window = FindBrowserWindow(pid);
                AutomationElement editor = CachedTopEditor(window);
                if (editor != null && ReadEditorValue(editor) != value) WriteEditorValueNoActivate(window, editor, value);
            }
            // WS_EX_NOACTIVATE keeps the master process foreground; do not force a handle switch.
        }
        Interlocked.Exchange(ref editorSnapshotQueued, 0);
    }

    private static void UiAutomationLoop()
    {
        string observed = null;
        string pending = null;
        int changedAt = 0;
        while (running)
        {
            try
            {
                // UI Automation is only for the browser address editor after Ctrl+L/F6.
                // Polling while a webpage field is focused can mistake a top-of-page
                // search box for the omnibox and interrupt an active IME composition.
                if (!chromeUiMode)
                {
                    observed = null; pending = null;
                    Thread.Sleep(70);
                    continue;
                }
                IntPtr master = FindBrowserWindow(masterPid);
                AutomationElement editor = CachedTopEditor(master);
                if (editor != null && editor.Current.HasKeyboardFocus)
                {
                    string value = ReadEditorValue(editor);
                    if (value != null && observed == null) observed = value;
                    else if (value != null && value != observed)
                    {
                        observed = value;
                        bool imeKeyboardActive = IsImeKeyboardActive(master);
                        bool committedImeValue = unchecked(Environment.TickCount - imeCommitRequestedAt) >= 0
                            && unchecked(Environment.TickCount - imeCommitRequestedAt) <= 1600;
                        if (!imeKeyboardActive || committedImeValue) { pending = value; changedAt = Environment.TickCount; }
                        else pending = null;
                    }
                    if (pending != null && unchecked(Environment.TickCount - changedAt) >= EditorSettleMs
                        && unchecked(Environment.TickCount - lastEditorActionAt) >= EditorSettleMs
                        && !IsImeComposing(master))
                    {
                        foreach (int pid in slavePids)
                        {
                            IntPtr slaveWindow = FindBrowserWindow(pid);
                            AutomationElement slaveEditor = CachedTopEditor(slaveWindow);
                            if (slaveEditor != null && ReadEditorValue(slaveEditor) != pending) WriteEditorValueNoActivate(slaveWindow, slaveEditor, pending);
                        }
                        pending = null;
                        RestoreMasterNoDelay();
                    }
                }
                else { observed = null; pending = null; }
            }
            catch { observed = null; pending = null; }
            Thread.Sleep(70);
        }
    }

    private static AutomationElement CachedTopEditor(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        lock (editorCacheLock)
        {
            AutomationElement cached;
            if (editorCache.TryGetValue(window, out cached))
            {
                try { bool enabled = cached.Current.IsEnabled; return cached; } catch { editorCache.Remove(window); }
            }
            AutomationElement found = FindTopEditor(window); if (found != null) editorCache[window] = found; return found;
        }
    }

    private static AutomationElement FindTopEditor(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        RECT bounds; if (!GetWindowRect(window, out bounds)) return null;
        AutomationElement root = AutomationElement.FromHandle(window);
        AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        AutomationElement best = null; double bestWidth = 0;
        foreach (AutomationElement edit in edits)
        {
            try
            {
                System.Windows.Rect rectangle = edit.Current.BoundingRectangle;
                double top = rectangle.Top - bounds.Top;
                if (top < 0 || top > 92 || rectangle.Width < 180 || !edit.Current.IsEnabled) continue;
                bool focused = edit.Current.HasKeyboardFocus;
                bool bestFocused = false;
                try { bestFocused = best != null && best.Current.HasKeyboardFocus; } catch { }
                if ((focused && !bestFocused) || (focused == bestFocused && rectangle.Width > bestWidth)) { best = edit; bestWidth = rectangle.Width; }
            }
            catch { }
        }
        return best;
    }

    private static string ReadEditorValue(AutomationElement editor)
    {
        object pattern;
        if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return ((ValuePattern)pattern).Current.Value;
        return null;
    }

    private static bool IsImeComposing(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        uint ignoredPid;
        uint threadId = GetWindowThreadProcessId(window, out ignoredPid);
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        IntPtr focus = GetGUIThreadInfo(threadId, ref info) && info.hwndFocus != IntPtr.Zero ? info.hwndFocus : window;
        IntPtr context = ImmGetContext(focus);
        if (context == IntPtr.Zero) return false;
        try { return ImmGetCompositionString(context, 0x0008, IntPtr.Zero, 0) > 0; }
        finally { ImmReleaseContext(focus, context); }
    }

    private static void WriteEditorValueNoActivate(IntPtr window, AutomationElement editor, string value)
    {
        focusGuardUntil = unchecked(Environment.TickCount + 500);
        IntPtr original = GetWindowLongPtr(window, -20);
        const uint refreshFlags = 0x00000237;
        SetWindowLongPtr(window, -20, new IntPtr(original.ToInt64() | 0x08000000L));
        SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, refreshFlags);
        try
        {
            WriteEditorValue(editor, value);
        }
        finally
        {
            SetWindowLongPtr(window, -20, original);
            SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, refreshFlags);
            // Chromium can post activation after ValuePattern.SetValue returns. Restore
            // only when a controlled browser actually became foreground; never pull the
            // user back from an unrelated application they intentionally switched to.
            RestoreMasterNoDelay();
            ThreadPool.QueueUserWorkItem(delegate
            {
                int[] waits = new int[] { 12, 24, 48, 96, 180 };
                foreach (int wait in waits) { Thread.Sleep(wait); RestoreMasterNoDelay(); }
            });
        }
    }

    private static void WriteEditorValue(AutomationElement editor, string value)
    {
        object pattern;
        if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            ValuePattern writable = (ValuePattern)pattern;
            if (!writable.Current.IsReadOnly) writable.SetValue(value);
        }
    }

    private static void RestoreMasterNoDelay()
    {
        IntPtr master = FindBrowserWindow(masterPid);
        if (master == IntPtr.Zero || IsProcessForeground(masterPid)) return;
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return;
        uint foregroundOwner;
        GetWindowThreadProcessId(foreground, out foregroundOwner);
        if (!slavePids.Contains((int)foregroundOwner)) return;
        uint ignoredForegroundPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredForegroundPid);
        uint ignoredTargetPid;
        uint targetThread = GetWindowThreadProcessId(master, out ignoredTargetPid);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        BringWindowToTop(master);
        SetForegroundWindow(master);
        SetFocus(master);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
    }

    private static void ForegroundChanged(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime)
    {
        if (eventType != EVENT_SYSTEM_FOREGROUND || window == IntPtr.Zero) return;
        if (unchecked(focusGuardUntil - Environment.TickCount) <= 0) return;
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (slavePids.Contains((int)owner)) RestoreMasterNoDelay();
    }


    private static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code != HC_ACTION) return CallNextHookEx(mouseHook, code, wParam, lParam);
        MSLLHOOKSTRUCT data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
        if (data.dwExtraInfo.ToInt64() == OwnInjectionMarker) return CallNextHookEx(mouseHook, code, wParam, lParam);
        IntPtr master = FindBrowserWindow(masterPid);
        if (master == IntPtr.Zero || !IsProcessForeground(masterPid)) return CallNextHookEx(mouseHook, code, wParam, lParam);
        RECT rect;
        if (!GetWindowRect(master, out rect)) return CallNextHookEx(mouseHook, code, wParam, lParam);
        IntPtr sourceSurface = FindChromeSurfaceAtPoint(masterPid, data.pt);
        RECT sourceRect = rect;
        bool sourcePopup = sourceSurface != IntPtr.Zero && sourceSurface != master && GetWindowRect(sourceSurface, out sourceRect);

        int message = wParam.ToInt32();
        bool buttonDown = message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN;
        bool buttonUp = message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP;
        bool wheel = message == WM_MOUSEWHEEL;
        bool move = message == WM_MOUSEMOVE;
        bool dragMove = move && ((GetAsyncKeyState(0x01) & 0x8000) != 0 || (GetAsyncKeyState(0x02) & 0x8000) != 0 || (GetAsyncKeyState(0x04) & 0x8000) != 0);
        int relativeY = data.pt.y - rect.Top;
        int uiHeight = Math.Min(150, Math.Max(92, (rect.Bottom - rect.Top) / 7));

        bool inChromeUi = relativeY >= 0 && relativeY <= uiHeight;
        bool nativeSurface = fullWindowMaster || devToolsMode || sourcePopup || inChromeUi;
        bool fullWindowEvent = fullWindowMaster || (!nativeSurface && !chromeUiMode && fullWindowSlavePids.Count > 0);
        if (buttonDown) chromeUiMode = nativeSurface;
        if ((buttonDown || buttonUp) && !syncClick) return CallNextHookEx(mouseHook, code, wParam, lParam);
        if (wheel && !syncScroll) return CallNextHookEx(mouseHook, code, wParam, lParam);
        if (move && !syncTrack) return CallNextHookEx(mouseHook, code, wParam, lParam);
        if (!(nativeSurface || chromeUiMode || fullWindowEvent) || (!buttonDown && !buttonUp && !wheel && !move && !dragMove)) return CallNextHookEx(mouseHook, code, wParam, lParam);

        Enqueue(new MirrorEvent
        {
            Keyboard = false,
            Message = message,
            Point = data.pt,
            MouseData = unchecked((int)data.mouseData),
            SlavesOnly = true,
            // The controlled windows must remain in the background. Coordinate mapping is
            // still applied by PostMouse; FullWindowOnly only filters the target set.
            PostMessageOnly = true,
            SourcePopup = sourcePopup,
            FullWindowOnly = fullWindowEvent,
            SourceRect = sourceRect
        });
        return CallNextHookEx(mouseHook, code, wParam, lParam);
    }

    private static void WorkerLoop()
    {
        foreach (MirrorEvent item in queue.GetConsumingEnumerable())
        {
            try
            {
                if (item.ApplyEditorSnapshot) { ApplyEditorSnapshotEffect(); continue; }
                if (item.DelayMs > 0) Thread.Sleep(item.DelayMs);
                else if (item.Keyboard && delayInput && item.Message == WM_KEYDOWN) Thread.Sleep(delayRandom.Next(inputMinMs, inputMaxMs + 1));
                else if (!item.Keyboard && delayClick && (item.Message == WM_LBUTTONDOWN || item.Message == WM_RBUTTONDOWN || item.Message == WM_MBUTTONDOWN)) Thread.Sleep(delayRandom.Next(clickMinMs, clickMaxMs + 1));
                IntPtr master = FindBrowserWindow(masterPid);
                if (master == IntPtr.Zero) continue;
                List<IntPtr> targets = new List<IntPtr>();
                foreach (int pid in slavePids)
                {
                    if (item.FullWindowOnly && !fullWindowSlavePids.Contains(pid)) continue;
                    IntPtr window = FindBrowserWindow(pid);
                    if (window != IntPtr.Zero && item.SourcePopup) window = FindMatchingChromePopup(pid, item.SourceRect, master, window);
                    if (window != IntPtr.Zero) targets.Add(window);
                }
                if (!item.SlavesOnly) targets.Add(master);
                // All controlled windows are background-only. Do not add a SendInput/
                // SetForegroundWindow fallback here: it makes Windows visibly alternate
                // active captions and can redirect the user's next event to a slave.
                foreach (IntPtr target in targets)
                {
                    if (item.Keyboard) PostKeyboard(item, target);
                    else PostMouse(item, item.SourceRect, target);
                }
            }
            catch { }
        }
    }

    private static void SendKeyboard(MirrorEvent item, bool slave)
    {
        bool extended = (item.KeyboardFlags & 0x01) != 0;
        bool keyUp = item.Message == WM_KEYUP || item.Message == WM_SYSKEYUP;
        SendKey(item.VirtualKey, item.ScanCode, keyUp, extended);
        // F12 is intentionally queued as a single command so DevTools opens once.
        if (item.VirtualKey == VK_F12 && !keyUp) SendKey(item.VirtualKey, item.ScanCode, true, extended);
    }

    private static void PostKeyboard(MirrorEvent item, IntPtr target)
    {
        // Keep controlled Chrome windows in the background while preserving modifier chords.
        bool keyUp = item.Message == WM_KEYUP || item.Message == WM_SYSKEYUP;
        bool system = item.Message == WM_SYSKEYDOWN || item.Message == WM_SYSKEYUP;
        bool extended = (item.KeyboardFlags & 0x01) != 0;
        if (item.VirtualKey == VK_F12 && !keyUp)
        {
            // F12 is a browser-level command, not a renderer key. Background Chromium
            // windows inconsistently accept synthetic key messages, so invoke the same
            // command ID used by Chrome's menu/accelerator dispatch without activation.
            PostMessage(target, WM_COMMAND, new IntPtr(IDC_DEV_TOOLS), IntPtr.Zero);
            return;
        }
        bool ownControl = item.VirtualKey == VK_CONTROL || item.VirtualKey == VK_LCONTROL || item.VirtualKey == VK_RCONTROL;
        bool ownShift = item.VirtualKey == 0x10 || item.VirtualKey == 0xA0 || item.VirtualKey == 0xA1;
        bool ownAlt = item.VirtualKey == 0x12 || item.VirtualKey == 0xA4 || item.VirtualKey == 0xA5;
        if (!keyUp) {
            if ((item.BootstrapControl || item.Control) && !ownControl) PostModifier(target, VK_CONTROL, false);
            if (item.Shift && !ownShift) PostModifier(target, 0x10, false);
            if (item.Alt && !ownAlt) PostModifier(target, 0x12, false);
        }
        SendMessage(target, item.Message, new IntPtr(unchecked((int)item.VirtualKey)), BuildKeyboardLParam(item.ScanCode, keyUp, extended, system));
        if (keyUp) {
            if (item.Alt && !ownAlt) PostModifier(target, 0x12, true);
            if (item.Shift && !ownShift) PostModifier(target, 0x10, true);
            if ((item.BootstrapControl || item.Control) && !ownControl) PostModifier(target, VK_CONTROL, true);
        }
    }

    private static void PostModifier(IntPtr target, uint key, bool up)
    {
        uint scan = MapVirtualKey(key, 0);
        SendMessage(target, up ? WM_KEYUP : WM_KEYDOWN, new IntPtr(unchecked((int)key)), BuildKeyboardLParam(scan, up, false, false));
    }

    private static IntPtr BuildKeyboardLParam(uint scanCode, bool keyUp, bool extended, bool system)
    {
        long value = 1 | ((long)(scanCode & 0xff) << 16);
        if (extended) value |= 1L << 24;
        if (system) value |= 1L << 29;
        if (keyUp) value |= (1L << 30) | (1L << 31);
        return new IntPtr(unchecked((int)value));
    }

    private static void SendKey(uint virtualKey, uint scanCode, bool keyUp, bool extended)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = (ushort)virtualKey;
        input.U.ki.wScan = (ushort)scanCode;
        input.U.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
        input.U.ki.dwExtraInfo = new UIntPtr(unchecked((ulong)OwnInjectionMarker));
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendMouse(MirrorEvent item, RECT source, IntPtr target)
    {
        RECT destination;
        if (!GetWindowRect(target, out destination)) return;
        double xRatio = (item.Point.x - source.Left) / (double)Math.Max(1, source.Right - source.Left);
        double yRatio = (item.Point.y - source.Top) / (double)Math.Max(1, source.Bottom - source.Top);
        int x = destination.Left + (int)Math.Round(xRatio * (destination.Right - destination.Left));
        int y = destination.Top + (int)Math.Round(yRatio * (destination.Bottom - destination.Top));
        uint flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        if (item.Message == WM_LBUTTONDOWN) flags |= MOUSEEVENTF_LEFTDOWN;
        else if (item.Message == WM_LBUTTONUP) flags |= MOUSEEVENTF_LEFTUP;
        else if (item.Message == WM_RBUTTONDOWN) flags |= MOUSEEVENTF_RIGHTDOWN;
        else if (item.Message == WM_RBUTTONUP) flags |= MOUSEEVENTF_RIGHTUP;
        else if (item.Message == WM_MBUTTONDOWN) flags |= MOUSEEVENTF_MIDDLEDOWN;
        else if (item.Message == WM_MBUTTONUP) flags |= MOUSEEVENTF_MIDDLEUP;
        else if (item.Message == WM_MOUSEWHEEL) flags |= MOUSEEVENTF_WHEEL;

        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.U.mi.dx = (int)Math.Round(x * 65535.0 / Math.Max(1, GetSystemMetrics(SM_CXSCREEN) - 1));
        input.U.mi.dy = (int)Math.Round(y * 65535.0 / Math.Max(1, GetSystemMetrics(SM_CYSCREEN) - 1));
        input.U.mi.mouseData = item.Message == WM_MOUSEWHEEL ? (uint)((item.MouseData >> 16) & 0xffff) : 0;
        input.U.mi.dwFlags = flags;
        input.U.mi.dwExtraInfo = new UIntPtr(unchecked((ulong)OwnInjectionMarker));
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void PostMouse(MirrorEvent item, RECT source, IntPtr target)
    {
        RECT destination;
        if (!GetWindowRect(target, out destination)) return;
        double xRatio = (item.Point.x - source.Left) / (double)Math.Max(1, source.Right - source.Left);
        double yRatio = (item.Point.y - source.Top) / (double)Math.Max(1, source.Bottom - source.Top);
        POINT targetScreen = new POINT
        {
            x = destination.Left + (int)Math.Round(xRatio * (destination.Right - destination.Left)),
            y = destination.Top + (int)Math.Round(yRatio * (destination.Bottom - destination.Top))
        };
        IntPtr receiver = DeepestChildAtScreenPoint(target, targetScreen);
        if (receiver == IntPtr.Zero) receiver = target;
        if (item.Message == WM_MOUSEWHEEL)
        {
            int delta = (short)((item.MouseData >> 16) & 0xffff);
            IntPtr wheelParam = new IntPtr(unchecked((int)((uint)(ushort)delta << 16)));
            SendMessage(receiver, WM_MOUSEWHEEL, wheelParam, PackPoint(targetScreen.x, targetScreen.y));
            return;
        }
        POINT client = targetScreen;
        if (!ScreenToClient(receiver, ref client)) return;
        IntPtr pointParam = PackPoint(client.x, client.y);
        PostMessage(receiver, WM_MOUSEMOVE, IntPtr.Zero, pointParam);
        IntPtr keyState = IntPtr.Zero;
        if (item.Message == WM_LBUTTONDOWN) keyState = new IntPtr(0x0001);
        else if (item.Message == WM_RBUTTONDOWN) keyState = new IntPtr(0x0002);
        else if (item.Message == WM_MBUTTONDOWN) keyState = new IntPtr(0x0010);
        PostMessage(receiver, item.Message, keyState, pointParam);
    }

    private static IntPtr DeepestChildAtScreenPoint(IntPtr root, POINT screen)
    {
        IntPtr current = root;
        for (int depth = 0; depth < 12; depth++)
        {
            POINT client = screen;
            if (!ScreenToClient(current, ref client)) break;
            IntPtr child = ChildWindowFromPointEx(current, client, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
            if (child == IntPtr.Zero || child == current) break;
            current = child;
        }
        return current;
    }

    private static IntPtr PackPoint(int x, int y)
    {
        return new IntPtr(unchecked((int)(((uint)(ushort)y << 16) | (ushort)x)));
    }

    private static void PrepareBackgroundWindow(IntPtr window)
    {
        uint ignored;
        uint targetThread = GetWindowThreadProcessId(window, out ignored);
        uint currentThread = GetCurrentThreadId();
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        SetActiveWindow(window);
        SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
    }

    private static void FocusWindow(IntPtr window)
    {
        IntPtr foreground = GetForegroundWindow();
        uint ignoredForegroundPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredForegroundPid);
        uint ignoredTargetPid;
        uint targetThread = GetWindowThreadProcessId(window, out ignoredTargetPid);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        BringWindowToTop(window);
        SetForegroundWindow(window);
        SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
        Thread.Sleep(12);
    }

    private static bool IsProcessForeground(int pid)

    {

        IntPtr foreground = GetForegroundWindow();

        if (foreground == IntPtr.Zero) return false;

        uint owner;

        GetWindowThreadProcessId(foreground, out owner);

        return owner == (uint)pid;

    }

    private static bool IsChromeWidgetForPid(IntPtr window, int pid)
    {
        if (window == IntPtr.Zero || !IsWindowVisible(window)) return false;
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner != (uint)pid) return false;
        StringBuilder className = new StringBuilder(128);
        GetClassName(window, className, className.Capacity);
        return className.ToString().StartsWith("Chrome_WidgetWin_");
    }

    private static IntPtr FindChromeSurfaceAtPoint(int pid, POINT point)
    {
        IntPtr hit = WindowFromPoint(point);
        if (hit == IntPtr.Zero) return IntPtr.Zero;
        IntPtr root = GetAncestor(hit, GA_ROOT);
        if (IsChromeWidgetForPid(root, pid)) return root;
        return IsChromeWidgetForPid(hit, pid) ? hit : IntPtr.Zero;
    }

    private static IntPtr FindMatchingChromePopup(int pid, RECT sourcePopup, IntPtr sourceMain, IntPtr targetMain)
    {
        RECT sourceMainRect;
        RECT targetMainRect;
        if (!GetWindowRect(sourceMain, out sourceMainRect) || !GetWindowRect(targetMain, out targetMainRect)) return IntPtr.Zero;
        for (int attempt = 0; attempt < 12; attempt++)
        {
            IntPtr result = IntPtr.Zero;
            double bestScore = double.MaxValue;
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                if (window == targetMain || !IsChromeWidgetForPid(window, pid)) return true;
                RECT candidate;
                if (!GetWindowRect(window, out candidate)) return true;
                int sourceWidth = Math.Max(1, sourcePopup.Right - sourcePopup.Left);
                int sourceHeight = Math.Max(1, sourcePopup.Bottom - sourcePopup.Top);
                int candidateWidth = Math.Max(1, candidate.Right - candidate.Left);
                int candidateHeight = Math.Max(1, candidate.Bottom - candidate.Top);
                double sourceRight = (sourceMainRect.Right - sourcePopup.Right) / (double)Math.Max(1, sourceMainRect.Right - sourceMainRect.Left);
                double sourceTop = (sourcePopup.Top - sourceMainRect.Top) / (double)Math.Max(1, sourceMainRect.Bottom - sourceMainRect.Top);
                double candidateRight = (targetMainRect.Right - candidate.Right) / (double)Math.Max(1, targetMainRect.Right - targetMainRect.Left);
                double candidateTop = (candidate.Top - targetMainRect.Top) / (double)Math.Max(1, targetMainRect.Bottom - targetMainRect.Top);
                double score = Math.Abs(candidateWidth - sourceWidth) * 4.0
                    + Math.Abs(candidateHeight - sourceHeight) * 4.0
                    + Math.Abs(candidateRight - sourceRight) * 1200.0
                    + Math.Abs(candidateTop - sourceTop) * 1200.0;
                if (score < bestScore) { bestScore = score; result = window; }
                return true;
            }, IntPtr.Zero);
            if (result != IntPtr.Zero) return result;
            Thread.Sleep(25);
        }
        return IntPtr.Zero;
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

    private delegate IntPtr LowLevelProc(int code, IntPtr wParam, IntPtr lParam);
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromPoint(POINT point, [MarshalAs(UnmanagedType.Interface)] out object accessible, [MarshalAs(UnmanagedType.Struct)] out object child);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetActiveWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT point, uint flags);
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("imm32.dll")] private static extern IntPtr ImmGetContext(IntPtr window);
    [DllImport("imm32.dll")] private static extern bool ImmReleaseContext(IntPtr window, IntPtr context);
    [DllImport("imm32.dll", CharSet = CharSet.Unicode)] private static extern int ImmGetCompositionString(IntPtr context, int index, IntPtr buffer, int bufferLength);
    [DllImport("imm32.dll")] private static extern bool ImmIsIME(IntPtr keyboardLayout);
    [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint threadId);
}

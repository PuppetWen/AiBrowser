using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("AiBrowser Launcher")]
[assembly: AssemblyDescription("Portable shortcut launcher for AiBrowser")]
[assembly: AssemblyCompany("AiBrowser")]
[assembly: AssemblyProduct("AiBrowser")]
[assembly: AssemblyVersion("1.0.2.0")]
[assembly: AssemblyFileVersion("1.0.2.0")]

internal static class AiBrowserLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string explicitHome = ReadHomeArgument(args);
            string projectRoot = ResolveProjectRoot(explicitHome);
            if (projectRoot == null)
            {
                if (HasArgument(args, "--check")) return 2;
                projectRoot = PromptForProjectRoot();
                if (projectRoot == null)
                {
                    ShowError(
                        "找不到 AiBrowser 项目。\r\n\r\n" +
                        "请选择包含 start-test.cmd 的项目目录；也可以设置环境变量 " +
                        "OPENBROWSER_HOME，或使用 --home \"项目路径\" 启动。"
                    );
                    return 2;
                }
                SaveSidecarPath(projectRoot);
            }

            if (HasArgument(args, "--check")) return 0;

            string script = Path.Combine(projectRoot, "start-test.cmd");
            string localNode = Path.Combine(projectRoot, ".runtime", "node", "node.exe");
            if (!File.Exists(localNode) && !CanFindOnPath("node.exe"))
            {
                ShowError(
                    "AiBrowser 的 Node.js 运行时不存在。\r\n\r\n" +
                    "预期位置：\r\n" + localNode
                );
                return 3;
            }

            bool visible = HasArgument(args, "--console") || HasArgument(args, "--visible");
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            start.Arguments = "/d /s /c \"\"" + script + "\"\"";
            start.WorkingDirectory = projectRoot;
            start.UseShellExecute = false;
            start.CreateNoWindow = !visible;
            start.WindowStyle = visible ? ProcessWindowStyle.Normal : ProcessWindowStyle.Hidden;
            start.EnvironmentVariables["OPENBROWSER_LAUNCHED_BY"] = "AiBrowser-Launcher.exe";
            // The visible window belongs to Electron, so Windows would otherwise
            // pin electron.exe and relaunch it without the project argument.
            // Pass this stable launcher path to the BrowserWindow taskbar metadata.
            start.EnvironmentVariables["OPENBROWSER_TASKBAR_RELAUNCH"] =
                Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            start.EnvironmentVariables["OPENBROWSER_START_MENU_PROGRAMS"] =
                Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            Process process = Process.Start(start);
            if (process == null)
            {
                ShowError("无法启动 AiBrowser。请尝试使用 start-test.cmd。 ");
                return 4;
            }
            return 0;
        }
        catch (Exception error)
        {
            ShowError("启动 AiBrowser 失败：\r\n\r\n" + error.Message);
            return 1;
        }
    }

    private static string ResolveProjectRoot(string explicitHome)
    {
        List<string> candidates = new List<string>();
        AddCandidate(candidates, explicitHome);
        AddCandidate(candidates, Environment.GetEnvironmentVariable("OPENBROWSER_HOME"));
        AddCandidate(candidates, Environment.GetEnvironmentVariable("OPENBROWSER_PROJECT_ROOT"));

        string executableDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        AddCandidate(candidates, ReadSidecarPath(executableDirectory));
        DirectoryInfo current = String.IsNullOrEmpty(executableDirectory) ? null : new DirectoryInfo(executableDirectory);
        for (int depth = 0; current != null && depth < 8; depth++)
        {
            AddCandidate(candidates, current.FullName);
            current = current.Parent;
        }
        foreach (string candidate in candidates)
        {
            string valid = ValidateProjectRoot(candidate);
            if (valid != null) return valid;
        }
        return null;
    }

    private static void AddCandidate(List<string> candidates, string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return;
        string trimmed = value.Trim().Trim('"');
        foreach (string existing in candidates)
        {
            if (String.Equals(existing, trimmed, StringComparison.OrdinalIgnoreCase)) return;
        }
        candidates.Add(trimmed);
    }

    private static string ValidateProjectRoot(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return null;
        try
        {
            string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value));
            if (!File.Exists(Path.Combine(full, "start-test.cmd"))) return null;
            if (!File.Exists(Path.Combine(full, "Browserapp", "scripts", "run-app.js"))) return null;
            return full;
        }
        catch
        {
            return null;
        }
    }

    private static string ReadSidecarPath(string executableDirectory)
    {
        if (String.IsNullOrEmpty(executableDirectory)) return null;
        string pathFile = Path.Combine(executableDirectory, "AiBrowser-Launcher.path");
        try
        {
            return File.Exists(pathFile) ? File.ReadAllText(pathFile).Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    private static string PromptForProjectRoot()
    {
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "请选择 AiBrowser 项目目录（目录内应包含 start-test.cmd）";
            dialog.ShowNewFolderButton = false;
            if (dialog.ShowDialog() != DialogResult.OK) return null;
            string valid = ValidateProjectRoot(dialog.SelectedPath);
            if (valid == null)
            {
                ShowError("选择的目录不是有效的 AiBrowser 项目目录。\r\n\r\n" + dialog.SelectedPath);
                return null;
            }
            return valid;
        }
    }

    private static void SaveSidecarPath(string projectRoot)
    {
        try
        {
            string executableDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (String.IsNullOrEmpty(executableDirectory)) return;
            File.WriteAllText(Path.Combine(executableDirectory, "AiBrowser-Launcher.path"), projectRoot);
        }
        catch
        {
            // A read-only launcher location is still usable for the current run.
        }
    }

    private static string ReadHomeArgument(string[] args)
    {
        if (args == null) return null;
        for (int index = 0; index < args.Length; index++)
        {
            string value = args[index] ?? String.Empty;
            if (value.StartsWith("--home=", StringComparison.OrdinalIgnoreCase)) return value.Substring(7);
            if (String.Equals(value, "--home", StringComparison.OrdinalIgnoreCase) && index + 1 < args.Length) return args[index + 1];
        }
        return null;
    }

    private static bool HasArgument(string[] args, string expected)
    {
        if (args == null) return false;
        foreach (string value in args)
        {
            if (String.Equals(value, expected, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static bool CanFindOnPath(string fileName)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
        foreach (string directory in path.Split(Path.PathSeparator))
        {
            try
            {
                if (File.Exists(Path.Combine(directory.Trim().Trim('"'), fileName))) return true;
            }
            catch { }
        }
        return false;
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "AiBrowser Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

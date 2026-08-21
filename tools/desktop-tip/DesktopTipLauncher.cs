using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("EA Desktop Tip")]
[assembly: AssemblyDescription("EA desktop notification launcher")]
[assembly: AssemblyCompany("EazyGame")]
[assembly: AssemblyProduct("EA Desktop Tip")]
[assembly: AssemblyVersion("0.5.1.0")]
[assembly: AssemblyFileVersion("0.5.1.0")]

namespace EazyGame.DesktopTipLauncher
{
    internal static class Program
    {
        internal const string Version = "0.5.1";
        private const string ClientScriptName = "desktop-tip-client.ps1";

        [STAThread]
        private static int Main(string[] args)
        {
            string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            LauncherLog.Initialize(installDir);
            LauncherArguments options = LauncherArguments.Parse(args);
            LauncherLog.Write("launcher_boot", "version=" + Version + " installKey=" + StableKey(installDir));

            if (options.SelfTest)
            {
                return RunSelfTest(installDir);
            }

            string mutexName = "Local\\EADesktopTipLauncher_" + StableKey(installDir);
            bool createdNew;
            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    LauncherLog.Write("launcher_duplicate", "action=exit");
                    return 0;
                }

                try
                {
                    if (!options.SkipAutoStart)
                    {
                        StartupManager.ApplyPreference(installDir, Application.ExecutablePath);
                    }
                    StartClientHidden(installDir);
                    return 0;
                }
                catch (Exception error)
                {
                    LauncherLog.Write("launcher_failed", error.ToString());
                    try
                    {
                        MessageBox.Show(
                            "EA desktop tip failed to start. See logs\\desktop-tip-launcher.log.",
                            "EA Desktop Tip",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error);
                    }
                    catch
                    {
                    }
                    return 2;
                }
            }
        }

        private static int RunSelfTest(string installDir)
        {
            try
            {
                string scriptPath = Path.Combine(installDir, ClientScriptName);
                if (!File.Exists(scriptPath))
                {
                    throw new FileNotFoundException("Desktop tip client script was not found.", scriptPath);
                }
                string powershellPath = ResolvePowerShell();
                if (String.IsNullOrWhiteSpace(powershellPath))
                {
                    throw new FileNotFoundException("Windows PowerShell was not found.");
                }
                LauncherLog.Write("self_test_passed", "powershell=" + Path.GetFileName(powershellPath));
                return 0;
            }
            catch (Exception error)
            {
                LauncherLog.Write("self_test_failed", error.ToString());
                return 3;
            }
        }

        private static void StartClientHidden(string installDir)
        {
            string scriptPath = Path.Combine(installDir, ClientScriptName);
            if (!File.Exists(scriptPath))
            {
                throw new FileNotFoundException("Desktop tip client script was not found.", scriptPath);
            }
            string powershellPath = ResolvePowerShell();
            if (String.IsNullOrWhiteSpace(powershellPath))
            {
                throw new FileNotFoundException("Windows PowerShell was not found.");
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = powershellPath;
            startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " + Quote(scriptPath);
            startInfo.WorkingDirectory = installDir;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process process = Process.Start(startInfo);
            LauncherLog.Write("client_start_requested", "pid=" + (process == null ? 0 : process.Id));
        }

        private static string ResolvePowerShell()
        {
            string systemPowerShell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe");
            if (File.Exists(systemPowerShell))
            {
                return systemPowerShell;
            }
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string segment in pathValue.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    string candidate = Path.Combine(segment.Trim(), "powershell.exe");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch
                {
                }
            }
            return "";
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
        }

        private static string StableKey(string value)
        {
            string normalized = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(normalized));
                StringBuilder result = new StringBuilder();
                for (int index = 0; index < 8; index += 1)
                {
                    result.Append(hash[index].ToString("x2"));
                }
                return result.ToString();
            }
        }
    }

    internal sealed class LauncherArguments
    {
        internal bool SelfTest;
        internal bool SkipAutoStart;

        internal static LauncherArguments Parse(string[] args)
        {
            LauncherArguments result = new LauncherArguments();
            foreach (string raw in args ?? new string[0])
            {
                string value = raw ?? "";
                if (String.Equals(value, "--self-test", StringComparison.OrdinalIgnoreCase))
                {
                    result.SelfTest = true;
                }
                else if (String.Equals(value, "--skip-autostart", StringComparison.OrdinalIgnoreCase))
                {
                    result.SkipAutoStart = true;
                }
            }
            return result;
        }
    }

    internal static class StartupManager
    {
        private const string ShortcutName = "EADesktopTip.lnk";

        internal static void ApplyPreference(string installDir, string executablePath)
        {
            string preferencePath = Path.Combine(installDir, "data", "autostart-preference.txt");
            bool enabled = ReadPreference(preferencePath);
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            Directory.CreateDirectory(startupDir);
            string shortcutPath = Path.Combine(startupDir, ShortcutName);

            if (!enabled)
            {
                if (File.Exists(shortcutPath))
                {
                    File.Delete(shortcutPath);
                }
                LauncherLog.Write("autostart_disabled", "method=startup_shortcut");
                return;
            }

            object shell = null;
            object shortcut = null;
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null)
                {
                    throw new InvalidOperationException("Windows Script Host is unavailable.");
                }
                shell = Activator.CreateInstance(shellType);
                shortcut = shellType.InvokeMember(
                    "CreateShortcut",
                    BindingFlags.InvokeMethod,
                    null,
                    shell,
                    new object[] { shortcutPath });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { executablePath });
                shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "" });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { installDir });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { executablePath + ",0" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "EA desktop tip" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
                if (!File.Exists(preferencePath))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(preferencePath));
                    File.WriteAllText(preferencePath, "enabled", new UTF8Encoding(false));
                }
                LauncherLog.Write("autostart_enabled", "method=startup_shortcut");
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut))
                {
                    Marshal.FinalReleaseComObject(shortcut);
                }
                if (shell != null && Marshal.IsComObject(shell))
                {
                    Marshal.FinalReleaseComObject(shell);
                }
            }
        }

        private static bool ReadPreference(string preferencePath)
        {
            try
            {
                if (!File.Exists(preferencePath))
                {
                    return true;
                }
                string value = File.ReadAllText(preferencePath, Encoding.UTF8).Trim();
                return !String.Equals(value, "disabled", StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception error)
            {
                LauncherLog.Write("autostart_preference_read_failed", error.Message);
                return true;
            }
        }
    }

    internal static class LauncherLog
    {
        private static readonly object Sync = new object();
        private static string _path = "";

        internal static void Initialize(string installDir)
        {
            try
            {
                string logDir = Path.Combine(installDir, "logs");
                Directory.CreateDirectory(logDir);
                _path = Path.Combine(logDir, "desktop-tip-launcher.log");
            }
            catch
            {
                try
                {
                    string fallbackDir = Path.Combine(Path.GetTempPath(), "ea-desktop-tip");
                    Directory.CreateDirectory(fallbackDir);
                    _path = Path.Combine(fallbackDir, "desktop-tip-launcher.log");
                }
                catch
                {
                    _path = "";
                }
            }
        }

        internal static void Write(string eventName, string detail)
        {
            if (String.IsNullOrWhiteSpace(_path))
            {
                return;
            }
            string sanitized = (detail ?? "").Replace("\r", " ").Replace("\n", " ");
            string line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "] [EA-DESKTOP-TIP-LAUNCHER] "
                + eventName + " " + sanitized + Environment.NewLine;
            lock (Sync)
            {
                try
                {
                    File.AppendAllText(_path, line, new UTF8Encoding(false));
                }
                catch
                {
                }
            }
        }
    }
}

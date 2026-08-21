using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace EazyGame.EaLauncher
{
    internal static class Program
    {
        internal const string LauncherVersion = "0.1.0";
        private const string StartupLinkName = "EazyGameIntegratedAssistant";

        [STAThread]
        private static int Main(string[] args)
        {
            LauncherArguments arguments = LauncherArguments.Parse(args);
            string executableDir = AppDomain.CurrentDomain.BaseDirectory;
            LauncherConfig config;
            string projectDir;

            try
            {
                config = LauncherConfig.Load(executableDir);
                projectDir = ProjectLocator.Resolve(executableDir, config.ProjectDirRelative, arguments.ProjectDir);
            }
            catch (Exception error)
            {
                ShowFatalError("EA launcher initialization failed", error);
                return 2;
            }

            LauncherLog.Initialize(projectDir);
            LauncherLog.Write("launcher_boot", "version=" + LauncherVersion + " projectDir=" + projectDir);

            if (arguments.SelfTest)
            {
                return RunSelfTest(projectDir, config);
            }

            string instanceKey = StableKey(projectDir);
            string mutexName = "Local\\EAEaLauncher_" + instanceKey;
            string wakeName = "Local\\EAEaLauncherWake_" + instanceKey;
            string restartName = "Local\\EAEaLauncherRestart_" + instanceKey;
            bool createdNew;

            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    string eventName = arguments.Restart ? restartName : wakeName;
                    SignalExistingInstance(eventName);
                    LauncherLog.Write("duplicate_launcher", "action=" + (arguments.Restart ? "restart" : "wake"));
                    return 0;
                }

                if (arguments.TestHoldSeconds > 0)
                {
                    LauncherLog.Write("test_hold", "seconds=" + arguments.TestHoldSeconds);
                    Thread.Sleep(arguments.TestHoldSeconds * 1000);
                    return 0;
                }

                using (EventWaitHandle wakeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, wakeName))
                using (EventWaitHandle restartEvent = new EventWaitHandle(false, EventResetMode.AutoReset, restartName))
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs eventArgs)
                    {
                        LauncherLog.Write("ui_error", eventArgs.Exception.ToString());
                    };

                    EaLauncherContext context = new EaLauncherContext(
                        projectDir,
                        config,
                        wakeEvent,
                        restartEvent,
                        StartupLinkName,
                        arguments.Restart);
                    Application.Run(context);
                }
            }

            return 0;
        }

        private static int RunSelfTest(string projectDir, LauncherConfig config)
        {
            try
            {
                string entryScript = Path.Combine(projectDir, "src", "main.js");
                string packagePath = Path.Combine(projectDir, "package.json");
                if (!File.Exists(entryScript) || !File.Exists(packagePath))
                {
                    throw new InvalidOperationException("EA project files are incomplete.");
                }

                string nodePath = ProcessTools.ResolveExecutable(projectDir, config.NodeExecutable);
                if (String.IsNullOrWhiteSpace(nodePath))
                {
                    throw new InvalidOperationException("node.exe was not found.");
                }

                LauncherLog.Write("self_test_passed", "node=" + nodePath + " port=" + config.Port);
                return 0;
            }
            catch (Exception error)
            {
                LauncherLog.Write("self_test_failed", error.ToString());
                return 3;
            }
        }

        private static void SignalExistingInstance(string eventName)
        {
            for (int attempt = 0; attempt < 10; attempt += 1)
            {
                try
                {
                    using (EventWaitHandle handle = EventWaitHandle.OpenExisting(eventName))
                    {
                        handle.Set();
                        return;
                    }
                }
                catch (WaitHandleCannotBeOpenedException)
                {
                    Thread.Sleep(100);
                }
            }
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

        private static void ShowFatalError(string title, Exception error)
        {
            try
            {
                MessageBox.Show(error.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch
            {
            }
        }
    }

    internal sealed class EaLauncherContext : ApplicationContext
    {
        private readonly string _projectDir;
        private readonly LauncherConfig _config;
        private readonly EventWaitHandle _wakeEvent;
        private readonly EventWaitHandle _restartEvent;
        private readonly string _startupLinkName;
        private readonly NotifyIcon _notifyIcon;
        private readonly Control _dispatcher;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly ToolStripMenuItem _autoStartItem;
        private readonly string _autoStartPreferencePath;
        private volatile bool _closing;
        private int _operationInProgress;

        internal EaLauncherContext(
            string projectDir,
            LauncherConfig config,
            EventWaitHandle wakeEvent,
            EventWaitHandle restartEvent,
            string startupLinkName,
            bool restartOnStart)
        {
            _projectDir = projectDir;
            _config = config;
            _wakeEvent = wakeEvent;
            _restartEvent = restartEvent;
            _startupLinkName = startupLinkName;
            _autoStartPreferencePath = Path.Combine(_projectDir, "data", "ea-launcher", "startup-preference.txt");
            _dispatcher = new Control();
            _dispatcher.CreateControl();

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem versionItem = new ToolStripMenuItem("EA Launcher v" + Program.LauncherVersion);
            versionItem.Enabled = false;
            menu.Items.Add(versionItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(CreateMenuItem("\u6253\u5f00\u7ba1\u7406\u540e\u53f0", OpenAdmin));
            menu.Items.Add(CreateMenuItem("\u67e5\u770b\u8fd0\u884c\u72b6\u6001", ShowStatus));
            menu.Items.Add(CreateMenuItem("\u91cd\u542f EA", RestartEa));
            _autoStartItem = CreateMenuItem("\u5f00\u673a\u81ea\u52a8\u542f\u52a8", ToggleAutoStart);
            _autoStartItem.CheckOnClick = false;
            menu.Items.Add(_autoStartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(CreateMenuItem("\u4ec5\u9000\u51fa\u542f\u52a8\u5668", ExitLauncherOnly));
            menu.Items.Add(CreateMenuItem("\u505c\u6b62 EA \u5e76\u9000\u51fa", StopEaAndExit));

            _notifyIcon = new NotifyIcon();
            _notifyIcon.Icon = SystemIcons.Application;
            _notifyIcon.Text = "EA Launcher v" + Program.LauncherVersion;
            _notifyIcon.ContextMenuStrip = menu;
            _notifyIcon.Visible = true;
            _notifyIcon.DoubleClick += delegate { OpenAdmin(null, EventArgs.Empty); };

            bool? savedAutoStart = ReadAutoStartPreference();
            bool desiredAutoStart = savedAutoStart.HasValue
                ? savedAutoStart.Value
                : _config.AutoStartWithWindows;
            if (EnsureAutoStart(desiredAutoStart) && !savedAutoStart.HasValue)
            {
                WriteAutoStartPreference(desiredAutoStart);
            }
            RefreshAutoStartState();

            StartEventListener(_wakeEvent, delegate
            {
                Notify("EA Launcher", "EA \u542f\u52a8\u5668\u6b63\u5728\u8fd0\u884c\u3002", ToolTipIcon.Info);
            });
            StartEventListener(_restartEvent, delegate { BeginRestart("ipc"); });

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = Math.Max(5, _config.PollSeconds) * 1000;
            _timer.Tick += delegate { BeginEnsureRunning("timer", false); };
            _timer.Start();

            LauncherLog.Write("launcher_ready", "port=" + _config.Port + " autoRestart=" + _config.AutoRestart);
            if (restartOnStart)
            {
                BeginRestart("startup_argument");
            }
            else
            {
                BeginEnsureRunning("startup", true);
            }
        }

        private ToolStripMenuItem CreateMenuItem(string text, EventHandler handler)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.Click += handler;
            return item;
        }

        private void StartEventListener(EventWaitHandle handle, Action action)
        {
            Thread thread = new Thread(delegate()
            {
                while (!_closing)
                {
                    handle.WaitOne();
                    if (_closing)
                    {
                        return;
                    }
                    Post(action);
                }
            });
            thread.IsBackground = true;
            thread.Name = "EA launcher IPC listener";
            thread.Start();
        }

        private void Post(Action action)
        {
            if (_closing || _dispatcher.IsDisposed)
            {
                return;
            }
            try
            {
                _dispatcher.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
            }
        }

        private void BeginEnsureRunning(string reason, bool notifyWhenHealthy)
        {
            if (_closing || Interlocked.CompareExchange(ref _operationInProgress, 1, 0) != 0)
            {
                return;
            }

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    EaStatus status = EaRuntime.ReadStatus(_config);
                    if (status.Healthy)
                    {
                        LauncherLog.Write("health_ok", "reason=" + reason + " version=" + status.Version);
                        if (notifyWhenHealthy)
                        {
                            Notify("EA Launcher", "EA " + status.Version + " \u6b63\u5728\u8fd0\u884c\u3002", ToolTipIcon.Info);
                        }
                        return;
                    }

                    if (!_config.AutoRestart && reason == "timer")
                    {
                        LauncherLog.Write("auto_restart_disabled", "reason=" + reason);
                        return;
                    }

                    StartEaAndWait(reason);
                }
                catch (Exception error)
                {
                    LauncherLog.Write("ensure_failed", "reason=" + reason + " error=" + error);
                    Notify("EA Launcher", "EA \u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u67e5\u770b logs\\ea-launcher.log\u3002", ToolTipIcon.Error);
                }
                finally
                {
                    Interlocked.Exchange(ref _operationInProgress, 0);
                }
            });
        }

        private void StartEaAndWait(string reason)
        {
            if (EaRuntime.IsPortOpen(_config.Port))
            {
                LauncherLog.Write("port_conflict", "port=" + _config.Port + " reason=" + reason);
                Notify("EA Launcher", "\u7aef\u53e3 " + _config.Port + " \u5df2\u88ab\u975e EA \u670d\u52a1\u5360\u7528\u3002", ToolTipIcon.Error);
                return;
            }

            string nodePath = ProcessTools.ResolveExecutable(_projectDir, _config.NodeExecutable);
            if (String.IsNullOrWhiteSpace(nodePath))
            {
                throw new FileNotFoundException("node.exe was not found.");
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = nodePath;
            startInfo.Arguments = "src/main.js";
            startInfo.WorkingDirectory = _projectDir;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process process = Process.Start(startInfo);
            LauncherLog.Write("ea_start_requested", "reason=" + reason + " pid=" + (process == null ? 0 : process.Id));

            Stopwatch timeout = Stopwatch.StartNew();
            while (timeout.Elapsed < TimeSpan.FromSeconds(Math.Max(5, _config.StartupTimeoutSeconds)))
            {
                Thread.Sleep(1000);
                EaStatus status = EaRuntime.ReadStatus(_config);
                if (status.Healthy)
                {
                    LauncherLog.Write("ea_started", "reason=" + reason + " version=" + status.Version);
                    Notify("EA Launcher", "EA " + status.Version + " \u5df2\u542f\u52a8\u3002", ToolTipIcon.Info);
                    return;
                }
            }

            LauncherLog.Write("ea_start_timeout", "reason=" + reason + " timeoutSeconds=" + _config.StartupTimeoutSeconds);
            Notify("EA Launcher", "EA \u542f\u52a8\u8d85\u65f6\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002", ToolTipIcon.Warning);
        }

        private void RestartEa(object sender, EventArgs eventArgs)
        {
            BeginRestart("tray_menu");
        }

        private void BeginRestart(string reason)
        {
            if (_closing || Interlocked.CompareExchange(ref _operationInProgress, 1, 0) != 0)
            {
                Notify("EA Launcher", "EA \u6b63\u5728\u6267\u884c\u5176\u4ed6\u64cd\u4f5c\u3002", ToolTipIcon.Info);
                return;
            }

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    LauncherLog.Write("restart_requested", "reason=" + reason);
                    EaRuntime.StopVerifiedEa(_config);
                    Thread.Sleep(Math.Max(1, _config.RestartDelaySeconds) * 1000);
                    StartEaAndWait("restart_" + reason);
                }
                catch (Exception error)
                {
                    LauncherLog.Write("restart_failed", "reason=" + reason + " error=" + error);
                    Notify("EA Launcher", "EA \u91cd\u542f\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002", ToolTipIcon.Error);
                }
                finally
                {
                    Interlocked.Exchange(ref _operationInProgress, 0);
                }
            });
        }

        private void ShowStatus(object sender, EventArgs eventArgs)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                EaStatus status = EaRuntime.ReadStatus(_config);
                string message = status.Healthy
                    ? "EA " + status.Version + " \u6b63\u5728\u8fd0\u884c\u3002"
                    : "EA \u5f53\u524d\u672a\u6b63\u5e38\u8fd0\u884c\u3002\r\n" + status.Error;
                Post(delegate
                {
                    MessageBox.Show(message, "EA Launcher", MessageBoxButtons.OK,
                        status.Healthy ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                });
            });
        }

        private void OpenAdmin(object sender, EventArgs eventArgs)
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = _config.AdminUrl;
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
                LauncherLog.Write("admin_opened", "url=" + _config.AdminUrl);
            }
            catch (Exception error)
            {
                LauncherLog.Write("admin_open_failed", error.ToString());
                MessageBox.Show("\u7ba1\u7406\u540e\u53f0\u6253\u5f00\u5931\u8d25\u3002", "EA Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ToggleAutoStart(object sender, EventArgs eventArgs)
        {
            bool desired = !_autoStartItem.Checked;
            if (EnsureAutoStart(desired))
            {
                WriteAutoStartPreference(desired);
            }
            RefreshAutoStartState();
        }

        private bool EnsureAutoStart(bool enabled)
        {
            object shell = null;
            object shortcut = null;
            try
            {
                string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                Directory.CreateDirectory(startupDir);
                string shortcutPath = Path.Combine(startupDir, _startupLinkName + ".lnk");
                if (enabled)
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
                    string executablePath = Process.GetCurrentProcess().MainModule.FileName;
                    shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { executablePath });
                    shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "--background --project-dir \"" + _projectDir + "\"" });
                    shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { _projectDir });
                    shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { executablePath + ",0" });
                    shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "EA background launcher" });
                    shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
                    LauncherLog.Write("autostart_enabled", "method=startup_shortcut path=" + shortcutPath);
                }
                else
                {
                    if (File.Exists(shortcutPath))
                    {
                        File.Delete(shortcutPath);
                    }
                    LauncherLog.Write("autostart_disabled", "method=startup_shortcut");
                }
                return true;
            }
            catch (Exception error)
            {
                LauncherLog.Write("autostart_failed", error.ToString());
                Notify("EA Launcher", "\u5f00\u673a\u81ea\u52a8\u542f\u52a8\u8bbe\u7f6e\u5931\u8d25\u3002", ToolTipIcon.Warning);
                return false;
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

        private bool? ReadAutoStartPreference()
        {
            try
            {
                if (!File.Exists(_autoStartPreferencePath))
                {
                    return null;
                }
                string value = File.ReadAllText(_autoStartPreferencePath, Encoding.UTF8).Trim();
                if (String.Equals(value, "enabled", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                if (String.Equals(value, "disabled", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
                LauncherLog.Write("autostart_preference_invalid", "valueLength=" + value.Length);
            }
            catch (Exception error)
            {
                LauncherLog.Write("autostart_preference_read_failed", error.ToString());
            }
            return null;
        }

        private void WriteAutoStartPreference(bool enabled)
        {
            try
            {
                string directory = Path.GetDirectoryName(_autoStartPreferencePath);
                if (!String.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                File.WriteAllText(
                    _autoStartPreferencePath,
                    enabled ? "enabled" : "disabled",
                    new UTF8Encoding(false));
                LauncherLog.Write("autostart_preference_saved", "enabled=" + enabled);
            }
            catch (Exception error)
            {
                LauncherLog.Write("autostart_preference_write_failed", error.ToString());
            }
        }

        private void RefreshAutoStartState()
        {
            bool enabled = false;
            try
            {
                string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                enabled = File.Exists(Path.Combine(startupDir, _startupLinkName + ".lnk"));
            }
            catch
            {
            }
            _autoStartItem.Checked = enabled;
        }

        private void ExitLauncherOnly(object sender, EventArgs eventArgs)
        {
            LauncherLog.Write("launcher_exit", "stopEa=false");
            ExitLauncher();
        }

        private void StopEaAndExit(object sender, EventArgs eventArgs)
        {
            DialogResult result = MessageBox.Show(
                "\u786e\u5b9a\u505c\u6b62 EA \u5e76\u9000\u51fa\u542f\u52a8\u5668\u5417\uff1f",
                "EA Launcher",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (result != DialogResult.Yes)
            {
                return;
            }

            _timer.Stop();
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    EaRuntime.StopVerifiedEa(_config);
                    LauncherLog.Write("launcher_exit", "stopEa=true");
                }
                catch (Exception error)
                {
                    LauncherLog.Write("stop_before_exit_failed", error.ToString());
                }
                Post(ExitLauncher);
            });
        }

        private void Notify(string title, string message, ToolTipIcon icon)
        {
            Post(delegate
            {
                if (!_closing)
                {
                    _notifyIcon.ShowBalloonTip(4000, title, message, icon);
                }
            });
        }

        private void ExitLauncher()
        {
            if (_closing)
            {
                return;
            }
            _closing = true;
            _timer.Stop();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _wakeEvent.Set();
            _restartEvent.Set();
            _dispatcher.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_closing)
            {
                ExitLauncher();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class LauncherArguments
    {
        internal string ProjectDir;
        internal bool Restart;
        internal bool SelfTest;
        internal int TestHoldSeconds;

        internal static LauncherArguments Parse(string[] args)
        {
            LauncherArguments result = new LauncherArguments();
            for (int index = 0; index < args.Length; index += 1)
            {
                string value = args[index] ?? "";
                if (String.Equals(value, "--project-dir", StringComparison.OrdinalIgnoreCase) && index + 1 < args.Length)
                {
                    result.ProjectDir = args[++index];
                }
                else if (String.Equals(value, "--restart", StringComparison.OrdinalIgnoreCase))
                {
                    result.Restart = true;
                }
                else if (String.Equals(value, "--self-test", StringComparison.OrdinalIgnoreCase))
                {
                    result.SelfTest = true;
                }
                else if (String.Equals(value, "--test-hold-seconds", StringComparison.OrdinalIgnoreCase) && index + 1 < args.Length)
                {
                    Int32.TryParse(args[++index], out result.TestHoldSeconds);
                }
            }
            return result;
        }
    }

    internal sealed class LauncherConfig
    {
        internal string ProjectDirRelative = "../../..";
        internal string NodeExecutable = "node.exe";
        internal int Port = 39200;
        internal bool HttpsEnabled = true;
        internal string AdminUrl = "https://com.veryeazy.com:39200/";
        internal int PollSeconds = 30;
        internal int StartupTimeoutSeconds = 30;
        internal int RestartDelaySeconds = 3;
        internal bool AutoRestart = true;
        internal bool AutoStartWithWindows = true;

        internal static LauncherConfig Load(string executableDir)
        {
            LauncherConfig config = new LauncherConfig();
            string path = Path.Combine(executableDir, "ea-launcher.config.json");
            if (!File.Exists(path))
            {
                return config;
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> values = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
            config.ProjectDirRelative = ReadString(values, "projectDirRelative", config.ProjectDirRelative);
            config.NodeExecutable = ReadString(values, "nodeExecutable", config.NodeExecutable);
            config.Port = ReadInt(values, "port", config.Port);
            config.HttpsEnabled = ReadBool(values, "httpsEnabled", config.HttpsEnabled);
            config.AdminUrl = ReadString(values, "adminUrl", config.AdminUrl);
            config.PollSeconds = ReadInt(values, "pollSeconds", config.PollSeconds);
            config.StartupTimeoutSeconds = ReadInt(values, "startupTimeoutSeconds", config.StartupTimeoutSeconds);
            config.RestartDelaySeconds = ReadInt(values, "restartDelaySeconds", config.RestartDelaySeconds);
            config.AutoRestart = ReadBool(values, "autoRestart", config.AutoRestart);
            config.AutoStartWithWindows = ReadBool(values, "autoStartWithWindows", config.AutoStartWithWindows);
            return config;
        }

        internal string StatusUrl
        {
            get { return (HttpsEnabled ? "https" : "http") + "://127.0.0.1:" + Port + "/api/status"; }
        }

        private static string ReadString(Dictionary<string, object> values, string key, string fallback)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null && !String.IsNullOrWhiteSpace(Convert.ToString(value))
                ? Convert.ToString(value)
                : fallback;
        }

        private static int ReadInt(Dictionary<string, object> values, string key, int fallback)
        {
            object value;
            int parsed;
            return values.TryGetValue(key, out value) && Int32.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
        }

        private static bool ReadBool(Dictionary<string, object> values, string key, bool fallback)
        {
            object value;
            bool parsed;
            return values.TryGetValue(key, out value) && Boolean.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
        }
    }

    internal static class ProjectLocator
    {
        internal static string Resolve(string executableDir, string relativePath, string explicitPath)
        {
            if (!String.IsNullOrWhiteSpace(explicitPath))
            {
                return Validate(explicitPath);
            }

            string environmentPath = Environment.GetEnvironmentVariable("EA_PROJECT_DIR");
            if (!String.IsNullOrWhiteSpace(environmentPath))
            {
                return Validate(environmentPath);
            }

            if (!String.IsNullOrWhiteSpace(relativePath))
            {
                string configured = Path.GetFullPath(Path.Combine(executableDir, relativePath));
                if (IsProjectRoot(configured))
                {
                    return configured;
                }
            }

            DirectoryInfo current = new DirectoryInfo(executableDir);
            while (current != null)
            {
                if (IsProjectRoot(current.FullName))
                {
                    return current.FullName;
                }
                current = current.Parent;
            }

            throw new DirectoryNotFoundException("EA project directory was not found.");
        }

        private static string Validate(string path)
        {
            string fullPath = Path.GetFullPath(path);
            if (!IsProjectRoot(fullPath))
            {
                throw new DirectoryNotFoundException("Invalid EA project directory: " + fullPath);
            }
            return fullPath;
        }

        private static bool IsProjectRoot(string path)
        {
            return File.Exists(Path.Combine(path, "package.json"))
                && File.Exists(Path.Combine(path, "src", "main.js"));
        }
    }

    internal sealed class EaStatus
    {
        internal bool Healthy;
        internal string Version = "";
        internal string Error = "";
    }

    internal static class EaRuntime
    {
        internal static EaStatus ReadStatus(LauncherConfig config)
        {
            EaStatus result = new EaStatus();
            try
            {
                ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol | (SecurityProtocolType)3072;
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(config.StatusUrl);
                request.Method = "GET";
                request.Timeout = 3000;
                request.ReadWriteTimeout = 3000;
                request.ServerCertificateValidationCallback = delegate { return true; };
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        result.Error = "HTTP " + (int)response.StatusCode;
                        return result;
                    }
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    Dictionary<string, object> payload = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object okValue;
                    object appValue;
                    bool ok = payload.TryGetValue("ok", out okValue) && Convert.ToBoolean(okValue);
                    Dictionary<string, object> app = payload.TryGetValue("app", out appValue) ? appValue as Dictionary<string, object> : null;
                    object nameValue;
                    object versionValue;
                    string name = app != null && app.TryGetValue("name", out nameValue) ? Convert.ToString(nameValue) : "";
                    result.Version = app != null && app.TryGetValue("version", out versionValue) ? Convert.ToString(versionValue) : "";
                    result.Healthy = ok && String.Equals(name, "eazygame-integrated-assistant", StringComparison.OrdinalIgnoreCase);
                    if (!result.Healthy)
                    {
                        result.Error = "The status endpoint did not identify the EA service.";
                    }
                }
            }
            catch (Exception error)
            {
                result.Error = error.Message;
            }
            return result;
        }

        internal static bool IsPortOpen(int port)
        {
            using (TcpClient client = new TcpClient())
            {
                try
                {
                    IAsyncResult connect = client.BeginConnect("127.0.0.1", port, null, null);
                    bool connected = connect.AsyncWaitHandle.WaitOne(750);
                    if (connected)
                    {
                        client.EndConnect(connect);
                    }
                    return connected && client.Connected;
                }
                catch
                {
                    return false;
                }
            }
        }

        internal static void StopVerifiedEa(LauncherConfig config)
        {
            EaStatus status = ReadStatus(config);
            if (!status.Healthy)
            {
                if (IsPortOpen(config.Port))
                {
                    throw new InvalidOperationException("Port is in use, but it is not the EA status endpoint.");
                }
                return;
            }

            int processId = TcpProcessTable.FindListenerProcessId(config.Port);
            if (processId <= 0)
            {
                throw new InvalidOperationException("EA listener process was not found.");
            }

            using (Process process = Process.GetProcessById(processId))
            {
                string name = process.ProcessName ?? "";
                if (!String.Equals(name, "node", StringComparison.OrdinalIgnoreCase)
                    && !String.Equals(name, "nodejs", StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("The EA listener is not a Node.js process.");
                }
                LauncherLog.Write("ea_stop_requested", "pid=" + processId + " version=" + status.Version);
                process.Kill();
                process.WaitForExit(10000);
                LauncherLog.Write("ea_stopped", "pid=" + processId);
            }
        }
    }

    internal static class TcpProcessTable
    {
        private const int AfInet = 2;
        private const int TcpTableOwnerPidListener = 3;
        private const uint InsufficientBuffer = 122;

        [StructLayout(LayoutKind.Sequential)]
        private struct MibTcpRowOwnerPid
        {
            internal uint State;
            internal uint LocalAddress;
            internal uint LocalPort;
            internal uint RemoteAddress;
            internal uint RemotePort;
            internal uint OwningPid;
        }

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(
            IntPtr tcpTable,
            ref int size,
            bool order,
            int ipVersion,
            int tableClass,
            uint reserved);

        internal static int FindListenerProcessId(int port)
        {
            int size = 0;
            uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, true, AfInet, TcpTableOwnerPidListener, 0);
            if (result != InsufficientBuffer || size <= 0)
            {
                return 0;
            }

            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                result = GetExtendedTcpTable(buffer, ref size, true, AfInet, TcpTableOwnerPidListener, 0);
                if (result != 0)
                {
                    return 0;
                }

                int count = Marshal.ReadInt32(buffer);
                IntPtr rowPointer = IntPtr.Add(buffer, sizeof(int));
                int rowSize = Marshal.SizeOf(typeof(MibTcpRowOwnerPid));
                for (int index = 0; index < count; index += 1)
                {
                    MibTcpRowOwnerPid row = (MibTcpRowOwnerPid)Marshal.PtrToStructure(rowPointer, typeof(MibTcpRowOwnerPid));
                    int localPort = (int)(((row.LocalPort & 0xFF) << 8) | ((row.LocalPort & 0xFF00) >> 8));
                    if (localPort == port)
                    {
                        return (int)row.OwningPid;
                    }
                    rowPointer = IntPtr.Add(rowPointer, rowSize);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            return 0;
        }
    }

    internal static class ProcessTools
    {
        internal static string ResolveExecutable(string projectDir, string configured)
        {
            if (String.IsNullOrWhiteSpace(configured))
            {
                configured = "node.exe";
            }
            if (Path.IsPathRooted(configured))
            {
                return File.Exists(configured) ? configured : "";
            }

            string projectCandidate = Path.Combine(projectDir, configured);
            if (File.Exists(projectCandidate))
            {
                return projectCandidate;
            }

            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string segment in pathValue.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    string candidate = Path.Combine(segment.Trim(), configured);
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
    }

    internal static class LauncherLog
    {
        private static readonly object Sync = new object();
        private static string _path = "";

        internal static void Initialize(string projectDir)
        {
            string logDir = Path.Combine(projectDir, "logs");
            Directory.CreateDirectory(logDir);
            _path = Path.Combine(logDir, "ea-launcher.log");
        }

        internal static void Write(string eventName, string detail)
        {
            if (String.IsNullOrWhiteSpace(_path))
            {
                return;
            }
            string sanitized = (detail ?? "").Replace("\r", " ").Replace("\n", " ");
            string line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "] [EA-LAUNCHER] " + eventName + " " + sanitized + Environment.NewLine;
            lock (Sync)
            {
                File.AppendAllText(_path, line, new UTF8Encoding(false));
            }
        }
    }
}

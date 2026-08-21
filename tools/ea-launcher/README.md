# EA Launcher

Version: 0.1.0

`EA.exe` is the Windows tray launcher for the EA Node.js service.

## Daily use

Run:

```text
tools\ea-launcher\OutPackage\EA.exe
```

The launcher starts `node src\main.js` with no console window. Only one launcher is allowed for the same project directory. The tray menu can open the admin console, show status, restart EA, stop EA, or exit the launcher while leaving EA running.

The launcher checks EA every 30 seconds. When EA exits unexpectedly, it starts it again in the background. Runtime logs are written to the repository-relative path `logs\ea-launcher.log`.

Windows startup is enabled by default on the first normal launch. The launcher creates a shortcut in the current user's Windows Startup folder. The tray menu contains a checked `开机自动启动` item that can turn this behavior off or on without administrator permission.

`EA.exe` is a lightweight launcher, not a standalone copy of the full EA system. Keep it in `tools\ea-launcher\OutPackage`, or pass `--project-dir` when launching it from another location.

## Build

Run from the repository root:

```powershell
npm run build:ea-launcher
```

The build uses the Windows .NET Framework compiler and creates:

```text
tools\ea-launcher\OutPackage\EA.exe
```

## Startup registration

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1
```

The scheduled task launches the EXE directly at user logon. If scheduled-task registration is denied, the script creates the same launcher shortcut in the current user's Windows Startup folder.

## Command-line operations

- `--project-dir <path>`: explicitly select the EA repository.
- `--restart`: ask the running launcher to restart EA.
- `--self-test`: validate the launcher environment without starting EA.

Do not place Secrets in the launcher configuration. Existing `.env` and EA configuration files remain in the repository and are not copied into the launcher package.

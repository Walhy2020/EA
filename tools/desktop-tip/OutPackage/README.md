# EA 桌面提醒

Version: 0.5.0

EA 服务端 desktopTip 模块版本：0.4.3；当前客户端 v0.5.0 新增正式入口 `EA桌面提醒.exe`。同事解压后直接双击 EXE 即可使用，不显示 PowerShell 控制台，并默认随当前用户登录 Windows 自动启动。

## 管理后台普通消息测试

入口：EA 管理总后台 -> 配置 -> EA桌面提醒 -> 普通消息测试。页面首次进入仍需要企业微信扫码登录；测试阶段所有已签名登录的后台用户都可发送普通桌面消息，不要求消息管理员或授权发送者名单。

填写“消息标题”和“消息内容”后，接收范围固定为“全部已登记客户端（N台）”。已登记客户端指同事至少启动过一次 EA 桌面提醒并成功连接 EA；无需接收人登录，也无需填写企业微信 UserID。N 为 0 时后台会禁用发送，服务端也会拒绝创建空消息。

普通消息使用 `sourceKey=admin_manual_message`，不进入 `production_maintenance` 停服更新状态机，不写停服更新数据，也不影响 watchdog 按 UserID 的旧链路。点击“发送测试消息”后会直接提交到服务端，不再弹二次确认。

EA 桌面提醒是本机 PC 右下角浮窗客户端。EA 服务端写入 desktop-tip 事件，客户端轮询后展示置顶提醒窗口，不修改企业微信，也不走 1 号机器人。

## 文件

- `EA桌面提醒.exe`: 同事日常使用的正式入口，只启动 M04 桌面提醒，不管理 EA 服务端。
- `desktop-tip-client.ps1`: Windows 浮窗客户端。
- `desktop-tip-updater.ps1`: 独立更新助手，负责备份、白名单替换、失败回滚和重启。
- `启动EA右下角提醒.bat`: 旧版兼容入口，优先启动 EXE；EXE 缺失时才隐藏启动 PowerShell 客户端。
- `config/desktop-tip-client.config.json`: 客户端配置。
- `logs/desktop-tip-client.log`: 客户端运行日志，运行时创建。
- `OutPackage/`: 分享输出目录。

## 当前能力

- 通用 EA 桌面提醒事件轮询、显示、确认和关闭。
- 蓝色 EA 悬浮按钮右键菜单新增“发送通知”：填写标题和正文后，默认发送到全部已登记客户端；可选“同时发送企业微信群”，群列表只来自服务端真实绑定 registry，客户端不能填写 chatId。群通知方式支持“普通通知”和“@所有人”，本期不展示“@指定人员”。
- 通用消息面板只显示标题和正文；不向用户展示来源、批次等技术字段。正文与标题同字号，长正文保留自动换行和按需垂直滚动：正文完整容纳时不显示滚动条，超出可视区域时才显示。底部只保留居中的“收到”按钮，点击后提交已收到并关闭当前消息，不打开 URL。
- 客户端面板版本号显示为 `V0.x.x`，居中显示在蓝色 EA 标识内部下部。
- 正式服停服更新面板：
  - 停服倒计时，动态显示剩余时间。
  - 已停服，红色状态直显。
  - 停服延长，橙色状态直显，显示本次延长、累计延长和最新恢复时间。
  - 更新完成，绿色状态直显，显示实际完成时间。
- 旧 PowerShell 中文兼容：客户端面板中文文案使用 Unicode 码点生成，避免无 BOM UTF-8 在 Windows PowerShell 5 下乱码。
- 在线更新：启动后自动检查新版，运行期间默认每 30 分钟检查一次；右键菜单可手动“检查更新”。v0.4.1 起同一安装目录只允许一个客户端实例运行；v0.5.0 起在线升级会校验并生成 EXE 入口，后续更新继续保留 config/data/logs/clientId。
- 开机启动：首次正常运行默认创建当前用户 Startup 快捷方式；右键蓝色 EA 按钮可取消或重新开启“开机自动启动”，选择会持久化，不会在下次手动启动时被覆盖。

## 配置

使用相对路径。重要字段：

- `serverBaseUrl`: EA 后台地址。源码示例可使用 `http://127.0.0.1:39200` 本机调试；分享包默认使用 `https://com.veryeazy.com:39200`。
- `userId`: 旧版兼容字段，v0.2.3 起客户端会清空并忽略该字段，不再要求接收人填写企业微信 UserID。
- `clientToken`: 可选。仅当 EA 服务端启用 `EA_DESKTOP_TIP_TOKEN` 时填写。
- `pollSeconds`: 轮询间隔。
- `openUrl`: 正式服停服更新面板点击“查看详情”时打开的默认地址；通用消息面板不再打开 URL。
- `updateEnabled`: 是否启用在线更新，默认 `true`。
- `updateCheckMinutes`: 运行期间检查更新间隔，默认 30 分钟。

客户端“发送通知”当前是临时测试阶段能力：发送资格只校验本机 clientId 已在服务端登记，不是强身份认证；后续权限阶段会切换到授权发送者机制。服务端固定把桌面通知投递给全部已登记客户端，不信任客户端传入的接收人、chatId、targetClientId、targetUserId 或 operatorUserId。单客户端发送频率限制为 60 秒 1 次，标题最多 80 字，正文最多 1000 字。

企业微信群绑定显示：如果企业微信智能机器人回调中提供群名称，EA 会优先保存真实群名；当前 SDK 标准字段只保证 `chatid/chattype/from.userid`，不保证群名字段，也没有按 chatid 查询群名的接口。若后台群名不准确，可在对应群重新发送 `@1号机器人 绑定M04通知群 群显示名称` 刷新名称；后台会对同名群追加脱敏短标识，避免两个群显示完全一样。

正式服停服更新测试阶段只走 EA 管理总后台“EA 桌面提醒”标签页：所有已通过企业微信扫码登录的管理后台用户都可以发送和推进停服通知；接收范围固定为全部已登记 EA 桌面提醒客户端安装实例。客户端登记的定义是：同事启动客户端后，客户端自动生成并持久化唯一 clientId，至少成功连接 EA 轮询一次后进入服务端注册表；无需接收人登录，也无需填写企业微信 UserID。只复制文件但从未启动、或启动后从未连上 EA 的客户端，服务端无法知道，不会收到本次全员桌面提醒。已登记但后来卸载的客户端暂时无法自动准确识别，本期保留记录，后续权限/设备管理阶段再做停用。

## 在线更新发布

现有 v0.2.3 客户端不含更新器，第一次需要手动替换到 v0.3.0 或更高版本、或重新发首次安装包。从 v0.3.0 起后续可在线更新；已在 v0.3.0 及以上的同事可在软件右键菜单选择“检查更新”升级到 v0.5.0。

同事日常启动请双击 `EA桌面提醒.exe`。旧 BAT 继续保留兼容，但不再是推荐入口；如果直接手工运行 `desktop-tip-client.ps1`，Windows 仍可能显示 PowerShell 控制台。

如果已经出现很多“EA 桌面提醒更新”窗口，临时止血方式：只保留一个 `desktop-tip-client.ps1` 进程，关闭其他重复窗口；或在任意一个更新窗口点击“是”升级到 v0.5.0，升级后新客户端会自动收敛同安装目录的旧实例。不要批量结束其他 PowerShell，因为可能属于别的工具。

发布新版客户端时，在仓库根目录执行：

```powershell
npm run build:desktop-tip-release
```

脚本会生成：

- `tools/desktop-tip/releases/latest.json`
- `tools/desktop-tip/releases/EA桌面提醒_client_v版本号.zip`
- `tools/desktop-tip/OutPackage/EA桌面提醒_v版本号_首次安装.zip`

首次安装包包含 `EA桌面提醒.exe`；v0.5.0 在线更新包继续使用 v0.4.2 已允许的程序白名单，并由新版客户端从 SHA256 校验后的内置载荷生成 EXE，从而兼容现有同事自动升级。更新包不包含 `config/`、`data/`、`logs/`、`client-id.txt` 或 Secret。EA 服务端公开只读提供：

- `GET /api/desktop-tip/client-update/manifest`
- `GET /api/desktop-tip/client-update/package`

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\desktop-tip-client.ps1 -SelfTest
```

预期输出包含 `EA 桌面提醒 v0.5.0 self test passed`，并且中文显示正常。EXE 自检：

```powershell
& ".\EA桌面提醒.exe" --self-test
```

端到端行为测试请在仓库根目录运行：

```powershell
npm run test:desktop-tip-maintenance
npm run test:desktop-tip-update
```

测试只使用临时目录、假登录会话和假 clientId，不会写入真实 `data/desktop-tip/events.json`，也不会发送真实企业微信消息或群消息。

# 星语汉化集成套件 · Antigravity Star ZhCN Suite

一套将 **Google Antigravity 桌面端中文本地化（适配 2.32.2）**、**哈基米原生桌宠（方案 A · 含双击右键 Gemini 对话）** 与 **织梦玻璃壁纸皮肤** 深度整合的开源套件（同时完整保留备用独立猫娘额度挂件）。

本仓库保存个人融合版及后续 Windows 修复，包含完整可重建源码和运行所需素材。项目为社区扩展，Antigravity 客户端需要另行安装；支持范围以 [验证记录](VERIFICATION.md) 为准。

## 融合版新增功能

- **桌面哈基米**：透明置顶、空白区域鼠标穿透、自由拖拽；Antigravity 未打开时也能显示，宿主 Sidecar 会在桌面模式运行期间礼让。
- **极简输入条 + 头顶气泡**：双击右键输入，Enter 发送后收起输入条。宿主回复用打字机效果显示，API 回复随流式分片刷新；长回复支持滚动、选中复制和悬停阅读。
- **人设与称呼统一**：额外人设优先于内置默认称呼，例如 `自称本喵，称呼用户为老师` 同时作用于自动吐槽和固定备用台词。此偏好按需在设置中填写，仓库不包含个人配置。
- **Claude / Codex / Cherry Studio 吃醋**：识别真实客户端前台窗口，Cherry 使用六条专属傲娇台词，沿用两分钟冷却；切回 AGY 时恢复原有原谅反应。
- **Windows / WSL 衔接**：选择当前宿主的插件目录，使用 Python 桥接发现 WSL 会话服务；桌面端可重新发现宿主端点，避免沿用失效的端口和令牌。
- **可靠性修复**：SSE 首段文本、断流检测、取消/重置竞态、中文输入法、右键双击时序、汉化更新待生效状态与桌宠保护边界。

获取源码包后，在 Windows 本地目录解压，安装 Node.js 22.12+，运行 `一键安装与配置.bat`。详细变更见 [CHANGELOG.md](CHANGELOG.md) 与 [融合维护记录](docs/maintenance/2026-11-18-integrated-release.md)。

> **整合来源与致谢**
> - **界面汉化引擎（`localization/`）**：基于 `yiheng8023/antigravity-chinese`（v3.3.50，实测适配 **Antigravity App 2.32.2** / VS Code 扩展 1.12.0）。
> - **桌宠核心（方案 A · `hagemi-pet/`）**：基于 `KCFindstr/hagemi-pet-agy` 原生 Antigravity Sidecar 桌宠插件（工具动作演绎、子代理分身、小鱼干额度、摸头呼噜 / 戳多红温、切模型吃醋、宿主现编吐槽），**新增双击右键弹出输入框 + Gemini 实时对话**。
>   - 角色立绘 & 灵感：**CrossPet** (`lokicorvus` 及贡献者，CC BY-NC-SA 4.0)
>   - Gemini 猫娘人设原作：B站 **@ZipZipPipe** · 推介视频制作：**小克**
> - **织梦皮肤与备用挂件（`Antigravity-Dream-Skin/`、`Antigravity-Cat-Widget/`）**：基于 `Monokumakuki/Antigravity-Star-Suite`（v0.2.14，含蓝紫玻璃壁纸皮肤、WSL 会话日志追踪与独立 Electron 备用挂件）。

---

## 一、整合亮点（方案 A 架构）

1. **桌面漂浮哈基米 (`hagemi-pet/`)：不依赖 Antigravity 窗口，永久置顶桌面**
   - **真正漂浮在桌面最顶层**：基于透明无边框全工作区 Electron 窗体，空白透明处全自动鼠标点击穿透（不影响正常点击底层软件和桌面图标），支持全桌面自由拖拽、扔墙反弹、吸附屏幕边缘躲壁偷看、摸头呼噜、戳多红温；**Antigravity 最小化或未启动时照常独自运行**。
   - **与宿主无缝联动 & 自动互斥防重影**：当本机运行 Antigravity 时自动读取会话与 `LanguageServer`，演读文件/写代码/跑命令、开迷你分身、显示小鱼干额度；当桌面漂浮模式启动时会自动生成互斥锁，使 CDP Sidecar 礼让退出，绝不出现两只哈基米重影。
   - **Claude / Codex / Cherry Studio 前台吃醋**：切到这些桌面客户端（Claude / Codex 也支持标题可识别的 CLI 终端）时，哈基米切为 `puffed` 鼓腮表情并触发专属吐槽；切回 Antigravity 时冒爱心原谅，也可在设置中关闭。
   - **双击右键输入 · 头顶气泡回复**：双击右键打开紧凑输入条，发送后收起并归还焦点，回复从头顶气泡输出。默认优先复用已登录 Antigravity 的 `LanguageServer.GetModelResponse`；若未启动宿主或想直连，可填写 `Gemini API Key` 使用 `v1/interactions` SSE 通道，模型需以账号实际可用列表为准。
2. **一套控制面板统一管理**
   - 在 **织梦皮肤（Dream Skin）控制面板** 中直接集成「星语汉化集成 · 方案 A」卡片：实时查看 **2.32.2 汉化状态**、**哈基米桌宠状态** 与 **本机 CDP 端口状态**，支持一键安装/预注入汉化、安装/卸载哈基米插件、配置 CDP 连接、唤起备用挂件，以及 **自定义本地壁纸（PNG/JPG/WebP）**。
3. **原生适配 `Antigravity (WSL: Ubuntu)` 场景**
   - **WSL 会话日志与调试端口回退探测**：`hagemi-pet/sidecars/pet/lib/cdp.mjs` 新增 WSL 下自动探测 `/mnt/c/Users/*/AppData/Roaming/Antigravity/DevToolsActivePort`；`Antigravity-Cat-Widget` 支持异步扫描 `\\wsl.localhost\<Distro>\home\<user>\.gemini\antigravity\brain\`。
   - **WSL 智能体中文规则同步**：`suite-cli.js` 可同时将 `chinese-toolkit` 规则与技能同步到 Windows 与 WSL 发行版中。
4. **汉化引擎、玻璃皮肤与原生桌宠三者互不冲突**
   - `localization/core/i18n-runtime.js` 显式保护 Dream Skin 注入层（`#agy-dream-wallpaper-v2`、`#agy-dream-style-v2`、`[data-agy-dream-layer]`）以及哈基米宿主元素（`#hagemi-pet-host`），确保文本汉化、毛玻璃壁纸和 Shadow DOM 桌宠完全隔离。
5. **源码版一键配置 CDP 连接 & 自愈启动**
   - `tools/build-native.ps1` 编译 `ForegroundHost.exe` 与 `HostConnect.exe`，`suite-cli.js launch` 自动完成汉化自愈检查、补装哈基米插件、以 `--remote-debugging-port=0` 本机调试模式启动 Antigravity 并拉起织梦皮肤。

---

## 二、Windows 使用指南（配合 `Antigravity (WSL: Ubuntu)`）

> 因为 Antigravity 桌面客户端的界面进程运行在 **Windows 宿主机** 上，所以安装汉化补丁、编译原生跟随器以及运行挂件和壁纸控制面板，**请在 Windows 端执行**。

### 前置环境
- Windows 10 / 11 x64（含系统自带 `.NET Framework 4.x`）
- **Node.js 22.12+**（Windows 端）

### 方式 A：在 Windows 直接打开或复制项目后一键执行

如果本目录位于 WSL 中（例如 `/home/<linux-user>/.gemini/antigravity/scratch/antigravity-star-zhcn`），在 Windows 资源管理器或终端中可以通过以下路径访问，或先复制到 Windows 本地目录：
```text
\\wsl.localhost\Ubuntu\home\<linux-user>\.gemini\antigravity\scratch\antigravity-star-zhcn
```
*(建议先复制到 Windows 本地盘目录再运行，npm 安装 Electron 与文件监听会更快更稳定。)*

1. **首次安装与配置**：先保存工作并完全退出 Antigravity，然后双击运行：
   - **`一键安装与配置.bat`**
   - 它会自动完成：
     1. 安装根工程依赖（Electron）与 `localization` 依赖（`@electron/asar`）
     2. 编译 `ForegroundHost.exe` 与 `HostConnect.exe`
     3. 对 `Antigravity 2.32.2` 的 `app.asar` 备份原版并注入中文补丁
     4. 自动安装并启用 **哈基米原生桌宠插件 (`hagemi-pet-agy`)**（注入至 `~/.gemini/config/plugins/`）
     5. 同步安装 Windows 与 WSL 中的 `chinese-toolkit` 中文规则插件
     6. 打开「一键连接」向导，为快捷方式加上本机调试参数 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0` 并创建桌面入口 `Antigravity（星语连接）`
2. **日常一键启动**：以后直接双击：
   - **`启动桌面哈基米.cmd`**：**单独启动独立桌面漂浮哈基米**（完全不依赖是否打开 Antigravity！）。
   - **`一键启动套件.bat`**：自动检查汉化自愈、以本机 CDP 模式启动 Antigravity、启动**桌面漂浮哈基米**及**织梦皮肤控制面板**。
   - **哈基米对话小技巧**：在哈基米身上 **双击右键** 弹出 Gemini 输入框，按 `Enter` 发送（支持中文输入法上屏防误触，`Shift+Enter` 换行，`Esc` 关闭）；**单击右键** 打开设置菜单，可切换对话通道（自动优先宿主模型 / 仅宿主 / Gemini API Key 直连）、切换语言大小、开启或关闭切客户端吃醋监听。
3. **查看状态 / 单独启动 / 恢复原版**：
   - `检查套件状态.bat`：查看汉化、桌面漂浮哈基米、CDP 连接、WSL 插件与原生辅助程序状态
   - `启动星语皮肤.cmd` / `启动星语挂件.cmd`：单独启动皮肤面板或备用独立 Electron 猫娘挂件
   - `一键还原原版.bat`：恢复 `app.asar` 官方英文原版，并可选卸载插件或恢复启动快捷方式

---

## 三、常用命令 (`suite-cli.js`)

```powershell
# 查看完整状态
node suite-cli.js status

# 安装汉化 + 同步 WSL 插件 + 配置 CDP 连接
node suite-cli.js install

# 方案 A 启动：桌面漂浮哈基米 + 织梦皮肤（可选同时拉起 Antigravity）
node suite-cli.js launch
node suite-cli.js launch --no-host

# 单独启动或退出桌面漂浮哈基米（不依赖 Antigravity 窗口）
node suite-cli.js hagemi desktop
node suite-cli.js hagemi quit

# 备选管理 CDP Sidecar 插件或预览舞台
node suite-cli.js hagemi install
node suite-cli.js hagemi uninstall
node suite-cli.js hagemi status
node suite-cli.js hagemi preview

# 恢复英文原版（可选 --with-hagemi 卸载插件、--restore-connection 恢复原快捷方式）
node suite-cli.js restore
node suite-cli.js restore --with-hagemi --restore-connection

# 在 WSL 或 Windows 单独管理中文规则插件
node suite-cli.js wsl-plugin install
node suite-cli.js wsl-plugin status
```

---

## 四、目录结构

```text
antigravity-star-zhcn/
├── suite-cli.js                  # 统一整合 CLI（汉化 / 桌面哈基米 / CDP / 皮肤 / WSL 插件）
├── 启动桌面哈基米.cmd             # Windows 双击直启独立桌面漂浮哈基米（无需打开宿主窗口）
├── 一键安装与配置.bat             # Windows 首次一键安装脚本
├── 一键启动套件.bat               # Windows 一键启动全套组件（方案 A）
├── 一键还原原版.bat               # Windows 一键还原英文原版
├── 检查套件状态.bat               # Windows 状态巡检脚本
├── hagemi-pet/                   # 方案 A 主力桌宠：独立桌面漂浮入口 (desktop/) + Sidecar 核心
├── localization/                 # Antigravity 2.32.2 中文本地化引擎与词库
├── Antigravity-Dream-Skin/       # 织梦壁纸玻璃皮肤与套件集成控制面板
├── Antigravity-Cat-Widget/       # 备用独立 Electron 猫娘额度挂件（含 WSL 日志支持）
├── shared/                       # 本机 CDP 客户端与存储辅助
└── tools/                        # 原生编译、启动器与安装包构建工具
```

---

## 五、测试与验证

在安装 Node.js 22+ 与依赖后的环境中可运行：

```powershell
# 运行挂件、皮肤与整合桥接测试
npm run test:suite

# 运行哈基米桌宠与 Gemini 对话引擎测试
npm run test:hagemi

# 运行汉化引擎、边界保护与 Dream Skin 兼容测试
npm run test:i18n

# 运行全部测试
npm test
```

---

## 六、许可与免责声明

- 软件源码遵循 **MIT License**（见 `LICENSE`），保留各自上游原作者与社区贡献者版权声明。
- **美术与音效许可边界**：
  - `hagemi-pet/sidecars/pet/art/`、`hagemi-pet/assets/` 等哈基米角色立绘源自 **CrossPet**，遵循 **CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享）**（详见 `hagemi-pet/NOTICE.md`）；禁止将角色美术用于商业用途。
  - 其余壁纸与第三方音效许可详见 `ASSETS.md` 与 `NOTICE.md`。
- 本项目为非官方同人及社区开源工具，与 Google、Anthropic、OpenAI 无关联；所有修改与对话/状态读取仅在用户本机与用户自主配置的服务端执行。

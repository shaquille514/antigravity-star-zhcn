# 官方更新被皮肤面板阻塞

日期：2026-11-18。平台：Windows x64，Electron 45.1.0。宿主更新目标：Antigravity App 2.32.2 → 2.33.0。

## 复现与根因

官方更新包下载完成且 Google LLC 签名、SHA-512 校验有效。AGY 已退出，但安装器报告 `Failed to uninstall old application files...: 2`。Windows Restart Manager 确认持有宿主 `resources/app.asar` 的是 Dream Skin 的 Electron 主进程；正常退出面板后占用消失，官方安装器成功升级至 2.33.0。

状态面板通过 Electron 的 ASAR 虚拟文件系统探测并读取宿主归档，触发归档缓存持有文件句柄。按照 [Electron ASAR 文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file)，状态桥接及被调用的汉化 CLI 在 Electron 中改用 `original-fs`，普通 Node.js 下仍使用常规 `fs`。不修改翻译、补丁指纹、安装、备份或还原算法。

## 官方版本核查与边界

[官方更新日志](https://antigravity.google/docs/changelog)现已列出 2.33.0（2026-11-17）：SSH 主机连接、GitHub PR 集成、内嵌浏览器查找等。此次修复只影响归档读取与文件占用，不扩充上述新界面的翻译词条，也不把更新成功等同于 2.33.0 全界面汉化已验收。

## 回归验证

`tools/verify-asar-unlocked.cjs` 生成独立临时 ASAR，在真实 Electron 进程内连续调用面板状态读取，再在该进程仍存活时重命名归档。修复前稳定报 `EBUSY`，修复后要求状态准确且重命名成功；测试不访问实际客户端 ASAR，不创建 GUI 窗口，不发起模型请求。另运行完整 `npm test` 和一致性审计。

实际更新前保留旧汉化资源备份，用户配置和会话位于安装目录之外。未为本次验证强制结束用户会话，未对新版客户端自动套用未经复验的旧版汉化补丁。

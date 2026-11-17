# 融合套件源码发布

2026-11-18 将当前汉化组件与桌面哈基米、气泡对话、Dream Skin、备用额度挂件及 Windows/WSL 修复一起导出到个人融合仓库。汉化组件版本保持 3.3.50，词库及生成产物保持原样。

已核查 [官方更新日志](https://antigravity.google/docs/changelog)：公开页面列有 App 2.32.1，未找到 2.32.2 条目。2.32.2 仅作为本机安装与既有测试版本记录，不声明该版本完整官方更新面已核实。

本次不改词条、DOM 翻译策略、ASAR 注入/还原算法或插件配置。保留已完成的 Dream Skin 与桌宠边界保护、staged 更新处理及原版备份逻辑；不复制本机 ASAR、备份或个人配置。发布副本执行完整测试与一致性审计，等待目标提交 Windows / Ubuntu CI 通过后再创建发布标签。

完整来源、功能变更、已有实机验证和未覆盖范围见[融合发布记录](../../../docs/maintenance/2026-11-18-integrated-release.md)及根目录 `VERIFICATION.md`。

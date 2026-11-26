# dsh-bvs-pets

DSH 窗口里的桌面宠物插件。

A desktop pet plugin that lives inside the DSH window.

当前内置角色为 DeepSeek：透明 WebM 动画，可拖动，会沿窗口底部自行走动，并随机切换表情。右键可指定播放某一段。

Currently features DeepSeek: transparent WebM animations, draggable, walks along the bottom of the window, and randomly changes expressions. Right-click to play a specific clip.

目前仅在 DSH 窗口内运行。

Currently only runs inside the DSH window.

## Features / 功能

- 透明背景 WebM 动画 / Transparent WebM animations
- 可拖动定位 / Draggable
- 沿窗口底部自动走动 / Auto-walks along the window bottom
- 随机切换表情 / Random expression changes
- 右键菜单选择指定动画 / Right-click menu to select specific clips
- 位置与显示设置本地保存，刷新后保留 / Position and display settings are saved locally and persist across refreshes

## Installation / 安装

```bash
node scripts/install.mjs --profile web
```

安装后重启 DSH。

Restart DSH after installation.

卸载 / Uninstall：

```bash
node scripts/uninstall.mjs --profile web
```

插件名称 / Plugin name：`dsh-bvs-pets`

访问路径 / Served at：`/dsh-bvs-pets`

## Local Preview / 本地预览

```bash
node scripts/smoke.mjs
python3 -m http.server 8765 --bind 127.0.0.1 --directory assets
```

打开 / Open：[http://127.0.0.1:8765/preview.html](http://127.0.0.1:8765/preview.html)

预览页使用棋盘格背景，可检查透明效果与动画切换。

The preview page uses a checkerboard background to check transparency and clip switching.

## Adding Expressions / 添加表情

1. 将制作好的 `<名字>.webm` 放入 `assets/deepseek/`

   Put the finished `<name>.webm` into `assets/deepseek/`

2. 在 `pet.json` 中添加对应条目（`label`、`play`、`group`）

   Add an entry in `pet.json` (with `label`, `play`, `group`)

3. 刷新即可，无需改代码

   Refresh the page. No code changes needed.

## Project Structure / 目录结构

```text
lib/index.js            # 宿主侧 / Host side
web/widget.js           # 页面侧 / Page side
assets/<角色>/          # 宠物资源（需 pet.json）/ Pet assets (requires pet.json)
assets/preview.html     # 本地预览页 / Local preview
scripts/install.mjs     # 安装脚本 / Install script
```

## Notes / 说明

仓库中已包含可直接运行的完整内容。

The repository contains everything needed to run.

## License

MIT

## Roadmap

- [x] 在 DSH 窗口内运行的基础宠物（DeepSeek）

  Basic pet (DeepSeek) running inside the DSH window

- [ ] 更多内置角色 / More built-in characters
- [ ] 更丰富的互动（点击反应、状态联动等）

  Richer interactions (click reactions, state linkage, etc.)

- [ ] 支持显示到系统桌面 / Support for system desktop
- [ ] 更方便的角色安装与切换方式

  Easier character installation and switching

- [ ] 主题与自定义外观 / Themes and custom appearance

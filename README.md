# dsh-bvs-pets

DSH 窗口里的一只宠物。现在舞台上是 DeepSeek：透明 WebM，可拖动，自己沿窗口底边走动，也会自己换表情。右键她可以指定一段来播。

这是第一期，只活在 DSH 窗口里，还不会跑到系统桌面上去。

## 目录

```
lib/index.js            宿主侧：提供 /dsh-bvs-pets 下的脚本、目录和片子
web/widget.js           页面侧：播放、拖动、随机表情、右键菜单
assets/<角色>/          一只宠物。有 pet.json 才会出现
assets/preview.html     棋盘格上检查透明和换段
scripts/install.mjs     链进某个 DSH 配置
```

原始绿幕、抠像脚本、工艺说明和旧资源都在本机，不进仓库。绿幕原片在 `docs/原始绿幕/`，旧的九只宠物在 `docs/旧资源/`，说明都写在各自目录里。

## 装进 DSH

```sh
node scripts/install.mjs --profile web
```

装好后重启 DSH。卸掉用 `node scripts/uninstall.mjs --profile web`。

插件名是 `dsh-bvs-pets`。页面上的地址是 `/dsh-bvs-pets`。她的位置和显示设置仍记在原来的本地键里，刷新后不会丢。

## 本地看一眼

```sh
node scripts/smoke.mjs
python3 -m http.server 8765 --bind 127.0.0.1 --directory assets
```

打开 `http://127.0.0.1:8765/preview.html`。棋盘格应该从角色四周透出来。

## 加一段表情

把做好的 `<名字>.webm` 放进 `assets/deepseek/`，再在 `pet.json` 里加一行 `label`、`play`、`group`。刷新即可，不用改窗口代码。

## 放到 GitHub 上的文件

仓库里要有、克隆下来就能跑的：

- `lib/`、`web/`、`scripts/`、`package.json`、`cordis.patch.yml`
- `assets/deepseek/` 里的成品片子和 `pet.json`、`idle.png`
- `assets/preview.html`
- `README.md`、`LICENSE`、`.gitignore`

不要放上去的，已经写在 `.gitignore` 里：

| 路径 | 原因 |
|---|---|
| `tools/`、`docs/` | 抠像脚本、工艺说明、`docs/原始绿幕/` 里的绿幕原片，以及 `docs/旧资源/` 里的旧宠物 |
| `.venv/`、`.vendor/` | 本机 Python 环境和 ffmpeg |
| `.DS_Store`、`__pycache__/` | 系统缓存 |

`package.json` 里的 `"private": true` 只是不往 npm 发。GitHub 仓库本身可以公开。

# Local Videos Plus

Obsidian 插件 — 自动下载笔记中的视频链接到本地，类似 **Local Images Plus**，底层调用 **yt-dlp**。需要安装yt-dlp和ffmpeg，yt-dlp下载视频，ffmpeg把视频片段合并成一个视频。

---

## ✨ 功能

- 🎬 自动识别笔记中的视频链接并下载到本地
- 🔗 下载完成后自动替换 MD 中的网络链接为本地路径
- 📁 视频保存在 MD 同级的 `assets/` 子目录（可配置）
- 🌐 支持 YouTube、B站、Twitter/X、Reddit、Vimeo、TikTok、Instagram 等 **1800+ 网站**
- ⚡ 支持保存/新建文件时**自动触发**下载
- 🔒 防并发：同一文件不会重复处理

---

## 📋 前提：安装 yt-dlp

插件依赖系统安装的 `yt-dlp`，请先安装：

```bash
# macOS
brew install yt-dlp

# Windows
winget install yt-dlp

# Linux
pip install yt-dlp --break-system-packages
```

安装完成后，在插件设置里点击 **"检查 yt-dlp 安装"** 验证是否正常。

---

## 🚀 安装插件

### 方法一：手动安装（当前）

1. 下载本仓库的 `main.js` 和 `manifest.json`
2. 在 Vault 目录下创建文件夹：`.obsidian/plugins/local-videos-plus/`
3. 把 `main.js` 和 `manifest.json` 复制进去
4. 重启 Obsidian，进入 设置 → 第三方插件，启用 **Local Videos Plus**

### 方法二：从源码构建

```bash
git clone <本仓库>
cd local-videos-plus
npm install
npm run build
# 把生成的 main.js 和 manifest.json 复制到插件目录
```

---

## 📖 使用方法

### 手动触发（命令面板 Ctrl/Cmd+P）

| 命令 | 说明 |
|------|------|
| `Download videos in current file` | 下载当前文件的所有视频 |
| `Download videos in all files` | 扫描全库并下载 |
| `Check yt-dlp installation` | 检查 yt-dlp 是否可用 |

### 自动触发

在设置中开启：
- **保存时自动下载** — 每次 Ctrl+S 保存时触发
- **新建文件时自动下载** — Web Clipper 采集新页面时自动触发（推荐）

---

## ⚙️ 设置说明

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 视频子目录名 | `assets` | 视频保存的子文件夹名 |
| 相对于当前 MD | 开启 | 视频保存在 MD 同级目录 |
| 替换 MD 链接 | 开启 | 下载后替换网络链接为本地路径 |
| yt-dlp 路径 | `yt-dlp` | yt-dlp 可执行文件路径 |
| 最大文件大小 | `500m` | 超出则跳过 |
| 最大分辨率 | `1080` | 下载的最大视频高度 |
| 偏好格式 | `mp4` | 优先下载的视频格式 |
| 不下载播放列表 | 开启 | 只下载单个视频 |

---

## 📁 目录结构示例

```
Vault/
├── 笔记/
│   ├── 我的笔记.md          ← 视频链接被替换为本地路径
│   └── assets/
│       ├── How_to_use.mp4   ← YouTube 视频
│       └── Twitter_Video.mp4 ← X 视频
```

---

## ⚠️ 注意事项

- 本插件仅支持**桌面端**（依赖系统 yt-dlp）
- 视频文件较大，建议设置合理的 **最大文件大小** 限制
- 部分平台（如 Instagram、TikTok）可能需要登录，yt-dlp 支持传入 cookies
- X/Twitter 视频下载可能受平台限制，如失败请更新 yt-dlp 到最新版

---

## 📄 License

MIT

/*
Local Videos Plus - Obsidian Plugin
自动下载笔记中的视频链接，类似 Local Images Plus
支持 YouTube、B站、Twitter/X、Reddit、Vimeo、TikTok 等 1800+ 网站
依赖：yt-dlp（需提前安装到系统）
*/
"use strict";

const obsidian = require("obsidian");
const child_process = require("child_process");
const util = require("util");
const path = require("path");
const fs = require("fs");

const execFileAsync = util.promisify(child_process.execFile);
const execAsync = util.promisify(child_process.exec);

// ─── 视频链接正则匹配规则 ────────────────────────────────────────────────────
const VIDEO_PATTERNS = [
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s\)"']+/g,
  /https?:\/\/youtu\.be\/[\w\-]+[^\s\)"'""]*/g,
  /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w\-]+[^\s\)"'""]*/g,
  /https?:\/\/(?:www\.)?bilibili\.com\/video\/[\w]+[^\s\)"'""]*/g,
  /https?:\/\/b23\.tv\/[\w]+/g,
  /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/\w+\/status\/\d+[^\s\)"'""]*/g,
  /https?:\/\/(?:www\.)?reddit\.com\/r\/\w+\/comments\/[\w\/]+[^\s\)"'""]*/g,
  /https?:\/\/(?:www\.)?vimeo\.com\/\d+[^\s\)"'""]*/g,
  /https?:\/\/(?:www\.)?tiktok\.com\/@[\w\.]+\/video\/\d+[^\s\)"'""]*/g,
  /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[\w\-]+[^\s\)"'""]*/g,
];

const DEFAULT_SETTINGS = {
  videoFolder: "assets",
  useRelativePath: true,
  ytDlpPath: "yt-dlp",
  maxFileSize: "500m",
  preferredFormat: "mp4",
  maxHeight: "1080",
  autoDownloadOnSave: false,
  autoDownloadOnCreate: true,
  noPlaylist: true,
  replaceLinks: true,
};

function extractVideoUrls(content) {
  const found = new Set();
  for (const pattern of VIDEO_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      found.add(match[0].trim());
    }
  }
  return Array.from(found);
}

// ─── 设置页 ──────────────────────────────────────────────────────────────────
class LocalVideosPlusSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Local Videos Plus 设置" });

    // ── 目录 ──
    containerEl.createEl("h3", { text: "📁 保存目录" });

    new obsidian.Setting(containerEl)
      .setName("视频子目录名")
      .setDesc("视频保存到哪个子文件夹，如 assets、videos")
      .addText((t) =>
        t.setPlaceholder("assets")
          .setValue(this.plugin.settings.videoFolder)
          .onChange(async (v) => { this.plugin.settings.videoFolder = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("相对于当前 MD 文件")
      .setDesc("开启：视频保存在 MD 同级子目录；关闭：保存到 Vault 根目录")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useRelativePath)
          .onChange(async (v) => { this.plugin.settings.useRelativePath = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("替换 MD 中的链接")
      .setDesc("下载完成后，将网络链接自动替换为本地路径")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.replaceLinks)
          .onChange(async (v) => { this.plugin.settings.replaceLinks = v; await this.plugin.saveSettings(); })
      );

    // ── yt-dlp ──
    containerEl.createEl("h3", { text: "⚙️ yt-dlp 配置" });

    new obsidian.Setting(containerEl)
      .setName("yt-dlp 路径")
      .setDesc("yt-dlp 可执行文件路径，已加入 PATH 则填 yt-dlp 即可")
      .addText((t) =>
        t.setPlaceholder("yt-dlp")
          .setValue(this.plugin.settings.ytDlpPath)
          .onChange(async (v) => { this.plugin.settings.ytDlpPath = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("检查 yt-dlp 安装")
      .setDesc("点击检测 yt-dlp 是否可用")
      .addButton((btn) =>
        btn.setButtonText("检查").onClick(() => this.plugin.checkYtDlp())
      );

    new obsidian.Setting(containerEl)
      .setName("最大文件大小")
      .setDesc("超出此大小的视频跳过下载，如 500m、1g、2g")
      .addText((t) =>
        t.setPlaceholder("500m")
          .setValue(this.plugin.settings.maxFileSize)
          .onChange(async (v) => { this.plugin.settings.maxFileSize = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("最大分辨率")
      .setDesc("下载视频的最大高度")
      .addDropdown((d) =>
        d.addOption("480", "480p")
          .addOption("720", "720p")
          .addOption("1080", "1080p（推荐）")
          .addOption("1440", "1440p")
          .addOption("2160", "4K")
          .setValue(this.plugin.settings.maxHeight)
          .onChange(async (v) => { this.plugin.settings.maxHeight = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("偏好视频格式")
      .addDropdown((d) =>
        d.addOption("mp4", "MP4（推荐）")
          .addOption("webm", "WebM")
          .addOption("mkv", "MKV")
          .setValue(this.plugin.settings.preferredFormat)
          .onChange(async (v) => { this.plugin.settings.preferredFormat = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("不下载播放列表")
      .setDesc("只下载单个视频，不展开整个播放列表")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.noPlaylist)
          .onChange(async (v) => { this.plugin.settings.noPlaylist = v; await this.plugin.saveSettings(); })
      );

    // ── 自动化 ──
    containerEl.createEl("h3", { text: "🤖 自动触发" });

    new obsidian.Setting(containerEl)
      .setName("新建文件时自动下载")
      .setDesc("Web Clipper 采集新页面后自动触发视频下载（推荐开启）")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoDownloadOnCreate)
          .onChange(async (v) => { this.plugin.settings.autoDownloadOnCreate = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName("保存时自动下载")
      .setDesc("每次 Ctrl+S 保存 MD 文件时触发（可能略微影响保存速度）")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoDownloadOnSave)
          .onChange(async (v) => { this.plugin.settings.autoDownloadOnSave = v; await this.plugin.saveSettings(); })
      );

    // ── 说明 ──
    containerEl.createEl("h3", { text: "📖 命令说明" });
    const info = containerEl.createEl("div", { cls: "setting-item-description" });
    info.innerHTML = `
      <p>在命令面板（Ctrl/Cmd+P）搜索以下命令：</p>
      <ul style="margin-left:16px;line-height:2">
        <li><b>Local Videos: Download videos in current file</b> — 下载当前文件的视频</li>
        <li><b>Local Videos: Download videos in all files</b> — 扫描全库下载</li>
        <li><b>Local Videos: Check yt-dlp</b> — 检查安装状态</li>
      </ul>
      <p style="margin-top:8px"><b>支持平台：</b>YouTube、B站、Twitter/X、Reddit、Vimeo、TikTok、Instagram 等 1800+ 网站</p>
      <p><b>安装 yt-dlp：</b></p>
      <ul style="margin-left:16px;line-height:1.8;font-family:monospace">
        <li>macOS：brew install yt-dlp</li>
        <li>Windows：winget install yt-dlp</li>
        <li>Linux：pip install yt-dlp</li>
      </ul>
    `;
  }
}

// ─── 主插件类 ─────────────────────────────────────────────────────────────────
class LocalVideosPlusPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.downloadQueue = new Map();

    // 启动保护：Obsidian 启动时会批量触发 create 事件
    // isReady=false 期间忽略所有 create/modify 事件
    // 只有 onLayoutReady 之后才开始真正监听
    this.isReady = false;
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => {
        this.isReady = true;
        console.log("[LVP] ✅ 启动完成，开始监听新建文件");
      }, 2000);
    });

    // 命令：当前文件
    this.addCommand({
      id: "download-videos-current-file",
      name: "Local Videos: Download videos in current file",
      editorCallback: async (editor, view) => {
        if (view.file) await this.processFile(view.file, true);
      },
    });

    // 命令：全库
    this.addCommand({
      id: "download-videos-all-files",
      name: "Local Videos: Download videos in all files",
      callback: async () => await this.processAllFiles(),
    });

    // 命令：检查 yt-dlp
    this.addCommand({
      id: "check-ytdlp",
      name: "Local Videos: Check yt-dlp",
      callback: async () => await this.checkYtDlp(),
    });

    // 监听文件保存
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (
          !this.isReady ||                       // 启动阶段忽略
          !this.settings.autoDownloadOnSave ||
          !(file instanceof obsidian.TFile) ||
          file.extension !== "md"
        ) return;
        setTimeout(() => this.processFile(file, false), 1500);
      })
    );

    // 监听文件新建（仅响应 Web Clipper 等工具采集时创建的新文件）
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (
          !this.isReady ||                        // 启动阶段忽略，避免扫描全库
          !this.settings.autoDownloadOnCreate ||
          !(file instanceof obsidian.TFile) ||
          file.extension !== "md"
        ) return;
        console.log(`[LVP] 检测到新建文件：${file.path}`);
        // 等待 Web Clipper 把内容写完再处理
        setTimeout(() => this.processFile(file, false), 3000);
      })
    );

    this.addSettingTab(new LocalVideosPlusSettingTab(this.app, this));
    console.log("✅ Local Videos Plus loaded");
  }

  onunload() {
    console.log("Local Videos Plus unloaded");
  }

  // ─── 处理单个文件（带防并发） ───────────────────────────────────────────
  async processFile(file, showNotice) {
    if (this.downloadQueue.has(file.path)) {
      if (showNotice) new obsidian.Notice("⏳ 该文件正在处理中，请稍候...");
      return;
    }
    const promise = this._doProcessFile(file, showNotice);
    this.downloadQueue.set(file.path, promise);
    try { await promise; } finally { this.downloadQueue.delete(file.path); }
  }

  async _doProcessFile(file, showNotice) {
    let content = await this.app.vault.read(file);
    const urls = extractVideoUrls(content);

    if (urls.length === 0) {
      if (showNotice) new obsidian.Notice("✅ 没有发现视频链接");
      return;
    }

    if (showNotice) new obsidian.Notice(`🎬 发现 ${urls.length} 个视频链接，开始下载...`);

    const saveDir = this.getVideoDir(file);
    const vaultBase = this.app.vault.adapter.basePath;
    const absSaveDir = path.join(vaultBase, saveDir);
    if (!fs.existsSync(absSaveDir)) fs.mkdirSync(absSaveDir, { recursive: true });

    let ok = 0, fail = 0;

    for (const url of urls) {
      if (!url.startsWith("http")) continue;
      try {
        const localPath = await this.downloadVideo(url, absSaveDir, file, vaultBase);
        if (localPath && this.settings.replaceLinks) {
          content = content.split(url).join(`![[${localPath}]]`);
        }
        ok++;
        console.log(`[LVP] ✅ ${url} → ${localPath}`);
      } catch (e) {
        fail++;
        console.error(`[LVP] ❌ ${url}`, e.message || e);
      }
    }

    if (this.settings.replaceLinks && ok > 0) {
      await this.app.vault.modify(file, content);
    }

    if (showNotice || ok > 0 || fail > 0) {
      new obsidian.Notice(
        `🎉 完成！成功 ${ok} 个${fail > 0 ? `，失败 ${fail} 个（见控制台）` : ""}`
      );
    }
  }

  // ─── 全库处理 ────────────────────────────────────────────────────────────
  async processAllFiles() {
    const files = this.app.vault.getMarkdownFiles();
    new obsidian.Notice(`🔍 扫描 ${files.length} 个文件...`);
    let total = 0;
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const urls = extractVideoUrls(content);
      if (urls.length > 0) { total += urls.length; await this.processFile(file, false); }
    }
    new obsidian.Notice(`✅ 全库处理完成，共处理 ${total} 个视频链接`);
  }

  // ─── 下载前清理残留分片文件 ───────────────────────────────────────────────
  cleanFragments(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    let count = 0;
    for (const f of files) {
      if (/-Frag\d+|\.part$|\.ytdl$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); count++; } catch (e) {}
      }
    }
    if (count > 0) console.log(`[LVP] 清理了 ${count} 个残留分片文件`);
  }

  // ─── 下载单个视频 ────────────────────────────────────────────────────────
  async downloadVideo(url, absSaveDir, sourceFile, vaultBase) {
    // 始终先下载到本地临时目录，完成后再移动到目标目录（解决网络盘分片写入冲突）
    const os = require("os");
    const tmpDir = path.join(os.tmpdir(), "local-videos-plus");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(absSaveDir)) fs.mkdirSync(absSaveDir, { recursive: true });

    // 清理本地临时目录的残留分片
    this.cleanFragments(tmpDir);

    const outputTemplate = path.join(tmpDir, "%(title)s.%(ext)s");

    const args = [
      url,
      "-o", outputTemplate,
      "--force-overwrites",
      "--no-part",
      "--restrict-filenames",
      "--print", "after_move:filepath",
    ];

    if (this.settings.noPlaylist) args.push("--no-playlist");
    if (this.settings.maxFileSize) args.push("--max-filesize", this.settings.maxFileSize);

    const fmt = this.settings.preferredFormat;
    const h = this.settings.maxHeight;
    args.push(
      "-f",
      `bestvideo[height<=${h}][ext=${fmt}]+bestaudio/bestvideo[height<=${h}]+bestaudio/best`
    );
    args.push("--merge-output-format", fmt);

    console.log(`[LVP] 下载到本地临时目录: ${tmpDir}`);
    const { stdout } = await execFileAsync(this.settings.ytDlpPath, args);

    // 找到实际下载的文件
    let tmpFilePath = "";
    for (const line of stdout.trim().split("\n")) {
      const t = line.trim();
      if (t && fs.existsSync(t)) { tmpFilePath = t; break; }
    }

    // 备选：找临时目录里最新的文件
    if (!tmpFilePath) {
      const files = fs.readdirSync(tmpDir)
        .filter(f => !/-Frag\d+|\.part$|\.ytdl$/.test(f)) // 排除临时文件
        .map(f => ({ f, t: fs.statSync(path.join(tmpDir, f)).mtime }))
        .sort((a, b) => b.t - a.t);
      if (files.length > 0) tmpFilePath = path.join(tmpDir, files[0].f);
    }

    if (!tmpFilePath) throw new Error("下载成功但找不到文件");

    // 移动到目标目录（网络盘）
    const finalPath = path.join(absSaveDir, path.basename(tmpFilePath));
    console.log(`[LVP] 移动到目标目录: ${finalPath}`);
    fs.copyFileSync(tmpFilePath, finalPath);  // 先复制
    fs.unlinkSync(tmpFilePath);               // 再删除源文件

    // 返回相对于 MD 文件的路径（用于 Obsidian 内部链接）
    const mdDir = path.dirname(path.join(vaultBase, sourceFile.path));
    return path.relative(mdDir, finalPath).replace(/\\/g, "/");
  }

  // ─── 工具方法 ────────────────────────────────────────────────────────────
  getVideoDir(file) {
    if (this.settings.useRelativePath) {
      const mdDir = path.dirname(file.path);
      return obsidian.normalizePath(`${mdDir}/${this.settings.videoFolder}`);
    }
    return obsidian.normalizePath(this.settings.videoFolder);
  }

  async checkYtDlp() {
    try {
      const { stdout } = await execAsync(`"${this.settings.ytDlpPath}" --version`);
      new obsidian.Notice(`✅ yt-dlp 已安装，版本：${stdout.trim()}`, 5000);
    } catch {
      new obsidian.Notice(
        `❌ 未找到 yt-dlp！\n请先安装：\n  macOS: brew install yt-dlp\n  Windows: winget install yt-dlp\n  Linux: pip install yt-dlp`,
        10000
      );
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = LocalVideosPlusPlugin;

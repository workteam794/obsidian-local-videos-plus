import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";

import { exec, execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── 支持的视频链接正则 ───────────────────────────────────────────────────────
const VIDEO_PATTERNS = [
	// YouTube
	/https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s\)\"\']+/g,
	/https?:\/\/youtu\.be\/[\w\-]+[^\s\)\"\'"]*/g,
	/https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w\-]+[^\s\)\"\'"]*/g,
	// Bilibili
	/https?:\/\/(?:www\.)?bilibili\.com\/video\/[\w]+[^\s\)\"\'"]*/g,
	/https?:\/\/b23\.tv\/[\w]+/g,
	// Twitter / X
	/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/\w+\/status\/\d+[^\s\)\"\'"]*/g,
	// Reddit
	/https?:\/\/(?:www\.)?reddit\.com\/r\/\w+\/comments\/[\w\/]+[^\s\)\"\'"]*/g,
	// Vimeo
	/https?:\/\/(?:www\.)?vimeo\.com\/\d+[^\s\)\"\'"]*/g,
	// TikTok
	/https?:\/\/(?:www\.)?tiktok\.com\/@[\w\.]+\/video\/\d+[^\s\)\"\'"]*/g,
	// Instagram
	/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[\w\-]+[^\s\)\"\'"]*/g,
];

interface LocalVideosPlusSettings {
	videoFolder: string;         // 视频保存子目录
	useRelativePath: boolean;    // 是否相对于当前 MD
	ytDlpPath: string;           // yt-dlp 可执行文件路径
	maxFileSize: string;         // 最大文件大小，如 "500m"
	preferredFormat: string;     // 偏好格式，如 "mp4"
	maxHeight: string;           // 最大分辨率，如 "1080"
	autoDownloadOnSave: boolean; // 保存时自动下载
	autoDownloadOnCreate: boolean; // 新建文件时自动下载
	noPlaylist: boolean;         // 不下载播放列表
	replaceLinks: boolean;       // 替换 MD 中的链接为本地路径
}

const DEFAULT_SETTINGS: LocalVideosPlusSettings = {
	videoFolder: "assets",
	useRelativePath: true,
	ytDlpPath: "yt-dlp",
	maxFileSize: "500m",
	preferredFormat: "mp4",
	maxHeight: "1080",
	autoDownloadOnSave: false,
	autoDownloadOnCreate: false,
	noPlaylist: true,
	replaceLinks: true,
};

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function extractVideoUrls(content: string): string[] {
	const found = new Set<string>();
	for (const pattern of VIDEO_PATTERNS) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(content)) !== null) {
			found.add(match[0].trim());
		}
	}
	return Array.from(found);
}

function isAlreadyLocal(url: string): boolean {
	return !url.startsWith("http://") && !url.startsWith("https://");
}

// ─── 主插件类 ─────────────────────────────────────────────────────────────────

export default class LocalVideosPlusPlugin extends Plugin {
	settings: LocalVideosPlusSettings;
	private downloadQueue: Map<string, Promise<void>> = new Map();
	private isReady: boolean = false;

	async onload() {
		await this.loadSettings();

		// 启动保护：onLayoutReady 之后才开始监听，避免启动时扫描全库
		this.isReady = false;
		this.app.workspace.onLayoutReady(() => {
			setTimeout(() => {
				this.isReady = true;
				console.log("[LVP] ✅ 启动完成，开始监听新建文件");
			}, 2000);
		});

		// 命令：下载当前文件中的视频
		this.addCommand({
			id: "download-videos-current-file",
			name: "Download videos in current file",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				if (view.file) {
					await this.processFile(view.file, true);
				}
			},
		});

		// 命令：下载所有文件中的视频
		this.addCommand({
			id: "download-videos-all-files",
			name: "Download videos in all files",
			callback: async () => {
				await this.processAllFiles();
			},
		});

		// 命令：检查 yt-dlp 是否安装
		this.addCommand({
			id: "check-ytdlp",
			name: "Check yt-dlp installation",
			callback: async () => {
				await this.checkYtDlp();
			},
		});

		// 监听文件保存
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (
					!this.isReady ||
					!this.settings.autoDownloadOnSave ||
					!(file instanceof TFile) ||
					file.extension !== "md"
				) return;
				setTimeout(() => this.processFile(file, false), 1500);
			})
		);

		// 监听文件创建（仅响应 Web Clipper 等采集工具新建的文件）
		this.registerEvent(
			this.app.vault.on("create", async (file) => {
				if (
					!this.isReady ||                 // 启动阶段忽略，避免扫描全库
					!this.settings.autoDownloadOnCreate ||
					!(file instanceof TFile) ||
					file.extension !== "md"
				) return;
				console.log(`[LVP] 检测到新建文件：${file.path}`);
				setTimeout(() => this.processFile(file, false), 3000);
			})
		);

		// 设置页
		this.addSettingTab(new LocalVideosPlusSettingTab(this.app, this));

		console.log("Local Videos Plus loaded ✅");
	}

	onunload() {
		console.log("Local Videos Plus unloaded");
	}

	// ─── 核心：处理单个文件 ───────────────────────────────────────────────────

	async processFile(file: TFile, showNotice: boolean): Promise<void> {
		// 防止同一文件并发处理
		if (this.downloadQueue.has(file.path)) {
			if (showNotice) new Notice("⏳ 该文件正在处理中，请稍候...");
			return;
		}

		const promise = this._processFile(file, showNotice);
		this.downloadQueue.set(file.path, promise);
		try {
			await promise;
		} finally {
			this.downloadQueue.delete(file.path);
		}
	}

	private async _processFile(file: TFile, showNotice: boolean): Promise<void> {
		let content = await this.app.vault.read(file);
		const urls = extractVideoUrls(content);

		if (urls.length === 0) {
			if (showNotice) new Notice("✅ 当前文件没有发现视频链接");
			return;
		}

		if (showNotice) {
			new Notice(`🎬 发现 ${urls.length} 个视频链接，开始下载...`);
		}

		// 确定保存目录
		const saveDir = await this.getVideoDir(file);

		let successCount = 0;
		let failCount = 0;

		for (const url of urls) {
			if (isAlreadyLocal(url)) continue;

			try {
				const localPath = await this.downloadVideo(url, saveDir, file);
				if (localPath && this.settings.replaceLinks) {
					content = content.split(url).join(localPath);
				}
				successCount++;
			} catch (e) {
				console.error(`[Local Videos Plus] 下载失败: ${url}`, e);
				failCount++;
			}
		}

		// 写回文件
		if (this.settings.replaceLinks && successCount > 0) {
			await this.app.vault.modify(file, content);
		}

		if (showNotice) {
			new Notice(
				`🎉 完成！成功 ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ""}`
			);
		}
	}

	// ─── 处理所有文件 ─────────────────────────────────────────────────────────

	async processAllFiles(): Promise<void> {
		const mdFiles = this.app.vault.getMarkdownFiles();
		new Notice(`🔍 开始扫描 ${mdFiles.length} 个文件...`);

		let total = 0;
		for (const file of mdFiles) {
			const content = await this.app.vault.read(file);
			const urls = extractVideoUrls(content);
			if (urls.length > 0) {
				total += urls.length;
				await this.processFile(file, false);
			}
		}

		new Notice(`✅ 全库扫描完成，共处理 ${total} 个视频链接`);
	}

	// ─── 下载单个视频 ─────────────────────────────────────────────────────────

	async downloadVideo(
		url: string,
		saveDir: string,
		sourceFile: TFile
	): Promise<string | null> {
		// 确保目录存在
		const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
		const absSaveDir = path.join(vaultBasePath, saveDir);
		if (!fs.existsSync(absSaveDir)) {
			fs.mkdirSync(absSaveDir, { recursive: true });
		}

		const outputTemplate = path.join(absSaveDir, "%(title)s.%(ext)s");

		// 构建 yt-dlp 参数
		const args: string[] = [
			url,
			"-o", outputTemplate,
			"--force-overwrites",    // 覆盖残留的 .part 临时文件
			"--no-part",             // 不使用 .part 临时文件，直接写入目标文件
			"--restrict-filenames",  // 文件名只含 ASCII
		];

		if (this.settings.noPlaylist) args.push("--no-playlist");
		if (this.settings.maxFileSize) args.push("--max-filesize", this.settings.maxFileSize);
		if (this.settings.maxHeight) {
			args.push("-f", `bestvideo[height<=${this.settings.maxHeight}][ext=${this.settings.preferredFormat}]+bestaudio/bestvideo[height<=${this.settings.maxHeight}]+bestaudio/best`);
		}
		args.push("--merge-output-format", this.settings.preferredFormat);
		args.push("--print", "filename"); // 打印实际保存的文件名

		console.log(`[Local Videos Plus] 下载: ${url}`);
		console.log(`[Local Videos Plus] 命令: ${this.settings.ytDlpPath} ${args.join(" ")}`);

		try {
			const { stdout, stderr } = await execFileAsync(this.settings.ytDlpPath, args);

			// 从输出里找到实际文件名
			const lines = stdout.trim().split("\n");
			let actualFile = "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed && fs.existsSync(trimmed)) {
					actualFile = trimmed;
					break;
				}
			}

			if (!actualFile) {
				// 备选：找 saveDir 里最新的文件
				const files = fs.readdirSync(absSaveDir)
					.map(f => ({ name: f, time: fs.statSync(path.join(absSaveDir, f)).mtime }))
					.sort((a, b) => b.time.getTime() - a.time.getTime());
				if (files.length > 0) {
					actualFile = path.join(absSaveDir, files[0].name);
				}
			}

			if (actualFile) {
				// 转为相对于 Vault 的路径
				const relPath = path.relative(vaultBasePath, actualFile).replace(/\\/g, "/");
				// 转为相对于当前 MD 的路径
				if (this.settings.useRelativePath) {
					const mdDir = path.dirname(path.join(vaultBasePath, sourceFile.path));
					const relToMd = path.relative(mdDir, actualFile).replace(/\\/g, "/");
					return relToMd;
				}
				return relPath;
			}
		} catch (e: any) {
			throw new Error(`yt-dlp 执行失败: ${e.message || e}`);
		}

		return null;
	}

	// ─── 确定视频保存目录 ─────────────────────────────────────────────────────

	async getVideoDir(file: TFile): Promise<string> {
		if (this.settings.useRelativePath) {
			const mdDir = path.dirname(file.path);
			return normalizePath(`${mdDir}/${this.settings.videoFolder}`);
		}
		return normalizePath(this.settings.videoFolder);
	}

	// ─── 检查 yt-dlp ──────────────────────────────────────────────────────────

	async checkYtDlp(): Promise<void> {
		try {
			const { stdout } = await execAsync(`${this.settings.ytDlpPath} --version`);
			new Notice(`✅ yt-dlp 已安装，版本：${stdout.trim()}`);
		} catch (e) {
			new Notice(
				`❌ 未找到 yt-dlp！\n请先安装：\n  macOS: brew install yt-dlp\n  Windows: winget install yt-dlp\n  Linux: pip install yt-dlp`,
				8000
			);
		}
	}

	// ─── 设置读写 ─────────────────────────────────────────────────────────────

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ─── 设置页 UI ────────────────────────────────────────────────────────────────

class LocalVideosPlusSettingTab extends PluginSettingTab {
	plugin: LocalVideosPlusPlugin;

	constructor(app: App, plugin: LocalVideosPlusPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Local Videos Plus 设置" });

		// ── 目录设置 ──
		containerEl.createEl("h3", { text: "📁 保存目录" });

		new Setting(containerEl)
			.setName("视频子目录名")
			.setDesc("视频保存到哪个子文件夹（相对于 Vault 根目录或当前 MD 文件）")
			.addText((text) =>
				text
					.setPlaceholder("assets")
					.setValue(this.plugin.settings.videoFolder)
					.onChange(async (value) => {
						this.plugin.settings.videoFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("相对于当前 MD 文件")
			.setDesc("开启后视频保存在 MD 同级的子目录，关闭则保存到 Vault 根目录下")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useRelativePath)
					.onChange(async (value) => {
						this.plugin.settings.useRelativePath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("替换 MD 中的链接")
			.setDesc("下载完成后，将 MD 文件中的网络链接替换为本地路径")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.replaceLinks)
					.onChange(async (value) => {
						this.plugin.settings.replaceLinks = value;
						await this.plugin.saveSettings();
					})
			);

		// ── yt-dlp 设置 ──
		containerEl.createEl("h3", { text: "⚙️ yt-dlp 配置" });

		new Setting(containerEl)
			.setName("yt-dlp 路径")
			.setDesc("yt-dlp 的可执行文件路径，如已加入 PATH 直接填 yt-dlp 即可")
			.addText((text) =>
				text
					.setPlaceholder("yt-dlp")
					.setValue(this.plugin.settings.ytDlpPath)
					.onChange(async (value) => {
						this.plugin.settings.ytDlpPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("检查 yt-dlp 安装")
			.setDesc("点击检测 yt-dlp 是否可用")
			.addButton((btn) =>
				btn.setButtonText("检查").onClick(async () => {
					await this.plugin.checkYtDlp();
				})
			);

		new Setting(containerEl)
			.setName("最大文件大小")
			.setDesc("超出此大小的视频跳过下载，如 500m、1g")
			.addText((text) =>
				text
					.setPlaceholder("500m")
					.setValue(this.plugin.settings.maxFileSize)
					.onChange(async (value) => {
						this.plugin.settings.maxFileSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("最大分辨率")
			.setDesc("下载视频的最大高度像素，如 720、1080、2160")
			.addDropdown((drop) =>
				drop
					.addOption("480", "480p")
					.addOption("720", "720p")
					.addOption("1080", "1080p（推荐）")
					.addOption("1440", "1440p")
					.addOption("2160", "4K")
					.setValue(this.plugin.settings.maxHeight)
					.onChange(async (value) => {
						this.plugin.settings.maxHeight = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("偏好格式")
			.setDesc("优先下载的视频格式")
			.addDropdown((drop) =>
				drop
					.addOption("mp4", "MP4（推荐）")
					.addOption("webm", "WebM")
					.addOption("mkv", "MKV")
					.setValue(this.plugin.settings.preferredFormat)
					.onChange(async (value) => {
						this.plugin.settings.preferredFormat = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("不下载播放列表")
			.setDesc("开启后只下载单个视频，不展开整个播放列表")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.noPlaylist)
					.onChange(async (value) => {
						this.plugin.settings.noPlaylist = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 自动化设置 ──
		containerEl.createEl("h3", { text: "🤖 自动化" });

		new Setting(containerEl)
			.setName("保存时自动下载")
			.setDesc("每次保存 MD 文件时，自动扫描并下载视频（可能影响保存速度）")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoDownloadOnSave)
					.onChange(async (value) => {
						this.plugin.settings.autoDownloadOnSave = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("新建文件时自动下载")
			.setDesc("Web Clipper 采集新文件时，自动触发视频下载")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoDownloadOnCreate)
					.onChange(async (value) => {
						this.plugin.settings.autoDownloadOnCreate = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 使用说明 ──
		containerEl.createEl("h3", { text: "📖 使用说明" });
		const info = containerEl.createEl("div");
		info.innerHTML = `
			<p><b>命令面板（Ctrl/Cmd+P）可用命令：</b></p>
			<ul>
				<li><code>Download videos in current file</code> — 下载当前文件的视频</li>
				<li><code>Download videos in all files</code> — 扫描全库下载</li>
				<li><code>Check yt-dlp installation</code> — 检查 yt-dlp 安装状态</li>
			</ul>
			<p><b>支持平台：</b> YouTube、B站、Twitter/X、Reddit、Vimeo、TikTok、Instagram 等 1800+ 网站</p>
			<p><b>前提：</b> 需先安装 <a href="https://github.com/yt-dlp/yt-dlp">yt-dlp</a></p>
		`;
	}
}

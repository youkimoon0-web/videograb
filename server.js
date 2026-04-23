const express = require('express');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const app  = express();
const port = 3000;

// ─── Rate limiter ──────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT   = 10;
const RATE_WINDOW  = 60 * 1000;

function rateLimiter(req, res, next) {
    const ip    = req.ip;
    const now   = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, start: now };
    if (now - entry.start > RATE_WINDOW) { entry.count = 1; entry.start = now; }
    else entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > RATE_LIMIT)
        return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    next();
}

// ─── URL validation ────────────────────────────────────────────────────────────
function isValidUrl(str) {
    try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
}

// ─── Clean URL — strip playlist/tracking params ───────────────────────────────
function cleanUrl(url) {
    return url.split('?list=')[0].split('&list=')[0].split('?si=')[0].split('&si=')[0];
}

// ─── Downloads folder ─────────────────────────────────────────────────────────
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

// ─── Auto cleanup after 10 minutes ────────────────────────────────────────────
function scheduleCleanup(filePath) {
    setTimeout(() => {
        fs.unlink(filePath, (err) => {
            if (!err) console.log(`🗑️  Cleaned: ${path.basename(filePath)}`);
        });
    }, 10 * 60 * 1000);
}

// ─── yt-dlp base args — tv_embedded gives 144p to 1080p without PO Token ──────
const YTDLP_BASE_ARGS = [
    '--extractor-args', 'youtube:player_client=tv_embedded',
    '--no-playlist',
];

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

app.use((req, res, next) => { console.log(`📨 ${req.method} ${req.path}`); next(); });

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/test', (req, res) => res.json({ message: 'Server is working!' }));

// ─── Get video info ────────────────────────────────────────────────────────────
async function getVideoInfo(rawUrl) {
    return new Promise((resolve, reject) => {
        const url = cleanUrl(rawUrl);
        console.log('🔍 Fetching info for:', url);

        const ytDlp = spawn('python3', [
            '-m', 'yt_dlp',
            ...YTDLP_BASE_ARGS,
            '--dump-json',
            url
        ]);

        const timeout = setTimeout(() => {
            ytDlp.kill();
            reject(new Error('Timed out fetching video info.'));
        }, 45000);

        let stdout = '', stderr = '';
        ytDlp.stdout.on('data', d => { stdout += d.toString(); });
        ytDlp.stderr.on('data', d => { stderr += d.toString(); });

        ytDlp.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0) {
                console.error('yt-dlp error:', stderr);
                reject(new Error('Could not fetch video info. Check the URL and try again.'));
            } else {
                try { resolve(JSON.parse(stdout.trim())); }
                catch { reject(new Error('Failed to read video info.')); }
            }
        });
        ytDlp.on('error', () => { clearTimeout(timeout); reject(new Error('yt-dlp not found.')); });
    });
}

// ─── Download video ────────────────────────────────────────────────────────────
async function downloadVideo(rawUrl, outputPath, quality) {
    return new Promise((resolve, reject) => {
        const url = cleanUrl(rawUrl);

        // Best format string: prefers mp4+m4a for clean mp4 output
        // Falls back gracefully if exact quality not available
        let formatSpec;
        if (quality) {
            formatSpec = [
                `bestvideo[height=${quality}][ext=mp4]+bestaudio[ext=m4a]`,
                `bestvideo[height=${quality}]+bestaudio`,
                `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]`,
                `bestvideo[height<=${quality}]+bestaudio`,
                'best'
            ].join('/');
        } else {
            formatSpec = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
        }

        console.log(`📥 Downloading ${quality ? quality + 'p' : 'best'} video...`);

        const ytDlp = spawn('python3', [
            '-m', 'yt_dlp',
            ...YTDLP_BASE_ARGS,
            '-f', formatSpec,
            '--merge-output-format', 'mp4',
            '-o', outputPath + '.%(ext)s',
            url
        ]);

        const timeout = setTimeout(() => {
            ytDlp.kill();
            reject(new Error('Download timed out.'));
        }, 10 * 60 * 1000);

        let stderr = '';
        ytDlp.stderr.on('data', d => {
            const msg = d.toString();
            console.log('[yt-dlp]', msg.trim());
            stderr += msg;
        });

        ytDlp.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0) {
                console.error('yt-dlp error:', stderr);
                reject(new Error('Video download failed.'));
            } else {
                console.log('✅ Video downloaded!');
                resolve();
            }
        });
        ytDlp.on('error', () => { clearTimeout(timeout); reject(new Error('yt-dlp not found.')); });
    });
}

// ─── Download audio MP3 ────────────────────────────────────────────────────────
async function downloadAudioMP3(rawUrl, outputPath) {
    return new Promise((resolve, reject) => {
        const url = cleanUrl(rawUrl);
        console.log('🎵 Downloading audio...');

        const ytDlp = spawn('python3', [
            '-m', 'yt_dlp',
            ...YTDLP_BASE_ARGS,
            '-f', 'bestaudio[ext=m4a]/bestaudio/best',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '-o', outputPath + '.%(ext)s',
            url
        ]);

        const timeout = setTimeout(() => {
            ytDlp.kill();
            reject(new Error('Audio download timed out.'));
        }, 10 * 60 * 1000);

        let stderr = '';
        ytDlp.stderr.on('data', d => {
            const msg = d.toString();
            console.log('[yt-dlp]', msg.trim());
            stderr += msg;
        });

        ytDlp.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0) {
                console.error('yt-dlp error:', stderr);
                reject(new Error('Audio download failed.'));
            } else {
                console.log('✅ Audio downloaded!');
                resolve();
            }
        });
        ytDlp.on('error', () => { clearTimeout(timeout); reject(new Error('yt-dlp not found.')); });
    });
}

// ─── Find actual output file yt-dlp created ───────────────────────────────────
function findOutputFile(basePath, expectedExt) {
    const exact = basePath + '.' + expectedExt;
    if (fs.existsSync(exact)) return exact;
    const dir      = path.dirname(basePath);
    const baseName = path.basename(basePath);
    const files    = fs.readdirSync(dir);
    const match    = files.find(f => f.startsWith(baseName));
    return match ? path.join(dir, match) : null;
}

// ─── Main endpoint ─────────────────────────────────────────────────────────────
app.post('/download', rateLimiter, async (req, res) => {
    const { url, action, format, quality } = req.body;
    console.log('📥 Request:', { url, action, format, quality });

    if (!url || !isValidUrl(url))
        return res.status(400).json({ error: 'Invalid or missing URL.' });
    if (!action || !['info', 'download'].includes(action))
        return res.status(400).json({ error: 'Invalid action.' });

    try {
        // ── INFO ──────────────────────────────────────────────────────────────
        if (action === 'info') {
            const videoInfo = await getVideoInfo(url);
            const formats   = videoInfo.formats || [];

            // Collect all unique resolutions — skip audio-only streams
            const qualityMap = new Map();
            formats.forEach(f => {
                if (!f.height) return;
                if (!f.vcodec || f.vcodec === 'none') return;
                if (!qualityMap.has(f.height)) {
                    qualityMap.set(f.height, {
                        height:   f.height,
                        ext:      'mp4',
                        filesize: f.filesize || f.filesize_approx || null
                    });
                }
            });

            const qualities = Array.from(qualityMap.values())
                .sort((a, b) => b.height - a.height);

            console.log('✅ Qualities found:', qualities.map(q => q.height + 'p').join(', '));

            return res.json({
                title:              videoInfo.title,
                thumbnail:          videoInfo.thumbnail,
                duration:           videoInfo.duration,
                uploader:           videoInfo.uploader,
                availableQualities: qualities
            });
        }

        // ── DOWNLOAD ──────────────────────────────────────────────────────────
        if (action === 'download') {
            const timestamp = Date.now();
            const baseName  = `${format === 'audio' ? 'audio' : 'video'}_${timestamp}`;
            const basePath  = path.join(downloadDir, baseName);

            if (format === 'audio') {
                await downloadAudioMP3(url, basePath);
                const finalPath = findOutputFile(basePath, 'mp3');
                if (!finalPath)
                    return res.status(500).json({ error: 'Audio file not found after download.' });
                const filename = path.basename(finalPath);
                scheduleCleanup(finalPath);
                return res.json({
                    success: true, message: 'Audio downloaded!',
                    filename, path: `/downloads/${filename}`, type: 'audio'
                });

            } else {
                await downloadVideo(url, basePath, quality || null);
                const finalPath = findOutputFile(basePath, 'mp4');
                if (!finalPath)
                    return res.status(500).json({ error: 'Video file not found after download.' });
                const filename = path.basename(finalPath);
                scheduleCleanup(finalPath);
                return res.json({
                    success: true,
                    message: `Video downloaded${quality ? ' at ' + quality + 'p' : ''}!`,
                    filename, path: `/downloads/${filename}`,
                    type: 'video', quality: quality || 'best'
                });
            }
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});

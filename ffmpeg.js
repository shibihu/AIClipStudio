const fs = require('fs')
const path = require('path')

function resolveBinaries(root, platform = process.platform, arch = process.arch, canExecute = null) {
  // The committed vendor binaries target Linux (the Render deployment). Windows
  // must use its native FFmpeg installation from PATH instead of trying to
  // spawn a Linux ELF executable, which Node reports as ENOENT.
  if (platform === 'win32') return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

  const executable = canExecute || ((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch { return false }
  })
  const suffix = arch === 'x64' ? 'amd64' : arch
  const ffmpeg = path.join(root, 'vendor', `ffmpeg-${suffix}`)
  const ffprobe = path.join(root, 'vendor', `ffprobe-${suffix}`)
  if (executable(ffmpeg) && executable(ffprobe)) return { ffmpeg, ffprobe }

  const fallbackFfmpeg = path.join(root, 'vendor', 'ffmpeg')
  const fallbackFfprobe = path.join(root, 'vendor', 'ffprobe')
  if (executable(fallbackFfmpeg) && executable(fallbackFfprobe)) {
    return { ffmpeg: fallbackFfmpeg, ffprobe: fallbackFfprobe }
  }
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
}

module.exports = { resolveBinaries }

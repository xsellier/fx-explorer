const crypto = require('crypto')
const path = require('path')
const { execFile, spawn } = require('child_process')

const FORMATS = {
  wav: { mime: 'audio/wav' },
  flac: { mime: 'audio/flac', args: ['-c:a', 'flac'] },
  ogg: { mime: 'audio/ogg', args: ['-c:a', 'libvorbis', '-q:a', '6'] },
  mp3: { mime: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-q:a', '2'], maxRate: 48000, maxChannels: 2 }
}

const WAV_CODECS = ['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le']

// Keep the bit depth of the source when exporting to wav
function wavCodec (source) {
  const codec = (source.codec || '').replace(/be$/, 'le')

  if (WAV_CODECS.includes(codec)) return codec
  if (source.bits === 24) return 'pcm_s24le'
  if (source.bits === 32) return 'pcm_s32le'

  return 'pcm_s16le'
}

// Only one slot is handed over at a time, so `max` is never exceeded
function createLimiter (max) {
  let active = 0
  const queue = []

  const acquire = () => {
    if (active < max) {
      active++
      return Promise.resolve()
    }

    return new Promise((resolve) => queue.push(resolve))
  }

  const release = () => {
    const next = queue.shift()

    if (next) next()
    else active--
  }

  return {
    async run (task) {
      await acquire()

      try {
        return await task()
      } finally {
        release()
      }
    }
  }
}

class FFmpeg {
  constructor ({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', maxJobs = 1, tmp }) {
    this.ffmpeg = ffmpeg
    this.ffprobe = ffprobe
    this.tmp = tmp
    this.limiter = createLimiter(Math.max(1, maxJobs))
  }

  probe (file) {
    const args = [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,duration',
      '-of', 'json',
      file
    ]

    return new Promise((resolve, reject) => {
      execFile(this.ffprobe, args, { timeout: 60000 }, (error, stdout) => {
        if (error && error.code === 'ENOENT') return reject(error)
        if (error) return resolve(null)

        try {
          const data = JSON.parse(stdout)
          const stream = (data.streams || [])[0] || {}
          const duration = parseFloat(stream.duration) || parseFloat((data.format || {}).duration)
          const bits = parseInt(stream.bits_per_sample, 10) || parseInt(stream.bits_per_raw_sample, 10)

          resolve({
            duration: Number.isFinite(duration) ? duration : null,
            sampleRate: parseInt(stream.sample_rate, 10) || null,
            channels: stream.channels || null,
            bits: bits || null,
            codec: stream.codec_name || null
          })
        } catch (parseError) {
          resolve(null)
        }
      })
    })
  }

  // options: { start, end, format, channels, sampleRate, fadeIn, fadeOut }
  // source: file row from the database (duration, sampleRate, channels, bits, codec)
  buildExportArgs (input, output, source, options) {
    const format = FORMATS[options.format]
    const start = Math.max(0, options.start || 0)
    const end = options.end > start ? options.end : null
    const length = end !== null ? end - start : (source.duration ? source.duration - start : null)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']

    if (start > 0) args.push('-ss', start.toFixed(3))

    args.push('-i', input)

    if (end !== null) args.push('-t', (end - start).toFixed(3))

    args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1')

    let channels = options.channels || null
    let sampleRate = options.sampleRate || null

    if (format.maxChannels && !channels && source.channels > format.maxChannels) channels = format.maxChannels
    if (format.maxRate && (sampleRate || source.sampleRate) > format.maxRate) sampleRate = format.maxRate
    if (channels) args.push('-ac', String(channels))
    if (sampleRate) args.push('-ar', String(sampleRate))

    const filters = []

    if (options.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${(options.fadeIn / 1000).toFixed(3)}`)

    if (options.fadeOut > 0 && length) {
      const fade = Math.min(options.fadeOut / 1000, length)

      filters.push(`afade=t=out:st=${(length - fade).toFixed(3)}:d=${fade.toFixed(3)}`)
    }

    if (filters.length) args.push('-af', filters.join(','))

    args.push(...(format.args || ['-c:a', wavCodec(source)]), output)

    return args
  }

  run (args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''

      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
      })
    })
  }

  // Returns the path of a temporary file, the caller deletes it
  async export (input, source, options) {
    if (!FORMATS[options.format]) throw new Error(`Unknown format: ${options.format}`)

    const output = path.join(this.tmp, `fx-explorer-${crypto.randomUUID()}.${options.format}`)

    await this.limiter.run(() => this.run(this.buildExportArgs(input, output, source, options)))

    return output
  }

  // Streams an mp3 version of a file the browser cannot play (aiff, wma...)
  transcode (input, req, res) {
    return this.limiter.run(() => new Promise((resolve) => {
      if (res.writableEnded || req.destroyed) return resolve()

      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', input, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100',
        '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'
      ]
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] })

      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' })
      child.stdout.pipe(res)
      child.on('error', () => {
        res.end()
        resolve()
      })
      child.on('close', resolve)
      res.on('close', () => child.kill('SIGKILL'))
    }))
  }
}

module.exports = { FFmpeg, FORMATS, createLimiter }

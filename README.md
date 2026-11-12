# FX Explorer

My sound effects live on my NAS, spread across bundles and packs bought over the years. Finding the right click or the right ambience with a file manager is a pain, so I made this.

FX Explorer is a small web app that runs on a Raspberry Pi. It indexes the library once into a SQLite database, then everything happens in the browser: search, sort, play, cut, convert, download, delete.

## Features

- Lists every sound of the library folder, with its size, duration, format, sample rate, bit depth and channels
- One global volume for everything, set once, saved in the browser
- Scans the library once to fill the database, then only when you click on Scan
- Play, download or delete a sound
- Sort by name, date, size or duration, ascending or descending
- One search box for file names and tags, with `name:` and `tag:` to be specific
- Cut a part of a sound and download only that part
- Convert to WAV, FLAC, OGG or MP3, downmix to mono, resample, add a fade in / fade out
- Favorites and your own tags
- Keyboard navigation, so you can go through a folder with the arrow keys and hear every sound

## Requirements

- Node.js 20 or newer
- ffmpeg (`ffprobe` reads the durations, `ffmpeg` cuts and converts)
- The library mounted somewhere on the Pi (NFS, SMB, whatever)

```bash
sudo apt install ffmpeg
```

## Install

```bash
git clone https://github.com/xsellier/fx-explorer
cd fx-explorer
npm install --omit=dev
```

Create `config/local.json` with the path of your library:

```json
{
  "paths": {
    "audioLibrary": "/mnt/nas/sfx"
  }
}
```

Then start it:

```bash
npm start
```

Open `http://<raspberry-pi-ip>:3000`. On the first start, the library is scanned automatically. Files show up as soon as they are listed, durations are filled right after.

## Configuration

Everything is in `config/`. Files are merged in this order, the last one wins:

1. `default.json`
2. `<NODE_ENV>.json` if `NODE_ENV` is set
3. `local.json`, ignored by git, put your own settings there

Some values can also be set with environment variables: `PORT`, `HOST`, `LIBRARY_PATH`, `DATABASE_PATH`.

| Key | Default | What it does |
| --- | --- | --- |
| `server.port` | `3000` | HTTP port |
| `server.host` | `0.0.0.0` | Listening address |
| `server.auth` | `null` | `{ "user": "...", "password": "..." }` to enable basic auth |
| `paths.audioLibrary` | `./audio_library` | Folder containing the sounds |
| `paths.database` | `./data/fx-explorer.db` | SQLite database |
| `paths.trash` | `null` | When set, deleted files are moved there instead of being removed |
| `paths.tmp` | system temp folder | Where ffmpeg writes the exported files before sending them |
| `scanner.acceptedExtensions` | wav, mp3, aif, aiff, aac, ogg, oga, opus, flac, m4a, wma | Files to index |
| `scanner.ignoreHidden` | `true` | Skip files and folders starting with a dot |
| `scanner.ignoreFolders` | `@eaDir`, `#recycle`, `#snapshot`, `lost+found` | Folder names to skip, the NAS ones are already there |
| `scanner.scanOnFirstStart` | `true` | Scan when the database is empty |
| `scanner.statConcurrency` | `8` | Files read in parallel while indexing |
| `scanner.probeConcurrency` | `2` | ffprobe processes in parallel |
| `ffmpeg.ffmpeg` / `ffmpeg.ffprobe` | `ffmpeg` / `ffprobe` | Binaries to use |
| `ffmpeg.maxJobs` | `2` | ffmpeg processes in parallel (exports and transcoding) |
| `ui.copyPathPrefix` | `""` | Prepended to the path when you copy it, for instance `smb://nas/sfx/` |

## Scanning

The scan runs once, on the first start. After that, nothing happens until you click on Scan.

A scan is incremental: a file with the same size and the same modification date is skipped. Only new or modified files go through ffprobe, deleted files are removed from the database. Shift + click on Scan reads every duration again.

Two safety nets, because the library is on a NAS:

- If the library folder is missing or empty, the scan stops and the database is not touched. An unmounted share looks exactly like an empty folder.
- If a folder cannot be read during the scan, its files are kept in the database.

The database is only a cache. If you delete it, the next start rebuilds it, but you lose your favorites and your tags.

## Search

Type words, every word must match the file name or a tag. Tags are the folder names (`PremiumBeat SFX`, `West Wolf - Pedestrian Streets`...) plus the ones you add yourself.

| Query | Result |
| --- | --- |
| `footsteps gravel` | Both words in the name or the tags, mixed |
| `"city square"` | The exact phrase |
| `name: "city square"` | File name only |
| `tag: "west wolf"` | Tags only |
| `ext:wav` | Extension |
| `dur:<2`, `dur:>10`, `dur:1-3` | Duration, in seconds |
| `-evening`, `-tag: "cheap pack"` | Exclude |

The search does not care about case, accents, `_` or `-`. `pedestrian street` matches `PS_43_City_Pedestrian_Street`.

Clicking on a folder name or a tag adds it to the search. The star button in the header shows the favorites.

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Search |
| `Up` / `Down` | Previous / next sound, plays it if "Play on select" is checked |
| `Space` | Play / pause |
| `Enter` | Play |
| `E` | Cut / convert |
| `D` | Download |
| `F` | Favorite |
| `Del` | Delete |

## Cut and convert

The scissors button opens the editor. The browser downloads the file and draws the waveform, so the Pi does not have to.

- Drag to select a part, drag the edges to adjust, or type the start and end
- Mouse wheel to zoom, Shift + wheel to scroll
- Space plays the selection, the loop button loops it

Then pick the format, channels, sample rate and fades, and download. The export is done by ffmpeg on the Pi. WAV keeps the bit depth of the source. MP3 is automatically limited to stereo and 48 kHz, the encoder does not go further.

Without a selection, the whole file is exported, which is how you convert a file.

A short fade (5 to 10 ms) on both ends avoids the click you get when cutting in the middle of a waveform.

## Raspberry Pi notes

- Chrome and Firefox cannot play AIFF or WMA. For those, the Pi converts the file to MP3 on the fly. It costs some CPU, it is killed as soon as you play something else.
- Large files (long ambiences, 90 MB and more) take a few seconds to show up in the editor, the browser has to download them first.
- `ffmpeg.maxJobs` and `scanner.probeConcurrency` are the two knobs if the Pi struggles. On a Pi 3, put both to 1.
- The first scan of a big library can take a while: ffprobe runs once per file. You can use the app while it runs.

## Run it as a service

```bash
sudo cp systemctl-service/fx-explorer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fx-explorer
journalctl -u fx-explorer -f
```

The service uses `NODE_ENV=local`, so it reads `config/local.json`. Adjust `WorkingDirectory` and `User` if needed.

## Upgrading from the first version

- The database schema changed. The old database is dropped and rebuilt by a scan, nothing to do.
- The config keys `paths.audioLibrary`, `paths.database`, `server.port` and `server.host` did not change.
- `scanInterval`, `watchFiles` and the other unused keys are gone, they are ignored if still in `local.json`.
- `chokidar`, `sqlite3` and `cors` are no longer used. Run `npm install` again.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/files?q=&sort=&order=&offset=&limit=` | Search and list, `sort` is `name`, `date`, `size` or `duration`, `order` is `asc` or `desc` |
| `GET` | `/api/files/:id` | One file |
| `GET` | `/api/files/:id/stream` | Play, supports range requests. `?transcode=1` for an MP3 version |
| `GET` | `/api/files/:id/download` | Download the original |
| `GET` | `/api/files/:id/export?format=&start=&end=&channels=&rate=&fadeIn=&fadeOut=` | Cut and / or convert, times in seconds, fades in ms |
| `DELETE` | `/api/files/:id` | Delete the file (or move it to the trash folder) |
| `POST` | `/api/files/:id/tags` | Add a tag, body `{ "tag": "..." }` |
| `DELETE` | `/api/files/:id/tags/:tag` | Remove one of your tags |
| `GET` | `/api/tags` | Every tag with its count |
| `GET` | `/api/status` | Library stats and scan status |
| `POST` | `/api/scan` | Start a scan, body `{ "full": true }` to read every duration again |

## Tests

```bash
npm test
```

## License

MIT
